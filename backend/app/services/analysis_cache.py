from collections import OrderedDict
from collections.abc import Callable
from threading import RLock
from typing import TypeVar, cast
from weakref import WeakKeyDictionary

from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

T = TypeVar("T")
MAX_CACHED_PROJECTS_PER_DATABASE = 16

_lock = RLock()
_database_caches: WeakKeyDictionary[
    Engine, OrderedDict[int, dict[str, object]]
] = WeakKeyDictionary()
_hits = 0
_misses = 0


def get_or_create_project_analysis(
    database: Session,
    project_id: int,
    namespace: str,
    factory: Callable[[], T],
) -> T:
    """Return a cached immutable analysis snapshot for one project."""
    global _hits, _misses
    engine = _session_engine(database)
    with _lock:
        project_cache = _database_caches.setdefault(engine, OrderedDict())
        namespaces = project_cache.setdefault(project_id, {})
        project_cache.move_to_end(project_id)
        if namespace in namespaces:
            _hits += 1
            return cast(T, namespaces[namespace])
        # The entry identity is a bounded generation token. Invalidating, clearing
        # or evicting it fences off every factory already running for that entry.
        _misses += 1
        while len(project_cache) > MAX_CACHED_PROJECTS_PER_DATABASE:
            project_cache.popitem(last=False)

    value = factory()
    with _lock:
        if (
            _database_caches.get(engine) is not project_cache
            or project_cache.get(project_id) is not namespaces
        ):
            # The original caller may finish, but its obsolete result must never
            # become a cache hit for a subsequent request (or a recreated ID).
            return value
        if namespace in namespaces:
            _hits += 1
            return cast(T, namespaces[namespace])
        namespaces[namespace] = value
        project_cache.move_to_end(project_id)
    return value


def invalidate_project_analysis(database: Session, project_id: int) -> None:
    engine = _session_engine(database)
    with _lock:
        project_cache = _database_caches.get(engine)
        if project_cache is not None:
            project_cache.pop(project_id, None)


def clear_analysis_cache() -> None:
    global _hits, _misses
    with _lock:
        _database_caches.clear()
        _hits = 0
        _misses = 0


def analysis_cache_stats() -> dict[str, int]:
    with _lock:
        return {
            "hits": _hits,
            "misses": _misses,
            "projects": sum(len(cache) for cache in _database_caches.values()),
        }


def _session_engine(database: Session) -> Engine:
    bind = database.get_bind()
    return bind.engine if hasattr(bind, "engine") else cast(Engine, bind)
