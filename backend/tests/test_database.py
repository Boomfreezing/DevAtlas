from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

from app.core import database as database_module


def test_old_database_adds_unknown_source_revision_without_losing_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = create_engine(f"sqlite:///{(tmp_path / 'legacy.db').as_posix()}")
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)"))
            connection.execute(text("INSERT INTO projects (id, name) VALUES (6, 'existing')"))
            connection.execute(text("CREATE TABLE project_files (id INTEGER PRIMARY KEY)"))
            connection.execute(text("INSERT INTO project_files (id) VALUES (12)"))
        monkeypatch.setattr(database_module, "engine", engine)
        database_module.create_database()
        database_module.create_database()
        with engine.connect() as connection:
            assert connection.execute(text("SELECT id, name, source_commit FROM projects")).one() == (
                6, "existing", None,
            )
            assert connection.execute(text("SELECT id, modified_time_ns FROM project_files")).one() == (
                12, 0,
            )
    finally:
        engine.dispose()
