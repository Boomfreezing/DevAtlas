from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.services.analysis_cache import (
    MAX_CACHED_PROJECTS_PER_DATABASE,
    analysis_cache_stats,
    clear_analysis_cache,
    get_or_create_project_analysis,
    invalidate_project_analysis,
)


def test_reuses_namespaced_snapshot_and_invalidates_project() -> None:
    engine = create_engine("sqlite:///:memory:")
    calls = 0

    def build_snapshot() -> dict[str, int]:
        nonlocal calls
        calls += 1
        return {"generation": calls}

    clear_analysis_cache()
    with Session(engine) as database:
        first = get_or_create_project_analysis(database, 7, "quality", build_snapshot)
        second = get_or_create_project_analysis(database, 7, "quality", build_snapshot)
        graph = get_or_create_project_analysis(database, 7, "graph", build_snapshot)

        assert first is second
        assert first == {"generation": 1}
        assert graph == {"generation": 2}
        assert analysis_cache_stats() == {"hits": 1, "misses": 2, "projects": 1}

        invalidate_project_analysis(database, 7)
        rebuilt = get_or_create_project_analysis(database, 7, "quality", build_snapshot)

        assert rebuilt == {"generation": 3}
        assert analysis_cache_stats() == {"hits": 1, "misses": 3, "projects": 1}

    clear_analysis_cache()
    engine.dispose()


def test_same_project_id_is_isolated_between_databases() -> None:
    first_engine = create_engine("sqlite:///:memory:")
    second_engine = create_engine("sqlite:///:memory:")
    clear_analysis_cache()

    with Session(first_engine) as first_database, Session(second_engine) as second_database:
        first = get_or_create_project_analysis(
            first_database, 1, "quality", lambda: "first-database"
        )
        second = get_or_create_project_analysis(
            second_database, 1, "quality", lambda: "second-database"
        )

    assert first == "first-database"
    assert second == "second-database"
    assert analysis_cache_stats() == {"hits": 0, "misses": 2, "projects": 2}
    clear_analysis_cache()
    first_engine.dispose()
    second_engine.dispose()


@pytest.mark.parametrize("invalidation", ["project", "database", "eviction"])
def test_inflight_factory_cannot_repopulate_an_invalidated_entry(invalidation):
    engine = create_engine("sqlite:///:memory:")
    started, finish = Event(), Event()
    clear_analysis_cache()

    def old_factory():
        started.set()
        assert finish.wait(5), "test coordinator did not release old factory"
        return "obsolete"

    def build_old():
        with Session(engine) as database:
            return get_or_create_project_analysis(database, 1, "quality", old_factory)

    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(build_old)
            try:
                assert started.wait(5)
                with Session(engine) as database:
                    if invalidation == "project":
                        invalidate_project_analysis(database, 1)
                    elif invalidation == "database":
                        clear_analysis_cache()
                    else:
                        for project_id in range(2, MAX_CACHED_PROJECTS_PER_DATABASE + 2):
                            get_or_create_project_analysis(database, project_id, "quality", lambda: "other")
                    fresh = get_or_create_project_analysis(database, 1, "quality", lambda: "fresh")
                    assert fresh == "fresh"
            finally:
                finish.set()
            assert pending.result(timeout=5) == "obsolete"
        with Session(engine) as database:
            assert get_or_create_project_analysis(database, 1, "quality", lambda: "unexpected") == "fresh"
            assert analysis_cache_stats()["projects"] <= MAX_CACHED_PROJECTS_PER_DATABASE
    finally:
        finish.set()
        clear_analysis_cache()
        engine.dispose()


def test_failed_factory_can_be_retried_and_none_is_cacheable():
    engine = create_engine("sqlite:///:memory:")
    clear_analysis_cache()
    try:
        with Session(engine) as database:
            with pytest.raises(ValueError):
                get_or_create_project_analysis(database, 1, "quality", lambda: (_ for _ in ()).throw(ValueError("failed")))
            assert get_or_create_project_analysis(database, 1, "quality", lambda: None) is None
            assert get_or_create_project_analysis(database, 1, "quality", lambda: "unexpected") is None
    finally:
        clear_analysis_cache()
        engine.dispose()
