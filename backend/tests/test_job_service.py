from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.database import Base
from app.models.analysis import AnalysisJob
from app.models.project import Project, ProjectGitMetadata
from app.services import job_service
from app.services.git_metadata_service import save_git_metadata
from app.services.github_service import GitHubMetadata, parse_github_repository
from app.services.job_service import (
    fail_interrupted_jobs,
    run_github_job,
    run_github_sync_job,
    run_repository_job,
)
from app.services.project_service import create_scanned_project


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
    settings = Settings(
        repository_root=tmp_path / "repositories",
        search_index_root=tmp_path / "indexes",
        semantic_search_enabled=False,
    )
    settings.ensure_directories()
    add_job(factory, "github-job")

    async def fake_download(repository: object, current_settings: Settings) -> Path:
        target = current_settings.repository_root / "download" / "repo-main"
        target.mkdir(parents=True)
        (target / "main.py").write_text("def downloaded():\n    return True\n", encoding="utf-8")
        return target

    monkeypatch.setattr(job_service, "download_github_repository", fake_download)

    async def fake_metadata(repository: object) -> GitHubMetadata:
        return GitHubMetadata(
            repository_url="https://github.com/openai/example",
            default_branch="main",
            head_commit="b" * 40,
            recent_commits=[
                {
                    "sha": "b" * 40,
                    "message": "feat: imported history",
                    "author": "Grace",
                    "authored_at": "2026-08-28T10:00:00Z",
                }
            ],
        )

    monkeypatch.setattr(job_service, "fetch_github_metadata", fake_metadata)

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
        metadata = database.query(ProjectGitMetadata).filter_by(project_id=job.project_id).one()
        assert metadata.default_branch == "main"
        assert metadata.head_commit == "b" * 40
    factory.kw["bind"].dispose()


def test_synchronizes_github_source_after_staged_analysis_without_changing_project_id(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    factory = make_session_factory(tmp_path)
    settings = Settings(
        repository_root=tmp_path / "repositories",
        temporary_root=tmp_path / "temporary",
        search_index_root=tmp_path / "indexes",
        semantic_search_enabled=False,
    )
    settings.ensure_directories()
    old_path = settings.repository_root / "old-copy" / "example-main"
    old_path.mkdir(parents=True)
    (old_path / "main.py").write_text("def version():\n    return 'old'\n", encoding="utf-8")
    with factory() as database:
        project = create_scanned_project(
            database,
            old_path,
            source_filename="github.com/openai/example",
            project_name="example",
            search_index_root=settings.search_index_root,
        )
        project_id = project.id
        save_git_metadata(
            database,
            project,
            GitHubMetadata(
                repository_url="https://github.com/openai/example",
                default_branch="main",
                head_commit="a" * 40,
                recent_commits=[],
            ),
        )
        database.add(
            AnalysisJob(
                id="sync-job",
                source_type="github_sync",
                source_label="github.com/openai/example",
                status="queued",
                stage="queued",
                progress=5,
                message="queued",
                project_id=project_id,
            )
        )
        database.commit()

    async def fake_metadata(repository: object) -> GitHubMetadata:
        return GitHubMetadata(
            repository_url="https://github.com/openai/example",
            default_branch="main",
            head_commit="b" * 40,
            recent_commits=[{"sha": "b" * 40, "message": "update", "author": "Ada", "authored_at": "2026-08-28T10:00:00Z"}],
        )

    new_path = settings.repository_root / "new-copy" / "example-main"

    async def fake_download(repository: object, current_settings: Settings) -> Path:
        new_path.mkdir(parents=True)
        (new_path / "main.py").write_text("def version():\n    return 'new'\n", encoding="utf-8")
        (new_path / "feature.py").write_text("FEATURE = True\n", encoding="utf-8")
        return new_path

    monkeypatch.setattr(job_service, "fetch_github_metadata", fake_metadata)
    monkeypatch.setattr(job_service, "download_github_repository", fake_download)

    run_github_sync_job(
        "sync-job",
        project_id,
        parse_github_repository("https://github.com/openai/example"),
        settings,
        factory,
    )

    with factory() as database:
        job = database.get(AnalysisJob, "sync-job")
        project = database.get(Project, project_id)
        assert job is not None and job.status == "completed"
        assert job.project_id == project_id
        assert project is not None
        assert project.storage_path == str(new_path.resolve())
        assert {item.relative_path for item in project.files} == {"feature.py", "main.py"}
        assert project.git_metadata is not None
        assert project.git_metadata.head_commit == "b" * 40
        assert {item.reason for item in project.snapshots} >= {"import", "sync"}
        assert database.query(Project).count() == 1
    assert not (settings.repository_root / "old-copy").exists()
    assert (new_path / "main.py").read_text(encoding="utf-8").endswith("'new'\n")
    factory.kw["bind"].dispose()


def test_skips_remote_download_when_github_head_is_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    factory = make_session_factory(tmp_path)
    settings = Settings(
        repository_root=tmp_path / "repositories",
        search_index_root=tmp_path / "indexes",
        semantic_search_enabled=False,
    )
    settings.ensure_directories()
    source_path = settings.repository_root / "current" / "example-main"
    source_path.mkdir(parents=True)
    (source_path / "main.py").write_text("pass\n", encoding="utf-8")
    with factory() as database:
        project = Project(
            name="example",
            source_filename="github.com/openai/example",
            storage_path=str(source_path.resolve()),
            status="ready",
            file_count=1,
            code_line_count=1,
        )
        database.add(project)
        database.commit()
        database.refresh(project)
        project_id = project.id
        save_git_metadata(
            database,
            project,
            GitHubMetadata(
                repository_url="https://github.com/openai/example",
                default_branch="main",
                head_commit="a" * 40,
                recent_commits=[],
            ),
        )
        database.add(
            AnalysisJob(
                id="unchanged-sync",
                source_type="github_sync",
                source_label="github.com/openai/example",
                status="queued",
                stage="queued",
                progress=5,
                message="queued",
                project_id=project_id,
            )
        )
        database.commit()

    async def same_metadata(repository: object) -> GitHubMetadata:
        return GitHubMetadata(
            repository_url="https://github.com/openai/example",
            default_branch="main",
            head_commit="a" * 40,
            recent_commits=[{"sha": "a" * 40, "message": "same", "author": "Ada", "authored_at": "2026-08-28T10:00:00Z"}],
        )

    async def unexpected_download(*_: object) -> Path:
        raise AssertionError("unchanged HEAD must not download the repository")

    monkeypatch.setattr(job_service, "fetch_github_metadata", same_metadata)
    monkeypatch.setattr(job_service, "download_github_repository", unexpected_download)

    run_github_sync_job(
        "unchanged-sync",
        project_id,
        parse_github_repository("https://github.com/openai/example"),
        settings,
        factory,
    )

    with factory() as database:
        job = database.get(AnalysisJob, "unchanged-sync")
        assert job is not None and job.status == "completed"
        assert job.stage == "up_to_date"
        assert database.query(Project).count() == 1
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
    settings = Settings(
        repository_root=tmp_path / "repositories",
        search_index_root=tmp_path / "indexes",
        semantic_search_enabled=False,
    )
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
