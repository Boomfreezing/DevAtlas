import hashlib
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import CodeSymbol, SearchChunk
from app.services import impact_reference_resolver as resolver
from app.services.project_service import create_scanned_project


@pytest.fixture
def indexed_repository(tmp_path):
    root = tmp_path / "source"
    root.mkdir()
    (root / "alpha.py").write_text("def save():\n    return 1\n", encoding="utf-8")
    content = (
        "from alpha import save\n\nclass Consumer:\n    \"\"\"Long class documentation.\n"
        + "\n".join(f"    Documentation line {number}." for number in range(60))
        + '\n    """\n    category = "sample"\n\n    def run(self):\n        return save()\n'
    )
    path = root / "consumer.py"
    path.write_text(content, encoding="utf-8")
    engine = create_engine(f"sqlite:///{(tmp_path / 'fallback.db').as_posix()}")
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as database:
            project = create_scanned_project(
                database, root, "fixture", "fallback", search_index_root=tmp_path / "indexes",
            )
            files = {file.relative_path: file for file in project.files}
            symbols = {symbol.qualified_name: symbol for symbol in database.scalars(select(CodeSymbol).where(
                CodeSymbol.project_id == project.id,
            ))}
            yield database, project, files, symbols, path
    finally:
        engine.dispose()


def _indexed_bytes(database, file_id):
    return sum(len(chunk.content.encode("utf-8")) for chunk in database.scalars(select(SearchChunk).where(
        SearchChunk.file_id == file_id,
    )))


def test_legacy_class_header_gap_uses_matching_source_without_reindexing(indexed_repository):
    database, project, files, symbols, path = indexed_repository
    record = files["consumer.py"]
    chunks = database.scalars(select(SearchChunk).where(SearchChunk.file_id == record.id)).all()
    covered = {number for chunk in chunks for number in range(
        chunk.start_line, chunk.start_line + len(chunk.content.split("\n")),
    )}
    assert len(covered) < record.line_count  # real producer clips class headers to 40 lines
    before_chunks = [(chunk.id, chunk.content) for chunk in chunks]
    context = resolver._Context(database, project.id)

    parsed = context.file(record.id)

    assert parsed.complete
    assert context.bytes_read == _indexed_bytes(database, record.id) + len(path.read_bytes())
    assert [(call.scope.name, call.line) for call in parsed.calls if call.parts == ("save",)] == [
        ("Consumer.run", symbols["Consumer.run"].end_line),
    ]
    references, _ = resolver.resolve_symbol_relations(database, symbols["save"])
    assert any(row["file_path"] == "consumer.py" and row["confidence"] == "high"
               and row["symbol_name"] == "Consumer.run" for row in references)
    assert [(chunk.id, chunk.content) for chunk in database.scalars(select(SearchChunk).where(
        SearchChunk.file_id == record.id,
    ))] == before_chunks


@pytest.mark.parametrize("failure", ["changed", "missing", "hashless", "line_count", "outside"])
def test_unverifiable_source_never_repairs_an_incomplete_index(indexed_repository, failure):
    database, project, files, symbols, path = indexed_repository
    record = files["consumer.py"]
    if failure == "changed":
        path.write_text(path.read_text(encoding="utf-8").replace("return save()", "return other()"), encoding="utf-8")
    elif failure == "missing":
        path.unlink()
    elif failure == "hashless":
        record.content_hash = ""
    elif failure == "line_count":
        record.line_count += 1
    else:
        outside = path.parent.parent / "outside.py"
        outside.write_bytes(path.read_bytes())
        record.relative_path = "../outside.py"
    database.flush()

    context = resolver._Context(database, project.id)
    assert not context.file(record.id).complete
    assert resolver.resolve_symbol_references(database, symbols["save"]) == []


def test_source_read_is_bounded_even_when_file_grew_past_single_file_limit(indexed_repository):
    database, project, files, _, path = indexed_repository
    record = files["consumer.py"]
    oversized = path.read_bytes() + b"#" * (resolver.MAX_FILE_SOURCE_BYTES + 10)
    path.write_bytes(oversized)
    record.content_hash = hashlib.sha256(oversized).hexdigest()
    record.line_count += 1
    database.flush()
    indexed_bytes = _indexed_bytes(database, record.id)
    context = resolver._Context(database, project.id)

    assert not context.file(record.id).complete
    assert context.bytes_read == indexed_bytes + resolver.MAX_FILE_SOURCE_BYTES + 1
    assert context.bytes_read < indexed_bytes + len(oversized)


def test_disk_fallback_counts_against_the_shared_request_budget(indexed_repository, monkeypatch):
    database, project, files, _, _ = indexed_repository
    context = resolver._Context(database, project.id)
    context.file(files["alpha.py"].id)
    indexed_bytes = _indexed_bytes(database, files["consumer.py"].id)
    budget = context.bytes_read + indexed_bytes + 64
    monkeypatch.setattr(resolver, "MAX_TOTAL_SOURCE_BYTES", budget)

    assert not context.file(files["consumer.py"].id).complete
    assert context.bytes_read == budget  # includes the oversize/EOF probe byte


def test_complete_index_does_not_read_source_from_disk(indexed_repository, monkeypatch):
    database, project, files, _, _ = indexed_repository

    def unexpected_open(*args, **kwargs):
        raise AssertionError("Complete indexed source must not open a filesystem file")

    monkeypatch.setattr(Path, "open", unexpected_open)
    context = resolver._Context(database, project.id)
    assert context.file(files["alpha.py"].id).complete
    assert context.bytes_read == _indexed_bytes(database, files["alpha.py"].id)


def test_conflicting_chunks_cannot_be_silently_replaced_by_disk(indexed_repository, monkeypatch):
    database, project, files, _, _ = indexed_repository
    record = files["consumer.py"]
    chunk = database.scalar(select(SearchChunk).where(SearchChunk.file_id == record.id))
    database.add(SearchChunk(
        project_id=project.id, file_id=record.id, start_line=chunk.start_line,
        end_line=chunk.start_line, content="conflicting indexed text", kind="module",
    ))
    database.flush()

    def unexpected_open(*args, **kwargs):
        raise AssertionError("Conflicts must not trigger a disk fallback")

    monkeypatch.setattr(Path, "open", unexpected_open)
    assert not resolver._Context(database, project.id).file(record.id).complete


def test_disk_hash_does_not_hide_nonoverlapping_index_content_drift(indexed_repository):
    database, project, files, _, _ = indexed_repository
    record = files["consumer.py"]
    chunks = database.scalars(select(SearchChunk).where(SearchChunk.file_id == record.id)).all()
    for chunk in chunks:
        chunk.content = chunk.content.replace("from alpha import save", "from other import save")
    database.flush()
    assert not resolver._Context(database, project.id).file(record.id).complete
