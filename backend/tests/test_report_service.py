from app.models.project import Project, ProjectGitMetadata
from app.services.report_service import (
    _analysis_baseline,
    _cycle_description,
    _finding_basis,
    _finding_scope,
    _generation_provenance,
    _prioritized_findings,
    _recommendations,
    _risk_modules,
)


def _finding(path: str, severity: str, title: str = "超长函数") -> dict[str, object]:
    return {
        "file_path": path,
        "severity": severity,
        "title": title,
        "rule_id": "LONG_FUNCTION",
        "metric": 120,
        "threshold": 80,
        "start_line": 1,
    }


def test_report_prioritizes_production_findings_and_groups_modules() -> None:
    findings = [
        _finding("tests/test_service.py", "error"),
        _finding("src/service.py", "warning"),
        _finding("src/service.py", "error", "高扇出模块"),
        _finding("dist/app.min.js", "error"),
    ]

    prioritized = _prioritized_findings(findings)
    modules = _risk_modules(prioritized, limit=3)

    assert [item["file_path"] for item in prioritized] == [
        "src/service.py",
        "src/service.py",
        "tests/test_service.py",
        "dist/app.min.js",
    ]
    assert modules[0] == {
        "path": "src/service.py",
        "error": 1,
        "warning": 1,
        "info": 0,
        "score": 11,
        "rules": ["超长函数", "高扇出模块"],
        "scope": "生产代码",
    }
    assert _finding_scope("tests/test_service.py") == "test"
    assert _finding_scope("dist/app.min.js") == "generated"


def test_report_condenses_long_cycles_and_explains_thresholds() -> None:
    paths = [f"module_{index}.py" for index in range(12)]

    assert "共 12 个模块" in _cycle_description(paths, is_full=False)
    assert "共 12 个模块" not in _cycle_description(paths, is_full=True)
    assert _finding_basis(_finding("src/service.py", "warning")) == (
        "实际 120 / 建议 ≤ 80，超出 50%"
    )
    cycle = _finding("src/a.py", "error", "循环依赖")
    cycle.update(rule_id="CIRCULAR_DEPENDENCY", metric=3, threshold=0)
    assert _finding_basis(cycle) == "结构性风险，涉及 3 个模块"


def test_report_baseline_and_recommendations_are_traceable() -> None:
    project = Project(name="demo", source_filename="demo.zip", storage_path="demo")
    assert "未绑定可验证的 Git Commit" in _analysis_baseline(project)

    project.git_metadata = ProjectGitMetadata(
        repository_url="https://github.com/example/demo",
        default_branch="main",
        head_commit="a" * 40,
        history_available=True,
        recent_commits_json="[]",
    )
    baseline = _analysis_baseline(project)
    assert "`main`" in baseline
    assert f"`{'a' * 40}`" in baseline

    recommendations = _recommendations(
        {
            "total_findings": 1,
            "findings": [_finding("src/service.py", "error", "超长函数")],
        },
        {"cycle_count": 1, "cycles": [{"paths": ["src/a.py", "src/b.py"]}]},
        {"issue_count": 0},
    )
    assert "`src/a.py` → `src/b.py`" in recommendations[0]
    assert "`src/service.py:1`" in recommendations[1]


def test_report_provenance_distinguishes_local_and_model_generated_text() -> None:
    local_header, local_footer = _generation_provenance("本地规则分析", False)
    model_header, model_footer = _generation_provenance("Ollama 本地模型服务", True)

    assert "无需大模型" in local_header
    assert "数据与文本均由 DevAtlas 在本地生成" in local_footer
    assert "使用已配置的生成模型" in model_header
    assert "报告文本由 Ollama 本地模型服务" in model_footer
