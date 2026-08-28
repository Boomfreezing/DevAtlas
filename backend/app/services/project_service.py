import shutil
from collections.abc import Callable
from pathlib import Path, PurePosixPath

from sqlalchemy import select
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
) -> Project:
    _notify(progress_callback, "scanning", 35, "正在扫描仓库文件")
    result = scan_repository(repository_path)
    project = Project(
        name=project_name,
        source_filename=source_filename,
        storage_path=str(repository_path.resolve()),
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
    database: Session, project_id: int, directory: str = ""
) -> dict[str, object]:
    """Return only the immediate children of a repository directory."""
    normalized = _normalize_tree_directory(directory)
    statement = select(ProjectFile).where(ProjectFile.project_id == project_id)
    prefix = f"{normalized}/" if normalized else ""
    if prefix:
        statement = statement.where(
            ProjectFile.relative_path.startswith(prefix, autoescape=True)
        )
    files = list(database.scalars(statement.order_by(ProjectFile.relative_path)))

    directories: dict[str, dict[str, object]] = {}
    direct_files: list[dict[str, object]] = []
    for project_file in files:
        relative = project_file.relative_path[len(prefix):] if prefix else project_file.relative_path
        child_name, separator, _ = relative.partition("/")
        child_path = f"{prefix}{child_name}" if prefix else child_name
        if separator:
            node = directories.setdefault(
                child_name,
                {
                    "kind": "directory",
                    "name": child_name,
                    "path": child_path,
                    "file_count": 0,
                    "id": None,
                    "extension": None,
                    "language": None,
                    "size_bytes": None,
                    "line_count": None,
                },
            )
            node["file_count"] = int(node["file_count"]) + 1
        else:
            direct_files.append(
                {
                    "kind": "file",
                    "name": child_name,
                    "path": project_file.relative_path,
                    "file_count": 1,
                    "id": project_file.id,
                    "extension": project_file.extension,
                    "language": project_file.language,
                    "size_bytes": project_file.size_bytes,
                    "line_count": project_file.line_count,
                }
            )

    if normalized and not files:
        raise FileNotFoundError(f"Repository directory not found: {normalized}")
    items = sorted(directories.values(), key=lambda item: str(item["name"]).lower())
    items.extend(sorted(direct_files, key=lambda item: str(item["name"]).lower()))
    return {"path": normalized, "total_files": len(files), "items": items}


def _normalize_tree_directory(directory: str) -> str:
    normalized = directory.strip().replace("\\", "/").strip("/")
    if not normalized:
        return ""
    path = PurePosixPath(normalized)
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Repository directory path is invalid.")
    return path.as_posix()
