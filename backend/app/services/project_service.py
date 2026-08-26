import shutil
from collections.abc import Callable
from pathlib import Path

from sqlalchemy.orm import Session

from app.models.project import Project, ProjectFile
from app.services.repository_scanner import scan_repository
from app.services.repository_path_service import resolve_project_storage_path
from app.services.structure_analyzer import analyze_project_structure


def create_scanned_project(
    database: Session,
    repository_path: Path,
    source_filename: str,
    project_name: str,
    progress_callback: Callable[[str, int, str], None] | None = None,
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
    analyze_project_structure(database, project, progress_callback)
    project.status = "ready"
    database.commit()
    database.refresh(project)
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
