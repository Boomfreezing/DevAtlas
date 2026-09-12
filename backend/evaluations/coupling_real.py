"""Offline, locked-source coupling probes; not an exhaustive call-graph benchmark."""

import argparse
import hashlib
import json
import platform
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app import models  # noqa: F401
from app.core.database import Base
from app.models.analysis import CodeSymbol
from app.models.project import ProjectFile
from app.services.impact_analysis_service import analyze_change_impact
from app.services.project_service import create_scanned_project
from evaluations.real_corpus import CORPUS_ROOT, load_manifest, prepare_corpus
from evaluations.repository_qa import ROOT, implementation_source_hashes, source_hashes, source_path

ANNOTATIONS = ROOT / "benchmarks" / "coupling_real"
REPOSITORIES = ("flask", "requests", "express")


def resolve_anchor(root: Path, reference: dict) -> int:
    lines = source_path(root, reference["file_path"]).read_text(encoding="utf-8").splitlines()
    start = 0
    if reference.get("after"):
        scopes = [index for index, line in enumerate(lines) if reference["after"] in line]
        if len(scopes) != 1:
            raise ValueError("Scope anchor must be unique")
        start = scopes[0]
    anchor = reference.get("anchor", "")
    if not anchor.strip():
        raise ValueError("Empty source anchor")
    matches = [index + 1 for index in range(start, len(lines)) if anchor in lines[index]]
    if len(matches) != 1:
        raise ValueError(f"Missing/ambiguous anchor: {reference['file_path']} :: {anchor}")
    return matches[0]


def fingerprints(annotations: Path) -> dict[str, str]:
    values = implementation_source_hashes()
    for name in REPOSITORIES:
        path = annotations / f"{name}.json"
        values[f"coupling_annotations/{name}.json"] = hashlib.sha256(
            path.read_text(encoding="utf-8").encode("utf-8")
        ).hexdigest()
    return values


def load_cases(corpus: Path, annotations: Path = ANNOTATIONS) -> list[dict]:
    cases, seen = [], set()
    for repository in REPOSITORIES:
        items = json.loads((annotations / f"{repository}.json").read_text(encoding="utf-8"))
        for item in items:
            if (not item.get("id") or item["id"] in seen or item["repository"] != repository
                    or item["direction"] not in {"incoming", "outgoing"}
                    or item["expected"] not in {"bound", "not_bound"}
                    or not item.get("reason", "").strip()
                    or not item["target"].get("qualified_name")):
                raise ValueError("Invalid/duplicate coupling probe")
            seen.add(item["id"])
            resolved = {**item}
            for key in ("target", "evidence"):
                resolved[key] = {**item[key], "line": resolve_anchor(corpus / repository, item[key])}
            cases.append(resolved)
    if not cases:
        raise ValueError("Empty coupling probe set")
    return cases


def assess_probe(case: dict, relations: list[dict]) -> dict:
    evidence = case["evidence"]
    matches = [row for row in relations if (
        row["file_path"] == evidence["file_path"] and evidence["line"] in row["line_numbers"]
        and (case["direction"] == "incoming" or not evidence.get("qualified_name")
             or row.get("symbol_name") == evidence["qualified_name"])
    )]
    confirmed = any(row["relation"] == "bound_symbol_call" and row["confidence"] == "high"
                    for row in matches)
    return {"confirmed": confirmed, "passed": confirmed == (case["expected"] == "bound"),
            "matched_relations": matches}


def validate_locations(root: Path, rows: list[dict]) -> list[dict]:
    invalid = []
    for row in rows:
        try:
            lines = source_path(root, row["file_path"]).read_text(encoding="utf-8").splitlines()
            positions = [*row["line_numbers"], row.get("start_line"), row.get("end_line")]
            if any(type(line) is not int or not 1 <= line <= len(lines)
                   for line in positions if line is not None):
                raise ValueError("Out-of-range source position")
        except (ValueError, OSError):
            invalid.append(row)
    return invalid


def summarize(results: list[dict]) -> dict:
    positive = [row for row in results if row["expected"] == "bound"]
    negative = [row for row in results if row["expected"] == "not_bound"]
    return {
        "probes": len(results), "passed": sum(row["passed"] for row in results),
        "positive_probes": len(positive), "positive_confirmed": sum(row.get("confirmed", False) for row in positive),
        "negative_probes": len(negative), "negative_rejected": sum(row["passed"] for row in negative),
        "incorrect_confirmations": sum(row.get("confirmed", False) for row in negative),
        "evaluation_errors": sum(bool(row.get("error")) for row in results),
        "invalid_location_cases": sum(bool(row.get("invalid_locations")) for row in results),
        "failed_ids": [row["id"] for row in results if not row["passed"]],
    }


def run_probes(run_root: Path, corpus: Path, cases: list[dict], annotations: Path = ANNOTATIONS) -> dict:
    """Use a fresh database and index; existing corpus is read-only, never executed."""
    run_root.mkdir(parents=True, exist_ok=False)
    before = fingerprints(annotations)
    source_before = source_hashes(corpus)
    engine = create_engine(f"sqlite:///{(run_root / 'analysis.db').as_posix()}")
    results = []
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as database:
            for repository in dict.fromkeys(row["repository"] for row in cases):
                project = create_scanned_project(
                    database, corpus / repository, f"locked/{repository}", repository,
                    search_index_root=run_root / "indexes",
                )
                reports = {}
                for case in [row for row in cases if row["repository"] == repository]:
                    result = {**case, "passed": False, "confirmed": False}
                    try:
                        target = case["target"]
                        symbols = database.scalars(select(CodeSymbol).join(
                            ProjectFile, ProjectFile.id == CodeSymbol.file_id,
                        ).where(
                            CodeSymbol.project_id == project.id,
                            ProjectFile.relative_path == target["file_path"],
                            CodeSymbol.qualified_name == target["qualified_name"],
                            CodeSymbol.start_line == target["line"],
                        ).limit(2)).all()
                        if len(symbols) != 1:
                            raise ValueError("Target definition not uniquely indexed; probe is not a pass")
                        symbol = symbols[0]
                        if symbol.id not in reports:
                            start = time.perf_counter()
                            report = analyze_change_impact(database, project.id, "symbol", symbol.id)
                            reports[symbol.id] = report, round((time.perf_counter() - start) * 1000, 3)
                        report, elapsed_ms = reports[symbol.id]
                        relations = report["direct_callers" if case["direction"] == "incoming" else "called_objects"]
                        invalid = validate_locations(corpus / repository, relations)
                        result.update(assess_probe(case, relations))
                        result.update({"relations": relations, "risk": report["risk"],
                                       "elapsed_ms": elapsed_ms, "invalid_locations": invalid})
                        result["passed"] = result["passed"] and not invalid
                    except (ValueError, LookupError) as error:
                        result["error"] = str(error)
                    results.append(result)
    finally:
        engine.dispose()
    after = fingerprints(annotations)
    source_after = source_hashes(corpus)
    drift = sorted(key for key in before.keys() | after.keys() if before.get(key) != after.get(key))
    report = {
        "version": "coupling-probes-v1", "generated_at": datetime.now(timezone.utc).isoformat(),
        "annotation_status": "maintainer-authored targeted probes; not exhaustive or independent holdout",
        "metric_scope": "Positive confirmed and negative rejected only at specified file/line pairs; not whole-graph precision/recall",
        "risk_scope": "Scores retained for diagnostics only; no observed defects/runtime tests for risk calibration",
        "python": platform.python_version(), "implementation_hashes": before,
        "implementation_unchanged": not drift, "implementation_changed_paths": drift,
        "source_hashes": source_before, "sources_unchanged": source_before == source_after,
        "results": results, "summary": summarize(results),
        "by_repository": {name: summarize([row for row in results if row["repository"] == name])
                          for name in dict.fromkeys(row["repository"] for row in results)},
    }
    (run_root / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, default=CORPUS_ROOT)
    args = parser.parse_args()
    try:
        suite_hashes = fingerprints(ANNOTATIONS)
        corpus = prepare_corpus(root=args.corpus) / "repos"  # verification only; no download flag
        cases = load_cases(corpus)
        parent = ROOT / "data" / "tmp" / "coupling-runs"
        parent.mkdir(parents=True, exist_ok=True)
        run_root = Path(tempfile.mkdtemp(prefix="run-", dir=parent)) / "evaluation"
        print(f"Results: {run_root}", flush=True)
        report = run_probes(run_root, corpus, cases)
        drift = set(report["implementation_changed_paths"])
        for observed in (report["implementation_hashes"], fingerprints(ANNOTATIONS)):
            drift.update(key for key in suite_hashes.keys() | observed.keys()
                         if suite_hashes.get(key) != observed.get(key))
        report["implementation_changed_paths"] = sorted(drift)
        report["implementation_unchanged"] = not drift
        report["suite_start_hashes"] = suite_hashes
        report["repositories"] = load_manifest()["repositories"]
        (run_root / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report["by_repository"], ensure_ascii=False), flush=True)
        if not report["implementation_unchanged"] or not report["sources_unchanged"]:
            return 3
        return int(bool(report["summary"]["failed_ids"]))
    except (ValueError, OSError) as error:
        parser.error(str(error))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
