import asyncio
import io
import zipfile
from pathlib import Path

import httpx
import pytest

from app.core.config import Settings
from app.services import github_service
from app.services.github_service import (
    GitHubComparison,
    GitHubDownloadError,
    GitHubMetadata,
    GitHubValidationError,
    download_github_repository,
    fetch_github_comparison,
    fetch_github_metadata,
    parse_github_repository,
)


def test_parses_github_repository_root_url() -> None:
    repository = parse_github_repository("https://github.com/openai/openai-python.git")

    assert repository.owner == "openai"
    assert repository.name == "openai-python"
    assert repository.archive_url == "https://github.com/openai/openai-python/archive/HEAD.zip"


@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/openai/openai-python",
        "https://example.com/openai/openai-python",
        "https://github.com/openai/openai-python/tree/main",
        "https://github.com/openai/openai-python?tab=readme",
        "https://user:password@github.com/openai/openai-python",
    ],
)
def test_rejects_unsafe_or_non_root_github_urls(url: str) -> None:
    with pytest.raises(GitHubValidationError):
        parse_github_repository(url)


def make_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("repository-main/src/main.py", "print('downloaded')\n")
    return buffer.getvalue()


class FakeResponse:
    def __init__(self, status_code: int, content: bytes = b"") -> None:
        self.status_code = status_code
        self.content = content
        self.url = httpx.URL("https://codeload.github.com/openai/example/zip/HEAD")

    async def __aenter__(self) -> "FakeResponse":
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "download failed",
                request=httpx.Request("GET", "https://github.com/openai/example"),
                response=httpx.Response(self.status_code),
            )

    async def aiter_bytes(self, _: int):
        yield self.content


class FakeClient:
    response = FakeResponse(200, make_zip())

    def __init__(self, **_: object) -> None:
        pass

    async def __aenter__(self) -> "FakeClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    def stream(self, *_: object, **__: object) -> FakeResponse:
        return self.response


class ConnectionFailingClient(FakeClient):
    def stream(self, *_: object, **__: object) -> FakeResponse:
        raise httpx.ConnectError(
            "[WinError 10013] socket access was denied",
            request=httpx.Request("GET", "https://github.com/openai/example"),
        )


class FakeMetadataClient:
    def __init__(self, **_: object) -> None:
        pass

    async def __aenter__(self) -> "FakeMetadataClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def get(self, url: str, **_: object) -> httpx.Response:
        request = httpx.Request("GET", url)
        if "/compare/" in url:
            return httpx.Response(
                200,
                request=request,
                json={
                    "status": "ahead",
                    "ahead_by": 2,
                    "behind_by": 0,
                    "total_commits": 2,
                    "files": [
                        {"filename": "src/app.py", "status": "modified", "additions": 12, "deletions": 3, "changes": 15},
                        {"filename": "tests/test_app.py", "status": "added", "additions": 8, "deletions": 0, "changes": 8},
                    ],
                },
            )
        if url.endswith("/commits"):
            return httpx.Response(
                200,
                request=request,
                json=[
                    {
                        "sha": "a" * 40,
                        "commit": {
                            "message": "feat: add repository analysis\n\nbody",
                            "author": {"name": "Ada", "date": "2026-08-28T10:00:00Z"},
                        },
                    }
                ],
            )
        return httpx.Response(200, request=request, json={"default_branch": "main"})


def test_loads_bounded_github_commit_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(github_service.httpx, "AsyncClient", FakeMetadataClient)

    metadata = asyncio.run(
        fetch_github_metadata(parse_github_repository("https://github.com/openai/example"))
    )

    assert isinstance(metadata, GitHubMetadata)
    assert metadata.default_branch == "main"
    assert metadata.head_commit == "a" * 40
    assert metadata.recent_commits[0] == {
        "sha": "a" * 40,
        "message": "feat: add repository analysis",
        "author": "Ada",
        "authored_at": "2026-08-28T10:00:00Z",
    }


def test_compares_two_full_commit_shas_without_cloning(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(github_service.httpx, "AsyncClient", FakeMetadataClient)

    comparison = asyncio.run(
        fetch_github_comparison(
            parse_github_repository("https://github.com/openai/example"),
            "a" * 40,
            "b" * 40,
        )
    )

    assert isinstance(comparison, GitHubComparison)
    assert comparison.total_commits == 2
    assert comparison.additions == 20
    assert comparison.deletions == 3
    assert comparison.changed_files == 2
    assert comparison.files[0]["path"] == "src/app.py"


@pytest.mark.parametrize("commit_sha", [None, "B" * 40])
def test_downloads_and_extracts_github_archive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, commit_sha: str | None
) -> None:
    settings = Settings(
        repository_root=tmp_path / "repositories",
        temporary_root=tmp_path / "temporary",
    )
    settings.ensure_directories()
    repository = parse_github_repository("https://github.com/openai/example")
    FakeClient.response = FakeResponse(200, make_zip())
    monkeypatch.setattr(github_service.httpx, "AsyncClient", FakeClient)
    original_named_temporary_file = github_service.tempfile.NamedTemporaryFile
    captured_directory: dict[str, object] = {}

    def managed_temporary_file(**options: object):
        captured_directory["dir"] = options.get("dir")
        return original_named_temporary_file(**options)

    monkeypatch.setattr(
        github_service.tempfile, "NamedTemporaryFile", managed_temporary_file
    )

    captured_urls: list[str] = []

    def capture_stream(self: FakeClient, method: str, url: str) -> FakeResponse:
        captured_urls.append(url)
        return self.response

    monkeypatch.setattr(FakeClient, "stream", capture_stream)
    extracted = asyncio.run(download_github_repository(repository, settings, commit_sha=commit_sha))
    revision = commit_sha.lower() if commit_sha else "HEAD"
    assert captured_urls == [f"https://github.com/openai/example/archive/{revision}.zip"]

    assert extracted.name == "repository-main"
    assert (extracted / "src" / "main.py").read_text(encoding="utf-8") == "print('downloaded')\n"
    assert Path(captured_directory["dir"]) == settings.temporary_root
    assert list(settings.temporary_root.iterdir()) == []


@pytest.mark.parametrize("commit_sha", ["main", "../main", "a" * 39])
def test_rejects_unpinned_download_revision(tmp_path: Path, commit_sha: str) -> None:
    settings = Settings(temporary_root=tmp_path / "temporary")
    with pytest.raises(GitHubValidationError, match="full Git commit SHA"):
        asyncio.run(download_github_repository(
            parse_github_repository("https://github.com/example/demo"), settings,
            commit_sha=commit_sha,
        ))
    assert not settings.temporary_root.exists()


def test_metadata_supports_slash_branches_and_empty_commit_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class SlashBranchClient(FakeMetadataClient):
        async def get(self, url: str, **options: object) -> httpx.Response:
            if url.endswith("/commits"):
                assert options["params"]["sha"] == "release/1.x"
                payload = [{"sha": "c" * 40, "commit": {"message": ""}}]
            else:
                payload = {"default_branch": "release/1.x"}
            return httpx.Response(200, request=httpx.Request("GET", url), json=payload)

    monkeypatch.setattr(github_service.httpx, "AsyncClient", SlashBranchClient)
    metadata = asyncio.run(fetch_github_metadata(
        parse_github_repository("https://github.com/example/demo")
    ))
    assert metadata.default_branch == "release/1.x"
    assert metadata.recent_commits[0]["message"] == "No commit message"


def test_reports_missing_github_repository(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(repository_root=tmp_path / "repositories")
    settings.ensure_directories()
    repository = parse_github_repository("https://github.com/openai/missing")
    FakeClient.response = FakeResponse(404)
    monkeypatch.setattr(github_service.httpx, "AsyncClient", FakeClient)

    with pytest.raises(GitHubDownloadError, match="not found"):
        asyncio.run(download_github_repository(repository, settings))


def test_reports_github_connection_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(repository_root=tmp_path / "repositories")
    settings.ensure_directories()
    repository = parse_github_repository("https://github.com/openai/example")
    monkeypatch.setattr(github_service.httpx, "AsyncClient", ConnectionFailingClient)

    with pytest.raises(GitHubDownloadError, match="external network permission") as error:
        asyncio.run(download_github_repository(repository, settings))

    assert "WinError 10013" in str(error.value)


def test_reports_github_access_rejection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(repository_root=tmp_path / "repositories")
    settings.ensure_directories()
    repository = parse_github_repository("https://github.com/openai/private-example")
    FakeClient.response = FakeResponse(403)
    monkeypatch.setattr(github_service.httpx, "AsyncClient", FakeClient)

    with pytest.raises(GitHubDownloadError, match="private"):
        asyncio.run(download_github_repository(repository, settings))
