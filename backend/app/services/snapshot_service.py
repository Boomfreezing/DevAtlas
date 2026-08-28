"""Persistent, source-free analysis snapshots and deterministic comparisons."""

from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.analysis import AnalysisSnapshot, ParseIssue
from app.models.project import Project
from app.services.dependency_graph_service import build_dependency_snapshot, load_dependency_snapshot
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
    payload = _build_payload(database, project, use_runtime_cache=use_runtime_cache)
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
    return {
        "base": _summary(base, base_data),
        "target": _summary(target, target_data),
        "metric_changes": _metric_changes(base_data, target_data),
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
    database: Session, project: Project, *, use_runtime_cache: bool
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
    return {
        "version": 1,
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
        "file_count": project["file_count"],
        "symbol_count": structure["symbol_count"],
        "import_count": structure["import_count"],
        "finding_count": quality["total_findings"],
        "cycle_count": dependency["cycle_count"],
        "parse_issue_count": len(payload["parse_issues"]),
    }


def _metric_changes(base: dict[str, object], target: dict[str, object]) -> list[dict[str, object]]:
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
        {"key": key, "label": label, "base": old, "target": new, "delta": new - old}
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
