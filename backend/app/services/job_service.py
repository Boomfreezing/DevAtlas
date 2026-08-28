import asyncio
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.models.analysis import (
    AnalysisJob,
    AnalysisSnapshot,
    CodeSymbol,
    ImportRelation,
    ParseIssue,
    SearchChunk,
)
from app.models.project import Project, ProjectFile, ProjectGitMetadata
from app.services.analysis_cache import invalidate_project_analysis
from app.services.git_metadata_service import save_git_metadata
from app.services.github_service import (
    GitHubMetadata,
    GitHubMetadataError,
    GitHubRepository,
    download_github_repository,
    fetch_github_metadata,
)
from app.services.project_service import create_scanned_project, remove_managed_repository
from app.services.repository_path_service import resolve_project_storage_path
from app.services.search_service import build_project_search_index, remove_persisted_search_index
from app.services.snapshot_service import MAX_SNAPSHOTS_PER_PROJECT

SessionFactory = Callable[[], Session]


def run_repository_job(
    job_id: str,
    repository_path: Path,
    source_filename: str,
    project_name: str,
    settings: Settings,
    session_factory: sessionmaker[Session],
    git_metadata: GitHubMetadata | None = None,
) -> None:
    _update_job(
        session_factory,
        job_id,
        status="running",
        stage="scanning",
        progress=30,
        message="后台分析已启动",
    )
    try:
        with session_factory() as database:
            project = create_scanned_project(
                database,
                repository_path,
                source_filename=source_filename,
                project_name=project_name,
                search_index_root=settings.search_index_root,
                progress_callback=lambda stage, progress, message: _update_job(
                    session_factory,
                    job_id,
                    stage=stage,
                    progress=progress,
                    message=message,
                ),
            )
            if git_metadata is not None:
                save_git_metadata(database, project, git_metadata)
            project_id = project.id
        _update_job(
            session_factory,
            job_id,
            status="completed",
            stage="completed",
            progress=100,
            message="仓库分析完成",
            project_id=project_id,
            completed_at=datetime.now(timezone.utc),
        )
    except Exception as error:
        _remove_incomplete_project(session_factory, repository_path)
        remove_managed_repository(repository_path, settings.repository_root)
        _fail_job(session_factory, job_id, error)


def run_github_job(
    job_id: str,
    repository: GitHubRepository,
    settings: Settings,
    session_factory: sessionmaker[Session],
) -> None:
    _update_job(
        session_factory,
        job_id,
        status="running",
        stage="downloading",
        progress=8,
        message="正在从 GitHub 下载默认分支",
    )
    git_metadata: GitHubMetadata | None = None
    try:
        git_metadata = asyncio.run(fetch_github_metadata(repository))
    except GitHubMetadataError:
        # Source import remains available when the unauthenticated GitHub API is
        # rate-limited; users can retry metadata loading from the snapshot page.
        pass
    try:
        repository_path = asyncio.run(download_github_repository(repository, settings))
    except Exception as error:
        _fail_job(session_factory, job_id, error)
        return
    _update_job(
        session_factory,
        job_id,
        stage="preparing",
        progress=25,
        message="下载完成，正在准备仓库",
    )
    run_repository_job(
        job_id,
        repository_path,
        repository.display_source,
        repository.name,
        settings,
        session_factory,
        git_metadata,
    )


def run_github_sync_job(
    job_id: str,
    project_id: int,
    repository: GitHubRepository,
    settings: Settings,
    session_factory: sessionmaker[Session],
) -> None:
    """Safely replace one managed GitHub project after staging a complete analysis."""
    _update_job(
        session_factory,
        job_id,
        status="running",
        stage="checking_remote",
        progress=8,
        message="正在检查 GitHub 最新提交",
    )
    downloaded_path: Path | None = None
    staging_project_id: int | None = None
    promoted = False
    old_repository_path: Path | None = None
    try:
        metadata = asyncio.run(fetch_github_metadata(repository))
        with session_factory() as database:
            project = database.get(Project, project_id)
            if project is None:
                raise LookupError("Project not found.")
            stored = database.scalar(
                select(ProjectGitMetadata).where(ProjectGitMetadata.project_id == project_id)
            )
            if stored is not None and stored.head_commit == metadata.head_commit:
                save_git_metadata(database, project, metadata)
                _update_job(
                    session_factory,
                    job_id,
                    status="completed",
                    stage="up_to_date",
                    progress=100,
                    message="远程仓库没有新提交，本地分析已是最新版本",
                    project_id=project_id,
                    completed_at=datetime.now(timezone.utc),
                )
                return

        _update_job(
            session_factory,
            job_id,
            stage="downloading_update",
            progress=16,
            message="发现新提交，正在下载安全源码快照",
        )
        downloaded_path = asyncio.run(download_github_repository(repository, settings))
        _update_job(
            session_factory,
            job_id,
            stage="staging_analysis",
            progress=28,
            message="下载完成，正在独立目录验证并分析新版本",
        )
        with session_factory() as database:
            current = database.get(Project, project_id)
            if current is None:
                raise LookupError("Project not found.")
            old_repository_path = resolve_project_storage_path(current.storage_path)
            staged = create_scanned_project(
                database,
                downloaded_path,
                source_filename=repository.display_source,
                project_name=current.name,
                search_index_root=settings.search_index_root,
                progress_callback=lambda stage, progress, message: _update_job(
                    session_factory,
                    job_id,
                    stage=f"sync_{stage}",
                    progress=min(90, max(30, progress)),
                    message=message,
                ),
            )
            staging_project_id = staged.id
            _promote_synchronized_project(
                database,
                current,
                staged,
                settings.search_index_root,
            )
            promoted = True
            refreshed = database.get(Project, project_id)
            if refreshed is None:
                raise RuntimeError("Synchronized project could not be reloaded.")
            save_git_metadata(database, refreshed, metadata)

        if old_repository_path is not None and old_repository_path != downloaded_path:
            remove_managed_repository(old_repository_path, settings.repository_root)
        _update_job(
            session_factory,
            job_id,
            status="completed",
            stage="synchronized",
            progress=100,
            message="远程源码已更新，重新分析和版本快照已完成",
            project_id=project_id,
            completed_at=datetime.now(timezone.utc),
        )
    except Exception as error:
        if not promoted and downloaded_path is not None:
            _remove_incomplete_project(session_factory, downloaded_path)
            remove_managed_repository(downloaded_path, settings.repository_root)
        elif promoted:
            # Promotion is committed only after the staged analysis is complete. A
            # later metadata/job update error must not delete the now-active source.
            downloaded_path = None
        if staging_project_id is not None and not promoted:
            _remove_project_by_id(session_factory, staging_project_id)
        _fail_job(session_factory, job_id, error)


def _promote_synchronized_project(
    database: Session,
    current: Project,
    staged: Project,
    search_index_root: Path,
) -> None:
    """Atomically transplant staged analysis rows while retaining the project id."""
    current_id = current.id
    staged_id = staged.id
    remove_persisted_search_index(search_index_root, current)
    remove_persisted_search_index(search_index_root, staged)
    invalidate_project_analysis(database, current_id)
    invalidate_project_analysis(database, staged_id)

    for model in (SearchChunk, CodeSymbol, ImportRelation, ParseIssue):
        database.execute(delete(model).where(model.project_id == current_id))
    database.execute(delete(ProjectFile).where(ProjectFile.project_id == current_id))
    database.execute(delete(SearchChunk).where(SearchChunk.project_id == staged_id))

    for model in (ProjectFile, CodeSymbol, ImportRelation, ParseIssue):
        database.execute(
            update(model).where(model.project_id == staged_id).values(project_id=current_id)
        )
    database.execute(
        update(AnalysisSnapshot)
        .where(AnalysisSnapshot.project_id == staged_id)
        .values(project_id=current_id, reason="sync", label="远程同步")
    )
    snapshot_ids = list(
        database.scalars(
            select(AnalysisSnapshot.id)
            .where(AnalysisSnapshot.project_id == current_id)
            .order_by(AnalysisSnapshot.created_at.desc(), AnalysisSnapshot.id.desc())
        )
    )
    if len(snapshot_ids) > MAX_SNAPSHOTS_PER_PROJECT:
        database.execute(
            delete(AnalysisSnapshot).where(
                AnalysisSnapshot.id.in_(snapshot_ids[MAX_SNAPSHOTS_PER_PROJECT:])
            )
        )

    current.storage_path = staged.storage_path
    current.source_filename = staged.source_filename
    current.status = "ready"
    current.primary_language = staged.primary_language
    current.file_count = staged.file_count
    current.code_line_count = staged.code_line_count
    current.updated_at = datetime.now(timezone.utc)
    database.execute(delete(Project).where(Project.id == staged_id))
    database.flush()
    database.expunge_all()
    refreshed = database.get(Project, current_id)
    if refreshed is None:
        raise RuntimeError("Project promotion failed.")
    build_project_search_index(database, refreshed, search_index_root)
    database.commit()


def fail_interrupted_jobs(session_factory: sessionmaker[Session]) -> int:
    with session_factory() as database:
        jobs = list(
            database.scalars(
                select(AnalysisJob).where(AnalysisJob.status.in_(["queued", "running"]))
            )
        )
        for job in jobs:
            job.status = "failed"
            job.stage = "interrupted"
            job.message = "服务曾在任务完成前停止"
            job.error = "The backend restarted before this in-process job completed."
            job.completed_at = datetime.now(timezone.utc)
        database.commit()
        return len(jobs)


def _fail_job(
    session_factory: sessionmaker[Session], job_id: str, error: Exception
) -> None:
    detail = str(error).strip() or error.__class__.__name__
    _update_job(
        session_factory,
        job_id,
        status="failed",
        stage="failed",
        message="后台分析失败",
        error=detail[:2_000],
        completed_at=datetime.now(timezone.utc),
    )


def _update_job(
    session_factory: sessionmaker[Session], job_id: str, **values: object
) -> None:
    with session_factory() as database:
        job = database.get(AnalysisJob, job_id)
        if job is None:
            return
        for name, value in values.items():
            setattr(job, name, value)
        database.commit()


def _remove_incomplete_project(
    session_factory: sessionmaker[Session], repository_path: Path
) -> None:
    with session_factory() as database:
        project = database.scalar(
            select(Project).where(Project.storage_path == str(repository_path))
        )
        if project is not None:
            database.delete(project)
            database.commit()


def _remove_project_by_id(
    session_factory: sessionmaker[Session], project_id: int
) -> None:
    with session_factory() as database:
        project = database.get(Project, project_id)
        if project is not None:
            database.delete(project)
            database.commit()
