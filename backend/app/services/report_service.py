from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.models.project import Project
from app.services.dependency_graph_service import load_dependency_graph
from app.services.quality_service import build_quality_report
from app.services.structure_analyzer import (
    load_project_issues,
    load_project_structure_summary,
    load_project_symbols,
)


def build_markdown_report(database: Session, project: Project) -> str:
    """Build a complete local report without an LLM or external network call."""
    structure = load_project_structure_summary(database, project.id)
    symbol_page = load_project_symbols(database, project.id, offset=0, limit=50)
    issue_page = load_project_issues(database, project.id, offset=0, limit=100)
    graph = load_dependency_graph(database, project.id, limit=100)
    quality = build_quality_report(database, project.id, limit=1_000)
    generated_at = datetime.now(UTC).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")

    lines = [
        f"# {_text(project.name)} 代码仓库分析报告",
        "",
        "> 生成方式：DevAtlas 本地规则引擎（无需大模型、API Key 或网络请求）  ",
        f"> 生成时间：{generated_at}",
        "",
        "## 1. 项目概览",
        "",
        "| 指标 | 结果 |",
        "| --- | --- |",
        f"| 项目名称 | {_cell(project.name)} |",
        f"| 来源 | {_cell(project.source_filename)} |",
        f"| 主要语言 | {_cell(project.primary_language or '未识别')} |",
        f"| 文件数量 | {project.file_count} |",
        f"| 代码行数 | {project.code_line_count} |",
        f"| 分析状态 | {_cell(project.status)} |",
        "",
        "## 2. 智能分析结论",
        "",
        *_smart_insights(project, quality, graph, structure),
        "",
        "## 3. 代码结构",
        "",
        "| 指标 | 数量 |",
        "| --- | ---: |",
        f"| 类 / 接口 | {structure['class_count']} |",
        f"| 函数 / 方法 | {structure['function_count']} |",
        f"| 符号总数 | {structure['symbol_count']} |",
        f"| 导入关系 | {structure['import_count']} |",
        f"| 已解析项目内导入 | {structure['resolved_import_count']} |",
        f"| 解析问题 | {structure['issue_count']} |",
        "",
        "### 主要符号",
        "",
    ]
    symbols = list(symbol_page["items"])
    if symbols:
        lines.extend(["| 类型 | 符号 | 文件 | 行号 |", "| --- | --- | --- | ---: |"])
        for symbol in symbols:
            lines.append(
                f"| {_cell(symbol['kind'])} | `{_code(symbol['qualified_name'])}` | "
                f"`{_code(symbol['file_path'])}` | {symbol['start_line']}–{symbol['end_line']} |"
            )
        if symbol_page["has_more"]:
            lines.append(
                f"\n> 仅展示前 50 个符号，完整分析共 {structure['symbol_count']} 个。"
            )
    else:
        lines.append("当前项目未识别到类、接口、函数或方法。")

    lines.extend(
        [
            "",
            "## 4. 依赖关系",
            "",
            "| 指标 | 数量 |",
            "| --- | ---: |",
            f"| 依赖模块 | {graph['total_node_count']} |",
            f"| 项目内依赖边 | {graph['total_edge_count']} |",
            f"| 项目内导入次数 | {graph['internal_import_count']} |",
            f"| 外部导入次数 | {graph['external_import_count']} |",
            f"| 循环依赖 | {graph['cycle_count']} |",
            "",
            "### 关键模块",
            "",
        ]
    )
    nodes = list(graph["nodes"])
    if nodes:
        lines.extend(["| 模块 | 入度 | 出度 |", "| --- | ---: | ---: |"])
        for node in nodes[:20]:
            lines.append(
                f"| `{_code(node['path'])}` | {node['in_degree']} | {node['out_degree']} |"
            )
    else:
        lines.append("当前项目没有可展示的项目内依赖模块。")

    cycles = list(graph["cycles"])
    if cycles:
        lines.extend(["", "### 循环依赖", ""])
        for index, cycle in enumerate(cycles, start=1):
            paths = [str(path) for path in cycle["paths"]]
            lines.append(f"{index}. " + " → ".join([*paths, paths[0]]))

    severity_counts = quality["severity_counts"]
    scoring = quality["scoring"]
    lines.extend(
        [
            "",
            "## 5. 代码质量",
            "",
            f"**质量评分：{quality['score']} / 100（等级 {quality['grade']}）**",
            "",
            (
                f"> 评分采用项目规模归一化：规模系数 ×{scoring['size_factor']}，"
                f"基础扣分 {scoring['base_penalty']} 调整为 {scoring['adjusted_penalty']} 分。"
            ),
            "",
            "| 严重级别 | 数量 |",
            "| --- | ---: |",
            f"| 错误 | {severity_counts['error']} |",
            f"| 警告 | {severity_counts['warning']} |",
            f"| 提示 | {severity_counts['info']} |",
            "",
            "### 质量问题",
            "",
        ]
    )
    findings = list(quality["findings"])
    if findings:
        lines.extend(["| 级别 | 规则 | 位置 | 问题与建议 |", "| --- | --- | --- | --- |"])
        for finding in findings:
            location = str(finding["file_path"])
            if finding["start_line"]:
                location += f":{finding['start_line']}"
            detail = f"{finding['description']} 建议：{finding['suggestion']}"
            lines.append(
                f"| {_cell(finding['severity'])} | {_cell(finding['title'])} | "
                f"`{_code(location)}` | {_cell(detail)} |"
            )
    else:
        lines.append("未发现当前规则集命中的质量问题。")

    issues = list(issue_page["items"])
    lines.extend(["", "## 6. 解析问题", ""])
    if issues:
        for issue in issues:
            lines.append(f"- `{_code(issue.file_path)}`：{_text(issue.message)}")
        if issue_page["has_more"]:
            lines.append(f"\n> 仅展示前 100 个解析问题，完整分析共 {structure['issue_count']} 个。")
    else:
        lines.append("未记录解析问题。")

    lines.extend(
        [
            "",
            "## 7. 建议摘要",
            "",
            *_recommendations(quality, graph, structure),
            "",
            "---",
            "",
            "该报告由 DevAtlas 自动生成，所有分析均在本地完成。",
            "",
        ]
    )
    return "\n".join(lines)


def _smart_insights(
    project: Project,
    quality: dict[str, object],
    graph: dict[str, object],
    structure: dict[str, object],
) -> list[str]:
    """Create project-specific conclusions from the collected local evidence."""
    file_count = int(project.file_count)
    line_count = int(project.code_line_count)
    if file_count >= 500 or line_count >= 100_000:
        scale = "大型"
        scale_advice = "建议按模块拆分后逐项治理，并把质量检测接入持续集成。"
    elif file_count >= 80 or line_count >= 15_000:
        scale = "中型"
        scale_advice = "建议围绕核心模块建立维护边界，并持续关注依赖增长。"
    else:
        scale = "小型"
        scale_advice = "适合先补齐测试与工程约束，再随规模增长引入更严格的架构治理。"

    score = int(quality["score"])
    finding_count = int(quality["total_findings"])
    if score >= 90:
        quality_summary = f"当前质量评分为 {score}/100，规则层面风险较低。"
    elif score >= 70:
        quality_summary = f"当前质量评分为 {score}/100，共发现 {finding_count} 项问题，建议先处理错误和警告。"
    else:
        quality_summary = f"当前质量评分仅为 {score}/100，共发现 {finding_count} 项问题，应优先安排质量治理。"

    nodes = list(graph["nodes"])
    hotspot = max(nodes, key=lambda node: int(node["in_degree"]) + int(node["out_degree"]), default=None)
    if hotspot:
        hotspot_degree = int(hotspot["in_degree"]) + int(hotspot["out_degree"])
        hotspot_summary = (
            f"依赖热点是 `{_code(hotspot['path'])}`（总连接度 {hotspot_degree}），"
            "修改该模块前应检查上下游影响。"
        )
    else:
        hotspot_summary = "尚未形成可识别的项目内依赖热点，可能是项目较小或导入关系较少。"

    test_files = sum(
        1
        for file in project.files
        if any(part in file.relative_path.lower() for part in ("test", "tests", "spec", "__tests__"))
    )
    test_summary = (
        f"识别到 {test_files} 个可能的测试文件，建议让测试覆盖核心依赖热点和质量问题。"
        if test_files
        else "未从文件名中识别到测试文件，建议优先为核心业务路径补充自动化测试。"
    )

    language = project.primary_language or "未识别语言"
    issue_count = int(structure["issue_count"])
    confidence = (
        f"存在 {issue_count} 个解析问题，报告结论可能不完整，治理前应先处理解析失败文件。"
        if issue_count
        else "结构解析没有记录异常，本次结构、依赖与质量数据可作为当前仓库基线。"
    )

    return [
        f"- **项目画像：** 这是一个以 **{_text(language)}** 为主的{scale}项目，包含 {file_count} 个文件、{line_count} 行代码；{scale_advice}",
        f"- **质量判断：** {quality_summary}",
        f"- **架构关注点：** {hotspot_summary}",
        f"- **测试信号：** {test_summary}",
        f"- **分析可信度：** {confidence}",
    ]


def _recommendations(
    quality: dict[str, object], graph: dict[str, object], structure: dict[str, object]
) -> list[str]:
    recommendations: list[str] = []
    if int(graph["cycle_count"]):
        recommendations.append("- 优先拆分循环依赖，提取公共抽象或调整依赖方向。")
    if int(quality["total_findings"]):
        recommendations.append("- 按错误、警告、提示的顺序处理质量问题，并补充对应测试。")
    if int(structure["issue_count"]):
        recommendations.append("- 检查解析失败文件，确认文件编码和语法是否受当前解析器支持。")
    if not recommendations:
        recommendations.append("- 当前规则未发现明显风险，建议继续保持小步提交和自动化测试。")
    recommendations.append("- 在重要架构调整后重新执行全量分析并保存新报告用于对比。")
    return recommendations


def _text(value: object) -> str:
    return str(value).replace("\r", " ").replace("\n", " ").strip()


def _cell(value: object) -> str:
    return _text(value).replace("|", "\\|")


def _code(value: object) -> str:
    return _text(value).replace("`", "\\`")
