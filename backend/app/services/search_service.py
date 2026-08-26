import math
import re
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models.analysis import CodeSymbol, SearchChunk
from app.models.project import Project, ProjectFile
from app.services.code_parser import supports_extension


MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
MAX_CHUNK_LINES = 120
CHUNK_OVERLAP_LINES = 20
MAX_CONTAINER_LINES = 40
MAX_CHUNK_CHARS = 16_000
MAX_INDEX_CHUNKS = 20_000
TOKEN_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+|[\u4e00-\u9fff]+")
CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
SEARCH_CACHE_LIMIT = 8


@dataclass(frozen=True)
class SearchDocument:
    chunk_id: int
    file_id: int
    file_path: str
    symbol_name: str | None
    kind: str
    start_line: int
    end_line: int
    content: str
    token_count: int
    frequencies: Counter[str]


@dataclass(frozen=True)
class SearchIndex:
    signature: tuple[int, int]
    documents: list[SearchDocument]
    average_length: float
    document_frequency: Counter[str]


_SEARCH_CACHE: dict[tuple[str, int], SearchIndex] = {}


def tokenize(value: str) -> list[str]:
    tokens: list[str] = []
    for match in TOKEN_PATTERN.findall(value):
        normalized = match.lower()
        tokens.append(normalized)
        if normalized.isascii():
            parts: list[str] = []
            for underscore_part in match.split("_"):
                parts.extend(CAMEL_BOUNDARY.split(underscore_part))
            tokens.extend(part.lower() for part in parts if part and part.lower() != normalized)
    return tokens


def build_project_search_index(database: Session, project: Project) -> int:
    _SEARCH_CACHE.pop(_cache_key(project), None)
    database.execute(delete(SearchChunk).where(SearchChunk.project_id == project.id))
    database.flush()

    symbols_by_file: dict[int, list[CodeSymbol]] = defaultdict(list)
    symbols = database.scalars(
        select(CodeSymbol)
        .where(CodeSymbol.project_id == project.id)
        .order_by(CodeSymbol.file_id, CodeSymbol.start_line, CodeSymbol.end_line)
    )
    for symbol in symbols:
        symbols_by_file[symbol.file_id].append(symbol)

    repository_root = Path(project.storage_path).resolve()
    chunk_count = 0
    project_files = list(
        database.scalars(
            select(ProjectFile)
            .where(ProjectFile.project_id == project.id)
            .order_by(ProjectFile.relative_path)
        )
    )
    for project_file in project_files:
        if chunk_count >= MAX_INDEX_CHUNKS:
            break
        if not supports_extension(project_file.extension):
            continue
        if project_file.size_bytes > MAX_SEARCH_FILE_BYTES:
            continue

        source_path = (repository_root / project_file.relative_path).resolve()
        if repository_root != source_path and repository_root not in source_path.parents:
            continue
        try:
            lines = source_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue

        file_symbols = symbols_by_file.get(project_file.id, [])
        if not file_symbols:
            chunk_count += _add_range_chunks(
                database, project, project_file, lines, 1, len(lines), None, "file",
                MAX_INDEX_CHUNKS - chunk_count,
            )
            continue

        covered_intervals: list[tuple[int, int]] = []
        for symbol in file_symbols:
            chunk_count += _add_range_chunks(
                database,
                project,
                project_file,
                lines,
                symbol.start_line,
                symbol.end_line,
                symbol.qualified_name,
                symbol.kind,
                MAX_INDEX_CHUNKS - chunk_count,
            )
            covered_intervals.append((symbol.start_line, symbol.end_line))
            if chunk_count >= MAX_INDEX_CHUNKS:
                break

        if chunk_count >= MAX_INDEX_CHUNKS:
            break
        for start_line, end_line in _uncovered_ranges(len(lines), covered_intervals):
            chunk_count += _add_range_chunks(
                database, project, project_file, lines, start_line, end_line, None, "module",
                MAX_INDEX_CHUNKS - chunk_count,
            )
            if chunk_count >= MAX_INDEX_CHUNKS:
                break

    database.flush()
    return chunk_count


def search_project(
    database: Session,
    project: Project,
    query: str,
    limit: int = 10,
    offset: int = 0,
) -> dict[str, object]:
    started = time.perf_counter()
    indexed_chunks, maximum_chunk_id, indexed_characters = database.execute(
        select(
            func.count(SearchChunk.id),
            func.max(SearchChunk.id),
            func.coalesce(func.sum(func.length(SearchChunk.content)), 0),
        ).where(SearchChunk.project_id == project.id)
    ).one()
    if indexed_chunks == 0 or indexed_characters > indexed_chunks * MAX_CHUNK_CHARS:
        indexed_chunks = build_project_search_index(database, project)
        database.commit()
        maximum_chunk_id = database.scalar(
            select(func.max(SearchChunk.id)).where(SearchChunk.project_id == project.id)
        ) or 0

    query_tokens = tokenize(query)
    if not query_tokens or not indexed_chunks:
        return _response(query, int(indexed_chunks), 0, limit, offset, started, [])

    index = _load_search_index(
        database, project, (int(indexed_chunks), int(maximum_chunk_id or 0))
    )
    document_count = len(index.documents)
    scored: list[tuple[float, SearchDocument]] = []
    for document in index.documents:
        score = _bm25_score(
            query_tokens,
            document.frequencies,
            document.token_count,
            index.average_length,
            document_count,
            index.document_frequency,
        )
        if score > 0:
            scored.append((score, document))

    scored.sort(key=lambda item: (-item[0], item[1].file_path, item[1].start_line))
    results = []
    for score, document in scored[offset : offset + limit]:
        snippet, snippet_start, snippet_end = _make_snippet(
            document.content, document.start_line, query_tokens
        )
        results.append(
            {
                "chunk_id": document.chunk_id,
                "file_id": document.file_id,
                "file_path": document.file_path,
                "symbol_name": document.symbol_name,
                "kind": document.kind,
                "start_line": document.start_line,
                "end_line": document.end_line,
                "snippet_start_line": snippet_start,
                "snippet_end_line": snippet_end,
                "snippet": snippet,
                "score": round(score, 4),
            }
        )
    return _response(
        query,
        int(indexed_chunks),
        len(scored),
        limit,
        offset,
        started,
        results,
    )


def _load_search_index(
    database: Session, project: Project, signature: tuple[int, int]
) -> SearchIndex:
    cache_key = _cache_key(project)
    cached = _SEARCH_CACHE.get(cache_key)
    if cached is not None and cached.signature == signature:
        return cached

    rows = database.execute(
        select(SearchChunk, ProjectFile.relative_path)
        .join(ProjectFile, ProjectFile.id == SearchChunk.file_id)
        .where(SearchChunk.project_id == project.id)
    ).all()
    documents: list[SearchDocument] = []
    document_frequency: Counter[str] = Counter()
    total_tokens = 0
    for chunk, file_path in rows:
        boosted_metadata = f"{file_path} {chunk.symbol_name or ''} {chunk.symbol_name or ''}"
        tokens = tokenize(f"{boosted_metadata}\n{chunk.content}")
        frequencies = Counter(tokens)
        document_frequency.update(frequencies.keys())
        total_tokens += len(tokens)
        documents.append(
            SearchDocument(
                chunk_id=chunk.id,
                file_id=chunk.file_id,
                file_path=file_path,
                symbol_name=chunk.symbol_name,
                kind=chunk.kind,
                start_line=chunk.start_line,
                end_line=chunk.end_line,
                content=chunk.content,
                token_count=len(tokens),
                frequencies=frequencies,
            )
        )
    index = SearchIndex(
        signature=signature,
        documents=documents,
        average_length=total_tokens / len(documents) if documents else 1.0,
        document_frequency=document_frequency,
    )
    if len(_SEARCH_CACHE) >= SEARCH_CACHE_LIMIT:
        _SEARCH_CACHE.pop(next(iter(_SEARCH_CACHE)))
    _SEARCH_CACHE[cache_key] = index
    return index


def _bm25_score(
    query_tokens: list[str],
    counts: Counter[str],
    document_length: int,
    average_length: float,
    document_count: int,
    document_frequency: Counter[str],
) -> float:
    k1 = 1.5
    b = 0.75
    score = 0.0
    for token in set(query_tokens):
        frequency = counts[token]
        if frequency == 0:
            continue
        containing_documents = document_frequency[token]
        inverse_document_frequency = math.log(
            1 + (document_count - containing_documents + 0.5) / (containing_documents + 0.5)
        )
        denominator = frequency + k1 * (
            1 - b + b * document_length / max(average_length, 1.0)
        )
        score += inverse_document_frequency * frequency * (k1 + 1) / denominator
    return score


def _add_range_chunks(
    database: Session,
    project: Project,
    project_file: ProjectFile,
    lines: list[str],
    start_line: int,
    end_line: int,
    symbol_name: str | None,
    kind: str,
    remaining: int,
) -> int:
    if remaining <= 0 or not lines:
        return 0
    start_line = max(1, start_line)
    end_line = min(len(lines), max(start_line, end_line))
    if kind in {"class", "interface"}:
        end_line = min(end_line, start_line + MAX_CONTAINER_LINES - 1)
    step = MAX_CHUNK_LINES - CHUNK_OVERLAP_LINES
    added = 0
    current = start_line
    while current <= end_line and added < remaining:
        chunk_end = min(end_line, current + MAX_CHUNK_LINES - 1)
        content = "\n".join(lines[current - 1 : chunk_end])[:MAX_CHUNK_CHARS]
        if content.strip():
            indexed_line_count = max(1, len(content.splitlines()))
            database.add(
                SearchChunk(
                    project_id=project.id,
                    file_id=project_file.id,
                    symbol_name=symbol_name,
                    kind=kind,
                    start_line=current,
                    end_line=min(chunk_end, current + indexed_line_count - 1),
                    content=content,
                )
            )
            added += 1
        if chunk_end == end_line:
            break
        current += step
    return added


def _uncovered_ranges(
    line_count: int, intervals: list[tuple[int, int]]
) -> list[tuple[int, int]]:
    if line_count <= 0:
        return []
    merged: list[list[int]] = []
    for start, end in sorted(intervals):
        start, end = max(1, start), min(line_count, end)
        if not merged or start > merged[-1][1] + 1:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    ranges: list[tuple[int, int]] = []
    cursor = 1
    for start, end in merged:
        if cursor < start:
            ranges.append((cursor, start - 1))
        cursor = max(cursor, end + 1)
    if cursor <= line_count:
        ranges.append((cursor, line_count))
    return ranges


def _make_snippet(
    content: str, start_line: int, query_tokens: list[str]
) -> tuple[str, int, int]:
    lines = content.splitlines()
    match_index = 0
    for index, line in enumerate(lines):
        line_tokens = set(tokenize(line))
        if any(token in line_tokens for token in query_tokens):
            match_index = index
            break
    start_index = max(0, match_index - 2)
    end_index = min(len(lines), match_index + 3)
    return (
        "\n".join(lines[start_index:end_index]),
        start_line + start_index,
        start_line + end_index - 1,
    )


def _cache_key(project: Project) -> tuple[str, int]:
    return str(project.storage_path), project.id


def _response(
    query: str,
    indexed_chunks: int,
    total_matches: int,
    limit: int,
    offset: int,
    started: float,
    results: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "query": query,
        "indexed_chunks": indexed_chunks,
        "total_matches": total_matches,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(results) < total_matches,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
        "results": results,
    }
