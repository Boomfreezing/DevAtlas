import stat
import zipfile
from pathlib import Path

import pytest

from app.core.config import Settings
from app.services.archive_service import ArchiveValidationError, extract_archive_path


def write_archive(path: Path, files: dict[str, bytes | str]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)


def test_extracts_only_supported_repository_files(tmp_path: Path) -> None:
    archive_path = tmp_path / "repository.zip"
    write_archive(
        archive_path,
        {
            "repository-main/src/main.py": "print('safe')\n",
            "repository-main/node_modules/package/index.js": "throw new Error()\n",
            "repository-main/dist/bundle.js": "minified()\n",
            "repository-main/assets/logo.png": b"\x89PNG\r\n",
        },
    )
    settings = Settings(repository_root=tmp_path / "repositories")
    settings.ensure_directories()

    extracted = extract_archive_path(archive_path, settings)

    assert (extracted / "src" / "main.py").is_file()
    assert not (extracted / "node_modules").exists()
    assert not (extracted / "dist").exists()
    assert not (extracted / "assets" / "logo.png").exists()


def test_skips_symbolic_link_entries_without_creating_links(tmp_path: Path) -> None:
    archive_path = tmp_path / "symlink.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("repository-main/main.py", "print('safe')\n")
        symlink = zipfile.ZipInfo("repository-main/linked.py")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(symlink, "main.py")
    settings = Settings(repository_root=tmp_path / "repositories")
    settings.ensure_directories()

    extracted = extract_archive_path(archive_path, settings)

    assert (extracted / "main.py").is_file()
    assert not (extracted / "linked.py").exists()


def test_rejects_archives_with_too_many_entries(tmp_path: Path) -> None:
    archive_path = tmp_path / "many-files.zip"
    write_archive(
        archive_path,
        {
            "repository-main/a.py": "a = 1\n",
            "repository-main/b.py": "b = 2\n",
        },
    )
    settings = Settings(
        repository_root=tmp_path / "repositories",
        max_archive_entries=1,
    )
    settings.ensure_directories()

    with pytest.raises(ArchiveValidationError, match="more than 1 entries"):
        extract_archive_path(archive_path, settings)


def test_skips_source_files_over_the_single_file_limit(tmp_path: Path) -> None:
    archive_path = tmp_path / "oversized-source.zip"
    write_archive(
        archive_path,
        {
            "repository-main/main.py": "print('safe')\n",
            "repository-main/generated.py": b"x" * (1024 * 1024 + 1),
        },
    )
    settings = Settings(
        repository_root=tmp_path / "repositories",
        max_source_file_mb=1,
    )
    settings.ensure_directories()

    extracted = extract_archive_path(archive_path, settings)

    assert (extracted / "main.py").is_file()
    assert not (extracted / "generated.py").exists()
