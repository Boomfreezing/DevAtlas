import json
import posixpath
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from sqlalchemy import case, delete, func, or_, select
from sqlalchemy.orm import Session

from app.models.analysis import CodeSymbol, ImportRelation, ParseIssue, SearchChunk
from app.models.project import Project, ProjectFile
from app.services.analysis_cache import invalidate_project_analysis
from app.services.code_parser import parse_source, supports_extension
from app.services.repository_path_service import resolve_project_storage_path

MAX_PARSE_FILE_BYTES = 2 * 1024 * 1024
JAVASCRIPT_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx")
SOURCE_ROOT_DIRECTORIES = {"src", "backend", "server", "python"}


@dataclass(frozen=True)
class JavascriptImportConfig:
    directory: str
    base_url: str
    paths: dict[str, tuple[str, ...]]


def analyze_project_structure(
    database: Session,
    project: Project,
    progress_callback: Callable[[str, int, str], None] | None = None,
    search_index_root: Path | None = None,
) -> None:
    invalidate_project_analysis(database, project.id)
    database.execute(delete(SearchChunk).where(SearchChunk.project_id == project.id))
    database.execute(delete(CodeSymbol).where(CodeSymbol.project_id == project.id))
    database.execute(delete(ImportRelation).where(ImportRelation.project_id == project.id))
    database.execute(delete(ParseIssue).where(ParseIssue.project_id == project.id))

    files = list(project.files)
    _parse_project_files(database, project, files, files)

    database.flush()

    if progress_callback is not None:
        database.commit()
        progress_callback("indexing", 86, "正在建立并持久化 BM25 代码搜索索引")

    # Rebuild search chunks from the freshly persisted symbol line ranges.
    from app.services.search_service import build_project_search_index

    build_project_search_index(database, project, search_index_root)


def analyze_project_file_subset(
    database: Session, project: Project, project_files: list[ProjectFile]
) -> None:
    if not project_files:
        return
    file_ids = [item.id for item in project_files]
    database.execute(delete(SearchChunk).where(SearchChunk.file_id.in_(file_ids)))
    database.execute(delete(CodeSymbol).where(CodeSymbol.file_id.in_(file_ids)))
    database.execute(delete(ImportRelation).where(ImportRelation.file_id.in_(file_ids)))
    database.execute(delete(ParseIssue).where(ParseIssue.file_id.in_(file_ids)))
    all_files = list(
        database.scalars(
            select(ProjectFile)
            .where(ProjectFile.project_id == project.id)
            .order_by(ProjectFile.relative_path)
        )
    )
    _parse_project_files(database, project, project_files, all_files)
    _refresh_import_resolutions(database, project, all_files)
    database.flush()


def _parse_project_files(
    database: Session,
    project: Project,
    files_to_parse: list[ProjectFile],
    all_files: list[ProjectFile],
) -> None:
    repository_root = resolve_project_storage_path(project.storage_path)
    file_by_path = {item.relative_path: item for item in all_files}
    module_index = _build_python_module_index(all_files)
    javascript_configs = _load_javascript_import_configs(repository_root, all_files)

    for project_file in files_to_parse:
        if not supports_extension(project_file.extension):
            continue
        if project_file.size_bytes > MAX_PARSE_FILE_BYTES:
            _add_issue(database, project, project_file, "File exceeds the 2 MB parser limit.")
            continue
        source_path = (repository_root / project_file.relative_path).resolve()
        if repository_root not in source_path.parents:
            _add_issue(database, project, project_file, "File path is outside the managed repository.")
            continue

        try:
            source = source_path.read_bytes()
            result = parse_source(source, project_file.extension)
        except (OSError, ValueError) as error:
            _add_issue(database, project, project_file, f"Parser failed: {error}")
            continue

        for symbol in result.symbols:
            database.add(
                CodeSymbol(
                    project_id=project.id,
                    file_id=project_file.id,
                    name=symbol.name,
                    qualified_name=symbol.qualified_name,
                    kind=symbol.kind,
                    start_line=symbol.start_line,
                    end_line=symbol.end_line,
                )
            )

        for imported in result.imports:
            resolved_file = _resolve_import(
                project_file,
                imported.target_module,
                file_by_path,
                module_index,
                javascript_configs,
            )
            database.add(
                ImportRelation(
                    project_id=project.id,
                    file_id=project_file.id,
                    resolved_file_id=resolved_file.id if resolved_file else None,
                    source_path=project_file.relative_path,
                    target_module=imported.target_module,
                    line_number=imported.line_number,
                )
            )

        if result.has_syntax_errors:
            _add_issue(database, project, project_file, "Tree-sitter found one or more syntax errors.")


def _refresh_import_resolutions(
    database: Session, project: Project, all_files: list[ProjectFile]
) -> None:
    file_by_path = {item.relative_path: item for item in all_files}
    file_by_id = {item.id: item for item in all_files}
    module_index = _build_python_module_index(all_files)
    repository_root = resolve_project_storage_path(project.storage_path)
    javascript_configs = _load_javascript_import_configs(repository_root, all_files)
    relations = database.scalars(
        select(ImportRelation).where(ImportRelation.project_id == project.id)
    )
    for relation in relations:
        source_file = file_by_id.get(relation.file_id)
        if source_file is None:
            continue
        resolved = _resolve_import(
            source_file,
            relation.target_module,
            file_by_path,
            module_index,
            javascript_configs,
        )
        relation.resolved_file_id = resolved.id if resolved else None


def _add_issue(
    database: Session, project: Project, project_file: ProjectFile, message: str
) -> None:
    database.add(
        ParseIssue(
            project_id=project.id,
            file_id=project_file.id,
            file_path=project_file.relative_path,
            message=message,
        )
    )


def _build_python_module_index(files: list[ProjectFile]) -> dict[str, ProjectFile]:
    candidates: dict[str, list[ProjectFile]] = {}
    for item in files:
        if item.extension != ".py":
            continue
        module = item.relative_path[:-3].replace("/", ".")
        if module.endswith(".__init__"):
            module = module.removesuffix(".__init__")
        aliases = {module}
        parts = module.split(".")
        if len(parts) > 1 and parts[0] in SOURCE_ROOT_DIRECTORIES:
            aliases.add(".".join(parts[1:]))
        for alias in aliases:
            candidates.setdefault(alias, []).append(item)
    return {
        module: matches[0]
        for module, matches in candidates.items()
        if len(matches) == 1
    }


def _resolve_import(
    source_file: ProjectFile,
    target: str,
    file_by_path: dict[str, ProjectFile],
    module_index: dict[str, ProjectFile],
    javascript_configs: tuple[JavascriptImportConfig, ...] = (),
) -> ProjectFile | None:
    if source_file.extension == ".py":
        module = target
        if target.startswith("."):
            level = len(target) - len(target.lstrip("."))
            suffix = target.lstrip(".")
            source_parts = source_file.relative_path[:-3].split("/")[:-1]
            keep = max(0, len(source_parts) - max(0, level - 1))
            module = ".".join([*source_parts[:keep], *([suffix] if suffix else [])])
        return module_index.get(module)

    source_directory = PurePosixPath(source_file.relative_path).parent.as_posix()
    if target.startswith("."):
        return _resolve_javascript_path(
            posixpath.join(source_directory, target), file_by_path
        )

    for config in _applicable_javascript_configs(source_file.relative_path, javascript_configs):
        for pattern, replacements in config.paths.items():
            wildcard = _match_path_alias(pattern, target)
            if wildcard is None:
                continue
            for replacement in replacements:
                substituted = replacement.replace("*", wildcard)
                resolved = _resolve_javascript_path(
                    posixpath.join(config.base_url, substituted), file_by_path
                )
                if resolved is not None:
                    return resolved
        resolved = _resolve_javascript_path(
            posixpath.join(config.base_url, target), file_by_path
        )
        if resolved is not None:
            return resolved

    return _resolve_javascript_path(target.lstrip("/"), file_by_path)


def _resolve_javascript_path(
    candidate_path: str, file_by_path: dict[str, ProjectFile]
) -> ProjectFile | None:
    normalized = posixpath.normpath(candidate_path).removeprefix("./")
    if normalized == ".." or normalized.startswith("../"):
        return None
    candidates = [
        normalized,
        *(f"{normalized}{extension}" for extension in JAVASCRIPT_EXTENSIONS),
        f"{normalized}.d.ts",
        *(f"{normalized}/index{extension}" for extension in JAVASCRIPT_EXTENSIONS),
        f"{normalized}/index.d.ts",
    ]
    return next((file_by_path[path] for path in candidates if path in file_by_path), None)


def _load_javascript_import_configs(
    repository_root: Path, files: list[ProjectFile]
) -> tuple[JavascriptImportConfig, ...]:
    configs: list[JavascriptImportConfig] = []
    for item in files:
        if PurePosixPath(item.relative_path).name not in {"tsconfig.json", "jsconfig.json"}:
            continue
        config_path = repository_root / item.relative_path
        try:
            raw = config_path.read_text(encoding="utf-8-sig")
            data = json.loads(_strip_json_comments_and_trailing_commas(raw))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        compiler_options = data.get("compilerOptions", {})
        if not isinstance(compiler_options, dict):
            continue
        directory = PurePosixPath(item.relative_path).parent.as_posix()
        directory = "" if directory == "." else directory
        base_url_value = compiler_options.get("baseUrl", ".")
        base_url = posixpath.normpath(
            posixpath.join(directory, str(base_url_value))
        ).removeprefix("./")
        raw_paths = compiler_options.get("paths", {})
        paths = {
            str(pattern): tuple(str(value) for value in values)
            for pattern, values in raw_paths.items()
            if isinstance(values, list)
        } if isinstance(raw_paths, dict) else {}
        configs.append(JavascriptImportConfig(directory, base_url, paths))
    return tuple(sorted(configs, key=lambda config: len(config.directory), reverse=True))


def _applicable_javascript_configs(
    source_path: str, configs: tuple[JavascriptImportConfig, ...]
) -> list[JavascriptImportConfig]:
    return [
        config
        for config in configs
        if not config.directory
        or source_path == config.directory
        or source_path.startswith(f"{config.directory}/")
    ]


def _match_path_alias(pattern: str, target: str) -> str | None:
    if "*" not in pattern:
        return "" if pattern == target else None
    prefix, suffix = pattern.split("*", 1)
    if not target.startswith(prefix) or not target.endswith(suffix):
        return None
    end = len(target) - len(suffix) if suffix else len(target)
    return target[len(prefix):end]


def _strip_json_comments_and_trailing_commas(raw: str) -> str:
    without_block_comments = re.sub(r"/\*.*?\*/", "", raw, flags=re.DOTALL)
    without_line_comments = re.sub(r"(^|\s)//.*?$", r"\1", without_block_comments, flags=re.MULTILINE)
    return re.sub(r",\s*([}\]])", r"\1", without_line_comments)


def load_project_structure(database: Session, project_id: int) -> dict[str, object]:
    symbol_rows = database.execute(
        select(CodeSymbol, ProjectFile.relative_path)
        .join(ProjectFile, ProjectFile.id == CodeSymbol.file_id)
        .where(CodeSymbol.project_id == project_id)
        .order_by(ProjectFile.relative_path, CodeSymbol.start_line)
    ).all()
    symbols = [
        {
            "id": symbol.id,
            "file_id": symbol.file_id,
            "name": symbol.name,
            "qualified_name": symbol.qualified_name,
            "kind": symbol.kind,
            "start_line": symbol.start_line,
            "end_line": symbol.end_line,
            "file_path": file_path,
        }
        for symbol, file_path in symbol_rows
    ]
    imports = list(
        database.scalars(
            select(ImportRelation)
            .where(ImportRelation.project_id == project_id)
            .order_by(ImportRelation.source_path, ImportRelation.line_number)
        )
    )
    issues = list(
        database.scalars(
            select(ParseIssue)
            .where(ParseIssue.project_id == project_id)
            .order_by(ParseIssue.file_path)
        )
    )
    return {
        **load_project_structure_summary(database, project_id),
        "symbols": symbols,
        "imports": imports,
        "issues": issues,
    }


def load_project_structure_summary(database: Session, project_id: int) -> dict[str, int]:
    """Load aggregate structure metrics without materializing every result row."""
    symbol_count, class_count, function_count = database.execute(
        select(
            func.count(CodeSymbol.id),
            func.sum(
                case((CodeSymbol.kind.in_(["class", "interface"]), 1), else_=0)
            ),
            func.sum(
                case((CodeSymbol.kind.in_(["function", "method"]), 1), else_=0)
            ),
        ).where(CodeSymbol.project_id == project_id)
    ).one()
    import_count, resolved_import_count = database.execute(
        select(
            func.count(ImportRelation.id),
            func.sum(case((ImportRelation.resolved_file_id.is_not(None), 1), else_=0)),
        ).where(ImportRelation.project_id == project_id)
    ).one()
    issue_count = database.scalar(
        select(func.count(ParseIssue.id)).where(ParseIssue.project_id == project_id)
    )
    return {
        "symbol_count": int(symbol_count or 0),
        "class_count": int(class_count or 0),
        "function_count": int(function_count or 0),
        "import_count": int(import_count or 0),
        "resolved_import_count": int(resolved_import_count or 0),
        "issue_count": int(issue_count or 0),
    }


def load_project_symbols(
    database: Session,
    project_id: int,
    *,
    offset: int,
    limit: int,
    query: str | None = None,
    kind: str | None = None,
) -> dict[str, object]:
    filters = [CodeSymbol.project_id == project_id]
    if query:
        pattern = f"%{query}%"
        filters.append(
            or_(
                CodeSymbol.name.ilike(pattern),
                CodeSymbol.qualified_name.ilike(pattern),
                ProjectFile.relative_path.ilike(pattern),
            )
        )
    if kind:
        filters.append(CodeSymbol.kind == kind)

    total = database.scalar(
        select(func.count(CodeSymbol.id))
        .join(ProjectFile, ProjectFile.id == CodeSymbol.file_id)
        .where(*filters)
    ) or 0
    rows = database.execute(
        select(CodeSymbol, ProjectFile.relative_path)
        .join(ProjectFile, ProjectFile.id == CodeSymbol.file_id)
        .where(*filters)
        .order_by(ProjectFile.relative_path, CodeSymbol.start_line, CodeSymbol.id)
        .offset(offset)
        .limit(limit)
    ).all()
    items = [
        {
            "id": symbol.id,
            "file_id": symbol.file_id,
            "name": symbol.name,
            "qualified_name": symbol.qualified_name,
            "kind": symbol.kind,
            "start_line": symbol.start_line,
            "end_line": symbol.end_line,
            "file_path": file_path,
        }
        for symbol, file_path in rows
    ]
    return _page(items, int(total), offset, limit)


def load_project_imports(
    database: Session,
    project_id: int,
    *,
    offset: int,
    limit: int,
    query: str | None = None,
    scope: str = "all",
) -> dict[str, object]:
    filters = [ImportRelation.project_id == project_id]
    if query:
        pattern = f"%{query}%"
        filters.append(
            or_(
                ImportRelation.source_path.ilike(pattern),
                ImportRelation.target_module.ilike(pattern),
            )
        )
    if scope == "internal":
        filters.append(ImportRelation.resolved_file_id.is_not(None))
    elif scope == "external":
        filters.append(ImportRelation.resolved_file_id.is_(None))

    total = database.scalar(
        select(func.count(ImportRelation.id)).where(*filters)
    ) or 0
    items = list(
        database.scalars(
            select(ImportRelation)
            .where(*filters)
            .order_by(
                ImportRelation.source_path,
                ImportRelation.line_number,
                ImportRelation.id,
            )
            .offset(offset)
            .limit(limit)
        )
    )
    return _page(items, int(total), offset, limit)


def load_project_issues(
    database: Session, project_id: int, *, offset: int, limit: int
) -> dict[str, object]:
    total = database.scalar(
        select(func.count(ParseIssue.id)).where(ParseIssue.project_id == project_id)
    ) or 0
    items = list(
        database.scalars(
            select(ParseIssue)
            .where(ParseIssue.project_id == project_id)
            .order_by(ParseIssue.file_path, ParseIssue.id)
            .offset(offset)
            .limit(limit)
        )
    )
    return _page(items, int(total), offset, limit)


def _page(items: list[object], total: int, offset: int, limit: int) -> dict[str, object]:
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(items) < total,
        "items": items,
    }
