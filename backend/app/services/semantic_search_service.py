"""Optional local dense retrieval for repository questions.

The ONNX model and project vectors live under the configured search-index root's
parent directory, so no model data is written to the system drive by default.
Failures are deliberately non-fatal: BM25 remains the reliable fallback.
"""

import json
import math
import warnings
from array import array
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Iterable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.models.analysis import SearchChunk
from app.models.project import Project, ProjectFile
from app.services.code_scope_service import classify_code_scope
from app.services.repository_path_service import resolve_project_storage_path
from app.services.search_service import build_search_passage_metadata

SEMANTIC_MODEL_NAME = "BAAI/bge-small-zh-v1.5"
SEMANTIC_INDEX_FORMAT_VERSION = 2
MAX_SEMANTIC_CHUNKS = 5_000
MAX_SEMANTIC_TEXT_CHARS = 2_400
SEMANTIC_RESULT_LIMIT = 16
MIN_SEMANTIC_SCORE = 0.22


@dataclass(frozen=True)
class SemanticIndex:
    signature: tuple[int, int]
    chunk_ids: list[int]
    dimension: int
    vectors: array


_MODEL: object | None = None
_MODEL_CACHE_PATH: Path | None = None
_MODEL_FAILED = False
_SEMANTIC_CACHE: dict[tuple[str, int], SemanticIndex] = {}
_BUILD_LOCK = Lock()
_BUILDING_PROJECTS: set[tuple[str, int]] = set()


def build_project_semantic_index(
    database: Session,
    project: Project,
    index_root: Path,
) -> int:
    signature = _chunk_signature(database, project)
    if signature[0] == 0:
        remove_persisted_semantic_index(index_root, project)
        return 0
    existing = _SEMANTIC_CACHE.get(_cache_key(project))
    if existing is not None and existing.signature == signature:
        return len(existing.chunk_ids)
    existing = _read_index(index_root, project, signature)
    if existing is not None:
        return len(existing.chunk_ids)
    rows = database.execute(
        select(SearchChunk, ProjectFile.relative_path)
        .join(ProjectFile, ProjectFile.id == SearchChunk.file_id)
        .where(SearchChunk.project_id == project.id)
        .order_by(SearchChunk.id)
    ).all()
    rows = _select_semantic_rows(rows, MAX_SEMANTIC_CHUNKS)
    texts = [
        _passage_text(str(path), chunk.symbol_name, chunk.kind, chunk.content)
        for chunk, path in rows
    ]
    embeddings = _embed_texts(texts, _model_cache_root(index_root), query=False)
    if embeddings is None or len(embeddings) != len(rows):
        return 0
    index = _semantic_index_from_embeddings(
        signature,
        [int(chunk.id) for chunk, _ in rows],
        embeddings,
    )
    if index is None:
        return 0
    _SEMANTIC_CACHE[_cache_key(project)] = index
    _write_index(index_root, project, index)
    return len(index.chunk_ids)


def semantic_search_project(
    database: Session,
    project: Project,
    query: str,
    index_root: Path,
    limit: int = SEMANTIC_RESULT_LIMIT,
) -> list[dict[str, object]]:
    signature = _chunk_signature(database, project)
    if signature[0] == 0:
        return []
    cache_key = _cache_key(project)
    index = _SEMANTIC_CACHE.get(cache_key)
    if index is None or index.signature != signature:
        index = _read_index(index_root, project, signature)
    if index is None:
        return []
    query_embeddings = _embed_texts(
        [query], _model_cache_root(index_root), query=True
    )
    if not query_embeddings:
        return []
    query_vector = _normalize_vector(query_embeddings[0])
    if len(query_vector) != index.dimension:
        return []

    scores: list[tuple[float, int]] = []
    for position, chunk_id in enumerate(index.chunk_ids):
        start = position * index.dimension
        score = sum(
            query_vector[offset] * index.vectors[start + offset]
            for offset in range(index.dimension)
        )
        if score >= MIN_SEMANTIC_SCORE:
            scores.append((score, chunk_id))
    scores.sort(key=lambda item: -item[0])
    selected = scores[: max(limit * 3, limit)]
    if not selected:
        return []

    score_by_chunk = {chunk_id: score for score, chunk_id in selected}
    rows = database.execute(
        select(SearchChunk, ProjectFile.relative_path)
        .join(ProjectFile, ProjectFile.id == SearchChunk.file_id)
        .where(
            SearchChunk.project_id == project.id,
            SearchChunk.id.in_(score_by_chunk),
        )
    ).all()
    results: list[dict[str, object]] = []
    for chunk, file_path in rows:
        score = score_by_chunk[int(chunk.id)]
        scope = classify_code_scope(file_path)
        if scope == "generated":
            score *= 0.15
        elif scope == "test":
            score *= 0.58
        else:
            score *= 1.05
        results.append(
            {
                "file_id": int(chunk.file_id),
                "file_path": str(file_path),
                "start_line": int(chunk.start_line),
                "end_line": int(chunk.end_line),
                "symbol_name": chunk.symbol_name,
                "snippet": str(chunk.content)[:1_600],
                "source": "semantic_search",
                "_score": round(score * 30, 4),
            }
        )
    results.sort(key=lambda item: (-float(item["_score"]), str(item["file_path"])))
    return results[:limit]


def semantic_rerank_candidates(
    query: str,
    candidates: list[dict[str, object]],
    index_root: Path,
    limit: int = 36,
) -> list[dict[str, object]]:
    """Apply dense similarity to the bounded lexical/symbol candidate pool."""
    if not candidates:
        return candidates
    selected = candidates[:limit]
    texts = [
        _passage_text(
            str(item["file_path"]),
            str(item.get("symbol_name") or "") or None,
            str(item.get("source") or "evidence"),
            str(item["snippet"]),
        )
        for item in selected
    ]
    embeddings = _embed_texts(
        [query, *texts],
        _model_cache_root(index_root),
        query=False,
    )
    if embeddings is None or len(embeddings) != len(selected) + 1:
        return candidates
    query_vector = _normalize_vector(embeddings[0])
    reranked: list[dict[str, object]] = []
    for candidate, embedding in zip(selected, embeddings[1:], strict=True):
        vector = _normalize_vector(embedding)
        similarity = sum(left * right for left, right in zip(query_vector, vector, strict=True))
        updated = dict(candidate)
        updated["_semantic_score"] = similarity
        updated["_score"] = float(updated.get("_score", 0.0)) + max(0.0, similarity) * 22
        reranked.append(updated)
    return [*reranked, *candidates[len(selected) :]]


def warm_project_semantic_index(project_id: int, index_root: Path) -> None:
    """Build a persistent full-project index after the HTTP response has completed."""
    task_key = (str(index_root.resolve()), int(project_id))
    with _BUILD_LOCK:
        if task_key in _BUILDING_PROJECTS:
            return
        _BUILDING_PROJECTS.add(task_key)
    try:
        with SessionLocal() as database:
            project = database.get(Project, project_id)
            if project is not None:
                build_project_semantic_index(database, project, index_root)
    finally:
        with _BUILD_LOCK:
            _BUILDING_PROJECTS.discard(task_key)


def remove_persisted_semantic_index(index_root: Path, project: Project) -> None:
    _SEMANTIC_CACHE.pop(_cache_key(project), None)
    metadata_path, vectors_path = _index_paths(index_root, project)
    metadata_path.unlink(missing_ok=True)
    vectors_path.unlink(missing_ok=True)


def semantic_runtime_status(index_root: Path) -> dict[str, object]:
    return {
        "available": not _MODEL_FAILED,
        "model": SEMANTIC_MODEL_NAME,
        "model_cache": str(_model_cache_root(index_root)),
        "index_root": str((index_root / "semantic").resolve()),
    }


def _embed_texts(
    texts: list[str], cache_root: Path, *, query: bool
) -> list[list[float]] | None:
    if not texts:
        return []
    model = _embedding_model(cache_root)
    if model is None:
        return None
    prepared = [text[:MAX_SEMANTIC_TEXT_CHARS] for text in texts]
    try:
        return [list(map(float, vector)) for vector in model.embed(prepared, batch_size=32)]
    except Exception:
        return None


def _embedding_model(cache_root: Path) -> object | None:
    global _MODEL, _MODEL_CACHE_PATH, _MODEL_FAILED
    if _MODEL is not None and _MODEL_CACHE_PATH == cache_root:
        return _MODEL
    if _MODEL_FAILED:
        return None
    try:
        from fastembed import TextEmbedding

        cache_root.mkdir(parents=True, exist_ok=True)
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore",
                message="The model .* now uses mean pooling instead of CLS embedding.*",
                category=UserWarning,
            )
            _MODEL = TextEmbedding(
                model_name=SEMANTIC_MODEL_NAME,
                cache_dir=str(cache_root),
                threads=4,
            )
        _MODEL_CACHE_PATH = cache_root
        return _MODEL
    except Exception:
        _MODEL_FAILED = True
        return None


def _semantic_index_from_embeddings(
    signature: tuple[int, int],
    chunk_ids: list[int],
    embeddings: Iterable[Iterable[float]],
) -> SemanticIndex | None:
    normalized = [_normalize_vector(vector) for vector in embeddings]
    if not normalized or not normalized[0]:
        return None
    dimension = len(normalized[0])
    if any(len(vector) != dimension for vector in normalized):
        return None
    flattened = array("f")
    for vector in normalized:
        flattened.extend(vector)
    return SemanticIndex(signature, chunk_ids, dimension, flattened)


def _normalize_vector(vector: Iterable[float]) -> list[float]:
    values = [float(value) for value in vector]
    magnitude = math.sqrt(sum(value * value for value in values))
    if magnitude <= 0:
        return []
    return [value / magnitude for value in values]


def _chunk_signature(database: Session, project: Project) -> tuple[int, int]:
    count, maximum_id = database.execute(
        select(func.count(SearchChunk.id), func.max(SearchChunk.id)).where(
            SearchChunk.project_id == project.id
        )
    ).one()
    return int(count), int(maximum_id or 0)


def _passage_text(path: str, symbol_name: str | None, kind: str, content: str) -> str:
    metadata = build_search_passage_metadata(path, symbol_name, kind, content)
    return f"{metadata}\nsource:\n{content[:MAX_SEMANTIC_TEXT_CHARS]}"


def _select_semantic_rows(
    rows: list[tuple[SearchChunk, str]], limit: int
) -> list[tuple[SearchChunk, str]]:
    """Cover as many production files as possible before adding extra chunks."""
    if len(rows) <= limit:
        return rows

    kind_priority = {
        "function": 0,
        "method": 0,
        "class": 1,
        "interface": 1,
        "module": 2,
        "file": 2,
    }
    scope_priority = {"production": 0, "test": 1, "generated": 2}
    ordered = sorted(
        rows,
        key=lambda row: (
            scope_priority.get(classify_code_scope(str(row[1])), 0),
            str(row[1]),
            kind_priority.get(str(row[0].kind), 3),
            int(row[0].start_line),
            int(row[0].id),
        ),
    )
    selected: list[tuple[SearchChunk, str]] = []
    deferred: list[tuple[SearchChunk, str]] = []
    seen_files: set[int] = set()
    for row in ordered:
        file_id = int(row[0].file_id)
        if file_id not in seen_files:
            selected.append(row)
            seen_files.add(file_id)
        else:
            deferred.append(row)
        if len(selected) >= limit:
            return selected
    selected.extend(deferred[: limit - len(selected)])
    return selected


def _cache_key(project: Project) -> tuple[str, int]:
    return str(resolve_project_storage_path(project.storage_path)), int(project.id)


def _model_cache_root(index_root: Path) -> Path:
    return (index_root.resolve().parent / "models" / "fastembed").resolve()


def _index_paths(index_root: Path, project: Project) -> tuple[Path, Path]:
    import hashlib

    storage_key = str(resolve_project_storage_path(project.storage_path))
    digest = hashlib.sha256(storage_key.encode("utf-8")).hexdigest()[:12]
    base = index_root.resolve() / "semantic" / f"project-{project.id}-{digest}-semantic-v{SEMANTIC_INDEX_FORMAT_VERSION}"
    return base.with_suffix(".json"), base.with_suffix(".f32")


def _write_index(index_root: Path, project: Project, index: SemanticIndex) -> None:
    metadata_path, vectors_path = _index_paths(index_root, project)
    metadata_tmp = metadata_path.with_suffix(metadata_path.suffix + ".tmp")
    vectors_tmp = vectors_path.with_suffix(vectors_path.suffix + ".tmp")
    try:
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_tmp.write_text(
            json.dumps(
                {
                    "version": SEMANTIC_INDEX_FORMAT_VERSION,
                    "model": SEMANTIC_MODEL_NAME,
                    "signature": list(index.signature),
                    "dimension": index.dimension,
                    "chunk_ids": index.chunk_ids,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        with vectors_tmp.open("wb") as stream:
            index.vectors.tofile(stream)
        vectors_tmp.replace(vectors_path)
        metadata_tmp.replace(metadata_path)
    except (OSError, TypeError, ValueError):
        metadata_tmp.unlink(missing_ok=True)
        vectors_tmp.unlink(missing_ok=True)


def _read_index(
    index_root: Path,
    project: Project,
    signature: tuple[int, int],
) -> SemanticIndex | None:
    metadata_path, vectors_path = _index_paths(index_root, project)
    if not metadata_path.is_file() or not vectors_path.is_file():
        return None
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if (
            metadata.get("version") != SEMANTIC_INDEX_FORMAT_VERSION
            or metadata.get("model") != SEMANTIC_MODEL_NAME
            or tuple(metadata.get("signature", ())) != signature
        ):
            return None
        chunk_ids = [int(value) for value in metadata["chunk_ids"]]
        dimension = int(metadata["dimension"])
        vectors = array("f")
        with vectors_path.open("rb") as stream:
            vectors.fromfile(stream, len(chunk_ids) * dimension)
        if len(vectors) != len(chunk_ids) * dimension:
            return None
        index = SemanticIndex(signature, chunk_ids, dimension, vectors)
        _SEMANTIC_CACHE[_cache_key(project)] = index
        return index
    except (OSError, EOFError, json.JSONDecodeError, KeyError, TypeError, ValueError):
        return None
