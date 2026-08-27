import io
import sqlite3
import zipfile
from collections.abc import Generator
from contextlib import closing
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings, get_settings
from app.core.database import Base, get_db
from app.main import app
from app.api.routes import projects as project_routes
from app.services import repository_path_service


@pytest.fixture
def client(tmp_path: Path) -> Generator[TestClient, None, None]:
    engine = create_engine(
        f"sqlite:///{(tmp_path / 'test.db').as_posix()}",
        connect_args={"check_same_thread": False},
    )
    testing_session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    settings = Settings(
        database_url=f"sqlite:///{(tmp_path / 'test.db').as_posix()}",
        repository_root=tmp_path / "repositories",
        provider_config_path=tmp_path / "report-providers.json",
        max_upload_mb=5,
    )
    settings.ensure_directories()

    def override_database() -> Generator[Session, None, None]:
        database = testing_session()
        try:
            yield database
        finally:
            database.close()

    app.dependency_overrides[get_db] = override_database
    app.dependency_overrides[get_settings] = lambda: settings
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    engine.dispose()


def make_archive(files: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for filename, content in files.items():
            archive.writestr(filename, content)
    return buffer.getvalue()


def test_import_limits_follow_backend_configuration(client: TestClient) -> None:
    response = client.get("/api/import-limits")

    assert response.status_code == 200
    assert response.json() == {
        "max_upload_mb": 5,
        "max_folder_files": 20_000,
        "max_source_file_mb": 5,
    }


def test_project_lifecycle(client: TestClient) -> None:
    archive = make_archive(
        {
            "demo/main.py": "def hello():\n    return 'world'\n",
            "demo/README.md": "# Demo\n",
            "demo/node_modules/ignored.js": "ignored();\n",
        }
    )

    created = client.post(
        "/api/projects",
        files={"archive": ("demo.zip", archive, "application/zip")},
    )

    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "demo"
    assert body["primary_language"] == "Python"
    assert body["file_count"] == 2
    assert body["code_line_count"] == 2
    assert {item["relative_path"] for item in body["files"]} == {"main.py", "README.md"}

    search = client.get(f"/api/projects/{body['id']}/search", params={"q": "hello world"})
    assert search.status_code == 200
    search_body = search.json()
    assert search_body["indexed_chunks"] >= 1
    assert search_body["total_matches"] >= 1
    assert search_body["results"][0]["file_path"] == "main.py"
    assert search_body["results"][0]["symbol_name"] == "hello"
    assert "return 'world'" in search_body["results"][0]["snippet"]

    content = client.get(
        f"/api/projects/{body['id']}/files/{search_body['results'][0]['file_id']}/content"
    )
    assert content.status_code == 200
    assert content.json()["file_path"] == "main.py"
    assert content.json()["language"] == "Python"
    assert content.json()["total_lines"] == 2
    assert content.json()["lines"] == ["def hello():", "    return 'world'"]
    assert client.get(f"/api/projects/{body['id']}/files/999999/content").status_code == 404

    quality = client.get(f"/api/projects/{body['id']}/quality")
    assert quality.status_code == 200
    assert quality.json()["score"] == 100
    assert len(quality.json()["rules"]) == 6
    assert quality.json()["scoring"]["model"] == "size_normalized_v2"
    assert quality.json()["scoring"]["adjusted_penalty"] == 0

    report = client.get(f"/api/projects/{body['id']}/report.md")
    assert report.status_code == 200
    assert report.headers["content-type"].startswith("text/markdown")
    assert report.headers["content-disposition"].endswith(
        f'devatlas-project-{body["id"]}-report.md"'
    )
    assert "# demo 代码仓库分析报告" in report.text
    assert "无需大模型" in report.text
    assert "| 函数 / 方法 | 1 |" in report.text
    assert "## 2. 智能分析结论" in report.text
    assert "**项目画像：**" in report.text
    assert "评分采用项目规模归一化" in report.text

    generators = client.get("/api/projects/report-generators")
    assert generators.status_code == 200
    assert generators.json()[0]["id"] == "local"
    assert generators.json()[0]["available"] is True
    assert generators.json()[0]["cost_label"] == "免费 · 默认"
    assert generators.json()[1]["available"] is False

    preview = client.get(f"/api/projects/{body['id']}/report?generator=local")
    assert preview.status_code == 200
    assert preview.json()["generator"] == "local"
    assert preview.json()["filename"].endswith(".md")
    assert "智能分析结论" in preview.json()["content"]

    unavailable = client.get(f"/api/projects/{body['id']}/report?generator=ollama")
    assert unavailable.status_code == 400
    assert "not configured" in unavailable.json()["detail"]

    listed = client.get("/api/projects")
    assert listed.status_code == 200
    assert len(listed.json()) == 1

    deleted = client.delete(f"/api/projects/{body['id']}")
    assert deleted.status_code == 204
    assert client.get("/api/projects").json() == []


def test_code_search_supports_offset_pagination(client: TestClient) -> None:
    archive = make_archive(
        {
            "search-demo/main.py": (
                "def first_match():\n"
                "    return 'shared-search-token'\n\n"
                "def second_match():\n"
                "    return 'shared-search-token'\n"
            )
        }
    )
    created = client.post(
        "/api/projects",
        files={"archive": ("search-demo.zip", archive, "application/zip")},
    ).json()
    search_url = f"/api/projects/{created['id']}/search"

    first_page = client.get(
        search_url,
        params={"q": "shared-search-token", "limit": 1, "offset": 0},
    )
    second_page = client.get(
        search_url,
        params={"q": "shared-search-token", "limit": 1, "offset": 1},
    )

    assert first_page.status_code == 200
    assert second_page.status_code == 200
    assert first_page.json()["total_matches"] >= 2
    assert first_page.json()["limit"] == 1
    assert first_page.json()["offset"] == 0
    assert first_page.json()["has_more"] is True
    assert len(first_page.json()["results"]) == 1
    assert len(second_page.json()["results"]) == 1
    assert second_page.json()["offset"] == 1
    assert first_page.json()["results"][0]["chunk_id"] != second_page.json()["results"][0]["chunk_id"]


def test_structure_endpoints_use_server_side_pagination(client: TestClient) -> None:
    source = "\n".join(
        [f"import package_{index}" for index in range(155)]
        + [f"def symbol_{index}():\n    return {index}\n" for index in range(155)]
    )
    created = client.post(
        "/api/projects",
        files={"archive": ("paged.zip", make_archive({"paged/main.py": source}), "application/zip")},
    ).json()
    project_id = created["id"]

    summary = client.get(f"/api/projects/{project_id}/structure/summary")
    assert summary.status_code == 200
    assert summary.json()["symbol_count"] == 155
    assert summary.json()["import_count"] == 155
    assert "symbols" not in summary.json()

    first_symbols = client.get(
        f"/api/projects/{project_id}/symbols", params={"limit": 100, "offset": 0}
    ).json()
    second_symbols = client.get(
        f"/api/projects/{project_id}/symbols", params={"limit": 100, "offset": 100}
    ).json()
    assert first_symbols["total"] == 155
    assert first_symbols["has_more"] is True
    assert len(first_symbols["items"]) == 100
    assert len(second_symbols["items"]) == 55
    assert second_symbols["has_more"] is False
    assert {item["id"] for item in first_symbols["items"]}.isdisjoint(
        item["id"] for item in second_symbols["items"]
    )

    filtered = client.get(
        f"/api/projects/{project_id}/symbols",
        params={"q": "symbol_154", "kind": "function"},
    ).json()
    assert filtered["total"] == 1
    assert filtered["items"][0]["name"] == "symbol_154"

    first_imports = client.get(
        f"/api/projects/{project_id}/imports",
        params={"limit": 100, "offset": 0, "scope": "external"},
    ).json()
    second_imports = client.get(
        f"/api/projects/{project_id}/imports",
        params={"limit": 100, "offset": 100, "scope": "external"},
    ).json()
    assert first_imports["total"] == 155
    assert len(first_imports["items"]) == 100
    assert len(second_imports["items"]) == 55

    reanalyzed = client.post(f"/api/projects/{project_id}/reanalyze")
    assert reanalyzed.status_code == 200
    assert reanalyzed.json()["symbol_count"] == 155
    assert "symbols" not in reanalyzed.json()


def test_code_viewer_rejects_binary_large_and_missing_files(
    client: TestClient, tmp_path: Path
) -> None:
    archive = make_archive({"viewer/main.py": "def visible():\n    return True\n"})
    created = client.post(
        "/api/projects",
        files={"archive": ("viewer.zip", archive, "application/zip")},
    ).json()
    project_id = created["id"]
    file_id = created["files"][0]["id"]
    source_path = next((tmp_path / "repositories").rglob("main.py"))
    content_url = f"/api/projects/{project_id}/files/{file_id}/content"

    source_path.write_bytes(b"\x00binary")
    binary = client.get(content_url)
    assert binary.status_code == 400
    assert "Binary files" in binary.json()["detail"]

    source_path.write_bytes(b"x" * (2 * 1024 * 1024 + 1))
    oversized = client.get(content_url)
    assert oversized.status_code == 400
    assert "2 MB" in oversized.json()["detail"]

    source_path.unlink()
    missing = client.get(content_url)
    assert missing.status_code == 404
    assert "no longer available" in missing.json()["detail"]


def test_legacy_relative_storage_path_works_from_another_working_directory(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = make_archive({"legacy/main.py": "def legacy_path():\n    return True\n"})
    created = client.post(
        "/api/projects",
        files={"archive": ("legacy.zip", archive, "application/zip")},
    ).json()
    project_id = created["id"]
    file_id = created["files"][0]["id"]

    database_path = tmp_path / "test.db"
    with closing(sqlite3.connect(database_path)) as database:
        absolute_storage = Path(
            database.execute(
                "SELECT storage_path FROM projects WHERE id = ?", (project_id,)
            ).fetchone()[0]
        )
        legacy_storage = str(absolute_storage.relative_to(tmp_path))
        database.execute(
            "UPDATE projects SET storage_path = ? WHERE id = ?",
            (legacy_storage, project_id),
        )
        database.commit()

    monkeypatch.setattr(repository_path_service, "PROJECT_ROOT", tmp_path)
    unrelated_working_directory = tmp_path / "backend-working-directory"
    unrelated_working_directory.mkdir()
    monkeypatch.chdir(unrelated_working_directory)

    content = client.get(f"/api/projects/{project_id}/files/{file_id}/content")
    assert content.status_code == 200
    assert content.json()["lines"][0] == "def legacy_path():"

    incremental = client.post(f"/api/projects/{project_id}/incremental-reanalyze")
    assert incremental.status_code == 200
    assert incremental.json()["unchanged_file_count"] == 1

    reanalyzed = client.post(f"/api/projects/{project_id}/reanalyze")
    assert reanalyzed.status_code == 200
    assert reanalyzed.json()["symbol_count"] == 1

    repository_container = absolute_storage.parent
    deleted = client.delete(f"/api/projects/{project_id}")
    assert deleted.status_code == 204
    assert not repository_container.exists()


def test_queues_zip_analysis_job(client: TestClient) -> None:
    archive = make_archive(
        {"background/main.py": "def background_work():\n    return 'done'\n"}
    )

    queued = client.post(
        "/api/projects/jobs/zip",
        files={"archive": ("background.zip", archive, "application/zip")},
    )

    assert queued.status_code == 202
    job_id = queued.json()["id"]
    completed = client.get(f"/api/projects/jobs/{job_id}")
    assert completed.status_code == 200
    job = completed.json()
    assert job["status"] == "completed", job
    assert job["stage"] == "completed"
    assert job["progress"] == 100
    assert job["project_id"] is not None
    project = client.get(f"/api/projects/{job['project_id']}")
    assert project.status_code == 200
    assert project.json()["name"] == "background"


def test_incrementally_reanalyzes_changed_files(
    client: TestClient, tmp_path: Path
) -> None:
    archive = make_archive(
        {
            "incremental/a.py": "import b\ndef old_name():\n    return 1\n",
            "incremental/b.py": "def removed_name():\n    return 2\n",
            "incremental/README.md": "# unchanged\n",
        }
    )
    created = client.post(
        "/api/projects",
        files={"archive": ("incremental.zip", archive, "application/zip")},
    ).json()
    repository_root = next((tmp_path / "repositories").rglob("a.py")).parent
    (repository_root / "a.py").write_text(
        "import c\ndef changed_name():\n    return 3\n", encoding="utf-8"
    )
    (repository_root / "b.py").unlink()
    (repository_root / "c.py").write_text(
        "def added_name():\n    return 4\n", encoding="utf-8"
    )

    response = client.post(
        f"/api/projects/{created['id']}/incremental-reanalyze"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["added_file_count"] == 1
    assert body["changed_file_count"] == 1
    assert body["deleted_file_count"] == 1
    assert body["unchanged_file_count"] == 1
    assert body["parsed_file_count"] == 2
    assert body["added_paths"] == ["c.py"]
    assert body["changed_paths"] == ["a.py"]
    assert body["deleted_paths"] == ["b.py"]
    structure = client.get(f"/api/projects/{created['id']}/structure").json()
    symbol_names = {item["name"] for item in structure["symbols"]}
    assert symbol_names == {"changed_name", "added_name"}
    assert structure["resolved_import_count"] == 1

    unchanged = client.post(
        f"/api/projects/{created['id']}/incremental-reanalyze"
    ).json()
    assert unchanged["parsed_file_count"] == 0
    assert unchanged["unchanged_file_count"] == 3


def test_rejects_path_traversal_archive(client: TestClient) -> None:
    archive = make_archive({"../outside.py": "print('unsafe')\n"})

    response = client.post(
        "/api/projects",
        files={"archive": ("unsafe.zip", archive, "application/zip")},
    )

    assert response.status_code == 400
    assert "unsafe path" in response.json()["detail"]


def test_report_handles_parse_issues(client: TestClient) -> None:
    archive = make_archive({"broken/broken.py": "def broken(:\n    pass\n"})
    created = client.post(
        "/api/projects",
        files={"archive": ("broken.zip", archive, "application/zip")},
    ).json()

    report = client.get(f"/api/projects/{created['id']}/report.md")

    assert report.status_code == 200
    assert "## 6. 解析问题" in report.text
    assert "broken.py" in report.text
    issues = client.get(f"/api/projects/{created['id']}/issues", params={"limit": 1})
    assert issues.status_code == 200
    assert issues.json()["total"] >= 1
    assert issues.json()["items"][0]["file_path"] == "broken.py"


def test_configures_report_providers_from_the_api(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    ollama = client.put(
        "/api/projects/report-generators/ollama",
        json={"base_url": "http://127.0.0.1:11434", "model": "local-code-model"},
    )
    assert ollama.status_code == 200
    assert ollama.json()["configured"] is True
    assert ollama.json()["available"] is True
    assert ollama.json()["model"] == "local-code-model"

    openai = client.put(
        "/api/projects/report-generators/openai-compatible",
        json={
            "base_url": "https://api.openai.com/v1",
            "model": "configured-model",
            "api_key": "secret-test-key",
        },
    )
    assert openai.status_code == 200
    assert openai.json()["has_api_key"] is True
    assert "api_key" not in openai.json()
    listed = client.get("/api/projects/report-generators").json()
    assert "secret-test-key" not in str(listed)

    provider = ollama.json() | {
        "connection_status": "success",
        "connection_message": "连接成功",
    }
    monkeypatch.setattr(
        project_routes,
        "test_report_provider",
        lambda settings, provider_id: {"ok": True, "message": "连接成功", "provider": provider},
    )
    tested = client.post("/api/projects/report-generators/ollama/test")
    assert tested.status_code == 200
    assert tested.json()["ok"] is True


def test_imports_local_folder(client: TestClient) -> None:
    response = client.post(
        "/api/projects/folder",
        files=[
            (
                "files",
                (
                    "sample/src/main.ts",
                    b"import { answer } from './utils';\nexport const read = () => answer;\n",
                    "text/plain",
                ),
            ),
            ("files", ("sample/src/utils.ts", b"export const answer = 42;\n", "text/plain")),
            ("files", ("sample/README.md", b"# Sample\n", "text/markdown")),
        ],
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "sample"
    assert body["source_filename"] == "sample/"
    assert body["primary_language"] == "TypeScript"
    assert {item["relative_path"] for item in body["files"]} == {
        "src/main.ts",
        "src/utils.ts",
        "README.md",
    }

    structure = client.get(f"/api/projects/{body['id']}/structure")
    assert structure.status_code == 200
    analysis = structure.json()
    assert analysis["function_count"] == 1
    assert analysis["import_count"] == 1
    assert analysis["resolved_import_count"] == 1
    assert analysis["symbols"][0]["name"] == "read"
    assert analysis["symbols"][0]["file_path"] == "src/main.ts"

    reanalyzed = client.post(f"/api/projects/{body['id']}/reanalyze")
    assert reanalyzed.status_code == 200
    assert reanalyzed.json()["symbol_count"] == analysis["symbol_count"]

    graph = client.get(f"/api/projects/{body['id']}/dependency-graph")
    assert graph.status_code == 200
    graph_body = graph.json()
    assert graph_body["total_node_count"] == 2
    assert graph_body["total_edge_count"] == 1
    assert graph_body["internal_import_count"] == 1
    assert graph_body["cycle_count"] == 0
    assert graph_body["edges"][0]["source_path"] == "src/main.ts"
    assert graph_body["edges"][0]["target_path"] == "src/utils.ts"


def test_detects_python_dependency_cycle(client: TestClient) -> None:
    archive = make_archive(
        {
            "cycle/main.py": "import alpha\n",
            "cycle/alpha.py": "import beta\n",
            "cycle/beta.py": "import alpha\n",
        }
    )
    created = client.post(
        "/api/projects",
        files={"archive": ("cycle.zip", archive, "application/zip")},
    )
    project_id = created.json()["id"]

    graph = client.get(f"/api/projects/{project_id}/dependency-graph")

    assert graph.status_code == 200
    body = graph.json()
    assert body["total_edge_count"] == 3
    assert body["cycle_count"] == 1
    assert set(body["cycles"][0]["paths"]) == {"alpha.py", "beta.py"}


def test_rejects_non_github_import_url(client: TestClient) -> None:
    response = client.post(
        "/api/projects/github",
        json={"url": "https://example.com/owner/repository"},
    )

    assert response.status_code == 400
    assert "github.com" in response.json()["detail"]


def test_imports_public_github_repository(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_download(repository: object, settings: Settings) -> Path:
        target = settings.repository_root / "mock-github" / "repo-main"
        target.mkdir(parents=True)
        (target / "main.py").write_text("print('github')\n", encoding="utf-8")
        return target

    monkeypatch.setattr(project_routes, "download_github_repository", fake_download)

    response = client.post(
        "/api/projects/github",
        json={"url": "https://github.com/openai/example.git"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "example"
    assert body["source_filename"] == "github.com/openai/example"
    assert body["primary_language"] == "Python"
