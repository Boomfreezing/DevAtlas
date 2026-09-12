import asyncio
import re
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import BinaryIO
from urllib.parse import urlparse

import httpx

from app.core.config import Settings
from app.services.archive_service import ArchiveValidationError, extract_archive_path

GITHUB_HOSTS = {"github.com", "www.github.com"}
GITHUB_DOWNLOAD_HOSTS = GITHUB_HOSTS | {"codeload.github.com"}
GITHUB_API_HOST = "api.github.com"
REPOSITORY_PART = re.compile(r"^[A-Za-z0-9_.-]+$")
GITHUB_REDIRECT_STATUSES = {301, 302, 303, 307, 308}
GITHUB_TRANSIENT_STATUSES = {500, 502, 503, 504}
GITHUB_REQUEST_ATTEMPTS = 2
GITHUB_MAX_REDIRECTS = 3
GITHUB_RETRY_DELAY_SECONDS = 0.25
GITHUB_RETRYABLE_TRANSPORT_ERRORS = (
    httpx.TimeoutException,
    httpx.NetworkError,
    httpx.ProxyError,
    httpx.RemoteProtocolError,
)


class GitHubValidationError(ValueError):
    pass


class GitHubDownloadError(RuntimeError):
    pass


class GitHubMetadataError(RuntimeError):
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

    @property
    def repository_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.name}"

    @property
    def api_url(self) -> str:
        return f"https://api.github.com/repos/{self.owner}/{self.name}"


@dataclass(frozen=True)
class GitHubMetadata:
    repository_url: str
    default_branch: str
    head_commit: str
    recent_commits: list[dict[str, str]]


@dataclass(frozen=True)
class GitHubComparison:
    repository_url: str
    base_commit: str
    head_commit: str
    status: str
    ahead_by: int
    behind_by: int
    total_commits: int
    additions: int
    deletions: int
    changed_files: int
    files: list[dict[str, object]]
    truncated: bool


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
    repository: GitHubRepository, settings: Settings, *, commit_sha: str | None = None
) -> Path:
    if commit_sha is not None and not re.fullmatch(r"[0-9a-fA-F]{40}", commit_sha):
        raise GitHubValidationError("A full Git commit SHA is required for a pinned download.")
    archive_url = (
        f"{repository.repository_url}/archive/{commit_sha.lower()}.zip"
        if commit_sha is not None else repository.archive_url
    )
    temporary_path: Path | None = None
    try:
        settings.temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            suffix=".zip", delete=False, dir=settings.temporary_root
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)
            async with httpx.AsyncClient(
                follow_redirects=False,
                timeout=timeout,
                headers={"User-Agent": "DevAtlas/0.2"},
                trust_env=True,
            ) as client:
                await _download_archive_with_retries(
                    client, archive_url, temporary_file, settings
                )

        return extract_archive_path(temporary_path, settings)
    except GitHubDownloadError:
        raise
    except httpx.ProxyError as error:
        raise GitHubDownloadError(
            "Cannot connect to GitHub through the configured proxy. Check HTTP_PROXY, "
            "HTTPS_PROXY and NO_PROXY, then try again."
        ) from error
    except httpx.ConnectTimeout as error:
        raise GitHubDownloadError(
            "GitHub connection timed out before the download started. Check the network "
            "or proxy, then try again."
        ) from error
    except httpx.ReadTimeout as error:
        raise GitHubDownloadError(
            "GitHub download stalled while receiving data. The network may be slow or the "
            "repository may be large; try again or import a local ZIP."
        ) from error
    except httpx.TimeoutException as error:
        raise GitHubDownloadError(
            "GitHub download timed out. Check the network and try again."
        ) from error
    except httpx.ConnectError as error:
        detail = _safe_transport_detail(error)
        suffix = f" Details: {detail}" if detail else ""
        raise GitHubDownloadError(
            "Cannot connect to GitHub. Check the network or the backend's external "
            f"network permission.{suffix}"
        ) from error
    except (httpx.ReadError, httpx.RemoteProtocolError) as error:
        raise GitHubDownloadError(
            "GitHub download connection was interrupted before the archive completed. "
            "Check the network or proxy, then try again."
        ) from error
    except httpx.HTTPStatusError as error:
        status_code = error.response.status_code
        if _is_rate_limited(error.response):
            message = _rate_limit_message("download", error.response)
        elif status_code in {401, 403}:
            message = (
                "GitHub rejected the download. The repository may be private, "
                "or anonymous access may be unavailable."
            )
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
        detail = _safe_transport_detail(error)
        raise GitHubDownloadError(
            f"GitHub download failed: {detail or error.__class__.__name__}"
        ) from error
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


async def _download_archive_with_retries(
    client: httpx.AsyncClient,
    archive_url: str,
    temporary_file: BinaryIO,
    settings: Settings,
) -> None:
    for attempt in range(GITHUB_REQUEST_ATTEMPTS):
        temporary_file.seek(0)
        temporary_file.truncate(0)
        try:
            await _download_archive_once(client, archive_url, temporary_file, settings)
            return
        except httpx.HTTPStatusError as error:
            retryable = error.response.status_code in GITHUB_TRANSIENT_STATUSES
            if not retryable or attempt + 1 >= GITHUB_REQUEST_ATTEMPTS:
                raise
        except GITHUB_RETRYABLE_TRANSPORT_ERRORS:
            if attempt + 1 >= GITHUB_REQUEST_ATTEMPTS:
                raise
        await asyncio.sleep(GITHUB_RETRY_DELAY_SECONDS * (2**attempt))


async def _download_archive_once(
    client: httpx.AsyncClient,
    archive_url: str,
    temporary_file: BinaryIO,
    settings: Settings,
) -> None:
    current_url = httpx.URL(archive_url)
    for redirect_count in range(GITHUB_MAX_REDIRECTS + 1):
        _validate_download_url(current_url)
        async with client.stream("GET", str(current_url)) as response:
            _validate_download_url(response.url)
            if response.status_code in GITHUB_REDIRECT_STATUSES:
                location = response.headers.get("location", "").strip()
                if not location:
                    raise GitHubDownloadError(
                        "GitHub returned a redirect without a destination."
                    )
                if redirect_count >= GITHUB_MAX_REDIRECTS:
                    raise GitHubDownloadError(
                        "GitHub download exceeded the safe redirect limit."
                    )
                try:
                    redirected_url = response.url.join(location)
                except (httpx.InvalidURL, ValueError) as error:
                    raise GitHubDownloadError(
                        "GitHub returned an invalid download redirect."
                    ) from error
                _validate_download_url(redirected_url)
                current_url = redirected_url
                continue

            if response.status_code == 404:
                raise GitHubDownloadError("The public GitHub repository was not found.")
            response.raise_for_status()
            declared_size = _content_length(response)
            if declared_size is not None and declared_size > settings.max_upload_bytes:
                raise GitHubDownloadError(
                    f"Repository archive exceeds the {settings.max_upload_mb} MB limit."
                )

            total_bytes = 0
            async for chunk in response.aiter_bytes(1024 * 1024):
                total_bytes += len(chunk)
                if total_bytes > settings.max_upload_bytes:
                    raise GitHubDownloadError(
                        f"Repository archive exceeds the {settings.max_upload_mb} MB limit."
                    )
                temporary_file.write(chunk)
            return
    raise GitHubDownloadError("GitHub download exceeded the safe redirect limit.")


async def fetch_github_metadata(
    repository: GitHubRepository,
    *,
    commit_limit: int = 20,
) -> GitHubMetadata:
    """Read bounded public Git metadata without cloning or storing .git objects."""
    timeout = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "DevAtlas/0.9",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    try:
        async with httpx.AsyncClient(
            follow_redirects=False,
            timeout=timeout,
            headers=headers,
            trust_env=True,
        ) as client:
            repository_response = await _github_api_get(client, repository.api_url)
            _validate_api_response(repository_response)
            payload = repository_response.json()
            default_branch = str(payload.get("default_branch") or "").strip()
            if not default_branch or any(ord(char) < 32 for char in default_branch):
                raise GitHubMetadataError("GitHub did not return a valid default branch.")

            commits_response = await _github_api_get(
                client,
                f"{repository.api_url}/commits",
                params={"sha": default_branch, "per_page": max(1, min(commit_limit, 50))},
            )
            _validate_api_response(commits_response)
            commits_payload = commits_response.json()
            if not isinstance(commits_payload, list) or not commits_payload:
                raise GitHubMetadataError("GitHub did not return commit history.")

            commits: list[dict[str, str]] = []
            for item in commits_payload[: max(1, min(commit_limit, 50))]:
                if not isinstance(item, dict):
                    continue
                sha = str(item.get("sha") or "").strip()
                commit = item.get("commit") if isinstance(item.get("commit"), dict) else {}
                author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
                message_lines = str(commit.get("message") or "").splitlines()
                message = message_lines[0].strip() if message_lines else ""
                authored_at = str(author.get("date") or "").strip()
                author_name = str(author.get("name") or "Unknown").strip()[:160]
                if not re.fullmatch(r"[0-9a-fA-F]{40}", sha):
                    continue
                if authored_at:
                    try:
                        datetime.fromisoformat(authored_at.replace("Z", "+00:00"))
                    except ValueError:
                        authored_at = ""
                commits.append(
                    {
                        "sha": sha.lower(),
                        "message": message[:500] or "No commit message",
                        "author": author_name or "Unknown",
                        "authored_at": authored_at,
                    }
                )
            if not commits:
                raise GitHubMetadataError("GitHub commit history did not contain valid commits.")
            return GitHubMetadata(
                repository_url=repository.repository_url,
                default_branch=default_branch,
                head_commit=commits[0]["sha"],
                recent_commits=commits,
            )
    except GitHubMetadataError:
        raise
    except httpx.HTTPError as error:
        raise GitHubMetadataError(
            f"Unable to load GitHub metadata: {_transport_error_summary(error)}"
        ) from error
    except (ValueError, TypeError) as error:
        raise GitHubMetadataError(f"Unable to load GitHub metadata: {error}") from error


async def fetch_github_comparison(
    repository: GitHubRepository,
    base_commit: str,
    head_commit: str,
    *,
    file_limit: int = 100,
) -> GitHubComparison:
    """Compare two immutable public commit SHAs through GitHub's read-only API."""
    base = base_commit.strip().lower()
    head = head_commit.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40}", base) or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise GitHubMetadataError("Git comparison requires two full commit SHAs.")
    if base == head:
        raise GitHubMetadataError("Choose two different commits to compare.")
    bounded_limit = max(1, min(file_limit, 200))
    timeout = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "DevAtlas/0.9",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    try:
        async with httpx.AsyncClient(
            follow_redirects=False,
            timeout=timeout,
            headers=headers,
            trust_env=True,
        ) as client:
            response = await _github_api_get(
                client, f"{repository.api_url}/compare/{base}...{head}"
            )
            _validate_api_response(response)
            payload = response.json()
            if not isinstance(payload, dict):
                raise GitHubMetadataError("GitHub did not return a valid comparison.")
            raw_files = payload.get("files")
            if not isinstance(raw_files, list):
                raw_files = []
            parsed_files: list[dict[str, object]] = []
            for item in raw_files:
                if not isinstance(item, dict):
                    continue
                filename = str(item.get("filename") or "").strip().replace("\\", "/")
                status_value = str(item.get("status") or "modified").strip().lower()
                if not filename or filename.startswith("/") or ".." in filename.split("/"):
                    continue
                if status_value not in {"added", "modified", "removed", "renamed", "copied", "changed", "unchanged"}:
                    status_value = "modified"
                additions = max(0, int(item.get("additions") or 0))
                deletions = max(0, int(item.get("deletions") or 0))
                parsed_files.append(
                    {
                        "path": filename[:1_000],
                        "status": status_value,
                        "additions": additions,
                        "deletions": deletions,
                        "changes": max(0, int(item.get("changes") or additions + deletions)),
                    }
                )
            parsed_files.sort(key=lambda item: (-int(item["changes"]), str(item["path"])))
            files = parsed_files[:bounded_limit]
            return GitHubComparison(
                repository_url=repository.repository_url,
                base_commit=base,
                head_commit=head,
                status=str(payload.get("status") or "unknown")[:40],
                ahead_by=max(0, int(payload.get("ahead_by") or 0)),
                behind_by=max(0, int(payload.get("behind_by") or 0)),
                total_commits=max(0, int(payload.get("total_commits") or 0)),
                additions=sum(int(item["additions"]) for item in parsed_files),
                deletions=sum(int(item["deletions"]) for item in parsed_files),
                changed_files=len(parsed_files),
                files=files,
                truncated=len(parsed_files) > bounded_limit,
            )
    except GitHubMetadataError:
        raise
    except httpx.HTTPError as error:
        raise GitHubMetadataError(
            f"Unable to compare GitHub commits: {_transport_error_summary(error)}"
        ) from error
    except (ValueError, TypeError) as error:
        raise GitHubMetadataError(f"Unable to compare GitHub commits: {error}") from error


async def _github_api_get(
    client: httpx.AsyncClient, url: str, **options: object
) -> httpx.Response:
    for attempt in range(GITHUB_REQUEST_ATTEMPTS):
        try:
            response = await client.get(url, **options)
        except GITHUB_RETRYABLE_TRANSPORT_ERRORS:
            if attempt + 1 >= GITHUB_REQUEST_ATTEMPTS:
                raise
        else:
            if (
                response.status_code not in GITHUB_TRANSIENT_STATUSES
                or attempt + 1 >= GITHUB_REQUEST_ATTEMPTS
            ):
                return response
        await asyncio.sleep(GITHUB_RETRY_DELAY_SECONDS * (2**attempt))
    raise RuntimeError("GitHub API retry loop ended unexpectedly.")


def _validate_api_response(response: httpx.Response) -> None:
    if response.url.host != GITHUB_API_HOST:
        raise GitHubMetadataError("GitHub metadata request reached an unexpected host.")
    if response.status_code == 404:
        raise GitHubMetadataError("The public GitHub repository was not found.")
    if _is_rate_limited(response):
        raise GitHubMetadataError(_rate_limit_message("metadata", response))
    if response.status_code in {401, 403}:
        raise GitHubMetadataError(
            "GitHub rejected the metadata request. Check repository visibility and access."
        )
    if response.status_code in GITHUB_TRANSIENT_STATUSES:
        raise GitHubMetadataError(
            "GitHub metadata service is temporarily unavailable. Try again later."
        )
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        raise GitHubMetadataError(
            f"GitHub returned HTTP {response.status_code} while loading metadata."
        ) from error


def _validate_download_url(url: httpx.URL) -> None:
    parsed = urlparse(str(url))
    if (
        parsed.scheme != "https"
        or parsed.hostname not in GITHUB_DOWNLOAD_HOSTS
        or parsed.username
        or parsed.password
        or parsed.port not in {None, 443}
    ):
        raise GitHubDownloadError(
            "GitHub redirected the download to an unexpected or unsafe host."
        )


def _content_length(response: httpx.Response) -> int | None:
    raw_value = response.headers.get("content-length", "").strip()
    if not raw_value:
        return None
    try:
        value = int(raw_value)
    except ValueError:
        return None
    return value if value >= 0 else None


def _is_rate_limited(response: httpx.Response) -> bool:
    return response.status_code == 429 or (
        response.status_code == 403
        and response.headers.get("x-ratelimit-remaining") == "0"
    )


def _rate_limit_message(scope: str, response: httpx.Response) -> str:
    wait_seconds = _rate_limit_wait_seconds(response)
    if wait_seconds is not None:
        return f"GitHub {scope} rate limit reached. Retry after {wait_seconds} seconds."
    return f"GitHub {scope} rate limit reached. Wait before trying again."


def _rate_limit_wait_seconds(response: httpx.Response) -> int | None:
    retry_after = response.headers.get("retry-after", "").strip()
    if retry_after.isdigit():
        return max(1, min(int(retry_after), 7 * 24 * 60 * 60))
    reset = response.headers.get("x-ratelimit-reset", "").strip()
    if reset.isdigit():
        return max(1, min(int(reset) - int(time.time()), 7 * 24 * 60 * 60))
    return None


def _safe_transport_detail(error: httpx.HTTPError) -> str:
    detail = " ".join(str(error).split())[:300]
    return re.sub(r"([A-Za-z][A-Za-z0-9+.-]*://)[^/@\s]+@", r"\1***@", detail)


def _transport_error_summary(error: httpx.HTTPError) -> str:
    if isinstance(error, httpx.ProxyError):
        return "the configured proxy could not connect to GitHub"
    if isinstance(error, httpx.ConnectTimeout):
        return "the connection to GitHub timed out"
    if isinstance(error, httpx.ReadTimeout):
        return "GitHub stopped sending data before the response completed"
    if isinstance(error, httpx.ConnectError):
        return "the backend could not establish a connection to GitHub"
    return _safe_transport_detail(error) or error.__class__.__name__
