import re
import shutil
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from uuid import uuid4

from fastapi import UploadFile

from app.core.config import Settings


class ArchiveValidationError(ValueError):
    pass


async def save_and_extract_archive(upload: UploadFile, settings: Settings) -> tuple[Path, str]:
    original_name = Path(upload.filename or "repository.zip").name
    if Path(original_name).suffix.lower() != ".zip":
        raise ArchiveValidationError("Only ZIP archives are supported.")

    project_directory = settings.repository_root / uuid4().hex
    project_directory.mkdir(parents=True, exist_ok=False)

    try:
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as temporary_file:
            temporary_path = Path(temporary_file.name)
            total_bytes = 0
            while chunk := await upload.read(1024 * 1024):
                total_bytes += len(chunk)
                if total_bytes > settings.max_upload_bytes:
                    raise ArchiveValidationError(
                        f"Archive exceeds the {settings.max_upload_mb} MB upload limit."
                    )
                temporary_file.write(chunk)

        _safe_extract(temporary_path, project_directory)
        return collapse_single_root(project_directory), original_name
    except Exception:
        shutil.rmtree(project_directory, ignore_errors=True)
        raise
    finally:
        if "temporary_path" in locals():
            temporary_path.unlink(missing_ok=True)
        await upload.close()


def infer_project_name(filename: str) -> str:
    stem = Path(filename).stem
    normalized = re.sub(r"[^\w\- ]+", "-", stem, flags=re.UNICODE).strip(" -_")
    return normalized[:120] or "Imported repository"


def _safe_extract(archive_path: Path, destination: Path) -> None:
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            if not members:
                raise ArchiveValidationError("The ZIP archive is empty.")

            total_uncompressed = sum(member.file_size for member in members)
            if total_uncompressed > 500 * 1024 * 1024:
                raise ArchiveValidationError("The extracted archive is too large.")

            for member in members:
                member_path = PurePosixPath(member.filename.replace("\\", "/"))
                if member_path.is_absolute() or ".." in member_path.parts:
                    raise ArchiveValidationError("The archive contains an unsafe path.")

                target = (destination / Path(*member_path.parts)).resolve()
                if destination.resolve() not in target.parents and target != destination.resolve():
                    raise ArchiveValidationError("The archive contains an unsafe path.")

            archive.extractall(destination)
    except zipfile.BadZipFile as error:
        raise ArchiveValidationError("The uploaded file is not a valid ZIP archive.") from error


def extract_archive_path(archive_path: Path, settings: Settings) -> Path:
    """Extract an already-downloaded ZIP into a new managed repository directory."""
    project_directory = settings.repository_root / uuid4().hex
    project_directory.mkdir(parents=True, exist_ok=False)
    try:
        _safe_extract(archive_path, project_directory)
        return collapse_single_root(project_directory)
    except Exception:
        shutil.rmtree(project_directory, ignore_errors=True)
        raise


def collapse_single_root(directory: Path) -> Path:
    children = [item for item in directory.iterdir() if item.name != "__MACOSX"]
    if len(children) == 1 and children[0].is_dir():
        return children[0]
    return directory
