from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import CodeSymbol, ImportRelation
from app.models.project import Project, ProjectFile
from app.services.impact_analysis_service import (
    analyze_change_impact,
    search_impact_targets,
)
from app.services.project_service import create_scanned_project
from app.services.search_service import _add_range_chunks


@contextmanager
def _database_session(database_path: Path) -> Iterator[Session]:
    engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as database:
            yield database
    finally:
        engine.dispose()


def test_analyzes_symbol_change_impact_with_callers_dependencies_and_tests(
    tmp_path: Path,
) -> None:
    with _database_session(tmp_path / "impact.db") as database:
        sources = {
            "app/auth.py": (
                "from app.models.user import User\n\n"
                "def authenticate_user(name):\n    return User.find(name)\n"
            ),
            "app/api/login_route.py": (
                "from app.auth import authenticate_user\n\n"
                "def login(request):\n    return authenticate_user(request.name)\n"
            ),
            "app/main.py": "from app.api.login_route import login\n",
            "app/models/user.py": (
                "class User:\n    @classmethod\n"
                "    def find(cls, name):\n        return name\n"
            ),
            "tests/test_auth.py": (
                "from app.auth import authenticate_user\n\n"
                "def test_auth():\n    assert authenticate_user('demo')\n"
            ),
        }
        repository = tmp_path / "repo"
        for path, content in sources.items():
            target_path = repository / path
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_text(content, encoding="utf-8")
        # Exercise real indexed imports and complete source ranges, rather than
        # inferring a binding from a module edge with no import syntax.
        project = create_scanned_project(
            database, repository, "synthetic/impact-demo", "impact-demo",
            search_index_root=tmp_path / "indexes",
        )
        authenticate = database.scalar(select(CodeSymbol).where(
            CodeSymbol.project_id == project.id, CodeSymbol.name == "authenticate_user",
        ))

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
        assert report["risk"]["model"] == "evidence_v3"
        assert report["risk"]["base_score"] == 8
        factors = {item["key"]: item for item in report["risk"]["factors"]}
        assert factors["change_scope"]["reference"] == 200
        assert factors["direct_callers"]["actual"] >= 2
        assert factors["blast_radius"]["unit"] == "%"
        assert factors["test_evidence"]["contribution"] < 0
        assert factors["test_evidence"]["unit"] == "个"
        assert report["risk"]["score"] == max(
            0,
            min(
                100,
                report["risk"]["base_score"]
                + sum(item["contribution"] for item in report["risk"]["factors"]),
            ),
        )
        recommendations = {item["code"]: item for item in report["recommendations"]}
        assert recommendations["run_related_tests"]["priority"] == "high"
        assert recommendations["run_related_tests"]["related_paths"] == [
            "tests/test_auth.py"
        ]
        assert recommendations["verify_api_contract"]["priority"] == "high"
        assert recommendations["verify_data_contract"]["priority"] == "high"
        assert recommendations["run_module_regression"]["related_paths"] == [
            "app/main.py"
        ]
        assert report["recommendations"][-1]["code"] == "reanalyze_and_snapshot"


def test_file_impact_uses_exact_import_confidence(tmp_path: Path) -> None:
    with _database_session(tmp_path / "file-impact.db") as database:
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


@pytest.mark.parametrize(("target_type", "query"), [
    ("symbol", "calculate"),
    ("method", "calculate"),
    ("method", "calcu"),
    ("method", "Class.calculate"),
    ("file", "service.py"),
])
@pytest.mark.parametrize("limit", [1, 20])
def test_target_search_ranks_exact_matches_before_limiting(
    tmp_path: Path, target_type: str, query: str, limit: int,
) -> None:
    with _database_session(tmp_path / "target-ranking.db") as database:
        project = Project(
            name="target-ranking", source_filename="ranking/",
            storage_path=str(tmp_path / "repo"), status="ready",
        )
        database.add(project)
        database.flush()
        files = [
            ProjectFile(
                project_id=project.id,
                relative_path=f"copies/{index:02d}/service.py",
                extension=".py", language="Python", size_bytes=10,
                line_count=2, content_hash=str(index),
            )
            for index in range(limit * 2 + 1)
        ]
        exact_file = ProjectFile(
            project_id=project.id, relative_path="service.py", extension=".py",
            language="Python", size_bytes=10, line_count=2, content_hash="exact",
        )
        database.add_all([*files, exact_file])
        database.flush()
        exact_id = exact_file.id
        if target_type != "file":
            for index, project_file in enumerate(files):
                name = f"acalcu{index:02d}" if query == "calcu" else f"calculate_extra{index:02d}"
                database.add(CodeSymbol(
                    project_id=project.id, file_id=project_file.id,
                    name=name,
                    qualified_name=f"Class.{name}" if "." in query else name,
                    kind="function",
                    start_line=1, end_line=2,
                ))
            exact = CodeSymbol(
                project_id=project.id, file_id=exact_file.id,
                name="calculate",
                qualified_name="Class.calculate" if target_type == "method" else "calculate",
                kind="method" if target_type == "method" else "function",
                start_line=1, end_line=2,
            )
            database.add(exact)
            database.flush()
            exact_id = exact.id

        targets = search_impact_targets(database, project.id, query.upper(), limit)

        assert len(targets) == limit
        assert targets[0]["target_type"] == ("file" if target_type == "file" else "symbol")
        assert targets[0]["target_id"] == exact_id
        if target_type == "method":
            assert targets[0]["name"] == "Class.calculate"


@pytest.mark.parametrize(("target_type", "query", "unrelated"), [
    ("symbol", "get_user", "getXuser"),
    ("file", "dir/service_", "dir/serviceX"),
    ("file", "rate%", "rateOther"),
])
def test_target_search_treats_like_wildcards_as_literal_text(
    tmp_path: Path, target_type: str, query: str, unrelated: str,
) -> None:
    with _database_session(tmp_path / "literal-search.db") as database:
        project = Project(
            name="literal-search", source_filename="literal/",
            storage_path=str(tmp_path / "repo"), status="ready",
        )
        database.add(project)
        database.flush()
        files = []
        for index, name in enumerate((query, unrelated)):
            project_file = ProjectFile(
                project_id=project.id,
                relative_path=f"{name}.py" if target_type == "file" else f"src{index}.py",
                extension=".py", language="Python", size_bytes=10,
                line_count=2, content_hash=str(index),
            )
            database.add(project_file)
            database.flush()
            files.append(project_file)
            symbol_name = name if target_type == "symbol" else "calculate"
            database.add(CodeSymbol(
                project_id=project.id, file_id=project_file.id,
                name=symbol_name, qualified_name=f"Service.{symbol_name}", kind="method",
                start_line=1, end_line=2,
            ))
        database.flush()

        targets = search_impact_targets(database, project.id, query.upper())

        assert {item["file_id"] for item in targets} == {files[0].id}


@pytest.mark.parametrize("function_lines", [4, 100, 17_000])
def test_called_symbols_cover_function_ends_and_exclude_adjacent_context(
    tmp_path: Path, function_lines: int,
) -> None:
    with _database_session(tmp_path / "chunked-impact.db") as database:
        project = Project(
            name="chunked-impact", source_filename="chunked/",
            storage_path=str(tmp_path / "repo"), status="ready",
        )
        database.add(project)
        database.flush()
        source = [
            "before_object()", "", "def calculate():", "    head_helper()",
            *["    pass"] * (function_lines - 3), "    return tail_helper()",
            "", "after_object()",
        ]
        project_file = ProjectFile(
            project_id=project.id, relative_path="service.py", extension=".py",
            language="Python", size_bytes=len("\n".join(source)),
            line_count=len(source), content_hash="service",
        )
        database.add(project_file)
        database.flush()
        target = CodeSymbol(
            project_id=project.id, file_id=project_file.id,
            name="calculate", qualified_name="calculate", kind="function",
            start_line=3, end_line=function_lines + 2,
        )
        database.add(target)
        for name in ("head_helper", "tail_helper", "before_object", "after_object"):
            database.add(CodeSymbol(
                project_id=project.id, file_id=project_file.id,
                name=name, qualified_name=name, kind="function",
                start_line=len(source) + 2, end_line=len(source) + 3,
            ))
        _add_range_chunks(
            database, project, project_file, source, 1, len(source),
            "calculate", "function", remaining=1000,
        )
        database.flush()

        report = analyze_change_impact(database, project.id, "symbol", target.id)

        assert {item["symbol_name"] for item in report["called_objects"]} == {
            "head_helper", "tail_helper",
        }
