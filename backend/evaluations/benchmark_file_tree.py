"""Opt-in, offline file-tree service benchmark on synthetic SQLite metadata.

From backend: .venv/Scripts/python.exe -m evaluations.benchmark_file_tree
  --output ../docs/performance/file-tree-2026-09-12.json
  --work-dir ../data/tmp/file-tree-benchmark --samples 11

No fixture source code is created, imported, scanned, or executed. The legacy
helper below was frozen from project_service.py before the SQL/pagination edit.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import inspect
import json
import math
import platform
import sqlite3
import time
import tracemalloc
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from unittest.mock import patch

import sqlalchemy
from sqlalchemy import create_engine, func, insert, select
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[2]
CORPUS_VERSION = "file-tree-metadata-v1"
SEED = 20260912
SIZES = (500, 5_000, 20_000)
DEEP_DIRECTORY = "deep/level_00/level_01/level_02/level_03/level_04/level_05/level_06/level_07"
SCENARIOS = {"root": "", "wide_first_page": "wide", "deep_directory": DEEP_DIRECTORY}


def _normalize_legacy_tree_directory(directory: str) -> str:
    normalized = directory.strip().replace("\\", "/").strip("/")
    if not normalized:
        return ""
    path = PurePosixPath(normalized)
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Repository directory path is invalid.")
    return path.as_posix()


def legacy_load_project_file_tree(
    database: Session, project_id: int, directory: str = "", *, file_model
) -> dict[str, object]:
    """Frozen legacy: select every matching full ORM row, then aggregate in Python.

    Copied from app/services/project_service.py on 2026-09-12 before optimization.
    Only helper names and injected ProjectFile binding differ; the SELECT,
    materialization, aggregation, stable case-insensitive sort, and result match.
    """
    ProjectFile = file_model
    normalized = _normalize_legacy_tree_directory(directory)
    statement = select(ProjectFile).where(ProjectFile.project_id == project_id)
    prefix = f"{normalized}/" if normalized else ""
    if prefix:
        statement = statement.where(
            func.substr(ProjectFile.relative_path, 1, len(prefix)) == prefix
        )
    files = list(database.scalars(statement.order_by(ProjectFile.relative_path)))

    directories: dict[str, dict[str, object]] = {}
    direct_files: list[dict[str, object]] = []
    for project_file in files:
        relative = project_file.relative_path[len(prefix):] if prefix else project_file.relative_path
        child_name, separator, _ = relative.partition("/")
        child_path = f"{prefix}{child_name}" if prefix else child_name
        if separator:
            node = directories.setdefault(
                child_name,
                {
                    "kind": "directory",
                    "name": child_name,
                    "path": child_path,
                    "file_count": 0,
                    "id": None,
                    "extension": None,
                    "language": None,
                    "size_bytes": None,
                    "line_count": None,
                },
            )
            node["file_count"] = int(node["file_count"]) + 1
        else:
            direct_files.append(
                {
                    "kind": "file",
                    "name": child_name,
                    "path": project_file.relative_path,
                    "file_count": 1,
                    "id": project_file.id,
                    "extension": project_file.extension,
                    "language": project_file.language,
                    "size_bytes": project_file.size_bytes,
                    "line_count": project_file.line_count,
                }
            )

    if normalized and not files:
        raise FileNotFoundError(f"Repository directory not found: {normalized}")
    items = sorted(directories.values(), key=lambda item: str(item["name"]).lower())
    items.extend(sorted(direct_files, key=lambda item: str(item["name"]).lower()))
    return {"path": normalized, "total_files": len(files), "items": items}


def json_bytes(value: object) -> bytes:
    """Compact UTF-8 JSON, matching HTTP JSON separators and Unicode encoding."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def distribution(values: list[float], *, unit: str) -> dict:
    """Nearest-rank percentiles (ceil(p*n)-1), preserving all unrounded samples."""
    if not values or any(not math.isfinite(value) or value < 0 for value in values):
        raise ValueError("Samples must be a nonempty list of finite nonnegative values")
    ordered = sorted(values)
    return {
        "unit": unit,
        "samples": values,
        "p50": ordered[math.ceil(0.50 * len(ordered)) - 1],
        "p95": ordered[math.ceil(0.95 * len(ordered)) - 1],
    }


def create_metadata(count: int, *, seed: int = SEED) -> list[dict]:
    """Fixed arithmetic placement; SHA-256 seed controls deterministic metadata.

    10% root files, 65% direct wide files, 20% under the eight-level deep
    directory (half direct, half nested), and the remainder in 17 misc folders.
    Mixed ASCII case and Unicode names exercise the public ordering contract.
    """
    if count < 20:
        raise ValueError("At least 20 synthetic files are required")
    root_count, wide_count, deep_count = count // 10, count * 65 // 100, count // 5
    rows = []
    for index in range(count):
        stem = ("Alpha", "alpha", "Beta", "beta", "zeta", "目录")[index % 6]
        name = f"{stem}_{index:06d}.py"
        if index < root_count:
            path = name
        elif index < root_count + wide_count:
            path = f"wide/{name}"
        elif index < root_count + wide_count + deep_count:
            deep_index = index - root_count - wide_count
            suffix = name if deep_index % 2 == 0 else f"nested_{deep_index % 13:02d}/{name}"
            path = f"{DEEP_DIRECTORY}/{suffix}"
        else:
            path = f"misc/group_{index % 17:02d}/{name}"
        digest = hashlib.sha256(f"{seed}:{index}:{path}".encode()).hexdigest()
        rows.append({
            "id": index + 1,
            "project_id": 1,
            "relative_path": path,
            "extension": ".py",
            "language": "Python",
            "size_bytes": 80 + int(digest[:8], 16) % 16_000,
            "line_count": 1 + int(digest[8:16], 16) % 300,
            "content_hash": digest,
            "modified_time_ns": 1_700_000_000_000_000_000 + index,
        })
    return rows


def corpus_summary(rows: list[dict]) -> dict:
    counts = {}
    for scenario, directory in SCENARIOS.items():
        prefix = f"{directory}/" if directory else ""
        relative = [row["relative_path"][len(prefix):] for row in rows if row["relative_path"].startswith(prefix)]
        counts[scenario] = {
            "directory": directory,
            "recursive_files": len(relative),
            "immediate_files": sum("/" not in path for path in relative),
            "immediate_directories": len({path.partition("/")[0] for path in relative if "/" in path}),
        }
    return {
        "file_count": len(rows),
        "metadata_sha256": hashlib.sha256(json_bytes(rows)).hexdigest(),
        "maximum_path_segments": max(len(row["relative_path"].split("/")) for row in rows),
        "scenario_counts": counts,
    }


def validate_pagination(legacy: dict, fetch_page, *, expected_limit: int = 200) -> dict:
    """Compare every child and count in order, not just a truncated first page."""
    expected_items = legacy["items"]
    items = []
    pages = 0
    offset = 0
    first_page = None
    while True:
        page = fetch_page(offset)
        if first_page is None:
            first_page = page
        assert page["path"] == legacy["path"], "Directory path differs"
        assert page["total_files"] == legacy["total_files"], "Recursive file count differs"
        assert page["total_items"] == len(expected_items), "Immediate child count differs"
        assert len(page["items"]) <= expected_limit, "Page exceeds default limit"
        assert page["items"] == expected_items[offset:offset + expected_limit], "Page items/order/counts differ"
        items.extend(page["items"])
        pages += 1
        expected_more = len(items) < len(expected_items)
        assert page["has_more"] is expected_more, "has_more differs"
        if not expected_more:
            break
        assert page["items"], "Nonterminal page did not advance"
        offset += len(page["items"])
    assert items == expected_items, "Complete pagination differs from legacy result"
    assert sum(item["file_count"] for item in items) == legacy["total_files"], "Child file counts do not sum to total_files"
    return {"passed": True, "pages_checked": pages, "all_items_checked": len(items), "first_page": first_page}


@contextmanager
def isolated_runtime(runtime: Path):
    """Import application services with .env disabled and all settings isolated."""
    from app.core import config

    settings = config.Settings(
        _env_file=None,
        database_url=f"sqlite:///{(runtime / 'bootstrap.db').as_posix()}",
        repository_root=runtime / "repositories",
        temporary_root=runtime / "tmp",
        search_index_root=runtime / "indexes",
        provider_config_path=runtime / "unused-providers.json",
        semantic_search_enabled=False,
    )

    def forbidden_network(*args, **kwargs):
        raise RuntimeError("Network access is forbidden in the file-tree metadata benchmark")

    with patch.object(config, "get_settings", return_value=settings), \
            patch("socket.create_connection", side_effect=forbidden_network), \
            patch("socket.socket.connect", side_effect=forbidden_network):
        from app.core.database import Base
        from app.models.project import Project, ProjectFile
        from app.services.project_service import load_project_file_tree

        yield Base, Project, ProjectFile, load_project_file_tree


def query_once(engine, loader, *, timed: bool = False):
    # A fresh Session prevents identity-map reuse. Checkout and close/rollback
    # are outside the service timer; result construction is inside it.
    gc.collect()
    with Session(engine) as database:
        database.connection()
        started = time.perf_counter_ns() if timed else 0
        result = loader(database)
        elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000 if timed else None
    return result, elapsed_ms


def allocation_peak(engine, loader) -> int:
    gc.collect()
    with Session(engine) as database:
        database.connection()
        tracemalloc.start()
        try:
            result = loader(database)
            _, peak = tracemalloc.get_traced_memory()
            assert result is not None  # Keep the response alive until after sampling.
            return peak
        finally:
            tracemalloc.stop()


def measure_scenario(engine, model, current_loader, directory: str, samples: int, warmups: int, memory_samples: int) -> dict:
    def legacy_loader(database):
        return legacy_load_project_file_tree(database, 1, directory, file_model=model)

    def new_loader(database):
        return current_loader(database, 1, directory)

    legacy, _ = query_once(engine, legacy_loader)

    def fetch_page(offset):
        result, _ = query_once(engine, lambda database: current_loader(database, 1, directory, offset=offset))
        return result

    parity = validate_pagination(legacy, fetch_page)
    first_page = parity.pop("first_page")
    responses = {"legacy_all_children": legacy, "sql_default_page": first_page}
    loaders = {"legacy_all_children": legacy_loader, "sql_default_page": new_loader}
    # Release the verified full response before timing/allocation measurement.
    results = {
        key: {"returned_items": len(response["items"]), "response_bytes": len(json_bytes(response))}
        for key, response in responses.items()
    }
    del responses, legacy, first_page
    for _ in range(warmups):
        for loader in loaders.values():
            query_once(engine, loader)
    timings = {key: [] for key in loaders}
    orders = []
    for iteration in range(samples):
        order = list(loaders) if iteration % 2 == 0 else list(reversed(loaders))
        orders.append(order)
        for key in order:
            _, elapsed = query_once(engine, loaders[key], timed=True)
            timings[key].append(elapsed)
    for key, loader in loaders.items():
        results[key]["query_and_shape"] = distribution(timings[key], unit="ms")
        peaks = [allocation_peak(engine, loader) for _ in range(memory_samples)]
        results[key]["python_allocation_peak"] = distribution(peaks, unit="bytes")
    return {
        "directory": directory,
        "parity": parity,
        "timing_order_by_iteration": orders,
        "implementations": results,
    }


def run_benchmark(*, output: Path, work_dir: Path, samples: int = 11, warmups: int = 2, memory_samples: int = 3, sizes=SIZES) -> dict:
    if not 7 <= samples <= 100:
        raise ValueError("Timing samples must be between 7 and 100")
    if warmups < 1 or memory_samples < 1:
        raise ValueError("At least one warmup and one separate memory sample are required")
    # Restrict runtime data to this checkout's data/tmp even with an explicit flag.
    work_dir = work_dir.resolve()
    if not work_dir.is_relative_to((ROOT / "data/tmp").resolve()):
        raise ValueError("--work-dir must be within this checkout's data/tmp")
    runtime = work_dir / f"run-{uuid.uuid4().hex[:12]}"
    runtime.mkdir(parents=True, exist_ok=False)
    report = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "corpus_version": CORPUS_VERSION,
        "seed": SEED,
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "processor": platform.processor(),
            "sqlite": sqlite3.sqlite_version,
            "sqlalchemy": sqlalchemy.__version__,
        },
        "run_directory": str(runtime),
        "method": {
            "workload": "Synthetic metadata only; no repository source files, scan, import analysis, HTTP server, browser, model, or provider calls",
            "query_timing": "perf_counter_ns around service call only; includes SQL, ORM/row materialization and Python result shaping; excludes Session setup/connection checkout/close, fixture insertion, validation and JSON serialization",
            "cache_state": "Warm SQLite/OS cache; full-pagination parity check and explicit warmups precede timing; OS and SQLite caches are not flushed",
            "session_state": "Fresh SQLAlchemy Session per call; connection is pooled; garbage collection before each call is outside timer",
            "timing_samples_per_implementation": samples,
            "warmup_calls_per_implementation": warmups,
            "timing_order": "Alternating legacy/new then new/legacy on successive iterations",
            "percentile": "Nearest rank: sorted_samples[ceil(percentile * n) - 1]; no interpolation; raw samples preserved",
            "response_bytes": "len(json.dumps(service_result, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')); complete legacy response versus default 200-child page; no headers/compression",
            "memory": "Separate tracemalloc service calls after timings; Python traced allocation peak only, includes live result, excludes interpreter startup and preexisting allocations; not process RSS or SQLite native memory",
            "memory_samples_per_implementation": memory_samples,
            "process_rss": "not_measured",
            "parity": "Before timing each scenario, all new pages are compared with the complete legacy result, including order, every item field, total_files and total_items; child file_count sum also checked",
        },
        "legacy_provenance": {
            "source": "backend/app/services/project_service.py:load_project_file_tree",
            "frozen_before_optimization": "2026-09-12",
            "summary": "SELECT full ProjectFile ORM rows filtered by project/prefix, materialize every descendant, aggregate immediate directories and files in Python, directories-first stable name.lower() sorting, unpaginated result",
            "benchmark_changes": "Renamed helper/normalizer and injected ProjectFile model binding only",
            "frozen_helper_sha256": hashlib.sha256((inspect.getsource(legacy_load_project_file_tree) + inspect.getsource(_normalize_legacy_tree_directory)).encode()).hexdigest(),
        },
        "implementation_hashes": {},
        "projects": [],
    }
    with isolated_runtime(runtime) as (base, project_model, file_model, current_loader):
        for path in (Path(__file__).resolve(), ROOT / "backend/app/services/project_service.py", ROOT / "backend/app/models/project.py"):
            report["implementation_hashes"][path.relative_to(ROOT).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
        for count in sizes:
            database_path = runtime / f"files-{count}.db"
            engine = create_engine(f"sqlite:///{database_path.as_posix()}")
            try:
                base.metadata.create_all(engine)
                rows = create_metadata(count)
                project = corpus_summary(rows)
                with engine.begin() as connection:
                    connection.execute(insert(project_model), [{
                        "id": 1, "name": f"synthetic-{count}", "source_filename": "synthetic-metadata",
                        "storage_path": str(runtime / "no-source-created"), "status": "ready",
                        "file_count": count, "code_line_count": sum(row["line_count"] for row in rows),
                    }])
                    connection.execute(insert(file_model), rows)
                del rows
                project["scenarios"] = {}
                for scenario, directory in SCENARIOS.items():
                    project["scenarios"][scenario] = measure_scenario(engine, file_model, current_loader, directory, samples, warmups, memory_samples)
                    print(f"{count} files / {scenario}: full-pagination parity passed; {samples} timing samples per implementation", flush=True)
                report["projects"].append(project)
            finally:
                engine.dispose()
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(output, flush=True)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, default=ROOT / "data/tmp/file-tree-benchmark")
    parser.add_argument("--samples", type=int, default=11)
    parser.add_argument("--warmups", type=int, default=2)
    parser.add_argument("--memory-samples", type=int, default=3)
    arguments = parser.parse_args()
    if not 7 <= arguments.samples <= 100:
        parser.error("--samples must be between 7 and 100")
    if not 1 <= arguments.warmups <= 20 or not 1 <= arguments.memory_samples <= 10:
        parser.error("--warmups must be 1..20 and --memory-samples must be 1..10")
    try:
        run_benchmark(output=arguments.output, work_dir=arguments.work_dir, samples=arguments.samples, warmups=arguments.warmups, memory_samples=arguments.memory_samples)
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
