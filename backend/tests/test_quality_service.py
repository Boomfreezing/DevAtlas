from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import CodeSymbol, ImportRelation
from app.models.project import Project, ProjectFile
from app.services.quality_service import build_quality_report


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
    engine.dispose()
