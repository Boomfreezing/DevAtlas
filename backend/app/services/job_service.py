import asyncio
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.models.analysis import AnalysisJob
from app.models.project import Project
from app.services.github_service import GitHubRepository, download_github_repository
from app.services.project_service import create_scanned_project, remove_managed_repository


SessionFactory = Callable[[], Session]


def run_repository_job(
    job_id: str,
    repository_path: Path,
    source_filename: str,
    project_name: str,
    settings: Settings,
    session_factory: sessionmaker[Session],
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
                progress_callback=lambda stage, progress, message: _update_job(
                    session_factory,
                    job_id,
                    stage=stage,
                    progress=progress,
                    message=message,
                ),
            )
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
    )


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
