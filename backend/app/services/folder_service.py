import shutil
from pathlib import Path, PurePosixPath
from uuid import uuid4

from fastapi import UploadFile

from app.core.config import Settings
from app.services.archive_service import ArchiveValidationError, collapse_single_root


async def save_uploaded_folder(
    uploads: list[UploadFile], settings: Settings
) -> tuple[Path, str, str]:
    if not uploads:
        raise ArchiveValidationError("The selected folder is empty.")
    if len(uploads) > settings.max_folder_files:
        raise ArchiveValidationError(f"A folder can contain at most {settings.max_folder_files} uploaded files.")

    project_directory = settings.repository_root / uuid4().hex
    project_directory.mkdir(parents=True, exist_ok=False)
    total_bytes = 0
    root_names: list[str] = []

    try:
        for upload in uploads:
            relative_path = _validate_relative_path(upload.filename or "")
            target = project_directory.joinpath(*relative_path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            file_bytes = 0
            skipped_oversized_file = False

            with target.open("wb") as destination:
                while chunk := await upload.read(1024 * 1024):
                    file_bytes += len(chunk)
                    total_bytes += len(chunk)
                    if total_bytes > settings.max_upload_bytes:
                        raise ArchiveValidationError(
                            f"Folder exceeds the {settings.max_upload_mb} MB upload limit."
                        )
                    if file_bytes > settings.max_source_file_bytes:
                        skipped_oversized_file = True
                    if not skipped_oversized_file:
                        destination.write(chunk)

            if skipped_oversized_file:
                target.unlink(missing_ok=True)
                continue
            root_names.append(relative_path.parts[0])

        if not root_names:
            raise ArchiveValidationError(
                f"The folder has no files within the {settings.max_source_file_mb} MB per-file limit."
            )

        repository_path = collapse_single_root(project_directory)
        common_root = root_names[0] if len(set(root_names)) == 1 else "local-folder"
        project_name = Path(common_root).name or "Local folder"
        return repository_path, f"{project_name}/", project_name
    except Exception:
        shutil.rmtree(project_directory, ignore_errors=True)
        raise
    finally:
        for upload in uploads:
            await upload.close()


def _validate_relative_path(filename: str) -> PurePosixPath:
    path = PurePosixPath(filename.replace("\\", "/"))
    if not filename or path.is_absolute() or ".." in path.parts or not path.name:
        raise ArchiveValidationError("The folder contains an unsafe file path.")
    if path.parts[0].endswith(":"):
        raise ArchiveValidationError("The folder contains an unsafe file path.")
    return path
