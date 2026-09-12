"""Real Express call probes reduced to bounded CommonJS regressions."""

from contextlib import contextmanager

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import CodeSymbol
from app.models.project import ProjectFile
from app.services.impact_reference_resolver import resolve_symbol_references
from app.services.project_service import create_scanned_project


@pytest.fixture
def bindings(tmp_path):
    @contextmanager
    def create(definition, caller, extension="js"):
        root = tmp_path / "source"
        root.mkdir()
        (root / f"route.{extension}").write_text(definition, encoding="utf-8")
        (root / f"caller.{extension}").write_text(caller, encoding="utf-8")
        engine = create_engine("sqlite:///:memory:")
        try:
            Base.metadata.create_all(engine)
            with Session(engine) as database:
                project = create_scanned_project(database, root, "fixture", "cjs", search_index_root=tmp_path / "indexes")
                target = database.scalar(select(CodeSymbol).join(ProjectFile, ProjectFile.id == CodeSymbol.file_id).where(
                    CodeSymbol.project_id == project.id, ProjectFile.relative_path == f"route.{extension}",
                    CodeSymbol.qualified_name == "Route",
                ))
                assert target is not None
                yield resolve_symbol_references(database, target)
        finally:
            engine.dispose()
    return create


@pytest.mark.parametrize("expression", ["Route('/home')", "new Route('/home')"])
def test_require_default_export_supports_function_and_constructor_calls(bindings, expression):
    definition = "module.exports = Route;\nfunction Route(path) { this.path = path; }\n"
    with bindings(definition, f"var Route = require('./route');\nfunction make() {{ return {expression}; }}\n") as rows:
        assert len(rows) == 1
        assert rows[0]["file_path"] == "caller.js" and rows[0]["line_numbers"] == [2]
        assert rows[0]["relation"] == "bound_symbol_call" and rows[0]["confidence"] == "high"


@pytest.mark.parametrize("member", ["handle", "[method]"])
def test_prototype_method_write_does_not_reassign_constructor(bindings, member):
    access = member if member.startswith("[") else f".{member}"
    definition = ("module.exports = Route;\nfunction Route(path) { this.path = path; }\n"
                  f"Route.prototype{access} = function handle() {{ return 1; }};\n")
    with bindings(definition, "var Route = require('./route');\nfunction make() { return new Route('/'); }\n") as rows:
        assert len(rows) == 1 and rows[0]["confidence"] == "high"


@pytest.mark.parametrize("rewrite", [
    "Route = other;", "module.exports = {};", "module.exports = function Other() {};",
    "module.exports = externalValue;", "module.exports += Route;",
])
def test_constructor_or_export_reassignment_does_not_reuse_original_definition(bindings, rewrite):
    definition = f"function Route(path) {{ return path; }}\nmodule.exports = Route;\n{rewrite}\n"
    with bindings(definition, "var Route = require('./route');\nfunction make() { return new Route('/'); }\n") as rows:
        assert rows == []


def test_es_namespace_is_not_callable_even_if_it_has_a_default_export(bindings):
    with bindings("export default function Route(path) { return path; }\n",
                  'import * as Route from "./route";\nfunction make() { return Route("/"); }\n', "ts") as rows:
        assert rows == []


def test_local_require_parameter_is_not_a_commonjs_loader(bindings):
    with bindings("function Route(path) { return path; }\nmodule.exports = Route;\n",
                  "function make(require) { const Route = require('./route'); return new Route('/'); }\n") as rows:
        assert rows == []


def test_member_overwrite_is_not_mistaken_for_original_export(bindings):
    with bindings("function Route(path) { return path; }\nexports.Route = Route;\nexports.Route = other;\n",
                  "const router = require('./route');\nfunction make() { return router.Route('/'); }\n") as rows:
        assert rows == []


@pytest.mark.parametrize("exports", [
    "module.exports = {config: {}}; module.exports.config.Handler = Route;",
    "module.exports = Route; module['exports'] = {};",
    "module.exports = {}; function irrelevant(module) { module.exports = Route; }",
    "module.exports = Route; function rewrite() { module.exports = {}; }",
    "module.exports = Route; module = {};",
    "module.exports = Route; var module = {};",
])
def test_nested_computed_deferred_and_shadowed_export_writes_are_not_callable_defaults(bindings, exports):
    with bindings(f"function Route(path) {{ return path; }}\n{exports}\n",
                  "const Route = require('./route');\nfunction make() { return new Route('/'); }\n") as rows:
        assert rows == []
