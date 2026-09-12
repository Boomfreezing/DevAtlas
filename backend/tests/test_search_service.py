from collections.abc import Generator
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import SearchChunk
from app.models.project import Project, ProjectFile
from app.services import search_service


@pytest.fixture
def indexed_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Generator[tuple[Session, Project], None, None]:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    monkeypatch.setattr(search_service, "_SEARCH_CACHE", {})
    with Session(engine) as database:
        project = Project(
            name="search-regression",
            source_filename="search-regression/",
            storage_path=str(tmp_path / "repository"),
        )
        database.add(project)
        database.flush()
        for path, symbol_name, content in [
            ("a_module.py", None, "orbitneedle = 1"),
            ("b_symbol.py", "locate", "def locate():\n    return orbitneedle"),
            ("c_unrelated.py", "unrelated", "def unrelated():\n    return 0"),
        ]:
            project_file = ProjectFile(
                project_id=project.id,
                relative_path=path,
                extension=".py",
                language="Python",
                size_bytes=len(content.encode("utf-8")),
                line_count=len(content.splitlines()),
                content_hash=path,
            )
            database.add(project_file)
            database.flush()
            database.add(
                SearchChunk(
                    project_id=project.id,
                    file_id=project_file.id,
                    symbol_name=symbol_name,
                    kind="function" if symbol_name else "module",
                    start_line=1,
                    end_line=project_file.line_count,
                    content=content,
                )
            )
        database.commit()
        yield database, project
    engine.dispose()


@pytest.mark.parametrize("offset", [0, 3])
def test_nonmatching_query_returns_no_symbols_or_more_pages(
    indexed_project: tuple[Session, Project], offset: int
) -> None:
    database, project = indexed_project

    response = search_service.search_project(
        database, project, "zzqxvnomatch", limit=1, offset=offset
    )

    assert response["indexed_chunks"] == 3
    assert response["total_matches"] == 0
    assert response["results"] == []
    assert response["has_more"] is False
    assert response["offset"] == offset


def test_matching_symbols_keep_ranking_boost_and_unrelated_symbols_are_excluded(
    indexed_project: tuple[Session, Project],
) -> None:
    database, project = indexed_project

    response = search_service.search_project(database, project, "orbitneedle")

    assert response["total_matches"] == 2
    assert [item["file_path"] for item in response["results"]] == [
        "b_symbol.py",
        "a_module.py",
    ]
    assert response["results"][0]["score"] > response["results"][1]["score"] > 0


def test_search_pagination_counts_only_actual_matches(
    indexed_project: tuple[Session, Project],
) -> None:
    database, project = indexed_project
    pages = [
        search_service.search_project(database, project, "orbitneedle", limit=1, offset=offset)
        for offset in range(3)
    ]

    assert [page["total_matches"] for page in pages] == [2, 2, 2]
    assert [page["has_more"] for page in pages] == [True, False, False]
    assert [len(page["results"]) for page in pages] == [1, 1, 0]
    assert [page["results"][0]["file_path"] for page in pages[:2]] == [
        "b_symbol.py",
        "a_module.py",
    ]
    assert pages[0]["results"][0]["chunk_id"] != pages[1]["results"][0]["chunk_id"]
