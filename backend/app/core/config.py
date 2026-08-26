from functools import lru_cache
from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _find_project_root() -> Path:
    source_path = Path(__file__).resolve()
    for parent in source_path.parents:
        if (parent / "docker-compose.yml").exists():
            return parent
    return source_path.parents[2]


PROJECT_ROOT = _find_project_root()


class Settings(BaseSettings):
    """Runtime configuration loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_prefix="DEVATLAS_",
        extra="ignore",
    )

    app_name: str = "DevAtlas API"
    environment: str = "development"
    database_url: str = "sqlite:///./data/devatlas.db"
    repository_root: Path = Path("./data/repositories")
    provider_config_path: Path = Path("./data/report-providers.json")
    max_upload_mb: int = 50
    allowed_origins: str = "http://localhost:5173"

    @model_validator(mode="after")
    def resolve_project_paths(self) -> "Settings":
        if self.database_url.startswith("sqlite:///./"):
            relative_database = self.database_url.removeprefix("sqlite:///./")
            database_path = (PROJECT_ROOT / relative_database).resolve()
            self.database_url = f"sqlite:///{database_path.as_posix()}"
        if not self.repository_root.is_absolute():
            self.repository_root = (PROJECT_ROOT / self.repository_root).resolve()
        if not self.provider_config_path.is_absolute():
            self.provider_config_path = (PROJECT_ROOT / self.provider_config_path).resolve()
        return self

    @property
    def cors_origins(self) -> list[str]:
        return [item.strip() for item in self.allowed_origins.split(",") if item.strip()]

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    def ensure_directories(self) -> None:
        self.repository_root.mkdir(parents=True, exist_ok=True)
        self.provider_config_path.parent.mkdir(parents=True, exist_ok=True)
        if self.database_url.startswith("sqlite:///"):
            database_path = Path(self.database_url.removeprefix("sqlite:///"))
            if str(database_path) == ":memory:":
                return
            database_path.parent.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
