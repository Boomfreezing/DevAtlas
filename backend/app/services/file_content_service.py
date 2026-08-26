from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.project import Project, ProjectFile


MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024


class FileContentError(Exception):
    pass


class FileContentNotFoundError(FileContentError):
    pass


def load_project_file_content(
    database: Session, project_id: int, file_id: int
) -> dict[str, object]:
    row = database.execute(
        select(ProjectFile, Project.storage_path)
        .join(Project, Project.id == ProjectFile.project_id)
        .where(ProjectFile.id == file_id, ProjectFile.project_id == project_id)
    ).one_or_none()
    if row is None:
        raise FileContentNotFoundError("Project file not found.")

    project_file, storage_path = row
    repository_root = Path(storage_path).resolve()
    source_path = (repository_root / project_file.relative_path).resolve()
    try:
        source_path.relative_to(repository_root)
    except ValueError as error:
        raise FileContentError("Project file resolves outside the repository.") from error

    if not source_path.is_file():
        raise FileContentNotFoundError("Project file is no longer available on disk.")
    try:
        source_size = source_path.stat().st_size
    except OSError as error:
        raise FileContentError("Project file metadata could not be read.") from error
    if source_size > MAX_SOURCE_FILE_BYTES:
        raise FileContentError("Project file exceeds the 2 MB viewer limit.")

    try:
        raw_content = source_path.read_bytes()
    except OSError as error:
        raise FileContentError("Project file could not be read.") from error
    if b"\x00" in raw_content:
        raise FileContentError("Binary files cannot be displayed in the code viewer.")

    content = raw_content.decode("utf-8", errors="replace")
    return {
        "file_id": project_file.id,
        "file_path": project_file.relative_path,
        "language": project_file.language,
        "size_bytes": len(raw_content),
        "total_lines": len(content.splitlines()),
        "lines": content.splitlines(),
    }
