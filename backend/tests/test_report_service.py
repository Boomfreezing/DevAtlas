from app.services.report_service import (
    _cycle_description,
    _finding_basis,
    _finding_scope,
    _prioritized_findings,
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
