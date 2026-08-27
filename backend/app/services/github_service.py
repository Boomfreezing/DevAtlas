import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import httpx

from app.core.config import Settings
from app.services.archive_service import ArchiveValidationError, extract_archive_path


GITHUB_HOSTS = {"github.com", "www.github.com"}
GITHUB_DOWNLOAD_HOSTS = GITHUB_HOSTS | {"codeload.github.com"}
REPOSITORY_PART = re.compile(r"^[A-Za-z0-9_.-]+$")


class GitHubValidationError(ValueError):
    pass


class GitHubDownloadError(RuntimeError):
    pass


@dataclass(frozen=True)
class GitHubRepository:
    owner: str
    name: str

    @property
    def archive_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.name}/archive/HEAD.zip"

    @property
    def display_source(self) -> str:
        return f"github.com/{self.owner}/{self.name}"


def parse_github_repository(url: str) -> GitHubRepository:
    value = url.strip()
    if not value:
        raise GitHubValidationError("Enter a GitHub repository URL.")

    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname not in GITHUB_HOSTS:
        raise GitHubValidationError("Only HTTPS links from github.com are supported.")
    if parsed.username or parsed.password or parsed.port or parsed.query or parsed.fragment:
        raise GitHubValidationError("The GitHub URL contains unsupported components.")

    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 2:
        raise GitHubValidationError("Use a repository root URL such as https://github.com/owner/repo.")

    owner, name = parts
    if name.endswith(".git"):
        name = name[:-4]
    if not REPOSITORY_PART.fullmatch(owner) or not REPOSITORY_PART.fullmatch(name):
        raise GitHubValidationError("The GitHub owner or repository name is invalid.")
    return GitHubRepository(owner=owner, name=name)


async def download_github_repository(
    repository: GitHubRepository, settings: Settings
) -> Path:
    temporary_path: Path | None = None
    try:
        settings.temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            suffix=".zip", delete=False, dir=settings.temporary_root
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            total_bytes = 0
            timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)
            async with httpx.AsyncClient(
                follow_redirects=True,
                timeout=timeout,
                headers={"User-Agent": "DevAtlas/0.2"},
            ) as client:
                async with client.stream("GET", repository.archive_url) as response:
                    if response.status_code == 404:
                        raise GitHubDownloadError("The public GitHub repository was not found.")
                    response.raise_for_status()
                    if response.url.host not in GITHUB_DOWNLOAD_HOSTS:
                        raise GitHubDownloadError("GitHub redirected the download to an unexpected host.")

                    async for chunk in response.aiter_bytes(1024 * 1024):
                        total_bytes += len(chunk)
                        if total_bytes > settings.max_upload_bytes:
                            raise GitHubDownloadError(
                                f"Repository archive exceeds the {settings.max_upload_mb} MB limit."
                            )
                        temporary_file.write(chunk)

        return extract_archive_path(temporary_path, settings)
    except GitHubDownloadError:
        raise
    except httpx.TimeoutException as error:
        raise GitHubDownloadError(
            "GitHub download timed out. Check the network and try again."
        ) from error
    except httpx.ConnectError as error:
        detail = str(error).strip()
        suffix = f" Details: {detail}" if detail else ""
        raise GitHubDownloadError(
            "Cannot connect to GitHub. Check the network or the backend's external "
            f"network permission.{suffix}"
        ) from error
    except httpx.HTTPStatusError as error:
        status_code = error.response.status_code
        if status_code in {401, 403}:
            message = (
                "GitHub rejected the download. The repository may be private, "
                "or anonymous downloads may be rate-limited."
            )
        elif status_code == 429:
            message = "GitHub download rate limit reached. Wait a moment and try again."
        elif status_code >= 500:
            message = "GitHub is temporarily unavailable. Try again later."
        else:
            message = f"GitHub returned HTTP {status_code} while downloading the repository."
        raise GitHubDownloadError(message) from error
    except ArchiveValidationError as error:
        raise GitHubDownloadError(
            f"GitHub returned an invalid repository archive: {error}"
        ) from error
    except httpx.HTTPError as error:
        raise GitHubDownloadError(f"GitHub download failed: {error}") from error
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
