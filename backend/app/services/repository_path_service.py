from pathlib import Path

from app.core.config import PROJECT_ROOT


def resolve_project_storage_path(storage_path: str | Path) -> Path:
    """Resolve current absolute paths and legacy project-root-relative paths."""
    path = Path(storage_path)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path.resolve()
