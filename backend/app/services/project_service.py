import shutil
from collections.abc import Callable
from pathlib import Path, PurePosixPath

from sqlalchemy import func, literal, select, union_all
from sqlalchemy.orm import Session

from app.models.project import Project, ProjectFile
from app.services.repository_path_service import resolve_project_storage_path
from app.services.repository_scanner import scan_repository
from app.services.snapshot_service import create_analysis_snapshot
from app.services.structure_analyzer import analyze_project_structure


def create_scanned_project(
    database: Session,
    repository_path: Path,
    source_filename: str,
    project_name: str,
    progress_callback: Callable[[str, int, str], None] | None = None,
    search_index_root: Path | None = None,
    source_commit: str | None = None,
) -> Project:
    _notify(progress_callback, "scanning", 35, "正在扫描仓库文件")
    result = scan_repository(repository_path)
    project = Project(
        name=project_name,
        source_filename=source_filename,
        storage_path=str(repository_path.resolve()),
        source_commit=source_commit,
        status="analyzing" if progress_callback is not None else "ready",
        primary_language=result.primary_language,
        file_count=len(result.files),
        code_line_count=result.code_line_count,
    )
    project.files = [
        ProjectFile(
            relative_path=item.relative_path,
            extension=item.extension,
            language=item.language,
            size_bytes=item.size_bytes,
            line_count=item.line_count,
            content_hash=item.content_hash,
            modified_time_ns=item.modified_time_ns,
        )
        for item in result.files
    ]
    database.add(project)
    database.flush()
    if progress_callback is not None:
        database.commit()
    _notify(progress_callback, "parsing", 58, "正在解析函数、类和导入关系")
    analyze_project_structure(database, project, progress_callback, search_index_root)
    project.status = "ready"
    database.commit()
    database.refresh(project)
    create_analysis_snapshot(database, project, reason="import", use_runtime_cache=False)
    _notify(progress_callback, "finalizing", 96, "正在整理分析结果")
    return project


def _notify(
    callback: Callable[[str, int, str], None] | None,
    stage: str,
    progress: int,
    message: str,
) -> None:
    if callback is not None:
        callback(stage, progress, message)


def remove_managed_repository(repository_path: Path, repository_root: Path) -> None:
    root = repository_root.resolve()
    resolved_path = resolve_project_storage_path(repository_path)
    try:
        relative_path = resolved_path.relative_to(root)
    except ValueError:
        return
    if not relative_path.parts:
        return
    shutil.rmtree(root / relative_path.parts[0], ignore_errors=True)


def load_project_file_tree(
    database: Session,
    project_id: int,
    directory: str = "",
    *,
    limit: int = 200,
    offset: int = 0,
) -> dict[str, object]:
    """Aggregate immediate children in SQLite; materialize only the requested page."""
    if not 1 <= limit <= 500 or not 0 <= offset <= 2_147_483_647:
        raise ValueError("File tree limit must be 1–500 and offset must be 0–2147483647.")
    normalized = _normalize_tree_directory(directory)
    prefix = f"{normalized}/" if normalized else ""
    relative = func.substr(ProjectFile.relative_path, len(prefix) + 1)
    statement = select(
        relative.label("relative"),
        ProjectFile.id,
        ProjectFile.extension,
        ProjectFile.language,
        ProjectFile.size_bytes,
        ProjectFile.line_count,
    ).where(ProjectFile.project_id == project_id)
    if prefix:
        # LIKE is case-insensitive in SQLite and treats '_'/'%' as wildcards.
        statement = statement.where(
            func.substr(ProjectFile.relative_path, 1, len(prefix)) == prefix
        )
    descendants = statement.cte("tree_descendants")
    separator = func.instr(descendants.c.relative, "/")
    child_name = func.substr(descendants.c.relative, 1, separator - 1)
    # Aggregate directories only: grouping and min() over every direct file would
    # waste work in wide directories. The CTE is local to this read, not a stored index.
    directories = select(
        literal(True).label("is_directory"), child_name.label("name"),
        literal(None).label("id"), func.count().label("file_count"),
        *(literal(None).label(key) for key in ("extension", "language", "size_bytes", "line_count")),
    ).where(separator > 0).group_by(child_name)
    files = select(
        literal(False).label("is_directory"), descendants.c.relative.label("name"),
        descendants.c.id, literal(1).label("file_count"),
        descendants.c.extension, descendants.c.language,
        descendants.c.size_bytes, descendants.c.line_count,
    ).where(separator == 0)
    # UNION ALL preserves distinct file IDs even with duplicate legacy paths.
    # Only the requested page, never descendant ORM objects, enters Python.
    children = union_all(directories, files).subquery()
    # SQLite's built-in lower() only folds ASCII. Keep the existing Unicode
    # str.lower ordering without loading every name into Python for sorting.
    connection = database.connection()
    if not connection.info.get("devatlas_tree_lower_registered"):
        connection.connection.dbapi_connection.create_function(
            "devatlas_tree_lower", 1, str.lower, deterministic=True
        )
        connection.info["devatlas_tree_lower_registered"] = True
    page = select(
        children,
        func.count().over().label("total_items"),
        func.sum(children.c.file_count).over().label("total_files"),
    ).order_by(
        children.c.is_directory.desc(),
        func.devatlas_tree_lower(children.c.name),
        children.c.name,
        children.c.id,
    ).limit(limit).offset(offset)
    rows = database.execute(page).mappings().all()
    if rows:
        total_items, total_files = rows[0]["total_items"], rows[0]["total_files"]
    else:
        # An offset past the last page is valid, not a missing-directory error.
        total_items, total_files = database.execute(select(
            func.count(), func.coalesce(func.sum(children.c.file_count), 0)
        ).select_from(children)).one()
    if normalized and total_files == 0:
        raise FileNotFoundError(f"Repository directory not found: {normalized}")
    items = [
        {
            "kind": "directory" if row["is_directory"] else "file",
            "name": row["name"],
            "path": f"{prefix}{row['name']}",
            "file_count": row["file_count"],
            **{
                key: None if row["is_directory"] else row[key]
                for key in ("id", "extension", "language", "size_bytes", "line_count")
            },
        }
        for row in rows
    ]
    return {
        "path": normalized,
        "total_files": total_files,
        "total_items": total_items,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(items) < total_items,
        "items": items,
    }


def _normalize_tree_directory(directory: str) -> str:
    normalized = directory.strip().replace("\\", "/").strip("/")
    if not normalized:
        return ""
    path = PurePosixPath(normalized)
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Repository directory path is invalid.")
    return path.as_posix()
