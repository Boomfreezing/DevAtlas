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

from app.api.routes import projects as project_routes
from app.core.config import Settings, get_settings
from app.core.database import Base, get_db
from app.main import app
from app.services import repository_path_service, repository_qa_service, search_service
from app.services.analysis_cache import analysis_cache_stats, clear_analysis_cache
from app.services.github_service import GitHubComparison, GitHubMetadata


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
        search_index_root=tmp_path / "indexes",
        semantic_search_enabled=False,
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


def test_analysis_snapshots_can_be_created_compared_and_deleted(client: TestClient) -> None:
    archive = make_archive(
        {"snapshot/main.py": "def oversized():\n" + "    value = 1\n" * 90}
    )
    created = client.post(
        "/api/projects",
        files={"archive": ("snapshot.zip", archive, "application/zip")},
    )
    project_id = created.json()["id"]

    initial = client.get(f"/api/projects/{project_id}/snapshots")
    assert initial.status_code == 200
    assert len(initial.json()) == 1
    assert initial.json()[0]["reason"] == "import"

    manual = client.post(
        f"/api/projects/{project_id}/snapshots",
        json={"label": "重构前"},
    )
    assert manual.status_code == 201
    assert manual.json()["label"] == "重构前"
    assert manual.json()["finding_count"] >= 1

    comparison = client.get(
        f"/api/projects/{project_id}/snapshots/compare",
        params={"base_id": initial.json()[0]["id"], "target_id": manual.json()["id"]},
    )
    assert comparison.status_code == 200
    body = comparison.json()
    assert body["metric_changes"][0]["key"] == "score"
    assert body["quality"]["new_count"] == 0
    assert body["quality"]["fixed_count"] == 0
    assert body["quality"]["persistent_count"] >= 1

    deleted = client.delete(
        f"/api/projects/{project_id}/snapshots/{manual.json()['id']}"
    )
    assert deleted.status_code == 204
    assert len(client.get(f"/api/projects/{project_id}/snapshots").json()) == 1


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
    assert quality.json()["scoring"]["model"] == "source_scope_weighted_size_normalized_v4"
    assert quality.json()["scoring"]["adjusted_penalty"] == 0
    assert quality.json()["scope_scores"]["test"]["score"] is None
    assert quality.json()["scope_scores"]["test"]["available"] is False

    report = client.get(f"/api/projects/{body['id']}/report.md")
    assert report.status_code == 200
    assert report.headers["content-type"].startswith("text/markdown")
    assert report.headers["content-disposition"].endswith(
        f'devatlas-project-{body["id"]}-summary-report.md"'
    )
    assert "# demo 代码仓库分析报告" in report.text
    assert "无需大模型" in report.text
    assert "| 函数 / 方法 | 1 |" in report.text
    assert "## 2. 智能分析结论" in report.text
    assert "**项目画像：**" in report.text
    assert "评分采用项目规模归一化" in report.text
    assert "报告模式：摘要报告" in report.text
    assert "当前项目未绑定可验证的 Git Commit" in report.text
    assert "### 风险范围分布" in report.text
    assert "### 重点风险模块" in report.text
    assert "| 风险等级 | 数量 |" in report.text
    assert "| 高风险 | 0 |" in report.text
    assert "| 错误 |" not in report.text

    generators = client.get("/api/projects/report-generators")
    assert generators.status_code == 200
    assert generators.json()[0]["id"] == "local"
    assert generators.json()[0]["available"] is True
    assert generators.json()[0]["cost_label"] == "免费 · 默认"
    assert generators.json()[1]["available"] is False

    preview = client.get(f"/api/projects/{body['id']}/report?generator=local")
    assert preview.status_code == 200
    assert preview.json()["generator"] == "local"
    assert preview.json()["mode"] == "summary"
    assert preview.json()["filename"].endswith(".md")
    assert "智能分析结论" in preview.json()["content"]

    full_preview = client.get(
        f"/api/projects/{body['id']}/report", params={"generator": "local", "mode": "full"}
    )
    assert full_preview.status_code == 200
    assert full_preview.json()["mode"] == "full"
    assert full_preview.json()["filename"].endswith("-full-report.md")
    assert "报告模式：完整报告" in full_preview.json()["content"]
    assert client.get(
        f"/api/projects/{body['id']}/report", params={"mode": "invalid"}
    ).status_code == 422

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


def test_code_search_uses_inferred_concepts_for_api_routes(client: TestClient) -> None:
    archive = make_archive(
        {
            "concept-search/routes.py": (
                "from fastapi import APIRouter\n\n"
                "router = APIRouter()\n\n"
                "@router.post('/archives')\n"
                "def store_archive(payload):\n"
                "    return payload\n"
            ),
            "concept-search/math_utils.py": "def add(left, right):\n    return left + right\n",
        }
    )
    created = client.post(
        "/api/projects",
        files={"archive": ("concept-search.zip", archive, "application/zip")},
    ).json()

    response = client.get(
        f"/api/projects/{created['id']}/search",
        params={"q": "接口路由", "limit": 5},
    )

    assert response.status_code == 200
    assert response.json()["results"][0]["file_path"] == "routes.py"
    assert "@router.post('/archives')" in response.json()["results"][0]["snippet"]


def test_search_index_persists_across_memory_cache_resets(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = make_archive(
        {
            "persistent-search/main.py": (
                "def persistent_lookup():\n"
                "    return 'restart-safe-index-token'\n"
            )
        }
    )
    created = client.post(
        "/api/projects",
        files={"archive": ("persistent-search.zip", archive, "application/zip")},
    ).json()
    index_files = list((tmp_path / "indexes").glob("*.json.gz"))
    assert len(index_files) == 1
    assert index_files[0].stat().st_size > 0

    search_service._SEARCH_CACHE.clear()

    def fail_runtime_rebuild(*args: object, **kwargs: object) -> object:
        raise AssertionError("persisted index should be loaded instead of retokenizing")

    monkeypatch.setattr(search_service, "_build_runtime_search_index", fail_runtime_rebuild)
    response = client.get(
        f"/api/projects/{created['id']}/search",
        params={"q": "restart-safe-index-token"},
    )

    assert response.status_code == 200
    assert response.json()["total_matches"] >= 1
    assert response.json()["results"][0]["file_path"] == "main.py"

    assert client.delete(f"/api/projects/{created['id']}").status_code == 204
    assert list((tmp_path / "indexes").glob("*.json.gz")) == []


def test_repository_questions_require_generation_provider_and_return_source_citations(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = make_archive(
        {
            "qa-demo/README.md": "# QA Demo\n\nRun the project with `npm run dev`.\n",
            "qa-demo/package.json": '{\n  "scripts": {\n    "dev": "vite",\n    "start": "node server.js"\n  }\n}\n',
            "qa-demo/models.py": (
                "class User:\n"
                "    __tablename__ = \"users\"\n"
            ),
            "qa-demo/auth.py": (
                "from models import User\n\n"
                "def login_user(username, password):\n"
                "    token = create_access_token(username)\n"
                "    return token, User.__tablename__\n"
            ),
            "qa-demo/service.py": (
                "from auth import login_user\n\n"
                "def create_session(username, password):\n"
                "    return login_user(username, password)\n"
            ),
            "qa-demo/tests/test_auth.py": (
                "from auth import login_user\n\n"
                "def test_login_user():\n"
                "    assert login_user('demo', 'secret')\n"
            ),
            "qa-demo/upload.py": (
                "def store_archive(payload):\n"
                "    # 接收并保存用户上传的压缩文件\n"
                "    return payload\n"
            ),
        }
    )
    created = client.post(
        "/api/projects",
        files={"archive": ("qa-demo.zip", archive, "application/zip")},
    ).json()
    project_id = created["id"]

    missing_provider = client.post(
        f"/api/projects/{project_id}/ask",
        json={"question": "这个项目如何启动？"},
    )
    assert missing_provider.status_code == 422

    local_provider = client.post(
        f"/api/projects/{project_id}/ask",
        json={"question": "这个项目如何启动？", "provider": "local"},
    )
    assert local_provider.status_code == 400
    assert "必须选择已配置的生成模型" in local_provider.json()["detail"]

    configured = client.put(
        "/api/projects/report-generators/ollama",
        json={"base_url": "http://127.0.0.1:11434", "model": "code-model"},
    )
    assert configured.status_code == 200

    generated_answers: list[dict[str, object]] = []

    def fake_model_answer(
        settings: Settings,
        provider_id: str,
        *,
        question: str,
        evidence: str,
        history: list[dict[str, str]],
    ) -> str:
        generated_answers.append(
            {"provider": provider_id, "question": question, "evidence": evidence, "history": history}
        )
        return "这是生成模型基于仓库证据给出的回答。[1]"

    monkeypatch.setattr(repository_qa_service, "answer_with_report_provider", fake_model_answer)

    startup = client.post(
        f"/api/projects/{project_id}/ask",
        json={"question": "这个项目如何启动？", "provider": "ollama", "history": []},
    )
    assert startup.status_code == 200
    startup_body = startup.json()
    assert startup_body["provider"] == "ollama"
    assert startup_body["engine_name"] == "ollama"
    assert startup_body["evidence_count"] >= 1
    assert startup_body["reference_count"] == 1
    assert startup_body["confidence"] == "high"
    assert startup_body["grounding_status"] == "grounded"
    assert any(item["file_path"] == "README.md" for item in startup_body["citations"])
    assert startup_body["answer"].startswith("这是生成模型")
    assert generated_answers[-1]["provider"] == "ollama"
    assert "README.md" in str(generated_answers[-1]["evidence"])

    login = client.post(
        f"/api/projects/{project_id}/ask",
        json={"question": "登录功能 login_user 在哪里？", "provider": "ollama"},
    )
    assert login.status_code == 200
    login_body = login.json()
    citation = next(item for item in login_body["citations"] if item["file_path"] == "auth.py")
    assert citation["start_line"] == 3
    assert citation["end_line"] >= 1
    assert "login_user" in citation["snippet"]

    fuzzy_symbol = client.post(
        f"/api/projects/{project_id}/ask",
        json={"question": "login_usr 在哪里？", "provider": "ollama"},
    )
    assert fuzzy_symbol.status_code == 200
    assert any(
        item["file_path"] == "auth.py" and item["source"] == "symbol_fuzzy"
        for item in fuzzy_symbol.json()["citations"]
    )

    fuzzy_chinese = client.post(
        f"/api/projects/{project_id}/ask",
        json={"question": "项目在哪里处理文件上传？", "provider": "ollama"},
    )
    assert fuzzy_chinese.status_code == 200
    assert any(item["file_path"] == "upload.py" for item in fuzzy_chinese.json()["citations"])

    database_answer = client.post(
        f"/api/projects/{project_id}/ask",
        json={"question": "login_user 接口最后访问哪张表？", "provider": "ollama"},
    )
    assert database_answer.status_code == 200
    assert any(item["file_path"] == "models.py" for item in database_answer.json()["citations"])

    impact = client.post(
        f"/api/projects/{project_id}/ask",
        json={"question": "修改 login_user 会影响什么？", "provider": "ollama"},
    )
    assert impact.status_code == 200
    impact_body = impact.json()
    assert any(item["source"] == "dependency_relation" for item in impact_body["citations"])
    assert any(item["file_path"] == "tests/test_auth.py" for item in impact_body["citations"])
    assert len(generated_answers) == 6

    unsupported = client.post(
        f"/api/projects/{project_id}/ask",
        json={"question": "quantum_flux_controller_x91 在哪里？", "provider": "ollama"},
    )
    assert unsupported.status_code == 200
    assert unsupported.json()["evidence_count"] == 0
    assert unsupported.json()["citations"] == []
    assert unsupported.json()["confidence"] == "low"
    assert unsupported.json()["grounding_status"] == "insufficient"
    assert "[EVIDENCE_INSUFFICIENT]" in unsupported.json()["answer"]
    assert len(generated_answers) == 6

    assert client.post(
        f"/api/projects/{project_id}/ask",
        json={"question": "项目做什么？", "provider": "missing"},
    ).status_code == 400


def test_refreshes_and_returns_github_commit_metadata(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = client.post(
        "/api/projects",
        files={"archive": ("git-demo.zip", make_archive({"git-demo/main.py": "pass\n"}), "application/zip")},
    ).json()
    project_id = created["id"]
    unavailable = client.get(f"/api/projects/{project_id}/git-summary")
    assert unavailable.status_code == 200
    assert unavailable.json()["available"] is False
    assert unavailable.json()["refreshable"] is False

    with sqlite3.connect(tmp_path / "test.db") as connection:
        connection.execute(
            "UPDATE projects SET source_filename = ? WHERE id = ?",
            ("github.com/openai/example", project_id),
        )
        connection.commit()

    async def fake_metadata(repository: object) -> GitHubMetadata:
        return GitHubMetadata(
            repository_url="https://github.com/openai/example",
            default_branch="main",
            head_commit="c" * 40,
            recent_commits=[
                {
                    "sha": "c" * 40,
                    "message": "feat: add git metadata",
                    "author": "Lin",
                    "authored_at": "2026-08-28T12:00:00Z",
                }
            ],
        )

    monkeypatch.setattr(project_routes, "fetch_github_metadata", fake_metadata)
    refreshed = client.post(f"/api/projects/{project_id}/git-summary/refresh")

    assert refreshed.status_code == 200
    body = refreshed.json()
    assert body["available"] is True
    assert body["default_branch"] == "main"
    assert body["head_commit"] == "c" * 40
    assert body["recent_commits"][0]["message"] == "feat: add git metadata"

    report = client.get(f"/api/projects/{project_id}/report.md")
    assert report.status_code == 200
    assert "| Git 默认分支 | `main` |" in report.text
    assert f"| 源码 Commit | `{'c' * 40}` |" in report.text
    assert "远端产生新提交后需要重新同步和分析" in report.text

    async def fake_comparison(repository: object, base: str, head: str) -> GitHubComparison:
        return GitHubComparison(
            repository_url="https://github.com/openai/example",
            base_commit=base,
            head_commit=head,
            status="ahead",
            ahead_by=1,
            behind_by=0,
            total_commits=1,
            additions=9,
            deletions=2,
            changed_files=1,
            files=[{"path": "main.py", "status": "modified", "additions": 9, "deletions": 2, "changes": 11}],
            truncated=False,
        )

    monkeypatch.setattr(project_routes, "fetch_github_comparison", fake_comparison)
    compared = client.get(
        f"/api/projects/{project_id}/git-compare",
        params={"base": "a" * 40, "head": "c" * 40},
    )
    assert compared.status_code == 200
    assert compared.json()["files"][0] == {
        "path": "main.py",
        "status": "modified",
        "additions": 9,
        "deletions": 2,
        "changes": 11,
    }

    monkeypatch.setattr(project_routes, "run_github_sync_job", lambda *_args: None)
    queued = client.post(f"/api/projects/{project_id}/sync-github")
    assert queued.status_code == 202
    assert queued.json()["source_type"] == "github_sync"
    assert queued.json()["project_id"] == project_id
    duplicate = client.post(f"/api/projects/{project_id}/sync-github")
    assert duplicate.status_code == 202
    assert duplicate.json()["id"] == queued.json()["id"]


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
    assert "files" not in project.json()


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


def test_analysis_cache_is_invalidated_only_when_project_data_changes(
    client: TestClient, tmp_path: Path
) -> None:
    archive = make_archive({"cache/main.py": "def original():\n    return 1\n"})
    project_id = client.post(
        "/api/projects",
        files={"archive": ("cache.zip", archive, "application/zip")},
    ).json()["id"]
    clear_analysis_cache()

    assert client.get(f"/api/projects/{project_id}/quality").status_code == 200
    assert client.get(f"/api/projects/{project_id}/quality").status_code == 200
    assert analysis_cache_stats() == {"hits": 1, "misses": 1, "projects": 1}

    assert client.post(f"/api/projects/{project_id}/reanalyze").status_code == 200
    assert analysis_cache_stats()["projects"] == 0
    assert client.get(f"/api/projects/{project_id}/quality").status_code == 200
    assert analysis_cache_stats()["misses"] == 2

    unchanged = client.post(f"/api/projects/{project_id}/incremental-reanalyze")
    assert unchanged.json()["parsed_file_count"] == 0
    assert analysis_cache_stats()["projects"] == 1
    assert client.get(f"/api/projects/{project_id}/quality").status_code == 200
    assert analysis_cache_stats()["hits"] == 2

    source_file = next((tmp_path / "repositories").rglob("main.py"))
    source_file.write_text("def changed():\n    return 2\n", encoding="utf-8")
    changed = client.post(f"/api/projects/{project_id}/incremental-reanalyze")
    assert changed.json()["changed_file_count"] == 1
    assert analysis_cache_stats()["projects"] == 0

    assert client.get(f"/api/projects/{project_id}/quality").status_code == 200
    assert analysis_cache_stats()["misses"] == 3
    assert client.delete(f"/api/projects/{project_id}").status_code == 204
    assert analysis_cache_stats()["projects"] == 0


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

    additional_providers = [
        ("openai-chat-compatible", "https://api.deepseek.com", "deepseek-chat"),
        ("anthropic", "https://api.anthropic.com/v1", "claude-sonnet"),
        ("gemini", "https://generativelanguage.googleapis.com/v1beta", "gemini-flash"),
    ]
    for provider_id, base_url, model in additional_providers:
        configured = client.put(
            f"/api/projects/report-generators/{provider_id}",
            json={"base_url": base_url, "model": model, "api_key": "provider-secret"},
        )
        assert configured.status_code == 200
        assert configured.json()["configured"] is True
        assert configured.json()["has_api_key"] is True
        assert "api_key" not in configured.json()

    listed = client.get("/api/projects/report-generators").json()
    assert "secret-test-key" not in str(listed)
    assert "provider-secret" not in str(listed)
    assert {item["id"] for item in listed} >= {
        "local",
        "ollama",
        "openai-compatible",
        "openai-chat-compatible",
        "anthropic",
        "gemini",
    }

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

    root_tree = client.get(f"/api/projects/{body['id']}/files/tree")
    assert root_tree.status_code == 200
    assert root_tree.json()["total_files"] == 3
    assert [(item["kind"], item["name"], item["file_count"]) for item in root_tree.json()["items"]] == [
        ("directory", "src", 2),
        ("file", "README.md", 1),
    ]
    src_tree = client.get(
        f"/api/projects/{body['id']}/files/tree", params={"path": "src"}
    )
    assert src_tree.status_code == 200
    assert [item["path"] for item in src_tree.json()["items"]] == [
        "src/main.ts",
        "src/utils.ts",
    ]
    assert all(item["id"] for item in src_tree.json()["items"])
    assert client.get(
        f"/api/projects/{body['id']}/files/tree", params={"path": "missing"}
    ).status_code == 404
    assert client.get(
        f"/api/projects/{body['id']}/files/tree", params={"path": "../outside"}
    ).status_code == 400

    reanalyzed = client.post(f"/api/projects/{body['id']}/reanalyze")
    assert reanalyzed.status_code == 200
    assert reanalyzed.json()["symbol_count"] == analysis["symbol_count"]

    graph = client.get(f"/api/projects/{body['id']}/dependency-graph")
    assert graph.status_code == 200
    graph_body = graph.json()
    assert graph_body["total_node_count"] == 2
    assert graph_body["total_edge_count"] == 1
    assert graph_body["internal_import_count"] == 1
    assert graph_body["unresolved_import_count"] == 0
    assert graph_body["classification_confidence"] == 100
    assert graph_body["confidence_level"] == "high"
    assert graph_body["cycle_count"] == 0
    assert graph_body["edges"][0]["source_path"] == "src/main.ts"
    assert graph_body["edges"][0]["target_path"] == "src/utils.ts"


def test_detects_python_dependency_cycle(client: TestClient) -> None:
    clear_analysis_cache()
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

    focused = client.get(
        f"/api/projects/{project_id}/dependency-graph",
        params={"cycle": 1, "limit": 5},
    )
    assert focused.status_code == 200
    focused_body = focused.json()
    assert {node["path"] for node in focused_body["nodes"]} == {"alpha.py", "beta.py"}
    assert {(edge["source_path"], edge["target_path"]) for edge in focused_body["edges"]} == {
        ("alpha.py", "beta.py"),
        ("beta.py", "alpha.py"),
    }
    assert focused_body["truncated"] is False
    assert analysis_cache_stats() == {"hits": 1, "misses": 1, "projects": 1}
    assert client.get(
        f"/api/projects/{project_id}/dependency-graph", params={"cycle": 2}
    ).status_code == 404


def test_exposes_change_impact_targets_and_report(client: TestClient) -> None:
    archive = make_archive(
        {
            "impact/app/main.py": "from service import calculate\n\ndef run():\n    return calculate()\n",
            "impact/service.py": "def calculate():\n    return 42\n",
            "impact/tests/test_service.py": "from service import calculate\n\ndef test_calculate():\n    assert calculate() == 42\n",
        }
    )
    created = client.post(
        "/api/projects",
        files={"archive": ("impact.zip", archive, "application/zip")},
    ).json()
    project_id = created["id"]

    target_response = client.get(
        f"/api/projects/{project_id}/impact-targets", params={"q": "calculate"}
    )
    assert target_response.status_code == 200
    symbol_target = next(
        item for item in target_response.json() if item["target_type"] == "symbol"
    )

    impact_response = client.get(
        f"/api/projects/{project_id}/impact",
        params={"target_type": "symbol", "target_id": symbol_target["target_id"]},
    )
    assert impact_response.status_code == 200
    impact = impact_response.json()
    assert impact["target"]["name"] == "calculate"
    assert {item["file_path"] for item in impact["direct_callers"]} == {
        "app/main.py",
        "tests/test_service.py",
    }
    assert impact["related_tests"][0]["file_path"] == "tests/test_service.py"
    assert impact["risk"]["confidence"] == "medium"
    assert client.get(
        f"/api/projects/{project_id}/impact",
        params={"target_type": "file", "target_id": 999999},
    ).status_code == 404


def test_resolves_typescript_aliases_base_url_and_jsonc_config(
    client: TestClient,
) -> None:
    archive = make_archive(
        {
            "aliases/tsconfig.json": """{
              // Alias paths are relative to baseUrl.
              "compilerOptions": {
                "baseUrl": ".",
                "paths": {
                  "@/*": ["src/*"],
                  "@core": ["src/core/index.ts"],
                },
              },
            }
            """,
            "aliases/src/main.ts": """
import { answer } from '@/utils';
import { settings } from 'src/config';
import { core } from '@core';
import React from 'react';
export const run = () => answer + settings + core;
""",
            "aliases/src/utils.ts": "export const answer = 40;\n",
            "aliases/src/config.ts": "export const settings = 1;\n",
            "aliases/src/core/index.ts": "export const core = 1;\n",
        }
    )
    created = client.post(
        "/api/projects",
        files={"archive": ("aliases.zip", archive, "application/zip")},
    ).json()

    structure = client.get(f"/api/projects/{created['id']}/structure").json()
    assert structure["import_count"] == 4
    assert structure["resolved_import_count"] == 3
    resolved_targets = {
        item["target_module"] for item in structure["imports"] if item["resolved_file_id"]
    }
    assert resolved_targets == {"@/utils", "src/config", "@core"}

    graph = client.get(f"/api/projects/{created['id']}/dependency-graph").json()
    assert graph["internal_import_count"] == 3
    assert graph["external_import_count"] == 1
    assert graph["unresolved_import_count"] == 0


def test_resolves_python_imports_below_a_conventional_source_root(
    client: TestClient,
) -> None:
    archive = make_archive(
        {
            "python-root/backend/app/main.py": "import app.services.user\n",
            "python-root/backend/app/services/user.py": "def load_user():\n    return 1\n",
        }
    )
    created = client.post(
        "/api/projects",
        files={"archive": ("python-root.zip", archive, "application/zip")},
    ).json()

    structure = client.get(f"/api/projects/{created['id']}/structure").json()
    assert structure["import_count"] == 1
    assert structure["resolved_import_count"] == 1
    assert structure["imports"][0]["target_module"] == "app.services.user"


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
