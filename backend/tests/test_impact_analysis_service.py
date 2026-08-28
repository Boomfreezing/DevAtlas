from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import CodeSymbol, ImportRelation, SearchChunk
from app.models.project import Project, ProjectFile
from app.services.impact_analysis_service import (
    analyze_change_impact,
    search_impact_targets,
)


def test_analyzes_symbol_change_impact_with_callers_dependencies_and_tests(
    tmp_path: Path,
) -> None:
    engine = create_engine(f"sqlite:///{(tmp_path / 'impact.db').as_posix()}")
    Base.metadata.create_all(engine)
    with Session(engine) as database:
        project = Project(
            name="impact-demo",
            source_filename="impact-demo/",
            storage_path=str(tmp_path / "repo"),
            status="ready",
        )
        database.add(project)
        database.flush()

        files = {
            path: ProjectFile(
                project_id=project.id,
                relative_path=path,
                extension=".py",
                language="Python",
                size_bytes=100,
                line_count=20,
                content_hash=path,
            )
            for path in (
                "app/auth.py",
                "app/api/login_route.py",
                "app/main.py",
                "app/models/user.py",
                "tests/test_auth.py",
            )
        }
        database.add_all(files.values())
        database.flush()
        authenticate = CodeSymbol(
            project_id=project.id,
            file_id=files["app/auth.py"].id,
            name="authenticate_user",
            qualified_name="authenticate_user",
            kind="function",
            start_line=3,
            end_line=6,
        )
        user_model = CodeSymbol(
            project_id=project.id,
            file_id=files["app/models/user.py"].id,
            name="User",
            qualified_name="User",
            kind="class",
            start_line=1,
            end_line=8,
        )
        database.add_all([authenticate, user_model])
        database.flush()
        database.add_all(
            [
                ImportRelation(
                    project_id=project.id,
                    file_id=files["app/api/login_route.py"].id,
                    resolved_file_id=files["app/auth.py"].id,
                    source_path="app/api/login_route.py",
                    target_module="app.auth",
                    line_number=2,
                ),
                ImportRelation(
                    project_id=project.id,
                    file_id=files["app/main.py"].id,
                    resolved_file_id=files["app/api/login_route.py"].id,
                    source_path="app/main.py",
                    target_module="app.api.login_route",
                    line_number=1,
                ),
                ImportRelation(
                    project_id=project.id,
                    file_id=files["app/auth.py"].id,
                    resolved_file_id=files["app/models/user.py"].id,
                    source_path="app/auth.py",
                    target_module="app.models.user",
                    line_number=1,
                ),
                ImportRelation(
                    project_id=project.id,
                    file_id=files["tests/test_auth.py"].id,
                    resolved_file_id=files["app/auth.py"].id,
                    source_path="tests/test_auth.py",
                    target_module="app.auth",
                    line_number=1,
                ),
            ]
        )
        database.add_all(
            [
                SearchChunk(
                    project_id=project.id,
                    file_id=files["app/auth.py"].id,
                    symbol_name="authenticate_user",
                    kind="function",
                    start_line=3,
                    end_line=6,
                    content="def authenticate_user(name):\n    return User.find(name)",
                ),
                SearchChunk(
                    project_id=project.id,
                    file_id=files["app/api/login_route.py"].id,
                    symbol_name="login",
                    kind="function",
                    start_line=4,
                    end_line=8,
                    content="def login(request):\n    return authenticate_user(request.name)",
                ),
                SearchChunk(
                    project_id=project.id,
                    file_id=files["tests/test_auth.py"].id,
                    symbol_name="test_auth",
                    kind="function",
                    start_line=3,
                    end_line=5,
                    content="def test_auth():\n    assert authenticate_user('demo')",
                ),
            ]
        )
        database.commit()

        targets = search_impact_targets(database, project.id, "authenticate")
        assert targets[0]["target_id"] == authenticate.id
        report = analyze_change_impact(database, project.id, "symbol", authenticate.id)

        assert report["target"]["name"] == "authenticate_user"
        assert {item["file_path"] for item in report["direct_callers"]} >= {
            "app/api/login_route.py",
            "tests/test_auth.py",
        }
        assert {item["file_path"] for item in report["dependencies"]} == {
            "app/models/user.py"
        }
        assert {item["file_path"] for item in report["indirect_impacts"]} == {
            "app/main.py"
        }
        assert report["related_tests"][0]["file_path"] == "tests/test_auth.py"
        assert report["related_apis"][0]["file_path"] == "app/api/login_route.py"
        assert report["database_entities"][0]["file_path"] == "app/models/user.py"
        assert report["risk"]["level"] in {"medium", "high"}
        assert report["risk"]["confidence"] == "medium"
        assert report["risk"]["model"] == "reference_v2"
        assert report["risk"]["base_score"] == 8
        factors = {item["key"]: item for item in report["risk"]["factors"]}
        assert factors["change_scope"]["reference"] == 200
        assert factors["direct_callers"]["actual"] >= 2
        assert factors["blast_radius"]["unit"] == "%"
        assert factors["test_coverage"]["contribution"] < 0
        assert report["risk"]["score"] == max(
            0,
            min(
                100,
                report["risk"]["base_score"]
                + sum(item["contribution"] for item in report["risk"]["factors"]),
            ),
        )


def test_file_impact_uses_exact_import_confidence(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite:///{(tmp_path / 'file-impact.db').as_posix()}")
    Base.metadata.create_all(engine)
    with Session(engine) as database:
        project = Project(
            name="file-impact",
            source_filename="file-impact/",
            storage_path=str(tmp_path / "repo"),
            status="ready",
        )
        database.add(project)
        database.flush()
        target = ProjectFile(
            project_id=project.id,
            relative_path="src/service.py",
            extension=".py",
            language="Python",
            size_bytes=10,
            line_count=2,
            content_hash="service",
        )
        caller = ProjectFile(
            project_id=project.id,
            relative_path="src/main.py",
            extension=".py",
            language="Python",
            size_bytes=10,
            line_count=2,
            content_hash="main",
        )
        database.add_all([target, caller])
        database.flush()
        database.add(
            ImportRelation(
                project_id=project.id,
                file_id=caller.id,
                resolved_file_id=target.id,
                source_path="src/main.py",
                target_module="src.service",
                line_number=1,
            )
        )
        database.commit()

        report = analyze_change_impact(database, project.id, "file", target.id)

        assert report["direct_callers"][0]["file_path"] == "src/main.py"
        assert report["direct_callers"][0]["confidence"] == "high"
        assert report["risk"]["confidence"] == "high"
