"""Bounded, explainable change-impact analysis for files and code symbols."""

from __future__ import annotations

import re
import math
from collections import defaultdict

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.analysis import CodeSymbol, SearchChunk
from app.models.project import ProjectFile
from app.services.code_scope_service import classify_code_scope
from app.services.dependency_graph_service import (
    DependencyGraphSnapshot,
    load_dependency_snapshot,
)


MAX_TARGET_RESULTS = 30
MAX_RELATIONS = 24
MAX_REFERENCE_CANDIDATES = 240
IDENTIFIER_PATTERN = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]{2,}")
API_PATH_TERMS = ("api", "route", "router", "controller", "endpoint", "rest", "graphql")
DATABASE_PATH_TERMS = (
    "model", "models", "entity", "entities", "schema", "repository", "dao", "database", "db",
)


class ImpactTargetNotFoundError(LookupError):
    pass


def search_impact_targets(
    database: Session,
    project_id: int,
    query: str,
    limit: int = 20,
) -> list[dict[str, object]]:
    normalized = query.strip()
    if not normalized:
        return []
    pattern = f"%{normalized}%"
    symbols = database.execute(
        select(CodeSymbol, ProjectFile.relative_path)
        .join(ProjectFile, ProjectFile.id == CodeSymbol.file_id)
        .where(
            CodeSymbol.project_id == project_id,
            or_(
                CodeSymbol.name.ilike(pattern),
                CodeSymbol.qualified_name.ilike(pattern),
                ProjectFile.relative_path.ilike(pattern),
            ),
        )
        .limit(limit * 2)
    ).all()
    files = list(
        database.scalars(
            select(ProjectFile)
            .where(
                ProjectFile.project_id == project_id,
                ProjectFile.relative_path.ilike(pattern),
            )
            .limit(limit)
        )
    )
    lowered = normalized.lower()
    results = [
        {
            "target_type": "symbol",
            "target_id": symbol.id,
            "file_id": symbol.file_id,
            "file_path": str(path),
            "name": symbol.qualified_name,
            "kind": symbol.kind,
            "start_line": symbol.start_line,
            "end_line": symbol.end_line,
        }
        for symbol, path in symbols
    ]
    results.extend(
        {
            "target_type": "file",
            "target_id": item.id,
            "file_id": item.id,
            "file_path": item.relative_path,
            "name": item.relative_path,
            "kind": "file",
            "start_line": 1,
            "end_line": max(1, item.line_count),
        }
        for item in files
    )
    results.sort(
        key=lambda item: (
            0 if str(item["name"]).lower() == lowered else 1,
            0 if str(item["name"]).lower().startswith(lowered) else 1,
            0 if item["target_type"] == "symbol" else 1,
            len(str(item["name"])),
            str(item["file_path"]),
        )
    )
    return results[: min(limit, MAX_TARGET_RESULTS)]


def analyze_change_impact(
    database: Session,
    project_id: int,
    target_type: str,
    target_id: int,
) -> dict[str, object]:
    target, symbol = _load_target(database, project_id, target_type, target_id)
    snapshot = load_dependency_snapshot(database, project_id)
    file_id = int(target["file_id"])

    direct_callers = _incoming_relations(snapshot, file_id)
    symbol_references: list[dict[str, object]] = []
    called_symbols: list[dict[str, object]] = []
    if symbol is not None:
        symbol_references = _symbol_references(database, symbol)
        direct_callers = _deduplicate_relations_by_file(
            [*symbol_references, *direct_callers]
        )
        called_symbols = _called_symbol_candidates(database, symbol)

    dependencies = _outgoing_relations(snapshot, file_id)
    indirect_impacts = _indirect_callers(snapshot, file_id)
    related_pool = _deduplicate_relations(
        [*direct_callers, *indirect_impacts, *dependencies, *called_symbols]
    )
    related_tests = [
        item for item in related_pool if classify_code_scope(str(item["file_path"])) == "test"
    ][:MAX_RELATIONS]
    related_apis = [
        item for item in related_pool if _path_contains(str(item["file_path"]), API_PATH_TERMS)
    ][:MAX_RELATIONS]
    database_entities = [
        item for item in related_pool if _path_contains(str(item["file_path"]), DATABASE_PATH_TERMS)
    ][:MAX_RELATIONS]
    cycles = [
        {
            "file_ids": list(cycle),
            "paths": [snapshot.files[item].path for item in cycle],
        }
        for cycle in snapshot.cycles
        if file_id in cycle
    ]
    risk = _risk_summary(
        target_type=target_type,
        target_line_count=int(target["end_line"]) - int(target["start_line"]) + 1,
        project_file_count=len(snapshot.files),
        direct_callers=direct_callers,
        dependencies=dependencies,
        indirect_impacts=indirect_impacts,
        related_tests=related_tests,
        related_apis=related_apis,
        database_entities=database_entities,
        cycles=cycles,
        has_symbol_references=bool(symbol_references),
    )
    return {
        "target": target,
        "definition": _definition_relation(target),
        "risk": risk,
        "direct_callers": direct_callers[:MAX_RELATIONS],
        "called_objects": _deduplicate_relations([*called_symbols, *dependencies])[:MAX_RELATIONS],
        "dependencies": dependencies[:MAX_RELATIONS],
        "indirect_impacts": indirect_impacts[:MAX_RELATIONS],
        "related_tests": related_tests,
        "related_apis": related_apis,
        "database_entities": database_entities,
        "cycles": cycles[:10],
        "limitations": (
            "文件依赖来自解析后的项目内导入关系；函数、方法和类的调用关系来自有界源码引用推断，"
            "不执行代码，也不等同于完整运行时调用链。"
        ),
    }


def _load_target(
    database: Session, project_id: int, target_type: str, target_id: int
) -> tuple[dict[str, object], CodeSymbol | None]:
    if target_type == "file":
        project_file = database.scalar(
            select(ProjectFile).where(
                ProjectFile.project_id == project_id,
                ProjectFile.id == target_id,
            )
        )
        if project_file is None:
            raise ImpactTargetNotFoundError("Impact file target not found.")
        return {
            "target_type": "file",
            "target_id": project_file.id,
            "file_id": project_file.id,
            "file_path": project_file.relative_path,
            "name": project_file.relative_path,
            "kind": "file",
            "start_line": 1,
            "end_line": max(1, project_file.line_count),
        }, None

    if target_type != "symbol":
        raise ImpactTargetNotFoundError("Unknown impact target type.")
    row = database.execute(
        select(CodeSymbol, ProjectFile.relative_path)
        .join(ProjectFile, ProjectFile.id == CodeSymbol.file_id)
        .where(CodeSymbol.project_id == project_id, CodeSymbol.id == target_id)
    ).one_or_none()
    if row is None:
        raise ImpactTargetNotFoundError("Impact symbol target not found.")
    symbol, file_path = row
    return {
        "target_type": "symbol",
        "target_id": symbol.id,
        "file_id": symbol.file_id,
        "file_path": str(file_path),
        "name": symbol.qualified_name,
        "kind": symbol.kind,
        "start_line": symbol.start_line,
        "end_line": symbol.end_line,
    }, symbol


def _incoming_relations(snapshot: DependencyGraphSnapshot, file_id: int) -> list[dict[str, object]]:
    return [
        _file_relation(
            snapshot,
            source_id,
            "imports_target_module",
            "high",
            line_numbers,
        )
        for (source_id, target_id), line_numbers in snapshot.edge_lines.items()
        if target_id == file_id
    ]


def _outgoing_relations(snapshot: DependencyGraphSnapshot, file_id: int) -> list[dict[str, object]]:
    return [
        _file_relation(
            snapshot,
            target_id,
            "target_imports_module",
            "high",
            (),
        )
        for (source_id, target_id), _line_numbers in snapshot.edge_lines.items()
        if source_id == file_id
    ]


def _indirect_callers(snapshot: DependencyGraphSnapshot, file_id: int) -> list[dict[str, object]]:
    incoming: dict[int, set[int]] = defaultdict(set)
    for source_id, target_id in snapshot.edge_lines:
        incoming[target_id].add(source_id)
    direct = incoming.get(file_id, set())
    indirect: set[int] = set()
    for caller_id in direct:
        indirect.update(incoming.get(caller_id, set()))
    indirect.difference_update(direct)
    indirect.discard(file_id)
    return [
        _file_relation(snapshot, item, "transitive_caller", "medium", (), depth=2)
        for item in sorted(indirect, key=lambda value: snapshot.files[value].path)
    ]


def _symbol_references(database: Session, symbol: CodeSymbol) -> list[dict[str, object]]:
    rows = database.execute(
        select(SearchChunk, ProjectFile.relative_path)
        .join(ProjectFile, ProjectFile.id == SearchChunk.file_id)
        .where(
            SearchChunk.project_id == symbol.project_id,
            SearchChunk.content.contains(symbol.name, autoescape=True),
        )
        .limit(MAX_REFERENCE_CANDIDATES)
    ).all()
    boundary = re.compile(rf"(?<![A-Za-z0-9_$]){re.escape(symbol.name)}(?![A-Za-z0-9_$])")
    results: list[dict[str, object]] = []
    for chunk, file_path in rows:
        if chunk.file_id == symbol.file_id and chunk.start_line <= symbol.start_line <= chunk.end_line:
            continue
        match = boundary.search(chunk.content)
        if match is None:
            continue
        line_number = chunk.start_line + chunk.content[: match.start()].count("\n")
        results.append(
            {
                "file_id": chunk.file_id,
                "file_path": str(file_path),
                "relation": "symbol_reference",
                "confidence": "medium",
                "depth": 1,
                "line_numbers": [line_number],
                "symbol_id": None,
                "symbol_name": chunk.symbol_name,
                "symbol_kind": chunk.kind,
                "start_line": chunk.start_line,
                "end_line": chunk.end_line,
            }
        )
        if len(results) >= MAX_RELATIONS:
            break
    return _deduplicate_relations(results)


def _called_symbol_candidates(database: Session, symbol: CodeSymbol) -> list[dict[str, object]]:
    chunk = database.scalar(
        select(SearchChunk)
        .where(
            SearchChunk.project_id == symbol.project_id,
            SearchChunk.file_id == symbol.file_id,
            SearchChunk.start_line <= symbol.start_line,
            SearchChunk.end_line >= symbol.end_line,
        )
        .order_by((SearchChunk.end_line - SearchChunk.start_line), SearchChunk.id)
        .limit(1)
    )
    if chunk is None:
        return []
    identifiers = sorted(set(IDENTIFIER_PATTERN.findall(chunk.content)))
    identifiers = [item for item in identifiers if item != symbol.name][:80]
    if not identifiers:
        return []
    rows = database.execute(
        select(CodeSymbol, ProjectFile.relative_path)
        .join(ProjectFile, ProjectFile.id == CodeSymbol.file_id)
        .where(
            CodeSymbol.project_id == symbol.project_id,
            CodeSymbol.name.in_(identifiers),
            CodeSymbol.id != symbol.id,
        )
        .limit(MAX_RELATIONS * 2)
    ).all()
    return _deduplicate_relations(
        [
            {
                "file_id": candidate.file_id,
                "file_path": str(path),
                "relation": "calls_or_references_symbol",
                "confidence": "low",
                "depth": 1,
                "line_numbers": [],
                "symbol_id": candidate.id,
                "symbol_name": candidate.qualified_name,
                "symbol_kind": candidate.kind,
                "start_line": candidate.start_line,
                "end_line": candidate.end_line,
            }
            for candidate, path in rows
        ]
    )[:MAX_RELATIONS]


def _file_relation(
    snapshot: DependencyGraphSnapshot,
    file_id: int,
    relation: str,
    confidence: str,
    line_numbers: tuple[int, ...],
    *,
    depth: int = 1,
) -> dict[str, object]:
    project_file = snapshot.files[file_id]
    return {
        "file_id": project_file.id,
        "file_path": project_file.path,
        "relation": relation,
        "confidence": confidence,
        "depth": depth,
        "line_numbers": list(line_numbers),
        "symbol_id": None,
        "symbol_name": None,
        "symbol_kind": None,
        "start_line": min(line_numbers) if line_numbers else None,
        "end_line": max(line_numbers) if line_numbers else None,
    }


def _definition_relation(target: dict[str, object]) -> dict[str, object]:
    return {
        "file_id": target["file_id"],
        "file_path": target["file_path"],
        "relation": "definition",
        "confidence": "high",
        "depth": 0,
        "line_numbers": [target["start_line"]],
        "symbol_id": target["target_id"] if target["target_type"] == "symbol" else None,
        "symbol_name": target["name"] if target["target_type"] == "symbol" else None,
        "symbol_kind": target["kind"] if target["target_type"] == "symbol" else None,
        "start_line": target["start_line"],
        "end_line": target["end_line"],
    }


def _deduplicate_relations(items: list[dict[str, object]]) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    seen: set[tuple[object, ...]] = set()
    for item in items:
        key = (item["file_id"], item.get("symbol_id"), item["relation"])
        if key in seen:
            continue
        seen.add(key)
        results.append(item)
    return results


def _deduplicate_relations_by_file(
    items: list[dict[str, object]],
) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    seen: set[int] = set()
    for item in items:
        file_id = int(item["file_id"])
        if file_id in seen:
            continue
        seen.add(file_id)
        results.append(item)
    return results


def _path_contains(path: str, terms: tuple[str, ...]) -> bool:
    segments = re.split(r"[/\\._-]+", path.lower())
    return any(term in segments for term in terms)


def _risk_summary(
    *,
    target_type: str,
    target_line_count: int,
    project_file_count: int,
    direct_callers: list[dict[str, object]],
    dependencies: list[dict[str, object]],
    indirect_impacts: list[dict[str, object]],
    related_tests: list[dict[str, object]],
    related_apis: list[dict[str, object]],
    database_entities: list[dict[str, object]],
    cycles: list[dict[str, object]],
    has_symbol_references: bool,
) -> dict[str, object]:
    score = 8
    reasons: list[str] = []
    factors: list[dict[str, object]] = []

    scope_points = _reference_points(target_line_count, reference=200, maximum=8)
    factors.append(_risk_factor(
        "change_scope", "修改范围", target_line_count, 200, "行", scope_points,
        "修改范围越大，遗漏联动逻辑的可能性越高。",
    ))
    score += scope_points

    direct_points = _reference_points(len(direct_callers), reference=8, maximum=20)
    factors.append(_risk_factor(
        "direct_callers", "直接调用或引用", len(direct_callers), 8, "个", direct_points,
        "达到参考值时计满该项风险。",
    ))
    if direct_callers:
        score += direct_points
        reasons.append(f"存在 {len(direct_callers)} 个直接调用或引用位置")

    dependency_points = _reference_points(len(dependencies), reference=6, maximum=10)
    factors.append(_risk_factor(
        "dependencies", "项目内依赖", len(dependencies), 6, "个", dependency_points,
        "依赖对象越多，修改时需要同步确认的契约越多。",
    ))
    if dependencies:
        score += dependency_points
        reasons.append(f"目标依赖 {len(dependencies)} 个项目内对象")

    indirect_points = _reference_points(len(indirect_impacts), reference=8, maximum=10)
    factors.append(_risk_factor(
        "indirect_impacts", "二级影响模块", len(indirect_impacts), 8, "个", indirect_points,
        "二级反向依赖代表潜在的间接回归范围。",
    ))
    if indirect_impacts:
        score += indirect_points
        reasons.append(f"发现 {len(indirect_impacts)} 个二级影响模块")

    affected_count = len({int(item["file_id"]) for item in [*direct_callers, *indirect_impacts]})
    blast_ratio = round(affected_count / max(1, project_file_count) * 100, 2)
    blast_points = _reference_points(blast_ratio, reference=5, maximum=12)
    factors.append(_risk_factor(
        "blast_radius", "项目影响占比", blast_ratio, 5, "%", blast_points,
        "参考值为影响约 5% 的项目文件，用于结合仓库规模校正影响面。",
    ))
    score += blast_points

    cycle_points = 15 if cycles else 0
    factors.append(_risk_factor(
        "cycles", "循环依赖", len(cycles), 1, "组", cycle_points,
        "进入依赖环会增加修改顺序与回归定位难度。",
    ))
    if cycles:
        score += cycle_points
        reasons.append("目标位于循环依赖中")

    api_points = 8 if related_apis else 0
    factors.append(_risk_factor(
        "api_surface", "接口层触达", len(related_apis), 1, "处", api_points,
        "接口层变化可能影响外部调用方或协议兼容性。",
    ))
    if related_apis:
        score += api_points
        reasons.append("影响范围触及接口或路由层")

    database_points = 10 if database_entities else 0
    factors.append(_risk_factor(
        "database_surface", "数据层触达", len(database_entities), 1, "处", database_points,
        "数据模型或访问层变化可能影响持久化契约。",
    ))
    if database_entities:
        score += database_points
        reasons.append("影响范围触及数据库实体或访问层")

    test_denominator = max(1, len(direct_callers) + len(indirect_impacts))
    test_coverage = round(min(1.0, len(related_tests) / test_denominator) * 100, 1)
    if related_tests:
        test_points = -round(10 * min(1.0, test_coverage / 50))
        score += test_points
        reasons.append(f"定位到 {len(related_tests)} 个相关测试，可用于回归验证")
    else:
        test_points = 8
        score += test_points
        reasons.append("未定位到直接相关测试，修改后需要补充验证")
    factors.append(_risk_factor(
        "test_coverage", "相关测试覆盖", test_coverage, 50, "%", test_points,
        "达到 50% 参考覆盖率时最多降低 10 分；未定位到测试则增加 8 分。",
    ))

    score = max(0, min(100, score))
    level = "high" if score >= 65 else "medium" if score >= 35 else "low"
    confidence = "high" if target_type == "file" else "medium" if has_symbol_references else "low"
    return {
        "model": "reference_v2",
        "base_score": 8,
        "level": level,
        "score": score,
        "confidence": confidence,
        "reasons": reasons,
        "factors": factors,
    }


def _reference_points(actual: float, *, reference: float, maximum: int) -> int:
    """Return bounded logarithmic points that reach maximum at the reference value."""
    if actual <= 0:
        return 0
    ratio = math.log1p(min(actual, reference)) / math.log1p(reference)
    return max(1, round(maximum * ratio))


def _risk_factor(
    key: str,
    label: str,
    actual: float,
    reference: float,
    unit: str,
    contribution: int,
    explanation: str,
) -> dict[str, object]:
    return {
        "key": key,
        "label": label,
        "actual": actual,
        "reference": reference,
        "unit": unit,
        "contribution": contribution,
        "explanation": explanation,
    }
