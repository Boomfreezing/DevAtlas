import asyncio
import io
import zipfile
from pathlib import Path

import httpx
import pytest

from app.core.config import Settings
from app.services import github_service
from app.services.github_service import (
    GitHubDownloadError,
    GitHubValidationError,
    download_github_repository,
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


def test_downloads_and_extracts_github_archive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
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

    extracted = asyncio.run(download_github_repository(repository, settings))

    assert extracted.name == "repository-main"
    assert (extracted / "src" / "main.py").read_text(encoding="utf-8") == "print('downloaded')\n"
    assert Path(captured_directory["dir"]) == settings.temporary_root
    assert list(settings.temporary_root.iterdir()) == []


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
