"""Reproducible source-evidence evaluation; generation is explicit and opt-in."""

import argparse
import hashlib
import json
import math
import platform
import shutil
import tempfile
import time
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app import models  # noqa: F401
from app.core.config import Settings
from app.core.database import Base
from app.models.analysis import SearchChunk
from app.services.code_scope_service import classify_code_scope
from app.services.project_service import create_scanned_project
from app.services.report_provider_service import ReportProviderError, list_report_providers
from app.services.repository_qa_service import (
    MAX_EVIDENCE_CHARS,
    _public_citation,
    answer_repository_question,
    retrieve_repository_evidence,
)
from app.services.semantic_search_service import build_project_semantic_index
from evaluations.local_embeddings import local_embeddings

ROOT = Path(__file__).resolve().parents[2]
DATASET_ROOT = ROOT / "benchmarks" / "repository_qa"
IMPLEMENTATION_FINGERPRINT_VERSION = 2
IMPLEMENTATION_FINGERPRINT_SCOPE = (
    "backend/app/**/*.py",
    "backend/evaluations/**/*.py",
    "benchmarks/repository_qa/cases.json",
    "benchmarks/repository_qa/sources.json",
    "benchmarks/repository_qa_real/cases.json",
    "benchmarks/repository_qa_real/repositories.json",
)


def implementation_source_hashes() -> dict[str, str]:
    """Fingerprint transitive source and annotation inputs, excluding credentials/run data.

    Enumerate application/evaluation sources again so additions and deletions count
    as drift too. Dataset inputs are explicit: baseline/recheck JSON reports in
    those directories are outputs and must not fingerprint themselves. All
    tracked text uses the same universal-newline/LF normalization across platforms.
    This is a working-source fingerprint, not a hash of installed dependencies.
    """
    paths = {
        path
        for pattern in IMPLEMENTATION_FINGERPRINT_SCOPE
        for path in ROOT.glob(pattern)
        if path.is_file()
    }
    return {
        path.relative_to(ROOT).as_posix(): hashlib.sha256(
            path.read_text(encoding="utf-8").encode("utf-8")
        ).hexdigest()
        for path in sorted(paths, key=lambda item: item.relative_to(ROOT).as_posix())
    }


def changed_implementation_paths(before: dict[str, str], after: dict[str, str]) -> list[str]:
    return sorted(path for path in before.keys() | after.keys() if before.get(path) != after.get(path))


def source_path(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f"Invalid fixture path: {relative}")
    return path


def source_hashes(root: Path) -> dict[str, str]:
    # Canonical LF makes Windows/Linux checkouts comparable.
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(
            path.read_text(encoding="utf-8").encode("utf-8")
        ).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def load_dataset(root: Path = DATASET_ROOT) -> dict:
    dataset = json.loads((root / "cases.json").read_text(encoding="utf-8"))
    actual_hashes = source_hashes(root / "repos")
    locked = json.loads((root / "sources.json").read_text(encoding="utf-8"))
    if actual_hashes != locked:
        raise ValueError("Fixture source hashes changed; review annotations and source lock together.")
    validate_annotations(dataset, root / "repos")
    return {**dataset, "source_hashes": actual_hashes}


def validate_annotations(dataset: dict, repositories: Path) -> None:
    seen = set()
    for case in dataset["cases"]:
        if case["id"] in seen:
            raise ValueError(f"Duplicate case: {case['id']}")
        seen.add(case["id"])
        if case["expected_behavior"] not in {"evidence", "insufficient", "project_context"}:
            raise ValueError(f"Unknown expected behavior: {case['id']}")
        if bool(case["expected_evidence"]) != (case["expected_behavior"] == "evidence"):
            raise ValueError(f"Invalid evidence annotation: {case['id']}")
        repository_root = (repositories / case["repository"]).resolve()
        if not repository_root.is_relative_to(repositories.resolve()):
            raise ValueError("Fixture repository escapes dataset")
        for expected in case["expected_evidence"]:
            lines = source_path(repository_root, expected["file_path"]).read_text(
                encoding="utf-8"
            ).splitlines()
            start, end = expected["start_line"], expected["end_line"]
            if not 1 <= start <= end <= len(lines):
                raise ValueError(f"Invalid annotated lines: {case['id']}")
            excerpt = "\n".join(lines[start - 1:end])
            if not expected["contains"] or not all(
                anchor in excerpt for anchor in expected["contains"]
            ):
                raise ValueError(f"Annotation text drift: {case['id']}")


def evidence_matches(citation: dict, expected: dict) -> bool:
    return (
        citation["file_path"] == expected["file_path"]
        and citation["start_line"] <= expected["start_line"]
        and citation["end_line"] >= expected["end_line"]
        and all(anchor in citation["snippet"] for anchor in expected["contains"])
    )


def citation_is_valid(root: Path, citation: dict) -> bool:
    try:
        lines = source_path(root, citation["file_path"]).read_text(encoding="utf-8").splitlines()
        start, end = citation["start_line"], citation["end_line"]
        return (
            1 <= start <= end <= len(lines)
            and citation["snippet"] == "\n".join(lines[start - 1:end])[:MAX_EVIDENCE_CHARS]
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False


def score_case(case: dict, citations: list[dict], behavior: str, repository_root: Path) -> dict:
    expected = case["expected_evidence"]
    hit_ranks = [
        next((rank for rank, item in enumerate(citations, 1) if evidence_matches(item, ref)), None)
        for ref in expected
    ]
    missing = [ref for ref, rank in zip(expected, hit_ranks, strict=True) if rank is None or rank > 5]
    invalid = [index for index, item in enumerate(citations, 1) if not citation_is_valid(repository_root, item)]
    first_rank = min((rank for rank in hit_ranks if rank is not None), default=None)
    noise_first = (
        case["category"] == "location"
        and bool(citations)
        and classify_code_scope(citations[0]["file_path"]) != "production"
    )
    passed = behavior == case["expected_behavior"] and not missing and not invalid and not noise_first
    return {
        "retrieval_pass": passed,
        "actual_behavior": behavior,
        "evidence_recall_at_5": round((len(expected) - len(missing)) / len(expected), 4) if expected else None,
        "reciprocal_rank": 1 / first_rank if first_rank else (0 if expected else None),
        "missing_evidence_at_5": missing,
        "invalid_citation_indices": invalid,
        "noise_ranked_first": noise_first,
    }


def summarize(rows: list[dict]) -> dict:
    evidence_rows = [row for row in rows if row["expected_behavior"] == "evidence"]
    unknown = [row for row in rows if row["expected_behavior"] == "insufficient"]
    durations = sorted(row["elapsed_ms"] for row in rows)

    def average(key: str) -> float | None:
        return round(sum(row[key] for row in evidence_rows) / len(evidence_rows), 4) if evidence_rows else None

    return {
        "cases": len(rows),
        "retrieval_passed": sum(row["retrieval_pass"] for row in rows),
        "failed_ids": [row["id"] for row in rows if not row["retrieval_pass"]],
        "answerable_cases": len(evidence_rows),
        "mean_evidence_recall_at_5": average("evidence_recall_at_5"),
        "mean_reciprocal_rank": average("reciprocal_rank"),
        "insufficient_correct": sum(row["actual_behavior"] == "insufficient" for row in unknown),
        "insufficient_cases": len(unknown),
        "citations": sum(len(row["citations"]) for row in rows),
        "invalid_citations": sum(len(row["invalid_citation_indices"]) for row in rows),
        "elapsed_p50_ms": durations[math.ceil(len(durations) * 0.5) - 1] if durations else None,
        "elapsed_p95_ms": durations[math.ceil(len(durations) * 0.95) - 1] if durations else None,
        "model_errors": sum("model_error" in row for row in rows),
        "reference_failed_cases": sum(row.get("grounding_status") == "reference_failed" for row in rows),
        "answer_quality": "not_measured" if not any("answer" in row for row in rows) else "pending_human_review",
    }


def run_evaluation(
    run_root: Path,
    dataset: dict,
    *,
    dataset_root: Path = DATASET_ROOT,
    provider: str | None = None,
    provider_config: Path | None = None,
    retrieval_mode: str = "production",
    embedding_model_dir: Path | None = None,
    generated_history: bool = False,
) -> dict:
    """Run against an isolated database and copied fixture sources, never daily projects."""
    run_root.mkdir(parents=True, exist_ok=True)
    implementation_hashes = implementation_source_hashes()
    if generated_history and not provider:
        raise ValueError("Generated history requires an explicitly selected provider")
    settings = Settings(
        _env_file=None,
        database_url="sqlite:///:memory:",
        repository_root=run_root / "repositories",
        temporary_root=run_root / "tmp",
        search_index_root=run_root / "indexes",
        provider_config_path=provider_config.resolve() if provider_config else run_root / "unused-providers.json",
        semantic_search_enabled=embedding_model_dir is not None,
    )
    provider_metadata = None
    if provider:
        provider_metadata = next(
            (item for item in list_report_providers(settings) if item["id"] == provider and item["id"] != "local"),
            None,
        )
        if not provider_metadata or not provider_metadata["configured"]:
            raise ValueError("Requested generation provider is not configured.")
    engine = create_engine(settings.database_url)
    rows = []
    try:
        Base.metadata.create_all(engine)
        with ExitStack() as runtimes, Session(engine, expire_on_commit=False) as database:
            embedding_metadata = runtimes.enter_context(local_embeddings(
                embedding_model_dir, settings.search_index_root
            )) if embedding_model_dir else None
            projects = {}
            coverage = {}
            conversation_turns = {}
            for name in sorted({case["repository"] for case in dataset["cases"]}):
                target = settings.repository_root / name
                shutil.copytree(dataset_root / "repos" / name, target)
                projects[name] = create_scanned_project(
                    database, target, dataset.get("source_urls", {}).get(name, f"synthetic-fixture/{name}"), name,
                    search_index_root=settings.search_index_root,
                )
                project = projects[name]
                chunks = database.scalar(select(func.count(SearchChunk.id)).where(SearchChunk.project_id == project.id))
                semantic_chunks = build_project_semantic_index(database, project, settings.search_index_root) if embedding_model_dir else 0
                if embedding_model_dir and chunks and not semantic_chunks:
                    raise ValueError("Semantic index is empty; experiment cannot silently fall back")
                coverage[name] = {"indexed_chunks": chunks, "semantic_chunks": semantic_chunks}
            for case in dataset["cases"]:
                project = projects[case["repository"]]
                started = time.perf_counter()
                extra = {}
                history = case.get("history")
                if generated_history and case.get("follow_up_to"):
                    parent_id = case["follow_up_to"]
                    if parent_id not in conversation_turns:
                        raise ValueError("Generated follow-up requires a preceding successful model turn")
                    history = conversation_turns[parent_id][-6:]
                if provider:
                    try:
                        result = answer_repository_question(
                            database, settings, project, case["question"], provider, history,
                            retrieval_mode=retrieval_mode,
                        )
                        citations = result["citations"]
                        status = result["grounding_status"]
                        behavior = status if status in {"project_context", "insufficient"} else "evidence"
                        extra = {
                            "answer": result["answer"],
                            "grounding_status": status,
                            "reference_count": result["reference_count"],
                            "manual_review": {
                                "facts_supported_by_cited_text": None,
                                "expected_facts_complete": None,
                                "appropriate_uncertainty_or_refusal": None,
                                "reviewer": None,
                                "notes": "Valid reference numbers alone do not prove factual support.",
                                "fact_reviews": [{"expected_fact": fact, "supported": None,
                                                  "supporting_citation_indices": [], "notes": ""}
                                                 for fact in case.get("expected_facts", [])],
                                "unsupported_claims": None,
                            },
                        }
                        conversation_turns[case["id"]] = [*(history or []),
                            {"role": "user", "content": case["question"]},
                            {"role": "assistant", "content": result["answer"]}]
                    except ReportProviderError:
                        citations, behavior = [], "model_error"
                        extra = {"model_error": "Generation failed; inspect provider connectivity separately."}
                else:
                    result = retrieve_repository_evidence(
                        database, settings, project, case["question"], history,
                        retrieval_mode=retrieval_mode,
                    )
                    citations = [_public_citation(item) for item in result.citations]
                    behavior = (
                        "project_context" if result.intents[0] in {"greeting", "help", "project_meta"}
                        else "evidence" if citations else "insufficient"
                    )
                elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
                rows.append({
                    **case,
                    **score_case(case, citations, behavior, Path(project.storage_path)),
                    "citations": citations,
                    "elapsed_ms": elapsed_ms,
                    "evidence_characters": sum(len(item["snippet"]) for item in citations),
                    "history_used": history or [],
                    **extra,
                })
    finally:
        engine.dispose()
    implementation_changes = changed_implementation_paths(
        implementation_hashes, implementation_source_hashes(),
    )
    return {
        "dataset_version": dataset["version"],
        "cases_sha256": hashlib.sha256(json.dumps(dataset["cases"], sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
        "source_hashes": dataset["source_hashes"],
        "implementation_fingerprint_version": IMPLEMENTATION_FINGERPRINT_VERSION,
        "implementation_fingerprint_scope": list(IMPLEMENTATION_FINGERPRINT_SCOPE),
        "implementation_hashes": implementation_hashes,
        "implementation_unchanged_during_run": not implementation_changes,
        "implementation_changed_paths": implementation_changes,
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "python": platform.python_version(),
        "mode": "model" if provider else "retrieval_only",
        "semantic_search_enabled": embedding_model_dir is not None,
        "retrieval_mode": retrieval_mode,
        "embedding": embedding_metadata,
        "index_coverage": coverage,
        "corpus_kind": dataset.get("corpus_kind", "synthetic"),
        "provider": {"id": provider, "model": provider_metadata["model"]} if provider_metadata else None,
        "history_mode": "preceding generated answers" if generated_history else "fixed annotated context, not end-to-end generated conversations",
        "timing_scope": "per question; excludes import, sequential run with warm index cache",
        "summary": summarize(rows),
        "results": rows,
    }


def render_markdown(report: dict) -> str:
    summary = report["summary"]
    lines = [
        "# 智能问答评测结果", "",
        f"模式：`{report['mode']}`；数据集：`{report['dataset_version']}`；时间：{report['measured_at']}", "",
        "自建合成样例，非真实大型仓库。默认关闭语义模型，不下载模型、不调用生成 API。",
        "检索通过不等于回答正确；引用路径/行号合法也不等于该引用支持模型的结论。", "",
        f"- 检索/路由通过：{summary['retrieval_passed']}/{summary['cases']}",
        f"- 必要证据 Recall@5（按题平均）：{summary['mean_evidence_recall_at_5']}",
        f"- MRR：{summary['mean_reciprocal_rank']}",
        f"- 无证据拦截：{summary['insufficient_correct']}/{summary['insufficient_cases']}",
        f"- 不合法引用：{summary['invalid_citations']}/{summary['citations']}",
        f"- 题目耗时 P50/P95：{summary['elapsed_p50_ms']} / {summary['elapsed_p95_ms']} ms（不含导入）",
        f"- 真实回答质量：{summary['answer_quality']}", "",
        "| 问题 ID | 类型 | 检索检查 | Recall@5 | 耗时 ms |", "| --- | --- | --- | --- | --- |",
    ]
    for row in report["results"]:
        lines.append(f"| {row['id']} | {row['category']} | {'PASS' if row['retrieval_pass'] else 'FAIL'} | {row['evidence_recall_at_5']} | {row['elapsed_ms']} |")
    if not report.get("implementation_unchanged_during_run", True):
        lines.extend(["", "**实现或题库在评测期间发生变化，结果不可作为固定实现的验收依据；检索分数保留供诊断。**"])
    lines.extend(["", "## 未通过题目", ""])
    for row in report["results"]:
        if row["retrieval_pass"]:
            continue
        missing = ", ".join(f"{ref['file_path']}:{ref['start_line']}-{ref['end_line']}" for ref in row["missing_evidence_at_5"])
        lines.extend([
            f"- **{row['id']}**：{row['question']}",
            f"  - 期望/实际：{row['expected_behavior']} / {row['actual_behavior']}",
            f"  - 缺少证据：{missing or '无'}；错误优先级：{row['noise_ranked_first']}；非法引用：{row['invalid_citation_indices']}",
        ])
    if not summary["failed_ids"]:
        lines.append("无。仅表示当前合成样例的检索与路由检查通过。")
    lines.extend(["", "逐题源码证据、预期事实及人工复核字段见同目录 result.json。", ""])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", help="Optional configured generation provider ID")
    parser.add_argument("--provider-config", type=Path, help="Explicit provider config; never recorded in results")
    parser.add_argument("--allow-model-calls", action="store_true", help="Allow sending synthetic fixture evidence; may incur API fees")
    parser.add_argument("--case", action="append", dest="case_ids", help="Run selected case IDs (repeatable)")
    args = parser.parse_args()
    if args.provider and not (args.allow_model_calls and args.provider_config and args.provider_config.is_file()):
        parser.error("Model evaluation requires --allow-model-calls and an existing --provider-config.")
    if not args.provider and (args.allow_model_calls or args.provider_config):
        parser.error("Select --provider to enable model evaluation.")
    dataset = load_dataset()
    if args.case_ids:
        known = {case["id"] for case in dataset["cases"]}
        if set(args.case_ids) - known:
            parser.error("Unknown case ID")
        dataset["cases"] = [case for case in dataset["cases"] if case["id"] in args.case_ids]
    parent = ROOT / "data" / "tmp" / "qa-eval"
    parent.mkdir(parents=True, exist_ok=True)
    run_root = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    try:
        report = run_evaluation(run_root, dataset, provider=args.provider, provider_config=args.provider_config)
    except ValueError as error:
        parser.error(str(error))
    (run_root / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_root / "result.md").write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    print(f"Results: {run_root / 'result.md'}")
    summary = report["summary"]
    if not report["implementation_unchanged_during_run"]:
        print("Implementation drift detected; scores are diagnostic only. Freeze inputs and rerun.")
        return 3
    return 1 if summary["failed_ids"] or summary["model_errors"] or summary["reference_failed_cases"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
