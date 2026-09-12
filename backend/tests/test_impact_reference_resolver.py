from contextlib import contextmanager

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session
from tree_sitter import Parser

from app.core.database import Base
from app.models.analysis import CodeSymbol, SearchChunk
from app.models.project import Project, ProjectFile
from app.services import impact_reference_resolver as resolver
from app.services.code_parser import LANGUAGES
from app.services.project_service import create_scanned_project
from app.services.search_service import _add_range_chunks


@pytest.fixture
def repository(tmp_path):
    @contextmanager
    def create(sources):
        root = tmp_path / "repository"
        for path, content in sources.items():
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        engine = create_engine(f"sqlite:///{(tmp_path / 'bindings.db').as_posix()}")
        try:
            Base.metadata.create_all(engine)
            with Session(engine) as database:
                project = create_scanned_project(database, root, "fixture", "bindings", search_index_root=tmp_path / "indexes")
                files = {file.relative_path: file for file in project.files}
                symbols = {
                    (files_by_id[symbol.file_id].relative_path, symbol.qualified_name): symbol
                    for files_by_id in [{file.id: file for file in files.values()}]
                    for symbol in database.scalars(select(CodeSymbol).where(CodeSymbol.project_id == project.id))
                }
                yield database, project, files, symbols
        finally:
            engine.dispose()

    return create


def test_python_alias_and_module_calls_resolve_the_bound_file(repository):
    with repository({
        "alpha.py": "def save():\n    return 1\n",
        "beta.py": "def save():\n    return 2\n",
        "consumer.py": (
            "from alpha import save as put\nimport beta as other\n"
            "def run():\n    put()\n    other.save()\n"
        ),
    }) as (database, _, _, symbols):
        calls = resolver.resolve_called_symbols(database, symbols["consumer.py", "run"])
        assert {(row["file_path"], row["symbol_name"]) for row in calls} == {
            ("alpha.py", "save"), ("beta.py", "save"),
        }
        assert all(row["relation"] == "bound_symbol_call" and row["confidence"] == "high" for row in calls)
        assert all(row["line_numbers"] == [1] for row in calls)
        incoming = resolver.resolve_symbol_references(database, symbols["alpha.py", "save"])
        assert len(incoming) == 1
        assert incoming[0]["file_path"] == "consumer.py"
        assert incoming[0]["line_numbers"] == [4]


@pytest.mark.parametrize("body", [
    '    "save() is documentation"\n    # save()\n    return None',
    "    other.save()",
    "    save = lambda: None\n    save()",
    "    save()\n    save = lambda: None",
])
def test_python_text_and_unknown_or_shadowed_calls_are_not_target_bindings(repository, body):
    with repository({
        "alpha.py": "def save():\n    return 1\n",
        "consumer.py": "from alpha import save\ndef run(other):\n" + body + "\n",
    }) as (database, _, _, symbols):
        assert resolver.resolve_symbol_references(database, symbols["alpha.py", "save"]) == []
        assert resolver.resolve_called_symbols(database, symbols["consumer.py", "run"]) == []


def test_python_parameter_shadowing_and_plain_import_do_not_count_as_calls(repository):
    with repository({
        "alpha.py": "def save():\n    return 1\n",
        "consumer.py": "from alpha import save\ndef run(save):\n    return save()\n",
        "unused.py": "from alpha import save\n",
    }) as (database, _, _, symbols):
        assert resolver.resolve_symbol_references(database, symbols["alpha.py", "save"]) == []


def test_real_index_producer_preserves_blank_line_between_import_and_definition(repository):
    with repository({
        "alpha.py": "def save():\n    return 1\n",
        "consumer.py": "from alpha import save\n\ndef run():\n    return save()\n",
    }) as (database, _, _, symbols):
        incoming = resolver.resolve_symbol_references(database, symbols["alpha.py", "save"])
        assert len(incoming) == 1
        assert incoming[0]["confidence"] == "high"
        assert incoming[0]["line_numbers"] == [4]


def test_same_file_calls_require_the_local_definition_not_a_global_namesake(repository):
    with repository({
        "alpha.py": "def save():\n    return 1\n",
        "consumer.py": "def save():\n    return 2\ndef run():\n    return save()\n",
    }) as (database, _, _, symbols):
        called = resolver.resolve_called_symbols(database, symbols["consumer.py", "run"])
        assert len(called) == 1
        assert called[0]["symbol_id"] == symbols["consumer.py", "save"].id
        assert resolver.resolve_symbol_references(database, symbols["alpha.py", "save"]) == []


@pytest.mark.parametrize("extension", ["js", "ts"])
def test_esm_named_namespace_and_default_aliases(extension, repository):
    with repository({
        f"alpha.{extension}": "export function save() { return 1; }\nexport default function main() { return 2; }\n",
        f"consumer.{extension}": (
            'import primary, {save as put} from "./alpha";\n'
            'import * as mod from "./alpha";\n'
            "export function run() { put(); mod.save(); primary(); }\n"
        ),
    }) as (database, _, _, symbols):
        calls = resolver.resolve_called_symbols(database, symbols[f"consumer.{extension}", "run"])
        assert {row["symbol_name"] for row in calls} == {"save", "main"}
        assert all(row["confidence"] == "high" for row in calls)
        incoming = resolver.resolve_symbol_references(database, symbols[f"alpha.{extension}", "save"])
        assert len(incoming) == 1
        assert incoming[0]["line_numbers"] == [3]


@pytest.mark.parametrize("declaration,call", [
    ('import {save} from "./alpha";', 'function run(save) { return save(); }'),
    ('import * as mod from "./alpha";', 'function run(mod) { return mod.save(); }'),
    ('import {save} from "./alpha";', 'function run() { const save = () => 2; return save(); }'),
    ('import * as mod from "./alpha";', 'function run() { return mod["save"](); }'),
])
def test_typescript_shadowing_and_dynamic_properties_do_not_bind_imports(repository, declaration, call):
    with repository({
        "alpha.ts": "export function save() { return 1; }\n",
        "consumer.ts": declaration + "\n" + call + "\n",
    }) as (database, _, _, symbols):
        assert resolver.resolve_symbol_references(database, symbols["alpha.ts", "save"]) == []


def test_javascript_private_definition_is_not_invented_as_an_export(repository):
    with repository({
        "alpha.js": "function save() { return 1; }\n",
        "consumer.js": 'import {save} from "./alpha";\nfunction run() { return save(); }\n',
    }) as (database, _, _, symbols):
        assert resolver.resolve_called_symbols(database, symbols["consumer.js", "run"]) == []


def test_commonjs_namespace_uses_explicit_exports(repository):
    with repository({
        "alpha.js": "function save() { return 1; }\nexports.save = save;\n",
        "consumer.js": 'const mod = require("./alpha");\nfunction run() { return mod.save(); }\n',
    }) as (database, _, _, symbols):
        calls = resolver.resolve_called_symbols(database, symbols["consumer.js", "run"])
        assert len(calls) == 1 and calls[0]["symbol_id"] == symbols["alpha.js", "save"].id


def test_long_index_only_function_keeps_low_confidence_head_and_tail(tmp_path):
    engine = create_engine(f"sqlite:///{(tmp_path / 'sparse.db').as_posix()}")
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as database:
            project = Project(name="sparse", source_filename="fixture", storage_path="not-on-disk")
            database.add(project)
            database.flush()
            lines = ["def calculate():", "    head_helper()", *["    pass"] * 16_997, "    tail_helper()"]
            source = ProjectFile(project_id=project.id, relative_path="source.py", extension=".py",
                                 line_count=len(lines), content_hash="fixture", size_bytes=160_000)
            database.add(source)
            database.flush()
            target = CodeSymbol(project_id=project.id, file_id=source.id, name="calculate", qualified_name="calculate",
                                kind="function", start_line=1, end_line=len(lines))
            database.add(target)
            for offset, name in enumerate(("head_helper", "tail_helper"), 1):
                database.add(CodeSymbol(project_id=project.id, file_id=source.id, name=name, qualified_name=name,
                                        kind="function", start_line=len(lines) + offset, end_line=len(lines) + offset))
            _add_range_chunks(database, project, source, lines, 1, len(lines), "calculate", "function", remaining=1000)
            database.flush()

            results = resolver.resolve_called_symbols(database, target)

            assert {item["symbol_name"] for item in results} == {"head_helper", "tail_helper"}
            assert all(item["confidence"] == "low" for item in results)
            assert resolver.resolve_symbol_references(database, target) == []
    finally:
        engine.dispose()


def test_request_source_budget_prevents_unbounded_file_parsing(repository, monkeypatch):
    with repository({
        "alpha.py": "def save():\n    return 1\n",
        "consumer.py": "from alpha import save\ndef run():\n    save()\n",
    }) as (database, project, files, _):
        monkeypatch.setattr(resolver, "MAX_TOTAL_SOURCE_BYTES", 30)
        context = resolver._Context(database, project.id)
        context.file(files["alpha.py"].id)
        context.file(files["consumer.py"].id)
        assert context.bytes_read <= 30
        assert not context.files[files["consumer.py"].id].complete


def test_scope_with_missing_index_lines_never_becomes_a_verified_call(repository, monkeypatch):
    with repository({
        "alpha.py": "def save():\n    return 1\n",
        "consumer.py": "from alpha import save\ndef run():\n    save()\n",
    }) as (database, _, files, symbols):
        files["consumer.py"].line_count += 10
        database.flush()
        assert resolver.resolve_symbol_references(database, symbols["alpha.py", "save"]) == []
        calls = resolver.resolve_called_symbols(database, symbols["consumer.py", "run"])
        assert calls == []  # incomplete scopes must not leak cross-file candidates


@pytest.mark.parametrize("body", [
    "    with cm as save:\n        save()",
    "    if (save := other):\n        save()",
    "    try:\n        other()\n    except Exception as save:\n        save()",
    "    global save\n    save()",
    "    del save\n    save()",
])
def test_python_additional_binding_forms_never_reuse_shadowed_import(repository, body):
    with repository({
        "alpha.py": "def save():\n    return 1\n",
        "consumer.py": "from alpha import save\ndef run(cm, other):\n" + body + "\n",
    }) as (database, _, _, symbols):
        assert resolver.resolve_symbol_references(database, symbols["alpha.py", "save"]) == []
        assert not any(row["confidence"] == "high" for row in resolver.resolve_called_symbols(
            database, symbols["consumer.py", "run"]
        ))


@pytest.mark.parametrize("body", [
    "const run = save => save();",
    "function run() { try { work(); } catch (save) { save(); } }",
    "function run() { if (false) { var save; } save(); }",
    "function run() { save(); if (false) { var save; } }",
    "function run() { if (ready) { save = other; } save(); }",
])
def test_typescript_arrow_catch_hoist_and_assignment_shadowing(repository, body):
    with repository({
        "alpha.ts": "export function save() { return 1; }\n",
        "consumer.ts": 'import {save} from "./alpha";\n' + body + "\n",
    }) as (database, _, _, symbols):
        assert resolver.resolve_symbol_references(database, symbols["alpha.ts", "save"]) == []


@pytest.mark.parametrize("extension,definition,imports", [
    ("py", "def save():\n    return 1\nsave = other\n", "from alpha import save\ndef run():\n    save()\n"),
    ("ts", "export function save() { return 1; }\nsave = other;\n",
     'import {save} from "./alpha";\nfunction run() { save(); }\n'),
    ("js", "function save() { return 1; }\nexports.save = save;\nsave = other;\n",
     'const mod = require("./alpha");\nfunction run() { mod.save(); }\n'),
])
def test_exported_symbol_reassigned_in_destination_is_not_confirmed(repository, extension, definition, imports):
    with repository({
        f"alpha.{extension}": definition,
        f"consumer.{extension}": imports,
    }) as (database, _, _, symbols):
        assert resolver.resolve_symbol_references(database, symbols[f"alpha.{extension}", "save"]) == []
        assert resolver.resolve_called_symbols(database, symbols[f"consumer.{extension}", "run"]) == []


def test_both_relation_directions_share_one_file_and_source_budget(repository, monkeypatch):
    with repository({
        "alpha.py": "def save():\n    return 1\n",
        "consumer.py": "from alpha import save\ndef run():\n    save()\n",
    }) as (database, _, _, symbols):
        instances = []
        original = resolver._Context

        class ObservedContext(original):
            def __init__(self, *args):
                super().__init__(*args)
                instances.append(self)

        monkeypatch.setattr(resolver, "_Context", ObservedContext)
        incoming, called = resolver.resolve_symbol_relations(database, symbols["alpha.py", "save"])
        assert incoming and called == []
        assert len(instances) == 1
        assert len(instances[0].files) == 2
        assert instances[0].bytes_read <= resolver.MAX_TOTAL_SOURCE_BYTES


def test_source_content_growth_between_metadata_and_read_stays_bounded(repository):
    with repository({"source.py": "def run():\n    return 1\n"}) as (database, project, files, _):
        chunk = database.scalar(select(SearchChunk).where(SearchChunk.file_id == files["source.py"].id))
        old_bytes = len(chunk.content.encode("utf-8"))
        fired = False

        def mutate_before_content_read(connection, _cursor, statement, _parameters, _context, _many):
            nonlocal fired
            if not fired and "substr(" in statement and "search_chunks" in statement:
                fired = True
                connection.exec_driver_sql(
                    "UPDATE search_chunks SET content = ? WHERE id = ?", ("变" * 100_000, chunk.id)
                )

        engine = database.get_bind()
        event.listen(engine, "before_cursor_execute", mutate_before_content_read)
        try:
            context = resolver._Context(database, project.id)
            parsed = context.file(files["source.py"].id)
        finally:
            event.remove(engine, "before_cursor_execute", mutate_before_content_read)
        assert fired
        assert not parsed.complete
        assert context.bytes_read <= old_bytes


def test_deep_syntax_or_exhausted_node_budget_cannot_escape_as_verified_source():
    source = b"{" * 1_200 + b"save();" + b"}" * 1_200
    tree = Parser(LANGUAGES[".ts"]).parse(source)
    parsed = resolver._File(ProjectFile(id=1, project_id=1, extension=".ts"), complete=True)
    resolver._walk_file(parsed, tree.root_node, source, 0, {})
    assert not parsed.complete

    chain = b"module" + b".member" * 1_200
    tree = Parser(LANGUAGES[".ts"]).parse(chain)
    expression = tree.root_node.named_children[0].named_children[0]
    assert len(resolver._parts(expression, chain)) == 1_201


@pytest.mark.parametrize("deleted", ["mapping[key]", "holder.values[key]"])
def test_python_subscript_deletion_does_not_taint_unrelated_same_file_call(repository, deleted):
    with repository({
        "source.py": (
            "def save():\n    return 1\n"
            f"def cleanup(mapping, holder, key):\n    del {deleted}\n"
            "def run():\n    return save()\n"
        ),
    }) as (database, _, _, symbols):
        called = resolver.resolve_called_symbols(database, symbols["source.py", "run"])
        assert len(called) == 1
        assert called[0]["symbol_id"] == symbols["source.py", "save"].id
        assert called[0]["relation"] == "bound_symbol_call"
        assert called[0]["confidence"] == "high"
        assert called[0]["line_numbers"] == [1]
        incoming = resolver.resolve_symbol_references(database, symbols["source.py", "save"])
        assert len(incoming) == 1
        assert incoming[0]["line_numbers"] == [6]
        assert incoming[0]["confidence"] == "high"


@pytest.mark.parametrize("deletion_location", ["source", "destination", "both"])
def test_python_subscript_deletion_preserves_cross_file_alias_bindings(repository, deletion_location):
    cleanup = "def cleanup(mapping, key):\n    del mapping[key]\n"
    destination = "def save():\n    return 1\n"
    consumer = (
        "from alpha import save as persist\nimport alpha as mod\n"
        "def run():\n    persist()\n    mod.save()\n"
    )
    if deletion_location in {"destination", "both"}:
        destination += cleanup
    if deletion_location in {"source", "both"}:
        consumer += cleanup
    with repository({"alpha.py": destination, "consumer.py": consumer}) as (database, _, _, symbols):
        called = resolver.resolve_called_symbols(database, symbols["consumer.py", "run"])
        assert len(called) == 1
        assert called[0]["symbol_id"] == symbols["alpha.py", "save"].id
        assert called[0]["relation"] == "bound_symbol_call"
        assert called[0]["confidence"] == "high"
        assert called[0]["file_path"] == "alpha.py"
        assert called[0]["line_numbers"] == [1]
        incoming = resolver.resolve_symbol_references(database, symbols["alpha.py", "save"])
        assert len(incoming) == 1
        assert incoming[0]["file_path"] == "consumer.py"
        assert incoming[0]["line_numbers"] == [4, 5]
        assert incoming[0]["confidence"] == "high"


@pytest.mark.parametrize("deleted", ["save", "mod", "mod.save", "save, mapping[key]"])
def test_python_name_or_attribute_deletion_remains_conservative(repository, deleted):
    with repository({
        "alpha.py": "def save():\n    return 1\n",
        "consumer.py": (
            "from alpha import save\nimport alpha as mod\n"
            f"def cleanup(mapping, key):\n    del {deleted}\n"
            "def run():\n    save()\n    mod.save()\n"
        ),
    }) as (database, _, _, symbols):
        assert resolver.resolve_symbol_references(database, symbols["alpha.py", "save"]) == []
        assert not any(row["confidence"] == "high" for row in resolver.resolve_called_symbols(
            database, symbols["consumer.py", "run"]
        ))


def test_python_subscript_deletion_does_not_turn_dynamic_receiver_into_a_binding(repository):
    with repository({
        "alpha.py": "def save():\n    return 1\n",
        "consumer.py": (
            "from alpha import save as persist\n"
            "def run(other, mapping, key):\n"
            "    del mapping[key]\n    other.save()\n    persist()\n"
        ),
    }) as (database, _, _, symbols):
        incoming = resolver.resolve_symbol_references(database, symbols["alpha.py", "save"])
        assert len(incoming) == 1
        assert incoming[0]["line_numbers"] == [5]
        assert incoming[0]["confidence"] == "high"
        called = resolver.resolve_called_symbols(database, symbols["consumer.py", "run"])
        assert len(called) == 1
        assert called[0]["symbol_id"] == symbols["alpha.py", "save"].id
        assert called[0]["line_numbers"] == [1]
