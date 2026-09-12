"""Bounded, explainable change-impact analysis for files and code symbols."""

from __future__ import annotations

import math
import re
from collections import defaultdict

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.analysis import CodeSymbol
from app.models.project import ProjectFile
from app.services.code_scope_service import classify_code_scope
from app.services.dependency_graph_service import (
    DependencyGraphSnapshot,
    load_dependency_snapshot,
)
from app.services.impact_reference_resolver import resolve_symbol_relations

MAX_TARGET_RESULTS = 30
MAX_RELATIONS = 24
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
    lowered = normalized.lower()
    symbols = database.execute(
        select(CodeSymbol, ProjectFile.relative_path)
        .join(ProjectFile, ProjectFile.id == CodeSymbol.file_id)
        .where(
            CodeSymbol.project_id == project_id,
            or_(
                CodeSymbol.name.icontains(normalized, autoescape=True),
                CodeSymbol.qualified_name.icontains(normalized, autoescape=True),
                ProjectFile.relative_path.icontains(normalized, autoescape=True),
            ),
        )
        .order_by(
            or_(
                func.lower(CodeSymbol.name) == lowered,
                func.lower(CodeSymbol.qualified_name) == lowered,
            ).desc(),
            or_(
                func.lower(CodeSymbol.name).startswith(lowered, autoescape=True),
                func.lower(CodeSymbol.qualified_name).startswith(lowered, autoescape=True),
            ).desc(),
            func.length(CodeSymbol.qualified_name),
            ProjectFile.relative_path,
            CodeSymbol.id,
        )
        .limit(limit * 2)
    ).all()
    files = list(
        database.scalars(
            select(ProjectFile)
            .where(
                ProjectFile.project_id == project_id,
                ProjectFile.relative_path.icontains(normalized, autoescape=True),
            )
            .order_by(
                (func.lower(ProjectFile.relative_path) == lowered).desc(),
                func.lower(ProjectFile.relative_path).startswith(lowered, autoescape=True).desc(),
                func.length(ProjectFile.relative_path),
                ProjectFile.relative_path,
                ProjectFile.id,
            )
            .limit(limit)
        )
    )
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
    simple_names = {symbol.id: symbol.name.lower() for symbol, _path in symbols}

    def target_order(item: dict[str, object]) -> tuple[bool, bool, bool, int, str]:
        names = [str(item["name"]).lower()]
        if item["target_type"] == "symbol":
            names.append(simple_names[int(item["target_id"])])
        return (
            not any(name == lowered for name in names),
            not any(name.startswith(lowered) for name in names),
            item["target_type"] != "symbol",
            len(str(item["name"])),
            str(item["file_path"]),
        )

    results.sort(key=target_order)
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
    called_symbols: list[dict[str, object]] = []
    if symbol is not None:
        symbol_references, called_symbols = resolve_symbol_relations(database, symbol)
        # A file importing this module need not call the selected symbol.
        direct_callers = _deduplicate_relations_by_file([
            item for item in symbol_references if _is_bound_call(item)
        ])

    dependencies = _outgoing_relations(snapshot, file_id)
    indirect_impacts = _indirect_callers(
        snapshot, file_id,
        direct_file_ids={int(item["file_id"]) for item in direct_callers}
        if symbol is not None else None,
    )
    related_pool = _deduplicate_relations(
        [*direct_callers, *indirect_impacts, *dependencies, *called_symbols]
    )
    related_tests = (
        _verified_test_relations(direct_callers) if symbol is not None else [
            item for item in related_pool
            if classify_code_scope(str(item["file_path"])) == "test"
        ]
    )[:MAX_RELATIONS]
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
        has_symbol_references=bool(direct_callers) if symbol is not None else False,
    )
    recommendations = _build_recommendations(
        target=target,
        direct_callers=direct_callers,
        dependencies=dependencies,
        indirect_impacts=indirect_impacts,
        related_tests=related_tests,
        related_apis=related_apis,
        database_entities=database_entities,
        cycles=cycles,
    )
    return {
        "target": target,
        "definition": _definition_relation(target),
        "risk": risk,
        "direct_callers": direct_callers[:MAX_RELATIONS],
        "called_objects": _deduplicate_relations(
            called_symbols if symbol is not None else dependencies
        )[:MAX_RELATIONS],
        "dependencies": dependencies[:MAX_RELATIONS],
        "indirect_impacts": indirect_impacts[:MAX_RELATIONS],
        "related_tests": related_tests,
        "related_apis": related_apis,
        "database_entities": database_entities,
        "cycles": cycles[:10],
        "recommendations": recommendations,
        "limitations": (
            "文件依赖来自已索引的项目内导入关系；符号调用只核验有界源码中的静态绑定。"
            "动态接收者、重新导出、缺失或超出读取预算的源码可能无法解析；未定位不等于不存在。"
            "模块依赖、二级影响和接口/数据库路径线索不代表目标函数必然触达。"
            "未执行代码或测试；静态测试关联不代表测试通过或实际测试覆盖率，也不是完整运行时调用链。"
        ),
    }


def _build_recommendations(
    *,
    target: dict[str, object],
    direct_callers: list[dict[str, object]],
    dependencies: list[dict[str, object]],
    indirect_impacts: list[dict[str, object]],
    related_tests: list[dict[str, object]],
    related_apis: list[dict[str, object]],
    database_entities: list[dict[str, object]],
    cycles: list[dict[str, object]],
) -> list[dict[str, object]]:
    actions: list[dict[str, object]] = []

    def add(
        code: str,
        priority: str,
        title: str,
        detail: str,
        paths: list[str],
    ) -> None:
        actions.append(
            {
                "code": code,
                "priority": priority,
                "title": title,
                "detail": detail,
                "related_paths": list(dict.fromkeys(paths))[:8],
            }
        )

    verified_tests = _verified_test_relations(related_tests)
    if verified_tests:
        add(
            "run_related_tests",
            "high",
            "优先运行已定位的相关测试",
            "源码中存在与目标静态绑定的调用；先实际运行并核对断言，修改后再次验证。",
            [str(item["file_path"]) for item in verified_tests],
        )
    elif related_tests:
        add(
            "run_related_tests",
            "high",
            "核对测试候选与目标的关系",
            "这些文件只存在模块级关联，尚未证实目标级调用或测试覆盖；请检查断言并实际运行。",
            [str(item["file_path"]) for item in related_tests],
        )
    else:
        add(
            "add_regression_test",
            "high",
            "补充目标级回归测试",
            "当前有界分析未定位到可核验的目标级测试调用，不等于没有测试；请核对并补充成功与失败路径验证。",
            [str(target["file_path"])],
        )
    if direct_callers:
        add(
            "review_direct_callers",
            "high" if len(direct_callers) >= 5 else "medium",
            "逐一检查静态调用者" if target["target_type"] == "symbol" else "检查直接依赖方",
            "确认参数、返回值、异常和副作用契约没有被修改破坏。",
            [str(item["file_path"]) for item in direct_callers],
        )
    if related_apis:
        add(
            "verify_api_contract",
            "high",
            "验证接口兼容性",
            "检查请求参数、响应结构、状态码和错误处理，并执行接口级回归。",
            [str(item["file_path"]) for item in related_apis],
        )
    if database_entities:
        add(
            "verify_data_contract",
            "high",
            "核对数据契约与迁移影响",
            "确认实体字段、查询条件、事务和兼容迁移策略，避免破坏已有数据。",
            [str(item["file_path"]) for item in database_entities],
        )
    if cycles:
        add(
            "verify_dependency_cycle",
            "high",
            "联合验证依赖环中的模块",
            "目标位于循环依赖中，需要按整组模块回归，不能只验证当前文件。",
            [str(path) for cycle in cycles for path in cycle.get("paths", [])],
        )
    if dependencies:
        add(
            "review_dependency_contracts",
            "medium",
            "核对被调用对象的契约",
            "检查目标依赖对象的公开接口、初始化顺序和异常传播方式。",
            [str(item["file_path"]) for item in dependencies],
        )
    if indirect_impacts:
        add(
            "run_module_regression",
            "medium",
            "执行间接影响模块回归",
            "直接验证通过后，再覆盖二级调用链上的关键业务流程。",
            [str(item["file_path"]) for item in indirect_impacts],
        )
    add(
        "reanalyze_and_snapshot",
        "low",
        "修改后重新分析并保存快照",
        "重新执行增量分析，对比质量分、问题、依赖边和影响范围是否出现非预期变化。",
        [str(target["file_path"])],
    )
    priority_order = {"high": 0, "medium": 1, "low": 2}
    return sorted(actions, key=lambda item: priority_order[str(item["priority"])])


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


def _indirect_callers(
    snapshot: DependencyGraphSnapshot, file_id: int, *, direct_file_ids: set[int] | None = None,
) -> list[dict[str, object]]:
    incoming: dict[int, set[int]] = defaultdict(set)
    for source_id, target_id in snapshot.edge_lines:
        incoming[target_id].add(source_id)
    direct = incoming.get(file_id, set()) if direct_file_ids is None else direct_file_ids
    indirect: set[int] = set()
    for caller_id in direct:
        indirect.update(incoming.get(caller_id, set()))
    indirect.difference_update(direct)
    indirect.discard(file_id)
    return [
        _file_relation(snapshot, item, "transitive_caller", "medium", (), depth=2)
        for item in sorted(indirect, key=lambda value: snapshot.files[value].path)
    ]


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
    seen: dict[int, dict[str, object]] = {}
    for item in items:
        file_id = int(item["file_id"])
        if file_id in seen:
            previous = seen[file_id]
            previous["line_numbers"] = sorted(set([
                *previous.get("line_numbers", []), *item.get("line_numbers", []),
            ]))
            continue
        copied = dict(item)
        seen[file_id] = copied
        results.append(copied)
    return results


def _is_bound_call(item: dict[str, object]) -> bool:
    return item.get("relation") == "bound_symbol_call" and item.get("confidence") == "high"


def _verified_test_relations(items: list[dict[str, object]]) -> list[dict[str, object]]:
    return _deduplicate_relations_by_file([
        item for item in items
        if _is_bound_call(item) and classify_code_scope(str(item["file_path"])) == "test"
    ])


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

    test_count = len(_verified_test_relations(related_tests))
    if test_count:
        # Static calls identify places to verify; they do not measure executed
        # tests, assertions, branches, or coverage. Keep this weak credit small.
        test_points = -3 * min(test_count, 2)
        score += test_points
        reasons.append(f"定位到 {test_count} 个存在目标静态调用的测试文件，仍需运行验证")
    else:
        test_points = 8
        score += test_points
        reasons.append("未定位到可核验的目标级测试调用，仍需补充验证")
    factors.append(_risk_factor(
        "test_evidence", "静态测试关联", test_count, 2, "个", test_points,
        "仅有目标绑定调用的测试文件提供有限参考，最多降低 6 分；不代表测试通过或运行覆盖率。",
    ))

    score = max(0, min(100, score))
    level = "high" if score >= 65 else "medium" if score >= 35 else "low"
    confidence = "high" if target_type == "file" else "medium" if has_symbol_references else "low"
    return {
        "model": "evidence_v3",
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
