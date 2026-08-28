import gzip
import hashlib
import json
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
from app.services.code_scope_service import classify_code_scope
from app.services.repository_path_service import resolve_project_storage_path

MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
MAX_CHUNK_LINES = 80
CHUNK_OVERLAP_LINES = 12
MAX_CONTAINER_LINES = 40
SYMBOL_CONTEXT_BEFORE_LINES = 3
SYMBOL_CONTEXT_AFTER_LINES = 2
MAX_CHUNK_CHARS = 16_000
MAX_INDEX_CHUNKS = 20_000
TOKEN_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+|[\u4e00-\u9fff]+")
CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
SEARCH_CACHE_LIMIT = 8
MAX_CJK_NGRAM_SOURCE_LENGTH = 512
SEARCH_INDEX_FORMAT_VERSION = 3
TEST_QUERY_TERMS = {"test", "tests", "spec", "coverage", "测试", "用例", "覆盖率"}

CONCEPT_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"(?:@\w*router\.|@app\.(?:get|post|put|patch|delete)|\b(?:route|router|endpoint|controller)\b)", re.IGNORECASE),
        "api route endpoint controller handler 接口 路由 端点",
    ),
    (
        re.compile(r"(?:__tablename__|\bselect\b.+\bfrom\b|\binsert\s+into\b|\bupdate\b.+\bset\b|\bdelete\s+from\b|sqlalchemy|prisma|repository|\bdao\b)", re.IGNORECASE),
        "database table model query persistence repository 数据库 数据表 持久化",
    ),
    (
        re.compile(r"(?:os\.environ|os\.getenv|process\.env|import\.meta\.env|base_settings|dotenv|environment)", re.IGNORECASE),
        "config settings environment env configuration 配置 环境变量",
    ),
    (
        re.compile(r"(?:\b(?:raise|throw|except|catch)\b|exception|error_handler|retry)", re.IGNORECASE),
        "error exception failure handling retry 异常 错误 失败 重试",
    ),
    (
        re.compile(r"(?:\b(?:login|signin|authenticate|authorize|jwt|token|session|password)\b)", re.IGNORECASE),
        "authentication authorization login session user 登录 认证 鉴权 会话",
    ),
    (
        re.compile(r"(?:\b(?:redis|cache|memoize|lru_cache)\b)", re.IGNORECASE),
        "cache redis caching 缓存",
    ),
)


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
        elif len(normalized) > 1:
            # Character bigrams let differently phrased Chinese questions share useful
            # lexical evidence without requiring an external segmenter or embedding model.
            bounded = normalized[:MAX_CJK_NGRAM_SOURCE_LENGTH]
            tokens.extend(bounded[index : index + 2] for index in range(len(bounded) - 1))
    return tokens


def build_project_search_index(
    database: Session,
    project: Project,
    index_root: Path | None = None,
) -> int:
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

    repository_root = resolve_project_storage_path(project.storage_path)
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
            context_start = max(1, symbol.start_line - SYMBOL_CONTEXT_BEFORE_LINES)
            context_end = min(len(lines), symbol.end_line + SYMBOL_CONTEXT_AFTER_LINES)
            chunk_count += _add_range_chunks(
                database,
                project,
                project_file,
                lines,
                context_start,
                context_end,
                symbol.qualified_name,
                symbol.kind,
                MAX_INDEX_CHUNKS - chunk_count,
            )
            covered_intervals.append((context_start, context_end))
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
    if index_root is not None:
        maximum_chunk_id = database.scalar(
            select(func.max(SearchChunk.id)).where(SearchChunk.project_id == project.id)
        ) or 0
        _load_search_index(
            database,
            project,
            (chunk_count, int(maximum_chunk_id)),
            index_root,
        )
    return chunk_count


def search_project(
    database: Session,
    project: Project,
    query: str,
    limit: int = 10,
    offset: int = 0,
    index_root: Path | None = None,
) -> dict[str, object]:
    started = time.perf_counter()
    indexed_chunks, maximum_chunk_id, indexed_characters, oversized_chunks = database.execute(
        select(
            func.count(SearchChunk.id),
            func.max(SearchChunk.id),
            func.coalesce(func.sum(func.length(SearchChunk.content)), 0),
            func.count(SearchChunk.id).filter(
                SearchChunk.end_line - SearchChunk.start_line + 1 > MAX_CHUNK_LINES
            ),
        ).where(SearchChunk.project_id == project.id)
    ).one()
    if (
        indexed_chunks == 0
        or indexed_characters > indexed_chunks * MAX_CHUNK_CHARS
        or oversized_chunks > 0
    ):
        indexed_chunks = build_project_search_index(database, project, index_root)
        database.commit()
        maximum_chunk_id = database.scalar(
            select(func.max(SearchChunk.id)).where(SearchChunk.project_id == project.id)
        ) or 0

    query_tokens = tokenize(query)
    if not query_tokens or not indexed_chunks:
        return _response(query, int(indexed_chunks), 0, limit, offset, started, [])

    index = _load_search_index(
        database,
        project,
        (int(indexed_chunks), int(maximum_chunk_id or 0)),
        index_root,
    )
    document_count = len(index.documents)
    test_focused_query = any(term in query.lower() for term in TEST_QUERY_TERMS)
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
        scope = classify_code_scope(document.file_path)
        if scope == "generated":
            score *= 0.15
        elif scope == "test":
            score *= 1.15 if test_focused_query else 0.55
        else:
            score *= 1.08
        if document.symbol_name:
            score = score * 1.15 + 0.35
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
    database: Session,
    project: Project,
    signature: tuple[int, int],
    index_root: Path | None = None,
) -> SearchIndex:
    cache_key = _cache_key(project)
    cached = _SEARCH_CACHE.get(cache_key)
    if cached is not None and cached.signature == signature:
        return cached

    if index_root is not None:
        persisted = _read_persisted_search_index(index_root, project, signature)
        if persisted is not None:
            _remember_search_index(cache_key, persisted)
            return persisted

    index = _build_runtime_search_index(database, project, signature)
    _remember_search_index(cache_key, index)
    if index_root is not None:
        _write_persisted_search_index(index_root, project, index)
    return index


def _build_runtime_search_index(
    database: Session, project: Project, signature: tuple[int, int]
) -> SearchIndex:

    rows = database.execute(
        select(SearchChunk, ProjectFile.relative_path)
        .join(ProjectFile, ProjectFile.id == SearchChunk.file_id)
        .where(SearchChunk.project_id == project.id)
    ).all()
    documents: list[SearchDocument] = []
    document_frequency: Counter[str] = Counter()
    total_tokens = 0
    for chunk, file_path in rows:
        boosted_metadata = build_search_passage_metadata(
            file_path,
            chunk.symbol_name,
            chunk.kind,
            chunk.content,
        )
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
    return SearchIndex(
        signature=signature,
        documents=documents,
        average_length=total_tokens / len(documents) if documents else 1.0,
        document_frequency=document_frequency,
    )


def _remember_search_index(cache_key: tuple[str, int], index: SearchIndex) -> None:
    if len(_SEARCH_CACHE) >= SEARCH_CACHE_LIMIT:
        _SEARCH_CACHE.pop(next(iter(_SEARCH_CACHE)))
    _SEARCH_CACHE[cache_key] = index


def _write_persisted_search_index(
    index_root: Path, project: Project, index: SearchIndex
) -> None:
    path = _persisted_index_path(index_root, project)
    temporary = path.with_suffix(path.suffix + ".tmp")
    payload = {
        "version": SEARCH_INDEX_FORMAT_VERSION,
        "storage_key": _project_storage_key(project),
        "signature": list(index.signature),
        "average_length": index.average_length,
        "document_frequency": dict(index.document_frequency),
        "documents": [
            [
                document.chunk_id,
                document.file_id,
                document.file_path,
                document.symbol_name,
                document.kind,
                document.start_line,
                document.end_line,
                document.content,
                document.token_count,
                dict(document.frequencies),
            ]
            for document in index.documents
        ],
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=6) as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
        temporary.replace(path)
    except (OSError, TypeError, ValueError):
        temporary.unlink(missing_ok=True)


def _read_persisted_search_index(
    index_root: Path, project: Project, signature: tuple[int, int]
) -> SearchIndex | None:
    path = _persisted_index_path(index_root, project)
    if not path.is_file():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            payload = json.load(stream)
        if (
            payload.get("version") != SEARCH_INDEX_FORMAT_VERSION
            or payload.get("storage_key") != _project_storage_key(project)
            or tuple(payload.get("signature", ())) != signature
        ):
            return None
        documents = [
            SearchDocument(
                chunk_id=int(item[0]),
                file_id=int(item[1]),
                file_path=str(item[2]),
                symbol_name=str(item[3]) if item[3] is not None else None,
                kind=str(item[4]),
                start_line=int(item[5]),
                end_line=int(item[6]),
                content=str(item[7]),
                token_count=int(item[8]),
                frequencies=Counter(
                    {str(token): int(count) for token, count in dict(item[9]).items()}
                ),
            )
            for item in payload["documents"]
            if isinstance(item, list) and len(item) == 10
        ]
        if len(documents) != signature[0]:
            return None
        return SearchIndex(
            signature=signature,
            documents=documents,
            average_length=float(payload["average_length"]),
            document_frequency=Counter(
                {
                    str(token): int(count)
                    for token, count in dict(payload["document_frequency"]).items()
                }
            ),
        )
    except (OSError, EOFError, KeyError, TypeError, ValueError):
        return None


def remove_persisted_search_index(index_root: Path, project: Project) -> None:
    _SEARCH_CACHE.pop(_cache_key(project), None)
    _persisted_index_path(index_root, project).unlink(missing_ok=True)
    from app.services.semantic_search_service import remove_persisted_semantic_index

    remove_persisted_semantic_index(index_root, project)


def _persisted_index_path(index_root: Path, project: Project) -> Path:
    digest = hashlib.sha256(_project_storage_key(project).encode("utf-8")).hexdigest()[:12]
    return index_root.resolve() / (
        f"project-{project.id}-{digest}-search-v{SEARCH_INDEX_FORMAT_VERSION}.json.gz"
    )


def _project_storage_key(project: Project) -> str:
    return str(resolve_project_storage_path(project.storage_path))


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


def build_search_passage_metadata(
    file_path: str,
    symbol_name: str | None,
    kind: str,
    content: str,
) -> str:
    """Create query-oriented metadata without changing source line references."""
    normalized_path = file_path.replace("\\", "/")
    labels = [
        f"path {normalized_path}",
        f"symbol {symbol_name or ''} {symbol_name or ''}",
        f"kind {kind}",
    ]
    if classify_code_scope(normalized_path.lower()) == "test":
        labels.append("test tests spec coverage 测试 用例 覆盖率")
    combined = f"{normalized_path}\n{symbol_name or ''}\n{content[:6_000]}"
    labels.extend(label for pattern, label in CONCEPT_PATTERNS if pattern.search(combined))
    return "\n".join(labels)


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
    match_index: int | None = None
    for index, line in enumerate(lines):
        line_tokens = set(tokenize(line))
        if any(token in line_tokens for token in query_tokens):
            match_index = index
            break
    if match_index is None:
        query_token_set = set(query_tokens)
        for pattern, labels in CONCEPT_PATTERNS:
            if not query_token_set.intersection(tokenize(labels)):
                continue
            match_index = next(
                (index for index, line in enumerate(lines) if pattern.search(line)),
                None,
            )
            if match_index is not None:
                break
    if match_index is None:
        match_index = 0
    start_index = max(0, match_index - 2)
    end_index = min(len(lines), match_index + 3)
    return (
        "\n".join(lines[start_index:end_index]),
        start_line + start_index,
        start_line + end_index - 1,
    )


def _cache_key(project: Project) -> tuple[str, int]:
    return str(resolve_project_storage_path(project.storage_path)), project.id


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
