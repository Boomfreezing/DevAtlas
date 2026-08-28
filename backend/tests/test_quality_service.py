from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import CodeSymbol, ImportRelation
from app.models.project import Project, ProjectFile
from app.services.analysis_cache import analysis_cache_stats, clear_analysis_cache
from app.services.quality_service import _quality_score, build_quality_report


def test_reports_all_quality_rules() -> None:
    clear_analysis_cache()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as database:
        project = Project(
            name="quality-demo",
            source_filename="quality-demo.zip",
            storage_path=".",
            primary_language="Python",
        )
        project.files = [
            ProjectFile(
                relative_path="main.py" if index == 0 else f"module_{index}.py",
                extension=".py",
                language="Python",
                size_bytes=1_000,
                line_count=1_200 if index == 0 else 20,
                content_hash=f"hash-{index}",
            )
            for index in range(12)
        ]
        database.add(project)
        database.flush()
        main_file = project.files[0]
        database.add_all(
            [
                CodeSymbol(
                    project_id=project.id,
                    file_id=main_file.id,
                    name="long_work",
                    qualified_name="long_work",
                    kind="function",
                    start_line=1,
                    end_line=120,
                ),
                CodeSymbol(
                    project_id=project.id,
                    file_id=main_file.id,
                    name="HugeService",
                    qualified_name="HugeService",
                    kind="class",
                    start_line=200,
                    end_line=800,
                ),
            ]
        )
        for index in range(26):
            database.add(
                ImportRelation(
                    project_id=project.id,
                    file_id=main_file.id,
                    resolved_file_id=project.files[index % 11 + 1].id if index < 11 else None,
                    source_path="main.py",
                    target_module=f"module_{index}",
                    line_number=index + 1,
                )
            )
        database.add_all(
            [
                ImportRelation(
                    project_id=project.id,
                    file_id=project.files[1].id,
                    resolved_file_id=project.files[2].id,
                    source_path="module_1.py",
                    target_module="module_2",
                    line_number=1,
                ),
                ImportRelation(
                    project_id=project.id,
                    file_id=project.files[2].id,
                    resolved_file_id=project.files[1].id,
                    source_path="module_2.py",
                    target_module="module_1",
                    line_number=1,
                ),
            ]
        )
        database.commit()

        report = build_quality_report(database, project.id)
        warning_page = build_quality_report(
            database, project.id, limit=1, severity="warning"
        )
        warning_next_page = build_quality_report(
            database, project.id, limit=1, offset=1, severity="warning"
        )

        assert analysis_cache_stats() == {"hits": 2, "misses": 1, "projects": 1}

    assert {finding["rule_id"] for finding in report["findings"]} == {
        "LONG_FUNCTION",
        "LARGE_CLASS",
        "LARGE_FILE",
        "TOO_MANY_IMPORTS",
        "HIGH_FAN_OUT",
        "CIRCULAR_DEPENDENCY",
    }
    assert report["severity_counts"]["error"] >= 1
    assert report["score"] < 100
    assert warning_page["filtered_findings"] == report["severity_counts"]["warning"]
    assert len(warning_page["findings"]) == 1
    assert warning_page["findings"][0]["severity"] == "warning"
    assert warning_page["has_more"] is True
    assert warning_next_page["offset"] == 1
    assert warning_next_page["findings"][0]["id"] != warning_page["findings"][0]["id"]
    assert report["scoring"]["model"] == "source_scope_weighted_size_normalized_v4"
    assert report["scoring"]["size_factor"] == 1
    assert report["scoring"]["project_size"] == {
        "file_count": 12,
        "code_line_count": 1_420,
        "symbol_count": 2,
    }
    assert report["score_scope"] == "composite"
    assert report["scope_scores"]["test"]["score"] is None
    assert report["scope_scores"]["test"]["grade"] is None
    assert report["scope_scores"]["test"]["effective_weight"] == 0
    assert "不参与综合评分" in report["scope_scores"]["test"]["exclusion_reason"]
    clear_analysis_cache()
    engine.dispose()


def test_quality_penalties_are_reduced_for_larger_projects() -> None:
    warning = {"rule_id": "LONG_FUNCTION", "severity": "warning"}
    error = {"rule_id": "CIRCULAR_DEPENDENCY", "severity": "error"}

    small_score, small_scoring = _quality_score(
        [warning], file_count=10, code_line_count=2_000, symbol_count=100
    )
    large_score, large_scoring = _quality_score(
        [warning], file_count=2_000, code_line_count=500_000, symbol_count=20_000
    )
    large_warning_score, _ = _quality_score(
        [warning] * 10, file_count=2_000, code_line_count=500_000, symbol_count=20_000
    )
    large_error_score, _ = _quality_score(
        [error] * 10, file_count=2_000, code_line_count=500_000, symbol_count=20_000
    )

    assert small_scoring["size_factor"] == 1
    assert large_scoring["size_factor"] == 0.02
    assert large_score > small_score
    assert large_scoring["effective_weights"]["warning"] == 0.06
    assert large_scoring["base_penalty"] == 3
    assert large_scoring["adjusted_penalty"] == 1
    assert large_error_score < large_warning_score


def test_composite_score_weights_all_available_code_scopes() -> None:
    clear_analysis_cache()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as database:
        project = Project(
            name="scoped-quality",
            source_filename="scoped-quality.zip",
            storage_path=".",
            primary_language="Python",
        )
        project.files = [
            ProjectFile(
                relative_path="src/main.py",
                extension=".py",
                language="Python",
                size_bytes=100,
                line_count=20,
                content_hash="production",
            ),
            ProjectFile(
                relative_path="tests/test_main.py",
                extension=".py",
                language="Python",
                size_bytes=5_000,
                line_count=1_200,
                content_hash="test",
            ),
            ProjectFile(
                relative_path="dist/bundle.min.js",
                extension=".js",
                language="JavaScript",
                size_bytes=5_000,
                line_count=1_300,
                content_hash="generated",
            ),
        ]
        database.add(project)
        database.commit()

        report = build_quality_report(database, project.id)
        test_page = build_quality_report(database, project.id, scope="test")

    assert report["score_scope"] == "composite"
    assert report["score"] == 99
    assert report["total_findings"] == 2
    assert report["scope_scores"]["production"]["finding_count"] == 0
    assert report["scope_scores"]["test"]["finding_count"] == 1
    assert report["scope_scores"]["generated"]["finding_count"] == 1
    assert report["scope_scores"]["production"]["effective_weight"] == 0.7
    assert report["scope_scores"]["test"]["effective_weight"] == 0.2
    assert report["scope_scores"]["generated"]["effective_weight"] == 0.1
    assert test_page["filtered_findings"] == 1
    assert test_page["findings"][0]["scope"] == "test"
    clear_analysis_cache()
    engine.dispose()


def test_quality_ignores_non_source_documents_for_code_rules_and_scoring() -> None:
    clear_analysis_cache()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as database:
        project = Project(
            name="source-only-quality",
            source_filename="source-only-quality.zip",
            storage_path=".",
            primary_language="Python",
        )
        project.files = [
            ProjectFile(
                relative_path="src/main.py",
                extension=".py",
                language="Python",
                size_bytes=100,
                line_count=20,
                content_hash="source",
            ),
            ProjectFile(
                relative_path="fixtures/large-output.txt",
                extension=".txt",
                language=None,
                size_bytes=100_000,
                line_count=5_000,
                content_hash="fixture",
            ),
            ProjectFile(
                relative_path="docs/reference.md",
                extension=".md",
                language=None,
                size_bytes=50_000,
                line_count=2_000,
                content_hash="docs",
            ),
        ]
        database.add(project)
        database.commit()

        report = build_quality_report(database, project.id)

    assert report["total_findings"] == 0
    assert report["score"] == 100
    assert report["scope_scores"]["production"]["project_size"] == {
        "file_count": 1,
        "code_line_count": 20,
        "symbol_count": 0,
    }
    assert report["scoring"]["project_size"]["file_count"] == 1
    assert report["scoring"]["coverage_level"] == "high"
    assert report["scoring"]["parser_supported_file_count"] == 1
    assert report["scoring"]["applicable_rule_count"] == 6
    clear_analysis_cache()
    engine.dispose()


def test_quality_marks_unsupported_source_language_as_limited_coverage() -> None:
    clear_analysis_cache()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as database:
        project = Project(
            name="java-quality",
            source_filename="java-quality.zip",
            storage_path=".",
            primary_language="Java",
        )
        project.files = [
            ProjectFile(
                relative_path="src/Main.java",
                extension=".java",
                language="Java",
                size_bytes=200,
                line_count=30,
                content_hash="java-source",
            )
        ]
        database.add(project)
        database.commit()

        report = build_quality_report(database, project.id)

    assert report["score"] == 100
    assert report["scoring"]["coverage_level"] == "limited"
    assert report["scoring"]["source_file_count"] == 1
    assert report["scoring"]["parser_supported_file_count"] == 0
    assert report["scoring"]["applicable_rule_count"] == 1
    assert "不能代表完整代码质量" in report["scoring"]["coverage_message"]
    clear_analysis_cache()
    engine.dispose()
