"""Local-only checks for evidence changing while a generation request is in flight."""

import hashlib
from pathlib import Path

import pytest
from sqlalchemy import create_engine, delete, select, update
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.database import Base
from app.models.project import Project, ProjectFile
from app.services import repository_qa_service as qa
from app.services.analysis_cache import invalidate_project_analysis
from app.services.incremental_analyzer import incrementally_analyze_project
from app.services.project_service import create_scanned_project
from app.services.report_provider_service import ReportProviderError
from app.services.snapshot_service import create_analysis_snapshot
from app.services.structure_analyzer import analyze_project_structure


@pytest.fixture
def answer_project(tmp_path, monkeypatch):
    root = tmp_path / "repository"
    root.mkdir()
    (root / "auth.py").write_text(
        "def login_user(name):\n    return name\n", encoding="utf-8"
    )
    settings = Settings(
        _env_file=None,
        database_url=f"sqlite:///{(tmp_path / 'qa.db').as_posix()}",
        repository_root=root,
        temporary_root=tmp_path / "tmp",
        search_index_root=tmp_path / "indexes",
        provider_config_path=tmp_path / "providers.json",
        semantic_search_enabled=False,
    )
    engine = create_engine(settings.database_url)

    def forbidden(*args, **kwargs):
        pytest.fail("This test must never call a real generation/embedding provider")

    monkeypatch.setattr(qa, "answer_with_report_provider", forbidden)
    monkeypatch.setattr(qa, "semantic_search_project", forbidden)
    monkeypatch.setattr(qa, "semantic_rerank_candidates", forbidden)
    try:
        Base.metadata.create_all(engine)
        with Session(engine, expire_on_commit=False) as database:
            project = create_scanned_project(
                database, root, "fixture", "qa-fixture",
                search_index_root=settings.search_index_root,
            )
            yield database, settings, project, root
    finally:
        engine.dispose()


def answer(fixture):
    database, settings, project, _ = fixture
    return qa.answer_repository_question(
        database, settings, project, "login_user 在哪里？", "ollama"
    )


def test_unchanged_answer_keeps_verified_public_citations(answer_project, monkeypatch):
    monkeypatch.setattr(
        qa, "answer_with_report_provider", lambda *args, **kwargs: "在 auth.py。[1]"
    )
    result = answer(answer_project)
    assert result["grounding_status"] == "grounded"
    assert result["reference_count"] == 1
    assert result["citations"]
    assert all(not any(key.startswith("_") for key in item) for item in result["citations"])


def test_full_reanalysis_rejects_answer_even_when_project_metadata_is_unchanged(
    answer_project, monkeypatch
):
    database, settings, project, _ = answer_project
    old_metadata = (project.updated_at, project.source_commit)

    def reanalyze(*args, **kwargs):
        analyze_project_structure(database, project, search_index_root=settings.search_index_root)
        database.commit()
        assert (project.updated_at, project.source_commit) == old_metadata
        return "This answer was generated from the previous index. [1]"

    monkeypatch.setattr(qa, "answer_with_report_provider", reanalyze)
    with pytest.raises(ReportProviderError, match="分析上下文已更新或失效"):
        answer(answer_project)


def test_retrieval_invalidated_before_generation_never_calls_model(answer_project, monkeypatch):
    database, _, project, _ = answer_project
    retrieve = qa.retrieve_repository_evidence

    def outdated(*args, **kwargs):
        result = retrieve(*args, **kwargs)
        invalidate_project_analysis(database, project.id)
        return result

    monkeypatch.setattr(qa, "retrieve_repository_evidence", outdated)
    with pytest.raises(ReportProviderError, match="分析上下文已更新或失效"):
        answer(answer_project)


@pytest.mark.parametrize("change", ["changed", "deleted", "unreadable"])
def test_source_change_during_generation_does_not_return_old_answer(
    answer_project, monkeypatch, change
):
    _, _, _, root = answer_project
    source = root / "auth.py"

    def change_source(*args, **kwargs):
        if change == "deleted":
            source.unlink()
        elif change == "changed":
            source.write_text("# unrelated source\n" * 5, encoding="utf-8")
        else:
            read_bytes = Path.read_bytes

            def unavailable(path):
                if path == source:
                    raise OSError("test read failure")
                return read_bytes(path)

            monkeypatch.setattr(Path, "read_bytes", unavailable)
        return "Do not display this obsolete claim. [1]"

    monkeypatch.setattr(qa, "answer_with_report_provider", change_source)
    with pytest.raises(ReportProviderError, match="引用源码已变化或不可读取"):
        answer(answer_project)


@pytest.mark.parametrize("change", ["source_commit", "storage_path", "delete_project"])
def test_another_session_project_change_bypasses_identity_map(
    answer_project, monkeypatch, change
):
    database, _, project, root = answer_project
    original_commit = project.source_commit

    def replace_project(*args, **kwargs):
        with Session(database.get_bind()) as writer:
            if change == "delete_project":
                writer.execute(delete(Project).where(Project.id == project.id))
            else:
                value = "f" * 40 if change == "source_commit" else str(root / "replacement")
                writer.execute(
                    update(Project).where(Project.id == project.id).values({change: value})
                )
            writer.commit()
        assert project.source_commit == original_commit
        return "Old cached project evidence. [1]"

    monkeypatch.setattr(qa, "answer_with_report_provider", replace_project)
    with pytest.raises(ReportProviderError, match="分析上下文已更新或失效"):
        answer(answer_project)


@pytest.mark.parametrize("change", ["hash", "path", "delete_file"])
def test_another_session_file_change_refreshes_cached_file_identity(
    answer_project, monkeypatch, change
):
    database, _, project, root = answer_project
    cached_file = database.scalar(select(ProjectFile).where(ProjectFile.project_id == project.id))
    old_hash = cached_file.content_hash

    def replace_file(*args, **kwargs):
        with Session(database.get_bind()) as writer:
            if change == "delete_file":
                writer.execute(delete(ProjectFile).where(ProjectFile.id == cached_file.id))
            elif change == "path":
                (root / "auth.py").rename(root / "renamed.py")
                writer.execute(
                    update(ProjectFile).where(ProjectFile.id == cached_file.id)
                    .values(relative_path="renamed.py")
                )
            else:
                # The cited two lines stay identical; only the file's indexed
                # version changes. Comparing snippets alone would miss this.
                source = root / "auth.py"
                source.write_text(source.read_text(encoding="utf-8") + "\n# new revision\n")
                writer.execute(
                    update(ProjectFile).where(ProjectFile.id == cached_file.id)
                    .values(content_hash=hashlib.sha256(source.read_bytes()).hexdigest())
                )
            writer.commit()
        assert cached_file.content_hash == old_hash
        return "Previous file identity. [1]"

    monkeypatch.setattr(qa, "answer_with_report_provider", replace_file)
    with pytest.raises(ReportProviderError, match="引用源码已变化或不可读取"):
        answer(answer_project)


def test_invalidation_during_post_generation_file_read_is_also_rejected(
    answer_project, monkeypatch
):
    database, _, project, _ = answer_project
    read_bytes = Path.read_bytes

    def generation(*args, **kwargs):
        def invalidate_while_reading(path):
            invalidate_project_analysis(database, project.id)
            return read_bytes(path)

        monkeypatch.setattr(Path, "read_bytes", invalidate_while_reading)
        return "Changed during final verification. [1]"

    monkeypatch.setattr(qa, "answer_with_report_provider", generation)
    with pytest.raises(ReportProviderError, match="分析上下文已更新或失效"):
        answer(answer_project)


@pytest.mark.parametrize("unrelated", ["unchanged_incremental", "manual_snapshot", "other_project"])
def test_unchanged_analysis_or_unrelated_actions_keep_answer_valid(
    answer_project, monkeypatch, unrelated
):
    database, settings, project, _ = answer_project

    def harmless(*args, **kwargs):
        if unrelated == "unchanged_incremental":
            result = incrementally_analyze_project(
                database, project, search_index_root=settings.search_index_root
            )
            assert result["changed_file_count"] == 0
        elif unrelated == "manual_snapshot":
            create_analysis_snapshot(database, project, reason="manual")
        else:
            invalidate_project_analysis(database, project.id + 1000)
        return "Still current. [1]"

    monkeypatch.setattr(qa, "answer_with_report_provider", harmless)
    assert answer(answer_project)["grounding_status"] == "grounded"
