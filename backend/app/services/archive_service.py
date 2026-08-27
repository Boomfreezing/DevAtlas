import re
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from uuid import uuid4

from fastapi import UploadFile

from app.core.config import Settings
from app.services.repository_scanner import IGNORED_DIRECTORIES, TEXT_EXTENSIONS


class ArchiveValidationError(ValueError):
    pass


async def save_and_extract_archive(upload: UploadFile, settings: Settings) -> tuple[Path, str]:
    original_name = Path(upload.filename or "repository.zip").name
    if Path(original_name).suffix.lower() != ".zip":
        raise ArchiveValidationError("Only ZIP archives are supported.")

    project_directory = settings.repository_root / uuid4().hex
    project_directory.mkdir(parents=True, exist_ok=False)

    try:
        settings.temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            suffix=".zip", delete=False, dir=settings.temporary_root
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            total_bytes = 0
            while chunk := await upload.read(1024 * 1024):
                total_bytes += len(chunk)
                if total_bytes > settings.max_upload_bytes:
                    raise ArchiveValidationError(
                        f"Archive exceeds the {settings.max_upload_mb} MB upload limit."
                    )
                temporary_file.write(chunk)

        _safe_extract(temporary_path, project_directory, settings)
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


def _safe_extract(archive_path: Path, destination: Path, settings: Settings) -> None:
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            if not members:
                raise ArchiveValidationError("The ZIP archive is empty.")
            if len(members) > settings.max_archive_entries:
                raise ArchiveValidationError(
                    f"The archive contains more than {settings.max_archive_entries} entries."
                )

            total_uncompressed = sum(member.file_size for member in members)
            if total_uncompressed > settings.max_extracted_bytes:
                raise ArchiveValidationError(
                    f"The extracted archive exceeds the {settings.max_extracted_mb} MB safety limit."
                )

            destination_root = destination.resolve()
            selected_members: list[tuple[zipfile.ZipInfo, Path]] = []
            selected_names: set[str] = set()
            selected_bytes = 0
            for member in members:
                member_path = PurePosixPath(member.filename.replace("\\", "/"))
                if member_path.is_absolute() or ".." in member_path.parts:
                    raise ArchiveValidationError("The archive contains an unsafe path.")

                target = (destination / Path(*member_path.parts)).resolve()
                if destination_root not in target.parents and target != destination_root:
                    raise ArchiveValidationError("The archive contains an unsafe path.")

                unix_mode = member.external_attr >> 16
                if unix_mode and stat.S_ISLNK(unix_mode):
                    # Git repositories commonly contain legitimate links. Never recreate
                    # them locally: skipping the entry avoids link traversal while still
                    # allowing the remaining source snapshot to be analyzed.
                    continue
                if member.flag_bits & 0x1:
                    raise ArchiveValidationError("Encrypted archive entries are not supported.")
                if member.is_dir():
                    continue

                path_parts = [part for part in member_path.parts if part not in {"", "."}]
                directory_parts = path_parts[:-1]
                if any(part.lower() in IGNORED_DIRECTORIES for part in directory_parts):
                    continue
                if Path(path_parts[-1]).suffix.lower() not in TEXT_EXTENSIONS:
                    continue
                if member.file_size > settings.max_source_file_bytes:
                    continue

                normalized_name = "/".join(path_parts).casefold()
                if normalized_name in selected_names:
                    raise ArchiveValidationError("The archive contains duplicate file paths.")
                selected_names.add(normalized_name)
                selected_bytes += member.file_size
                if len(selected_members) >= settings.max_folder_files:
                    raise ArchiveValidationError(
                        f"The archive contains more than {settings.max_folder_files} analyzable files."
                    )
                if selected_bytes > settings.max_upload_bytes:
                    raise ArchiveValidationError(
                        f"Analyzable files exceed the {settings.max_upload_mb} MB safety limit."
                    )
                selected_members.append((member, target))

            if not selected_members:
                raise ArchiveValidationError("The archive does not contain supported source or text files.")

            actual_total = 0
            for member, target in selected_members:
                target.parent.mkdir(parents=True, exist_ok=True)
                member_total = 0
                with archive.open(member) as source, target.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        member_total += len(chunk)
                        actual_total += len(chunk)
                        if member_total > settings.max_source_file_bytes:
                            raise ArchiveValidationError(
                                f"An extracted file exceeds the {settings.max_source_file_mb} MB limit."
                            )
                        if actual_total > settings.max_upload_bytes:
                            raise ArchiveValidationError(
                                f"Analyzable files exceed the {settings.max_upload_mb} MB safety limit."
                            )
                        output.write(chunk)
    except zipfile.BadZipFile as error:
        raise ArchiveValidationError("The uploaded file is not a valid ZIP archive.") from error
    except (RuntimeError, NotImplementedError) as error:
        raise ArchiveValidationError("The ZIP archive uses an unsupported or encrypted format.") from error


def extract_archive_path(archive_path: Path, settings: Settings) -> Path:
    """Extract an already-downloaded ZIP into a new managed repository directory."""
    project_directory = settings.repository_root / uuid4().hex
    project_directory.mkdir(parents=True, exist_ok=False)
    try:
        _safe_extract(archive_path, project_directory, settings)
        return collapse_single_root(project_directory)
    except Exception:
        shutil.rmtree(project_directory, ignore_errors=True)
        raise


def collapse_single_root(directory: Path) -> Path:
    children = [item for item in directory.iterdir() if item.name != "__MACOSX"]
    if len(children) == 1 and children[0].is_dir():
        return children[0]
    return directory
