from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import CodeSymbol, ImportRelation
from app.models.project import Project, ProjectFile
from app.services.quality_service import _quality_score, build_quality_report


def test_reports_all_quality_rules() -> None:
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
    assert report["scoring"]["model"] == "size_normalized_v2"
    assert report["scoring"]["size_factor"] == 1
    assert report["scoring"]["project_size"] == {
        "file_count": 12,
        "code_line_count": 1_420,
        "symbol_count": 2,
    }
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
