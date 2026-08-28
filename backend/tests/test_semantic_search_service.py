from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import SearchChunk
from app.models.project import Project, ProjectFile
from app.services import semantic_search_service


def _chunk(chunk_id: int, file_id: int, kind: str = "function") -> SearchChunk:
    return SearchChunk(
        id=chunk_id,
        project_id=1,
        file_id=file_id,
        symbol_name=f"symbol_{chunk_id}",
        kind=kind,
        start_line=chunk_id,
        end_line=chunk_id,
        content=f"def symbol_{chunk_id}(): pass",
    )


def test_semantic_selection_prioritizes_file_coverage_and_production_code() -> None:
    rows = [
        (_chunk(1, 1), "src/auth.py"),
        (_chunk(2, 1), "src/auth.py"),
        (_chunk(3, 2), "src/billing.py"),
        (_chunk(4, 3), "tests/test_auth.py"),
        (_chunk(5, 4), "vendor/generated.min.js"),
    ]

    selected = semantic_search_service._select_semantic_rows(rows, 3)

    assert [path for _, path in selected] == [
        "src/auth.py",
        "src/billing.py",
        "tests/test_auth.py",
    ]
    assert len({chunk.file_id for chunk, _ in selected}) == 3


def test_semantic_passage_adds_repository_concepts_without_changing_source() -> None:
    passage = semantic_search_service._passage_text(
        "src/routes.py",
        "upload_archive",
        "function",
        "@router.post('/archives')\ndef upload_archive(): pass",
    )

    assert "接口" in passage
    assert "route endpoint" in passage
    assert "@router.post('/archives')" in passage


def test_builds_persists_and_restores_semantic_repository_index(
    tmp_path: Path, monkeypatch
) -> None:
    engine = create_engine(f"sqlite:///{(tmp_path / 'semantic.db').as_posix()}")
    Base.metadata.create_all(engine)
    repository = tmp_path / "repository"
    repository.mkdir()
    (repository / "auth.py").write_text(
        "def authenticate_user(name, password):\n    return create_session(name)\n",
        encoding="utf-8",
    )
    (repository / "cache.py").write_text(
        "def warm_cache(key):\n    return redis.get(key)\n",
        encoding="utf-8",
    )
    index_root = tmp_path / "indexes"

    def fake_embeddings(texts: list[str], cache_root: Path, *, query: bool):
        if query:
            return [[1.0, 0.0]]
        return [
            [1.0, 0.0] if "authenticate_user" in text else [0.0, 1.0]
            for text in texts
        ]

    monkeypatch.setattr(semantic_search_service, "_embed_texts", fake_embeddings)
    with Session(engine) as database:
        project = Project(
            name="semantic-demo",
            source_filename="semantic-demo/",
            storage_path=str(repository),
            status="ready",
        )
        database.add(project)
        database.flush()
        auth_file = ProjectFile(
            project_id=project.id,
            relative_path="auth.py",
            extension=".py",
            language="Python",
            size_bytes=70,
            line_count=2,
            content_hash="auth",
        )
        cache_file = ProjectFile(
            project_id=project.id,
            relative_path="cache.py",
            extension=".py",
            language="Python",
            size_bytes=55,
            line_count=2,
            content_hash="cache",
        )
        database.add_all([auth_file, cache_file])
        database.flush()
        database.add_all(
            [
                SearchChunk(
                    project_id=project.id,
                    file_id=auth_file.id,
                    symbol_name="authenticate_user",
                    kind="function",
                    start_line=1,
                    end_line=2,
                    content="def authenticate_user(name, password):\n    return create_session(name)",
                ),
                SearchChunk(
                    project_id=project.id,
                    file_id=cache_file.id,
                    symbol_name="warm_cache",
                    kind="function",
                    start_line=1,
                    end_line=2,
                    content="def warm_cache(key):\n    return redis.get(key)",
                ),
            ]
        )
        database.commit()

        assert semantic_search_service.build_project_semantic_index(
            database, project, index_root
        ) == 2
        semantic_search_service._SEMANTIC_CACHE.clear()
        results = semantic_search_service.semantic_search_project(
            database, project, "用户如何登录？", index_root
        )

        assert results[0]["file_path"] == "auth.py"
        assert results[0]["symbol_name"] == "authenticate_user"
        assert results[0]["source"] == "semantic_search"
        metadata = list((index_root / "semantic").glob("*.json"))
        vectors = list((index_root / "semantic").glob("*.f32"))
        assert len(metadata) == 1
        assert len(vectors) == 1

        semantic_search_service.remove_persisted_semantic_index(index_root, project)
        assert not metadata[0].exists()
        assert not vectors[0].exists()


def test_semantic_search_falls_back_cleanly_when_embeddings_are_unavailable(
    tmp_path: Path, monkeypatch
) -> None:
    engine = create_engine(f"sqlite:///{(tmp_path / 'fallback.db').as_posix()}")
    Base.metadata.create_all(engine)
    repository = tmp_path / "repository"
    repository.mkdir()
    with Session(engine) as database:
        project = Project(
            name="fallback",
            source_filename="fallback/",
            storage_path=str(repository),
            status="ready",
        )
        database.add(project)
        database.flush()
        project_file = ProjectFile(
            project_id=project.id,
            relative_path="main.py",
            extension=".py",
            language="Python",
            size_bytes=10,
            line_count=1,
            content_hash="main",
        )
        database.add(project_file)
        database.flush()
        database.add(
            SearchChunk(
                project_id=project.id,
                file_id=project_file.id,
                symbol_name="main",
                kind="function",
                start_line=1,
                end_line=1,
                content="def main(): pass",
            )
        )
        database.commit()
        monkeypatch.setattr(
            semantic_search_service, "_embed_texts", lambda *args, **kwargs: None
        )

        assert semantic_search_service.semantic_search_project(
            database, project, "启动入口", tmp_path / "indexes"
        ) == []


def test_dense_similarity_reranks_bounded_question_candidates(
    tmp_path: Path, monkeypatch
) -> None:
    def fake_embeddings(texts: list[str], cache_root: Path, *, query: bool):
        vectors = [[1.0, 0.0]]
        vectors.extend(
            [1.0, 0.0] if "authenticate_user" in text else [0.0, 1.0]
            for text in texts[1:]
        )
        return vectors

    monkeypatch.setattr(semantic_search_service, "_embed_texts", fake_embeddings)
    candidates = [
        {
            "file_id": 1,
            "file_path": "src/cache.py",
            "start_line": 1,
            "end_line": 2,
            "symbol_name": "warm_cache",
            "snippet": "def warm_cache(key): return redis.get(key)",
            "source": "code_search",
            "_score": 10.0,
        },
        {
            "file_id": 2,
            "file_path": "src/auth.py",
            "start_line": 1,
            "end_line": 2,
            "symbol_name": "authenticate_user",
            "snippet": "def authenticate_user(name, password): return create_session(name)",
            "source": "code_search",
            "_score": 10.0,
        },
    ]

    reranked = semantic_search_service.semantic_rerank_candidates(
        "用户登录功能在哪里", candidates, tmp_path / "indexes"
    )

    assert reranked[1]["_semantic_score"] > reranked[0]["_semantic_score"]
    assert reranked[1]["_score"] > reranked[0]["_score"]
