import math
import time
from collections import Counter, defaultdict
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.analysis import CodeSymbol, ImportRelation
from app.models.project import ProjectFile
from app.services.analysis_cache import get_or_create_project_analysis
from app.services.code_parser import supports_extension
from app.services.code_scope_service import CODE_SCOPES, classify_code_scope, code_scope_label
from app.services.dependency_graph_service import find_cycles

LONG_FUNCTION_LINES = 80
LARGE_CLASS_LINES = 500
LARGE_FILE_LINES = 1_000
TOO_MANY_IMPORTS = 25
HIGH_FAN_OUT = 10
QUALITY_SCORING_MODEL = "size_normalized_v2"
COMPOSITE_SCORING_MODEL = "source_scope_weighted_size_normalized_v4"
SCOPE_SCORE_WEIGHTS = {"production": 0.70, "test": 0.20, "generated": 0.10}
BASE_SEVERITY_WEIGHTS = {"error": 8.0, "warning": 3.0, "info": 1.0}
REFERENCE_PROJECT_SIZE = {"files": 50, "code_lines": 10_000, "symbols": 500}
MAX_RULE_PENALTY = 20.0
QUALITY_CACHE_NAMESPACE = "quality_report_v3"

QUALITY_RULES = [
    {
        "id": "LONG_FUNCTION",
        "title": "超长函数",
        "description": "函数或方法过长，通常承担了过多职责。",
        "default_severity": "warning",
    },
    {
        "id": "LARGE_CLASS",
        "title": "超大类",
        "description": "类或接口跨度过大，维护和测试成本较高。",
        "default_severity": "warning",
    },
    {
        "id": "LARGE_FILE",
        "title": "超大文件",
        "description": "单个源文件代码行数过高，可能需要按职责拆分。",
        "default_severity": "warning",
    },
    {
        "id": "TOO_MANY_IMPORTS",
        "title": "导入过多",
        "description": "文件依赖的模块数量过多，耦合度和变更风险较高。",
        "default_severity": "warning",
    },
    {
        "id": "HIGH_FAN_OUT",
        "title": "高扇出模块",
        "description": "模块直接依赖过多项目内文件，可能成为架构耦合点。",
        "default_severity": "warning",
    },
    {
        "id": "CIRCULAR_DEPENDENCY",
        "title": "循环依赖",
        "description": "多个模块形成强连通依赖环，初始化顺序和重构会更困难。",
        "default_severity": "error",
    },
]


def _build_quality_report_snapshot(
    database: Session, project_id: int
) -> dict[str, object]:
    files = list(
        database.scalars(
            select(ProjectFile)
            .where(ProjectFile.project_id == project_id)
            .order_by(ProjectFile.relative_path)
        )
    )
    file_by_id = {item.id: item for item in files}
    source_files = [item for item in files if item.language is not None]
    parser_supported_files = [
        item for item in source_files if supports_extension(item.extension)
    ]
    symbols = list(
        database.scalars(
            select(CodeSymbol)
            .where(CodeSymbol.project_id == project_id)
            .order_by(CodeSymbol.file_id, CodeSymbol.start_line)
        )
    )
    imports = list(
        database.scalars(
            select(ImportRelation)
            .where(ImportRelation.project_id == project_id)
            .order_by(ImportRelation.file_id, ImportRelation.line_number)
        )
    )
    findings: list[dict[str, object]] = []

    for project_file in source_files:
        if project_file.line_count > LARGE_FILE_LINES:
            findings.append(
                _finding(
                    "LARGE_FILE",
                    _severity(project_file.line_count, LARGE_FILE_LINES, 3),
                    project_file,
                    1,
                    project_file.line_count,
                    project_file.line_count,
                    LARGE_FILE_LINES,
                    f"文件包含 {project_file.line_count} 行代码。",
                    "按业务职责拆分文件，并将可复用逻辑提取到独立模块。",
                )
            )

    for symbol in symbols:
        line_count = symbol.end_line - symbol.start_line + 1
        project_file = file_by_id.get(symbol.file_id)
        if project_file is None:
            continue
        if symbol.kind in {"function", "method"} and line_count > LONG_FUNCTION_LINES:
            finding = _finding(
                "LONG_FUNCTION",
                _severity(line_count, LONG_FUNCTION_LINES, 2),
                project_file,
                symbol.start_line,
                symbol.end_line,
                line_count,
                LONG_FUNCTION_LINES,
                f"{symbol.qualified_name} 包含 {line_count} 行代码。",
                "拆分为职责单一的辅助函数，并为分支逻辑补充单元测试。",
            )
            finding["id"] += f":{symbol.id}"
            findings.append(finding)
        if symbol.kind in {"class", "interface"} and line_count > LARGE_CLASS_LINES:
            finding = _finding(
                "LARGE_CLASS",
                _severity(line_count, LARGE_CLASS_LINES, 2),
                project_file,
                symbol.start_line,
                symbol.end_line,
                line_count,
                LARGE_CLASS_LINES,
                f"{symbol.qualified_name} 跨越 {line_count} 行。",
                "按领域职责拆分类，并优先将无状态逻辑提取为独立服务。",
            )
            finding["id"] += f":{symbol.id}"
            findings.append(finding)

    imports_by_file: dict[int, list[ImportRelation]] = defaultdict(list)
    internal_targets: dict[int, set[int]] = defaultdict(set)
    edge_lines: dict[tuple[int, int], list[int]] = defaultdict(list)
    for relation in imports:
        imports_by_file[relation.file_id].append(relation)
        if relation.resolved_file_id is not None and relation.resolved_file_id in file_by_id:
            internal_targets[relation.file_id].add(relation.resolved_file_id)
            edge_lines[(relation.file_id, relation.resolved_file_id)].append(relation.line_number)

    for file_id, file_imports in imports_by_file.items():
        project_file = file_by_id.get(file_id)
        if project_file is None:
            continue
        if len(file_imports) > TOO_MANY_IMPORTS:
            findings.append(
                _finding(
                    "TOO_MANY_IMPORTS",
                    _severity(len(file_imports), TOO_MANY_IMPORTS, 2),
                    project_file,
                    min(item.line_number for item in file_imports),
                    max(item.line_number for item in file_imports),
                    len(file_imports),
                    TOO_MANY_IMPORTS,
                    f"文件包含 {len(file_imports)} 条导入语句。",
                    "合并重复导入，并重新检查该文件是否承担了过多职责。",
                )
            )
        target_count = len(internal_targets[file_id])
        if target_count > HIGH_FAN_OUT:
            findings.append(
                _finding(
                    "HIGH_FAN_OUT",
                    _severity(target_count, HIGH_FAN_OUT, 2),
                    project_file,
                    min(item.line_number for item in file_imports),
                    max(item.line_number for item in file_imports),
                    target_count,
                    HIGH_FAN_OUT,
                    f"文件直接依赖 {target_count} 个项目内模块。",
                    "引入更稳定的门面或领域接口，减少跨层直接依赖。",
                )
            )

    cycles = find_cycles(
        {file_id for edge in edge_lines for file_id in edge}, set(edge_lines)
    )
    for cycle_index, cycle in enumerate(cycles, start=1):
        cycle_set = set(cycle)
        cycle_edges = [
            (edge, lines)
            for edge, lines in edge_lines.items()
            if edge[0] in cycle_set and edge[1] in cycle_set
        ]
        first_edge, first_lines = min(cycle_edges, key=lambda item: min(item[1]))
        project_file = file_by_id[first_edge[0]]
        paths = [file_by_id[file_id].relative_path for file_id in cycle]
        finding = _finding(
            "CIRCULAR_DEPENDENCY",
            "error",
            project_file,
            min(first_lines),
            min(first_lines),
            len(cycle),
            0,
            "依赖环：" + " → ".join([*paths, paths[0]]),
            "提取公共抽象或反转其中一条依赖，使模块关系重新变为有向无环图。",
        )
        finding["id"] += f":{cycle_index}"
        findings.append(finding)

    severity_order = {"error": 0, "warning": 1, "info": 2}
    findings.sort(
        key=lambda item: (
            severity_order[str(item["severity"])],
            str(item["file_path"]),
            int(item["start_line"] or 0),
            str(item["rule_id"]),
        )
    )
    severity_counts = Counter(str(item["severity"]) for item in findings)
    rule_counts = Counter(str(item["rule_id"]) for item in findings)
    files_by_scope: dict[str, list[ProjectFile]] = {
        scope: [] for scope in CODE_SCOPES
    }
    file_scope_by_id: dict[int, str] = {}
    for project_file in source_files:
        file_scope = classify_code_scope(project_file.relative_path)
        files_by_scope[file_scope].append(project_file)
        if project_file.id is not None:
            file_scope_by_id[project_file.id] = file_scope

    symbol_counts_by_scope = Counter(
        file_scope_by_id[symbol.file_id]
        for symbol in symbols
        if symbol.file_id in file_scope_by_id
    )
    findings_by_scope = {
        scope: [item for item in findings if item["scope"] == scope]
        for scope in CODE_SCOPES
    }
    scope_scores: dict[str, dict[str, object]] = {}
    available_weight = sum(
        SCOPE_SCORE_WEIGHTS[scope] for scope in CODE_SCOPES if files_by_scope[scope]
    )
    for scope in CODE_SCOPES:
        scoped_findings = findings_by_scope[scope]
        scoped_files = files_by_scope[scope]
        available = bool(scoped_files)
        if available:
            scoped_score, scoped_scoring = _quality_score(
                scoped_findings,
                file_count=len(scoped_files),
                code_line_count=sum(item.line_count for item in scoped_files),
                symbol_count=symbol_counts_by_scope[scope],
            )
            scoped_grade: str | None = _grade(scoped_score)
            effective_weight = SCOPE_SCORE_WEIGHTS[scope] / available_weight
        else:
            scoped_score = None
            scoped_grade = None
            effective_weight = 0.0
        scoped_severity_counts = Counter(str(item["severity"]) for item in scoped_findings)
        scope_scores[scope] = {
            "scope": scope,
            "label": code_scope_label(scope),
            "score": scoped_score,
            "grade": scoped_grade,
            "available": available,
            "configured_weight": SCOPE_SCORE_WEIGHTS[scope],
            "effective_weight": round(effective_weight, 4),
            "exclusion_reason": None if available else f"未检测到{code_scope_label(scope)}文件，不参与综合评分。",
            "finding_count": len(scoped_findings),
            "severity_counts": {
                "error": scoped_severity_counts["error"],
                "warning": scoped_severity_counts["warning"],
                "info": scoped_severity_counts["info"],
            },
            "project_size": {
                "file_count": len(scoped_files),
                "code_line_count": sum(item.line_count for item in scoped_files),
                "symbol_count": symbol_counts_by_scope[scope],
            },
        }
    score = round(
        sum(
            int(scope_scores[scope]["score"]) * float(scope_scores[scope]["effective_weight"])
            for scope in CODE_SCOPES
            if scope_scores[scope]["available"]
        )
    )
    _, scoring = _quality_score(
        findings,
        file_count=len(source_files),
        code_line_count=sum(item.line_count for item in source_files),
        symbol_count=len(symbols),
    )
    scoring.update(
        {
            "model": COMPOSITE_SCORING_MODEL,
            "adjusted_penalty": 100 - score,
            "scope_weights": SCOPE_SCORE_WEIGHTS,
            "effective_scope_weights": {
                scope: scope_scores[scope]["effective_weight"] for scope in CODE_SCOPES
            },
            "excluded_scopes": [
                scope for scope in CODE_SCOPES if not scope_scores[scope]["available"]
            ],
            **_quality_coverage(source_files, parser_supported_files),
            "explanation": (
                "综合分由生产代码、测试代码、生成/外部代码按 70%、20%、10% 加权；"
                "不存在的代码范围不计 100 分且不参与评分，其权重按比例分配给已有范围。"
            ),
        }
    )
    return {
        "score": score,
        "grade": _grade(score),
        "score_scope": "composite",
        "scoring": scoring,
        "scope_scores": scope_scores,
        "total_findings": len(findings),
        "severity_counts": {
            "error": severity_counts["error"],
            "warning": severity_counts["warning"],
            "info": severity_counts["info"],
        },
        "rule_counts": dict(rule_counts),
        "rules": QUALITY_RULES,
        "findings": tuple(findings),
    }


def _quality_coverage(
    source_files: list[ProjectFile], parser_supported_files: list[ProjectFile]
) -> dict[str, object]:
    source_count = len(source_files)
    supported_count = len(parser_supported_files)
    ratio = supported_count / source_count if source_count else 0.0
    if source_count == 0:
        level = "none"
        message = "未检测到可参与质量检查的源代码文件，综合质量分不具有参考意义。"
    elif ratio >= 0.8:
        level = "high"
        message = "大部分源码支持结构解析，六类质量规则具备较完整的数据基础。"
    elif ratio > 0:
        level = "partial"
        message = "仅部分源码支持结构解析，函数、类与依赖类规则可能不完整。"
    else:
        level = "limited"
        message = "当前源码语言尚未获得结构解析支持，仅文件级规则可执行，综合分不能代表完整代码质量。"
    return {
        "source_file_count": source_count,
        "parser_supported_file_count": supported_count,
        "applicable_rule_count": (
            len(QUALITY_RULES) if supported_count else 1 if source_count else 0
        ),
        "total_rule_count": len(QUALITY_RULES),
        "parser_coverage": round(ratio, 4),
        "coverage_level": level,
        "coverage_message": message,
    }


def build_quality_report(
    database: Session,
    project_id: int,
    limit: int = 100,
    offset: int = 0,
    severity: str | None = None,
    rule_id: str | None = None,
    scope: str | None = None,
) -> dict[str, object]:
    started = time.perf_counter()
    snapshot = load_quality_snapshot(database, project_id)
    findings = cast(tuple[dict[str, object], ...], snapshot["findings"])
    filtered_findings = [
        finding
        for finding in findings
        if (severity is None or finding["severity"] == severity)
        and (rule_id is None or finding["rule_id"] == rule_id)
        and (scope is None or finding["scope"] == scope)
    ]
    page = filtered_findings[offset:offset + limit]
    return {
        **{key: value for key, value in snapshot.items() if key != "findings"},
        "filtered_findings": len(filtered_findings),
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(page) < len(filtered_findings),
        "findings": page,
        "truncated": offset + len(page) < len(filtered_findings),
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
    }


def load_quality_snapshot(database: Session, project_id: int) -> dict[str, object]:
    """Return the complete cached quality result for non-paginated consumers."""
    return get_or_create_project_analysis(
        database,
        project_id,
        QUALITY_CACHE_NAMESPACE,
        lambda: build_quality_snapshot(database, project_id),
    )


def build_quality_snapshot(database: Session, project_id: int) -> dict[str, object]:
    """Build the full quality result without reading or populating the runtime cache."""
    return _build_quality_report_snapshot(database, project_id)


def _finding(
    rule_id: str,
    severity: str,
    project_file: ProjectFile,
    start_line: int | None,
    end_line: int | None,
    metric: int,
    threshold: int,
    description: str,
    suggestion: str,
) -> dict[str, object]:
    rule = next(item for item in QUALITY_RULES if item["id"] == rule_id)
    return {
        "id": f"{rule_id}:{project_file.id}:{start_line or 0}",
        "rule_id": rule_id,
        "severity": severity,
        "scope": classify_code_scope(project_file.relative_path),
        "title": rule["title"],
        "description": description,
        "suggestion": suggestion,
        "file_id": project_file.id,
        "file_path": project_file.relative_path,
        "start_line": start_line,
        "end_line": end_line,
        "metric": metric,
        "threshold": threshold,
    }


def _severity(metric: int, threshold: int, error_multiplier: int) -> str:
    return "error" if metric > threshold * error_multiplier else "warning"


def _quality_score(
    findings: list[dict[str, object]],
    *,
    file_count: int,
    code_line_count: int,
    symbol_count: int,
) -> tuple[int, dict[str, object]]:
    """Score findings with lower per-item weights as the analyzed project grows."""
    scale_units = max(
        1.0,
        file_count / REFERENCE_PROJECT_SIZE["files"],
        code_line_count / REFERENCE_PROJECT_SIZE["code_lines"],
        symbol_count / REFERENCE_PROJECT_SIZE["symbols"],
    )
    size_factor = 1 / scale_units
    effective_weights = {
        severity: weight * size_factor
        for severity, weight in BASE_SEVERITY_WEIGHTS.items()
    }
    base_penalties_by_rule: dict[str, float] = defaultdict(float)
    adjusted_penalties_by_rule: dict[str, float] = defaultdict(float)
    for finding in findings:
        rule_id = str(finding["rule_id"])
        severity = str(finding["severity"])
        base_penalties_by_rule[rule_id] += BASE_SEVERITY_WEIGHTS[severity]
        adjusted_penalties_by_rule[rule_id] += effective_weights[severity]

    base_penalty = sum(
        min(MAX_RULE_PENALTY, value) for value in base_penalties_by_rule.values()
    )
    adjusted_rule_penalties = {
        rule_id: min(MAX_RULE_PENALTY, value)
        for rule_id, value in adjusted_penalties_by_rule.items()
    }
    adjusted_penalty = min(
        100,
        math.ceil(sum(adjusted_rule_penalties.values())) if findings else 0,
    )
    score = max(0, 100 - adjusted_penalty)
    scoring = {
        "model": QUALITY_SCORING_MODEL,
        "size_factor": round(size_factor, 3),
        "scale_units": round(scale_units, 2),
        "project_size": {
            "file_count": file_count,
            "code_line_count": code_line_count,
            "symbol_count": symbol_count,
        },
        "reference_size": {
            "file_count": REFERENCE_PROJECT_SIZE["files"],
            "code_line_count": REFERENCE_PROJECT_SIZE["code_lines"],
            "symbol_count": REFERENCE_PROJECT_SIZE["symbols"],
        },
        "base_weights": BASE_SEVERITY_WEIGHTS,
        "effective_weights": {
            severity: round(weight, 2)
            for severity, weight in effective_weights.items()
        },
        "base_penalty": round(base_penalty, 2),
        "adjusted_penalty": adjusted_penalty,
        "rule_penalties": {
            rule_id: round(value, 2)
            for rule_id, value in adjusted_rule_penalties.items()
        },
        "explanation": (
            "高风险、中风险和低风险项的基础权重分别为 8、3、1；项目超过参考规模后，"
            "单项权重按规模单位线性递减，每条规则最多扣 20 分；只要存在问题，"
            "最终至少扣 1 分。"
        ),
    }
    return score, scoring


def _grade(score: int) -> str:
    if score >= 90:
        return "A"
    if score >= 75:
        return "B"
    if score >= 60:
        return "C"
    if score >= 40:
        return "D"
    return "F"
