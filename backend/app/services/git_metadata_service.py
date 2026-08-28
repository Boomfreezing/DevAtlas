import json
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.project import Project, ProjectGitMetadata
from app.services.github_service import (
    GitHubMetadata,
    GitHubRepository,
    GitHubValidationError,
    parse_github_repository,
)


def repository_for_project(project: Project) -> GitHubRepository | None:
    source = project.source_filename.strip()
    if not source.startswith("github.com/"):
        return None
    try:
        return parse_github_repository(f"https://{source}")
    except GitHubValidationError:
        return None


def save_git_metadata(
    database: Session,
    project: Project,
    metadata: GitHubMetadata,
) -> ProjectGitMetadata:
    stored = database.scalar(
        select(ProjectGitMetadata).where(ProjectGitMetadata.project_id == project.id)
    )
    if stored is None:
        stored = ProjectGitMetadata(project_id=project.id)
        database.add(stored)
    stored.repository_url = metadata.repository_url
    stored.default_branch = metadata.default_branch
    stored.head_commit = metadata.head_commit
    stored.history_available = True
    stored.recent_commits_json = json.dumps(
        metadata.recent_commits,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    stored.fetched_at = datetime.now(UTC)
    database.commit()
    database.refresh(stored)
    return stored


def get_git_summary(database: Session, project: Project) -> dict[str, object]:
    repository = repository_for_project(project)
    stored = database.scalar(
        select(ProjectGitMetadata).where(ProjectGitMetadata.project_id == project.id)
    )
    if stored is None:
        return {
            "available": False,
            "refreshable": repository is not None,
            "repository_url": repository.repository_url if repository else None,
            "default_branch": None,
            "head_commit": None,
            "history_available": False,
            "recent_commits": [],
            "fetched_at": None,
            "message": (
                "该 GitHub 项目尚未加载提交元数据。"
                if repository
                else "当前项目不是通过 GitHub 仓库地址导入，无法自动获取提交历史。"
            ),
        }
    try:
        commits = json.loads(stored.recent_commits_json)
    except json.JSONDecodeError:
        commits = []
    return {
        "available": True,
        "refreshable": repository is not None,
        "repository_url": stored.repository_url,
        "default_branch": stored.default_branch,
        "head_commit": stored.head_commit,
        "history_available": stored.history_available,
        "recent_commits": commits if isinstance(commits, list) else [],
        "fetched_at": stored.fetched_at,
        "message": "已加载 GitHub 默认分支与最近提交元数据。",
    }
