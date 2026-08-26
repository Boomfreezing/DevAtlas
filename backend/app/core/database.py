from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings


class Base(DeclarativeBase):
    pass


settings = get_settings()
connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def create_database() -> None:
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    if engine.url.get_backend_name() == "sqlite":
        column_names = {
            column["name"] for column in inspect(engine).get_columns("project_files")
        }
        if "modified_time_ns" not in column_names:
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "ALTER TABLE project_files ADD COLUMN modified_time_ns "
                        "INTEGER NOT NULL DEFAULT 0"
                    )
                )


def get_db() -> Generator[Session, None, None]:
    database = SessionLocal()
    try:
        yield database
    finally:
        database.close()
