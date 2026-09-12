from collections.abc import Generator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.routes.projects import router
from app.core.database import Base, get_db
from app.models.project import Project, ProjectFile


@pytest.fixture
def tree_client() -> Generator[TestClient, None, None]:
    # No application lifespan or user database/configuration in this contract test.
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as database:
            database.add(Project(id=1, name="tree", source_filename="tree/", storage_path="unused"))
            database.flush()
            database.add_all(ProjectFile(project_id=1, relative_path=path, extension=".py",
                                         content_hash=path) for path in (
                "src/main.py", "src/nested/deep.py", "root.py",
            ))
            database.commit()

        def get_test_db():
            with Session(engine) as database:
                yield database

        app = FastAPI()
        app.include_router(router, prefix="/api/projects")
        app.dependency_overrides[get_db] = get_test_db
        with TestClient(app) as client:
            yield client
    finally:
        engine.dispose()


def test_file_tree_api_exposes_page_and_descendant_totals(tree_client: TestClient) -> None:
    first = tree_client.get("/api/projects/1/files/tree", params={"limit": 1}).json()
    assert first["total_files"] == 3
    assert first["total_items"] == 2
    assert first["limit"] == 1 and first["offset"] == 0 and first["has_more"] is True
    assert first["items"][0]["path"] == "src"
    assert first["items"][0]["file_count"] == 2
    last = tree_client.get("/api/projects/1/files/tree", params={"limit": 1, "offset": 1}).json()
    assert last["items"][0]["path"] == "root.py"
    assert last["has_more"] is False
    beyond = tree_client.get("/api/projects/1/files/tree", params={"path": "src", "offset": 20})
    assert beyond.status_code == 200
    assert beyond.json()["total_items"] == 2 and beyond.json()["items"] == []


@pytest.mark.parametrize("params", [
    {"limit": 0}, {"limit": 501}, {"offset": -1}, {"offset": 2_147_483_648}, {"limit": "bad"},
])
def test_file_tree_api_rejects_invalid_page_params(tree_client: TestClient, params: dict) -> None:
    assert tree_client.get("/api/projects/1/files/tree", params=params).status_code == 422


def test_file_tree_api_distinguishes_missing_resources_and_bad_paths(tree_client: TestClient) -> None:
    assert tree_client.get("/api/projects/999/files/tree").status_code == 404
    assert tree_client.get("/api/projects/1/files/tree", params={"path": "missing"}).status_code == 404
    assert tree_client.get("/api/projects/1/files/tree", params={"path": "../src"}).status_code == 400
