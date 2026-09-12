"""Type-only declarations are not executable call bindings."""

from contextlib import contextmanager

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import CodeSymbol
from app.services import impact_reference_resolver as resolver
from app.services.project_service import create_scanned_project


@pytest.fixture
def repository(tmp_path):
    @contextmanager
    def create(sources):
        root = tmp_path / "repository"
        for path, content in sources.items():
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        engine = create_engine("sqlite:///:memory:")
        try:
            Base.metadata.create_all(engine)
            with Session(engine) as database:
                project = create_scanned_project(
                    database, root, "fixture", "type-bindings",
                    search_index_root=tmp_path / "indexes",
                )
                files = {file.id: file.relative_path for file in project.files}
                symbols = {
                    (files[symbol.file_id], symbol.qualified_name): symbol
                    for symbol in database.scalars(
                        select(CodeSymbol).where(CodeSymbol.project_id == project.id)
                    )
                }
                yield database, symbols
        finally:
            engine.dispose()

    return create


@pytest.mark.parametrize("declaration,call,target", [
    ('import type {save} from "./alpha";', "save()", "save"),
    ('import type {save as persist} from "./alpha";', "persist()", "save"),
    ('import {type save as persist} from "./alpha";', "persist()", "save"),
    ('import type main from "./alpha";', "main()", "main"),
    ('import type * as mod from "./alpha";', "mod.save()", "save"),
    ('import /* comment */ type {save} from "./alpha";', "save()", "save"),
])
def test_type_only_imports_cannot_prove_runtime_calls(repository, declaration, call, target):
    # The call is syntactically valid but semantically invalid TypeScript: the
    # type-only import disappears at runtime and must never become bound/high.
    with repository({
        "alpha.ts": "export function save() { return 1; }\nexport default function main() { return 2; }\n",
        "consumer.ts": declaration + "\nexport function run() { " + call + "; }\n",
    }) as (database, symbols):
        assert resolver.resolve_called_symbols(database, symbols["consumer.ts", "run"]) == []
        assert resolver.resolve_symbol_references(database, symbols["alpha.ts", target]) == []


@pytest.mark.parametrize("declaration,imported", [
    ("export type {save};", "save"),
    ("export type {save as persist};", "persist"),
    ("export {type save as persist};", "persist"),
    ("export /* comment */ type {save};", "save"),
    ("export type save = { value: string };", "save"),
])
def test_type_only_exports_cannot_expose_a_private_runtime_function(repository, declaration, imported):
    with repository({
        "alpha.ts": "function save() { return 1; }\n" + declaration + "\n",
        "consumer.ts": (
            'import {' + imported + '} from "./alpha";\n'
            "export function run() { " + imported + "(); }\n"
        ),
    }) as (database, symbols):
        assert resolver.resolve_called_symbols(database, symbols["consumer.ts", "run"]) == []
        assert resolver.resolve_symbol_references(database, symbols["alpha.ts", "save"]) == []


@pytest.mark.parametrize("extension", ["ts", "tsx"])
def test_mixed_type_and_value_imports_preserve_only_value_evidence(repository, extension):
    with repository({
        f"alpha.{extension}": "export function save() { return 1; }\nexport function read() { return 2; }\n",
        f"consumer.{extension}": (
            'import {type save as persist, read as load} from "./alpha";\n'
            "export function run() {\n    persist();\n    load();\n}\n"
        ),
    }) as (database, symbols):
        called = resolver.resolve_called_symbols(database, symbols[f"consumer.{extension}", "run"])
        assert len(called) == 1
        assert called[0]["symbol_id"] == symbols[f"alpha.{extension}", "read"].id
        assert called[0]["confidence"] == "high"
        assert called[0]["line_numbers"] == [2]
        assert resolver.resolve_symbol_references(database, symbols[f"alpha.{extension}", "save"]) == []
        incoming = resolver.resolve_symbol_references(database, symbols[f"alpha.{extension}", "read"])
        assert len(incoming) == 1
        assert incoming[0]["line_numbers"] == [4]


def test_mixed_type_and_value_exports_preserve_only_value_evidence(repository):
    with repository({
        "alpha.ts": (
            "function save() { return 1; }\nfunction read() { return 2; }\n"
            "export {type save as persist, read as load};\n"
        ),
        "consumer.ts": (
            'import {persist, load} from "./alpha";\n'
            "export function run() {\n    persist();\n    load();\n}\n"
        ),
    }) as (database, symbols):
        called = resolver.resolve_called_symbols(database, symbols["consumer.ts", "run"])
        assert len(called) == 1
        assert called[0]["symbol_id"] == symbols["alpha.ts", "read"].id
        assert called[0]["relation"] == "bound_symbol_call"
        assert called[0]["line_numbers"] == [2]
        assert resolver.resolve_symbol_references(database, symbols["alpha.ts", "save"]) == []


@pytest.mark.parametrize("declaration,target", [
    ("export function type() { return 1; }\n", "type"),
    ("function save() { return 1; }\nexport {save as type};\n", "save"),
])
def test_runtime_identifier_named_type_is_not_mistaken_for_a_type_modifier(repository, declaration, target):
    with repository({
        "alpha.ts": declaration,
        "consumer.ts": 'import {type} from "./alpha";\nexport function run() { type(); }\n',
    }) as (database, symbols):
        called = resolver.resolve_called_symbols(database, symbols["consumer.ts", "run"])
        assert len(called) == 1
        assert called[0]["symbol_id"] == symbols["alpha.ts", target].id
        assert called[0]["relation"] == "bound_symbol_call"
        assert called[0]["confidence"] == "high"
        assert called[0]["line_numbers"] == [1]


def test_type_alias_does_not_erase_an_explicit_runtime_export(repository):
    with repository({
        "alpha.ts": "export function save() { return 1; }\nexport type save = { value: string };\n",
        "consumer.ts": 'import {save} from "./alpha";\nexport function run() { save(); }\n',
    }) as (database, symbols):
        called = resolver.resolve_called_symbols(database, symbols["consumer.ts", "run"])
        assert len(called) == 1
        assert called[0]["symbol_id"] == symbols["alpha.ts", "save"].id
        assert called[0]["confidence"] == "high"


@pytest.mark.parametrize("barrel", [
    'export {save} from "./alpha";\n',
    'export * from "./alpha";\n',
    'import {save} from "./alpha";\nexport {save};\n',
    'export type {save} from "./alpha";\n',
])
def test_reexport_resolution_is_not_invented(repository, barrel):
    with repository({
        "alpha.ts": "export function save() { return 1; }\n",
        "barrel.ts": barrel,
        "consumer.ts": 'import {save} from "./barrel";\nexport function run() { save(); }\n',
    }) as (database, symbols):
        assert resolver.resolve_called_symbols(database, symbols["consumer.ts", "run"]) == []
        assert resolver.resolve_symbol_references(database, symbols["alpha.ts", "save"]) == []


def test_inherited_method_and_dynamic_receiver_are_not_guessed(repository):
    with repository({
        "alpha.ts": "export class Base {\n    static save() { return 1; }\n}\n",
        "consumer.ts": (
            'import {Base} from "./alpha";\n'
            "class Child extends Base {}\n"
            "export function run(other: Base) { Child.save(); other.save(); }\n"
        ),
    }) as (database, symbols):
        assert resolver.resolve_called_symbols(database, symbols["consumer.ts", "run"]) == []
        assert resolver.resolve_symbol_references(database, symbols["alpha.ts", "Base.save"]) == []
