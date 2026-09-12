"""Persistent, source-free analysis snapshots and deterministic comparisons."""

from __future__ import annotations

import hashlib
import json
from importlib.metadata import PackageNotFoundError, version

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.analysis import AnalysisSnapshot, ParseIssue
from app.models.project import Project
from app.services import quality_service
from app.services.code_parser import LANGUAGES, PARSER_ANALYSIS_VERSION
from app.services.dependency_graph_service import (
    build_dependency_snapshot,
    load_dependency_snapshot,
)
from app.services.quality_service import build_quality_snapshot, load_quality_snapshot
from app.services.structure_analyzer import load_project_structure_summary

MAX_SNAPSHOTS_PER_PROJECT = 30
MAX_COMPARISON_ITEMS = 100


class SnapshotNotFoundError(LookupError):
    pass


def create_analysis_snapshot(
    database: Session,
    project: Project,
    *,
    label: str | None = None,
    reason: str = "manual",
    use_runtime_cache: bool = True,
) -> dict[str, object]:
    payload = _build_payload(database, project, use_runtime_cache=use_runtime_cache, reason=reason)
    snapshot = AnalysisSnapshot(
        project_id=project.id,
        label=(label or _default_label(reason)).strip()[:120],
        reason=reason,
        data_json=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    )
    database.add(snapshot)
    database.flush()
    _prune_snapshots(database, project.id, keep_id=snapshot.id)
    database.commit()
    database.refresh(snapshot)
    return _summary(snapshot, payload)


def list_analysis_snapshots(database: Session, project_id: int) -> list[dict[str, object]]:
    snapshots = list(
        database.scalars(
            select(AnalysisSnapshot)
            .where(AnalysisSnapshot.project_id == project_id)
            .order_by(AnalysisSnapshot.created_at.desc(), AnalysisSnapshot.id.desc())
        )
    )
    return [_summary(item, _load_payload(item)) for item in snapshots]


def delete_analysis_snapshot(database: Session, project_id: int, snapshot_id: int) -> None:
    snapshot = _get_snapshot(database, project_id, snapshot_id)
    database.delete(snapshot)
    database.commit()


def compare_analysis_snapshots(
    database: Session,
    project_id: int,
    base_id: int,
    target_id: int,
) -> dict[str, object]:
    if base_id == target_id:
        raise ValueError("Choose two different analysis snapshots.")
    base = _get_snapshot(database, project_id, base_id)
    target = _get_snapshot(database, project_id, target_id)
    base_data = _load_payload(base)
    target_data = _load_payload(target)
    warnings = _comparison_warnings(base_data, target_data)
    comparable = not warnings
    return {
        "base": _summary(base, base_data),
        "target": _summary(target, target_data),
        "comparable": comparable,
        "comparison_warnings": warnings,
        "metric_changes": _metric_changes(base_data, target_data, comparable=comparable),
        "quality": _compare_items(
            base_data["quality"]["findings"], target_data["quality"]["findings"]
        ),
        "parse_issues": _compare_items(
            base_data["parse_issues"], target_data["parse_issues"]
        ),
        "cycles": _compare_items(
            base_data["dependency"]["cycles"], target_data["dependency"]["cycles"]
        ),
    }


def _build_payload(
    database: Session, project: Project, *, use_runtime_cache: bool, reason: str
) -> dict[str, object]:
    structure = load_project_structure_summary(database, project.id)
    quality = (
        load_quality_snapshot(database, project.id)
        if use_runtime_cache
        else build_quality_snapshot(database, project.id)
    )
    dependency = (
        load_dependency_snapshot(database, project.id)
        if use_runtime_cache
        else build_dependency_snapshot(database, project.id)
    )
    findings = [
        {
            "key": _finding_key(item),
            "rule_id": item["rule_id"],
            "severity": item["severity"],
            "scope": item["scope"],
            "title": item["title"],
            "file_path": item["file_path"],
            "start_line": item["start_line"],
            "end_line": item["end_line"],
            "metric": item["metric"],
            "threshold": item["threshold"],
        }
        for item in quality["findings"]
    ]
    parse_issues = [
        {
            "key": f"{item.file_path}|{item.message}",
            "file_path": item.file_path,
            "message": item.message,
        }
        for item in database.scalars(
            select(ParseIssue)
            .where(ParseIssue.project_id == project.id)
            .order_by(ParseIssue.file_path, ParseIssue.id)
        )
    ]
    cycles = []
    for cycle in dependency.cycles:
        paths = sorted(dependency.files[file_id].path for file_id in cycle)
        cycles.append({"key": "|".join(paths), "paths": paths})
    context = _analysis_context(quality, parse_issues)
    if reason in {"manual", "incremental"}:
        previous_analysis = database.scalar(
            select(AnalysisSnapshot)
            .where(
                AnalysisSnapshot.project_id == project.id,
                AnalysisSnapshot.reason.in_(["import", "full", "incremental", "sync"]),
            )
            .order_by(AnalysisSnapshot.created_at.desc(), AnalysisSnapshot.id.desc())
            .limit(1)
        )
        previous_context = _load_payload(previous_analysis).get("analysis_context") if previous_analysis else None
        previous_signature = previous_context.get("parser_signature") if isinstance(previous_context, dict) else None
        # Saving is not parsing. Incremental analysis also retains unchanged
        # symbols, so a parser upgrade cannot certify the entire stored index.
        if reason == "manual":
            context["parser_signature"] = previous_signature
            context["parser"] = previous_context.get("parser") if isinstance(previous_context, dict) else None
        elif previous_signature != context["parser_signature"]:
            context["parser_signature"] = None
            context["parser"] = None
    return {
        "version": 2,
        "analysis_context": context,
        "project": {
            "name": project.name,
            "primary_language": project.primary_language,
            "file_count": project.file_count,
            "code_line_count": project.code_line_count,
        },
        "structure": structure,
        "quality": {
            "score": quality["score"],
            "grade": quality["grade"],
            "total_findings": quality["total_findings"],
            "severity_counts": quality["severity_counts"],
            "findings": findings,
        },
        "dependency": {
            "node_count": len(dependency.participating_ids),
            "edge_count": len(dependency.edge_lines),
            "internal_import_count": sum(map(len, dependency.edge_lines.values())),
            "external_import_count": dependency.external_import_count,
            "unresolved_import_count": dependency.unresolved_import_count,
            "cycle_count": len(dependency.cycles),
            "cycles": cycles,
        },
        "parse_issues": parse_issues,
    }


def _summary(snapshot: AnalysisSnapshot, payload: dict[str, object]) -> dict[str, object]:
    project = payload["project"]
    structure = payload["structure"]
    quality = payload["quality"]
    dependency = payload["dependency"]
    return {
        "id": snapshot.id,
        "project_id": snapshot.project_id,
        "label": snapshot.label,
        "reason": snapshot.reason,
        "created_at": snapshot.created_at,
        "score": quality["score"],
        "grade": quality["grade"],
        "score_available": _score_available(payload),
        "file_count": project["file_count"],
        "symbol_count": structure["symbol_count"],
        "import_count": structure["import_count"],
        "finding_count": quality["total_findings"],
        "cycle_count": dependency["cycle_count"],
        "parse_issue_count": len(payload["parse_issues"]),
        "analysis_context": payload.get("analysis_context"),
    }


def _analysis_context(quality: dict, parse_issues: list[dict]) -> dict[str, object]:
    """Persist analysis provenance, never reconstruct it for historical snapshots."""
    scoring = quality["scoring"]
    rule_parameters = {
        name: getattr(quality_service, name)
        for name in (
            "LONG_FUNCTION_LINES", "LARGE_CLASS_LINES", "LARGE_FILE_LINES",
            "TOO_MANY_IMPORTS", "HIGH_FAN_OUT", "QUALITY_SCORING_MODEL",
            "SCOPE_SCORE_WEIGHTS", "BASE_SEVERITY_WEIGHTS", "REFERENCE_PROJECT_SIZE",
            "MAX_RULE_PENALTY", "QUALITY_RULES",
        )
    }
    parser_packages = {}
    for package in ("tree-sitter", "tree-sitter-python", "tree-sitter-typescript"):
        try:
            parser_packages[package] = version(package)
        except PackageNotFoundError:
            parser_packages[package] = "unknown"
    parser_spec = {
        "analysis_version": PARSER_ANALYSIS_VERSION,
        "packages": parser_packages,
        "supported_extensions": sorted(LANGUAGES),
    }
    fingerprint = lambda value: hashlib.sha256(  # noqa: E731
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    return {
        "scoring_model": scoring["model"],
        "rules_signature": fingerprint(rule_parameters),
        "parser_signature": fingerprint(parser_spec),
        "parser": parser_spec,
        "coverage": {
            key: scoring[key]
            for key in (
                "coverage_model", "source_file_count", "parser_supported_file_count",
                "parser_analyzed_file_count", "parser_issue_file_count", "parser_coverage",
                "coverage_level", "applicable_rule_count", "total_rule_count",
            )
        } | {"parse_issue_file_count": len({item["file_path"] for item in parse_issues})},
    }


def _score_available(payload: dict) -> bool | None:
    context = payload.get("analysis_context")
    coverage = context.get("coverage") if isinstance(context, dict) else None
    if not isinstance(coverage, dict):
        return None
    if coverage.get("coverage_level") in {"none", "limited"}:
        return False
    if coverage.get("coverage_model") == quality_service.COVERAGE_MODEL:
        return bool(coverage.get("parser_analyzed_file_count"))
    # Historical extension-only coverage cannot certify usable parser evidence.
    return None


def _comparison_warnings(base: dict, target: dict) -> list[str]:
    left, right = base.get("analysis_context"), target.get("analysis_context")
    required = ("scoring_model", "rules_signature", "parser_signature", "coverage")
    if not isinstance(left, dict) or not isinstance(right, dict) or any(
        not context.get(key) for context in (left, right) for key in required
    ):
        return ["包含未记录完整分析口径的快照（历史快照或解析来源未知）：仅展示观测差异，不判断质量提升或问题已修复。"]
    warnings = []
    if (left["scoring_model"], left["rules_signature"]) != (right["scoring_model"], right["rules_signature"]):
        warnings.append("评分模型或规则参数不同，分数与问题差异不能直接归因于代码修改。")
    if left["parser_signature"] != right["parser_signature"]:
        warnings.append("解析器版本或支持范围不同，符号、依赖与问题数量不可按同一口径比较。")
    left_coverage, right_coverage = left["coverage"], right["coverage"]
    if left_coverage.get("coverage_model") != right_coverage.get("coverage_model"):
        warnings.append("检测覆盖的计算口径不同，语言支持率与实际可用解析比例不能直接比较。")
    coverage_fields = ("parser_coverage", "coverage_level", "applicable_rule_count", "total_rule_count", "parse_issue_file_count")
    if any(left_coverage.get(key) != right_coverage.get(key) for key in coverage_fields):
        warnings.append("解析覆盖程度或解析失败情况不同，未再检出的问题不一定代表已经修复。")
    if not left_coverage.get("source_file_count") or not right_coverage.get("source_file_count"):
        warnings.append("至少一个快照没有可评分的源码，不计算综合质量分的变化。")
    elif _score_available(base) is False or _score_available(target) is False:
        warnings.append("至少一个快照缺少可用的结构解析依据，暂不评级，也不计算综合质量分的变化。")
    return warnings


def _metric_changes(
    base: dict[str, object], target: dict[str, object], *, comparable: bool = True
) -> list[dict[str, object]]:
    fields = (
        ("score", "综合质量分", base["quality"]["score"], target["quality"]["score"]),
        ("files", "文件", base["project"]["file_count"], target["project"]["file_count"]),
        ("symbols", "符号", base["structure"]["symbol_count"], target["structure"]["symbol_count"]),
        ("imports", "导入", base["structure"]["import_count"], target["structure"]["import_count"]),
        ("findings", "质量问题", base["quality"]["total_findings"], target["quality"]["total_findings"]),
        ("cycles", "循环依赖", base["dependency"]["cycle_count"], target["dependency"]["cycle_count"]),
        ("parse_issues", "解析问题", len(base["parse_issues"]), len(target["parse_issues"])),
    )
    return [
        {
            "key": key, "label": label, "base": old, "target": new,
            "delta": new - old if comparable or key == "files" else None,
        }
        for key, label, old, new in fields
    ]


def _compare_items(base_items: list[dict[str, object]], target_items: list[dict[str, object]]) -> dict[str, object]:
    base_by_key = {str(item["key"]): item for item in base_items}
    target_by_key = {str(item["key"]): item for item in target_items}
    new_keys = sorted(target_by_key.keys() - base_by_key.keys())
    fixed_keys = sorted(base_by_key.keys() - target_by_key.keys())
    persistent_keys = sorted(base_by_key.keys() & target_by_key.keys())
    return {
        "new_count": len(new_keys),
        "fixed_count": len(fixed_keys),
        "persistent_count": len(persistent_keys),
        "new_items": [target_by_key[key] for key in new_keys[:MAX_COMPARISON_ITEMS]],
        "fixed_items": [base_by_key[key] for key in fixed_keys[:MAX_COMPARISON_ITEMS]],
        "persistent_items": [target_by_key[key] for key in persistent_keys[:MAX_COMPARISON_ITEMS]],
        "truncated": any(len(keys) > MAX_COMPARISON_ITEMS for keys in (new_keys, fixed_keys, persistent_keys)),
    }


def _finding_key(item: dict[str, object]) -> str:
    return "|".join(
        (
            str(item["rule_id"]),
            str(item["file_path"]),
            str(item["start_line"] or 0),
            str(item["title"]),
        )
    )


def _get_snapshot(database: Session, project_id: int, snapshot_id: int) -> AnalysisSnapshot:
    snapshot = database.scalar(
        select(AnalysisSnapshot).where(
            AnalysisSnapshot.id == snapshot_id,
            AnalysisSnapshot.project_id == project_id,
        )
    )
    if snapshot is None:
        raise SnapshotNotFoundError("Analysis snapshot not found.")
    return snapshot


def _load_payload(snapshot: AnalysisSnapshot) -> dict[str, object]:
    return json.loads(snapshot.data_json)


def _default_label(reason: str) -> str:
    labels = {"full": "全量分析", "incremental": "增量分析", "import": "首次导入"}
    return labels.get(reason, "手动快照")


def _prune_snapshots(database: Session, project_id: int, keep_id: int) -> None:
    ids = list(
        database.scalars(
            select(AnalysisSnapshot.id)
            .where(AnalysisSnapshot.project_id == project_id)
            .order_by(AnalysisSnapshot.created_at.desc(), AnalysisSnapshot.id.desc())
        )
    )
    expired = [snapshot_id for snapshot_id in ids[MAX_SNAPSHOTS_PER_PROJECT:] if snapshot_id != keep_id]
    if expired:
        database.execute(delete(AnalysisSnapshot).where(AnalysisSnapshot.id.in_(expired)))
