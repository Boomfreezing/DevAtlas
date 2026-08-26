from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.database import Base
from app.models.analysis import AnalysisJob
from app.services import job_service
from app.services.github_service import parse_github_repository
from app.services.job_service import fail_interrupted_jobs, run_github_job, run_repository_job


def make_session_factory(tmp_path: Path) -> sessionmaker[Session]:
    engine = create_engine(
        f"sqlite:///{(tmp_path / 'jobs.db').as_posix()}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def add_job(factory: sessionmaker[Session], job_id: str, status: str = "queued") -> None:
    with factory() as database:
        database.add(
            AnalysisJob(
                id=job_id,
                source_type="github",
                source_label="github.com/openai/example",
                status=status,
                stage=status,
                progress=5,
                message="queued",
            )
        )
        database.commit()


def test_runs_github_job_to_completion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    factory = make_session_factory(tmp_path)
    settings = Settings(repository_root=tmp_path / "repositories")
    settings.ensure_directories()
    add_job(factory, "github-job")

    async def fake_download(repository: object, current_settings: Settings) -> Path:
        target = current_settings.repository_root / "download" / "repo-main"
        target.mkdir(parents=True)
        (target / "main.py").write_text("def downloaded():\n    return True\n", encoding="utf-8")
        return target

    monkeypatch.setattr(job_service, "download_github_repository", fake_download)

    run_github_job(
        "github-job",
        parse_github_repository("https://github.com/openai/example"),
        settings,
        factory,
    )

    with factory() as database:
        job = database.get(AnalysisJob, "github-job")
        assert job is not None
        assert job.status == "completed"
        assert job.progress == 100
        assert job.project_id is not None
    factory.kw["bind"].dispose()


def test_marks_interrupted_jobs_failed(tmp_path: Path) -> None:
    factory = make_session_factory(tmp_path)
    add_job(factory, "queued-job", "queued")
    add_job(factory, "running-job", "running")

    affected = fail_interrupted_jobs(factory)

    assert affected == 2
    with factory() as database:
        assert database.get(AnalysisJob, "queued-job").stage == "interrupted"
        assert database.get(AnalysisJob, "running-job").status == "failed"
    factory.kw["bind"].dispose()


def test_failed_job_cleans_repository(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    factory = make_session_factory(tmp_path)
    settings = Settings(repository_root=tmp_path / "repositories")
    repository_path = settings.repository_root / "failed-import" / "repo"
    repository_path.mkdir(parents=True)
    add_job(factory, "failed-job")

    def fail_analysis(*_: object, **__: object) -> object:
        raise RuntimeError("synthetic analysis failure")

    monkeypatch.setattr(job_service, "create_scanned_project", fail_analysis)

    run_repository_job(
        "failed-job",
        repository_path,
        "failed.zip",
        "failed",
        settings,
        factory,
    )

    with factory() as database:
        job = database.get(AnalysisJob, "failed-job")
        assert job is not None
        assert job.status == "failed"
        assert "synthetic analysis failure" in (job.error or "")
    assert not repository_path.exists()
    factory.kw["bind"].dispose()
