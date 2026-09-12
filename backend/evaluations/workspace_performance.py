"""Opt-in, isolated workspace benchmarks. Never read the user's project database."""

import argparse
import ctypes
import hashlib
import json
import math
import platform
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routes.projects import router
from app.core.config import Settings, get_settings
from app.core.database import Base, get_db
from app.services import search_service
from app.services.analysis_cache import clear_analysis_cache
from app.services.project_service import create_scanned_project

ROOT = Path(__file__).resolve().parents[2]
SIZES = {"small": 24, "medium": 240, "large": 1200}


def distribution(values: list[float]) -> dict:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("At least one sample is required")
    return {
        "samples_ms": [round(value, 3) for value in values],
        "p50_ms": round(ordered[math.ceil(len(ordered) * 0.5) - 1], 3),
        "p95_ms": round(ordered[math.ceil(len(ordered) * 0.95) - 1], 3),
    }


def process_peak_mib() -> float:
    """Lifetime process peak RSS/working set, not Python heap or per-request memory."""
    if platform.system() == "Windows":
        class MemoryCounters(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong)] + [
                (name, ctypes.c_size_t) for name in (
                    "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                    "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                    "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage",
                )
            ]
        counters = MemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        get_process = ctypes.windll.kernel32.GetCurrentProcess
        get_process.restype = ctypes.c_void_p
        get_memory = ctypes.windll.psapi.GetProcessMemoryInfo
        get_memory.argtypes = [ctypes.c_void_p, ctypes.POINTER(MemoryCounters), ctypes.c_ulong]
        if not get_memory(get_process(), ctypes.byref(counters), counters.cb):
            raise ctypes.WinError()
        return round(counters.PeakWorkingSetSize / 1024**2, 2)
    import resource
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(value / (1024**2 if platform.system() == "Darwin" else 1024), 2)


def create_corpus(directory: Path, count: int) -> dict:
    directory.mkdir(parents=True, exist_ok=False)
    digest = hashlib.sha256()
    line_count = 0
    for index in range(count):
        path = f"services/order_{index:04d}.py"
        source = f"from .order_{(index + 1) % count:04d} import validate_order\n\n"
        source += "def validate_order(order):\n    return order is not None\n\n"
        source += f"def process_order_{index}(order):\n    total = 0\n"
        # Include deterministic structural findings, not just trivial empty files.
        source += "    total += order.get('amount', 0)\n" * (85 if index % 10 == 0 else 25)
        source += "    return total if validate_order(order) else 0\n"
        destination = directory / path
        destination.parent.mkdir(exist_ok=True)
        destination.write_text(source, encoding="utf-8", newline="\n")
        digest.update(path.encode() + b"\0" + source.encode())
        line_count += len(source.splitlines())
    archive_path = directory.with_suffix(".zip")
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(directory.rglob("*.py")):
            archive.write(path, f"{directory.name}/{path.relative_to(directory).as_posix()}")
    return {"files": count, "lines": line_count, "sha256": digest.hexdigest(), "archive": str(archive_path)}


def run(samples: int, parent: Path) -> Path:
    parent.mkdir(parents=True, exist_ok=True)
    # Inherit workspace permissions so the separate browser runner can read
    # these synthetic fixtures too; never include user source or credentials.
    runtime = (parent / f"run-{uuid.uuid4().hex[:12]}").resolve()
    runtime.mkdir(exist_ok=False)
    settings = Settings(
        _env_file=None,
        database_url=f"sqlite:///{(runtime / 'devatlas.db').as_posix()}",
        repository_root=runtime / "repositories", temporary_root=runtime / "tmp",
        search_index_root=runtime / "indexes", provider_config_path=runtime / "providers.json",
        semantic_search_enabled=False,
    )
    settings.ensure_directories()
    engine = create_engine(settings.database_url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    app = FastAPI()  # No production lifespan, migrations or background model warmup.
    app.include_router(router, prefix="/api/projects")

    def database():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_settings] = lambda: settings
    report = {
        "schema_version": 1, "corpus_version": "orders-v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "environment": {"python": platform.python_version(), "platform": platform.platform()},
        "method": "TestClient serialized in-process HTTP; no socket/browser latency; OS disk cache not cleared",
        "memory_method": "cumulative lifetime peak working set/RSS of benchmark process, includes corpus import",
        "samples": samples, "projects": [],
    }
    try:
        with TestClient(app) as client:
            for name, count in SIZES.items():
                source = settings.repository_root / name
                corpus = create_corpus(source, count)
                started = time.perf_counter()
                with Session(engine) as session:
                    project = create_scanned_project(session, source, "benchmark", name, search_index_root=settings.search_index_root)
                    project_id = project.id
                corpus["import_ms"] = round((time.perf_counter() - started) * 1000, 3)
                corpus["name"] = name
                corpus["project_id"] = project_id
                corpus["metrics"] = {}
                prefix = f"/api/projects/{project_id}"

                def measure(paths: list[str]) -> tuple[float, int]:
                    started = time.perf_counter()
                    responses = [client.get(prefix + path) for path in paths]
                    elapsed = (time.perf_counter() - started) * 1000
                    for response in responses:
                        response.raise_for_status()
                    return elapsed, sum(len(response.content) for response in responses)

                operations = {
                    "quality": ["/quality?limit=100"],
                    "search": ["/search?q=order%20validation&limit=10"],
                    # Sequential service workload only; actual click-to-render is measured separately.
                    "switch_read_bundle": ["", "/structure/summary", "/files/tree"],
                }
                for operation, paths in operations.items():
                    for mode in ("cold", "warm"):
                        timings = []
                        if mode == "warm":
                            measure(paths)
                        for _ in range(samples):
                            if mode == "cold":
                                clear_analysis_cache()
                                search_service._SEARCH_CACHE.clear()
                            elapsed, response_bytes = measure(paths)
                            timings.append(elapsed)
                        corpus["metrics"][f"{operation}_{mode}"] = distribution(timings) | {"response_bytes": response_bytes}
                corpus["cumulative_process_peak_mib"] = process_peak_mib()
                report["projects"].append(corpus)
                print(f"{name}: {count} files, peak {corpus['cumulative_process_peak_mib']} MiB", flush=True)
    finally:
        clear_analysis_cache()
        search_service._SEARCH_CACHE.clear()
        engine.dispose()
    output = runtime / "result.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(output, flush=True)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--output-parent", type=Path, default=ROOT / "data/tmp/workspace-performance")
    args = parser.parse_args()
    if not 5 <= args.samples <= 100:
        parser.error("--samples must be between 5 and 100")
    run(args.samples, args.output_parent)
