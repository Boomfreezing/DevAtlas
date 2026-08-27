from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.services.analysis_cache import (
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
