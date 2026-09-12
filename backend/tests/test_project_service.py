from collections.abc import Generator
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.project import Project, ProjectFile
from app.services.project_service import load_project_file_tree


@pytest.fixture
def tree_project(tmp_path: Path) -> Generator[tuple[Session, int], None, None]:
    engine = create_engine("sqlite:///:memory:")
    try:
        yield from _tree_project_session(engine, tmp_path)
    finally:
        engine.dispose()


def _tree_project_session(engine, tmp_path: Path) -> Generator[tuple[Session, int], None, None]:
    Base.metadata.create_all(engine)
    with Session(engine) as database:
        projects = [
            Project(
                name=f"tree-{index}",
                source_filename=f"tree-{index}/",
                storage_path=str(tmp_path / f"repository-{index}"),
            )
            for index in range(2)
        ]
        database.add_all(projects)
        database.flush()
        for project, paths in [
            (
                projects[0],
                [
                    "src/lower.py",
                    "src/nested/child.py",
                    "SRC/upper.py",
                    "src_extra/sibling.py",
                    "a_b/underscore.py",
                    "axb/neighbor.py",
                    "a%b/percent.py",
                    "aZZb/neighbor.py",
                ],
            ),
            (projects[1], ["src/foreign.py", "SRC/foreign.py", "a_b/foreign.py", "a%b/foreign.py"]),
        ]:
            database.add_all(
                ProjectFile(
                    project_id=project.id,
                    relative_path=path,
                    extension=".py",
                    content_hash=path,
                )
                for path in paths
            )
        database.commit()
        yield database, projects[0].id


def test_file_tree_keeps_case_distinct_directories_separate(
    tree_project: tuple[Session, int],
) -> None:
    database, project_id = tree_project

    lower = load_project_file_tree(database, project_id, "src")
    upper = load_project_file_tree(database, project_id, "SRC")

    assert lower["total_files"] == 2
    assert [(item["path"], item["file_count"]) for item in lower["items"]] == [
        ("src/nested", 1),
        ("src/lower.py", 1),
    ]
    assert upper["total_files"] == 1
    assert [item["path"] for item in upper["items"]] == ["SRC/upper.py"]


def test_file_tree_rejects_missing_directory_with_different_case(
    tree_project: tuple[Session, int],
) -> None:
    database, project_id = tree_project

    with pytest.raises(FileNotFoundError, match="sRc"):
        load_project_file_tree(database, project_id, "sRc")


@pytest.mark.parametrize("directory,filename", [("a_b", "underscore.py"), ("a%b", "percent.py")])
def test_file_tree_matches_literal_prefix_and_project(
    tree_project: tuple[Session, int], directory: str, filename: str
) -> None:
    database, project_id = tree_project

    response = load_project_file_tree(database, project_id, directory)

    assert response["total_files"] == 1
    assert [item["path"] for item in response["items"]] == [f"{directory}/{filename}"]


def test_file_tree_pages_direct_children_not_descendant_count(
    tree_project: tuple[Session, int],
) -> None:
    database, project_id = tree_project
    pages = [load_project_file_tree(database, project_id, limit=3, offset=n) for n in (0, 3, 6)]
    assert [page["total_files"] for page in pages] == [8, 8, 8]
    assert [page["total_items"] for page in pages] == [7, 7, 7]
    assert [len(page["items"]) for page in pages] == [3, 3, 1]
    assert [page["has_more"] for page in pages] == [True, True, False]
    assert [page["offset"] for page in pages] == [0, 3, 6]
    assert all(page["limit"] == 3 for page in pages)
    items = [item for page in pages for item in page["items"]]
    assert len({item["path"] for item in items}) == 7
    assert sum(item["file_count"] for item in items) == 8
    assert all(item["id"] is None and item["language"] is None for item in items)
    assert [item["path"] for item in items] == ["a%b", "a_b", "axb", "aZZb", "SRC", "src", "src_extra"]
    beyond = load_project_file_tree(database, project_id, "src", offset=2_147_483_647)
    assert beyond["items"] == []
    assert beyond["total_items"] == beyond["total_files"] == 2
    assert beyond["has_more"] is False


def test_file_tree_retains_unicode_sort_metadata_and_duplicate_file_ids(
    tree_project: tuple[Session, int],
) -> None:
    database, project_id = tree_project
    names = ["É.py", "z.py", "Ü.py", "é.py", "é.py", "ü.py", "A.py", "a.py"]
    paths = [f"unicode/{name}" for name in names] + ["unicode/zdir/x.py", "unicode/Ädir/y.py"]
    database.add_all(ProjectFile(
        project_id=project_id, relative_path=path, extension=".py", language="Python",
        size_bytes=90, line_count=9, content_hash=path,
    ) for path in paths)
    database.commit()
    database.expunge_all()

    pages = [load_project_file_tree(database, project_id, "unicode", limit=3, offset=n)
             for n in (0, 3, 6, 9)]
    items = [item for page in pages for item in page["items"]]
    assert [item["name"] for item in items] == ["zdir", "Ädir", *sorted(sorted(names), key=str.lower)]
    assert all(page["total_items"] == page["total_files"] == 10 for page in pages)
    assert len({item["id"] for item in items if item["kind"] == "file"}) == 8
    assert all(item["size_bytes"] == 90 and item["line_count"] == 9
               and item["language"] == "Python" and item["extension"] == ".py"
               for item in items if item["kind"] == "file")
    assert not any(isinstance(value, ProjectFile) for value in database.identity_map.values())


def test_file_tree_default_page_is_bounded_and_empty_root_is_valid(
    tree_project: tuple[Session, int],
) -> None:
    database, project_id = tree_project
    empty = Project(name="empty", source_filename="empty/", storage_path="unused")
    database.add(empty)
    database.flush()
    result = load_project_file_tree(database, empty.id)
    assert result == {"path": "", "total_files": 0, "total_items": 0,
                      "limit": 200, "offset": 0, "has_more": False, "items": []}
    with pytest.raises(FileNotFoundError):
        load_project_file_tree(database, empty.id, "missing", offset=50)
    database.add_all(ProjectFile(project_id=project_id, relative_path=f"wide/{n:04}.py",
                                 extension=".py", content_hash=str(n)) for n in range(501))
    database.commit()
    first = load_project_file_tree(database, project_id, "wide")
    assert len(first["items"]) == first["limit"] == 200
    assert first["total_items"] == first["total_files"] == 501
    assert first["has_more"] is True
    last = load_project_file_tree(database, project_id, "wide", limit=500, offset=500)
    assert [item["name"] for item in last["items"]] == ["0500.py"]
    assert last["has_more"] is False


@pytest.mark.parametrize("pagination", [
    {"limit": 0}, {"limit": 501}, {"offset": -1}, {"offset": 2_147_483_648},
])
def test_file_tree_rejects_invalid_pagination(tree_project, pagination) -> None:
    database, project_id = tree_project
    with pytest.raises(ValueError, match="limit"):
        load_project_file_tree(database, project_id, **pagination)
