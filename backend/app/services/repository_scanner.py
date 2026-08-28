import hashlib
import os
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

IGNORED_DIRECTORIES = {
    ".git",
    ".idea",
    ".mypy_cache",
    ".next",
    ".nuxt",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    ".vscode",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
    "venv",
}

LANGUAGE_BY_EXTENSION = {
    ".c": "C",
    ".cpp": "C++",
    ".cs": "C#",
    ".css": "CSS",
    ".go": "Go",
    ".html": "HTML",
    ".java": "Java",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".kt": "Kotlin",
    ".php": "PHP",
    ".py": "Python",
    ".rb": "Ruby",
    ".rs": "Rust",
    ".scss": "SCSS",
    ".sql": "SQL",
    ".swift": "Swift",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".vue": "Vue",
}

TEXT_EXTENSIONS = set(LANGUAGE_BY_EXTENSION) | {
    ".env",
    ".json",
    ".md",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}


@dataclass(frozen=True)
class ScannedFile:
    relative_path: str
    extension: str
    language: str | None
    size_bytes: int
    line_count: int
    content_hash: str
    modified_time_ns: int


@dataclass(frozen=True)
class ScanResult:
    files: list[ScannedFile]
    primary_language: str | None
    code_line_count: int


class KnownFile(Protocol):
    size_bytes: int
    line_count: int
    content_hash: str
    modified_time_ns: int


def scan_repository(
    root: Path, known_files: dict[str, KnownFile] | None = None
) -> ScanResult:
    files: list[ScannedFile] = []
    language_lines: Counter[str] = Counter()

    for current_root, directories, filenames in os.walk(root):
        directories[:] = sorted(item for item in directories if item not in IGNORED_DIRECTORIES)
        for filename in sorted(filenames):
            path = Path(current_root) / filename
            extension = path.suffix.lower()
            if extension not in TEXT_EXTENSIONS or path.is_symlink():
                continue

            relative_path = path.relative_to(root).as_posix()
            try:
                metadata = path.stat()
            except OSError:
                continue
            known = (known_files or {}).get(relative_path)
            if (
                known is not None
                and known.modified_time_ns > 0
                and known.size_bytes == metadata.st_size
                and known.modified_time_ns == metadata.st_mtime_ns
            ):
                line_count = known.line_count
                content_hash = known.content_hash
            else:
                try:
                    content = path.read_bytes()
                except OSError:
                    continue

                if b"\x00" in content[:4096]:
                    continue

                line_count = _count_lines(content)
                content_hash = hashlib.sha256(content).hexdigest()

            language = LANGUAGE_BY_EXTENSION.get(extension)
            if language:
                language_lines[language] += line_count

            files.append(
                ScannedFile(
                    relative_path=relative_path,
                    extension=extension,
                    language=language,
                    size_bytes=metadata.st_size,
                    line_count=line_count,
                    content_hash=content_hash,
                    modified_time_ns=metadata.st_mtime_ns,
                )
            )

    primary_language = language_lines.most_common(1)[0][0] if language_lines else None
    return ScanResult(
        files=files,
        primary_language=primary_language,
        code_line_count=sum(language_lines.values()),
    )


def _count_lines(content: bytes) -> int:
    if not content:
        return 0
    return content.count(b"\n") + (0 if content.endswith(b"\n") else 1)
