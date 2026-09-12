"""Impact relations must follow static bindings, not same-name text or module imports."""

from pathlib import Path
from textwrap import dedent

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import CodeSymbol
from app.models.project import ProjectFile
from app.services.impact_analysis_service import ImpactTargetNotFoundError, analyze_change_impact
from app.services.project_service import create_scanned_project

PYTHON_SOURCES = {
    "alpha.py": """
        def save(value):
            return value

        def other(value):
            return value * 2
    """,
    "beta.py": """
        def save(value):
            return value + "-beta"
    """,
    "named.py": """
        from alpha import save as persist

        def named_consumer():
            return persist("named")
    """,
    "module_alias.py": """
        import alpha as a

        def module_consumer():
            return a.save("module")
    """,
    "direct.py": """
        from alpha import save

        def direct_consumer():
            return save("direct")
    """,
    "wrong_target.py": """
        from beta import save

        def wrong_consumer():
            return save("other binding")
    """,
    "import_only.py": """
        import alpha

        def unrelated():
            return alpha.other(2)
    """,
    "documentation.py": """
        NOTE = "save('not executable evidence')"
        # save('a comment is not a call')
        def explain():
            return "alpha.save is only text"
    """,
    "shadowed.py": """
        from alpha import save

        def shadowed_consumer(save):
            return save("parameter, not imported target")
    """,
    "tests/test_other.py": """
        import alpha

        def test_other():
            assert alpha.other(2) == 4
    """,
    "tests/test_save.py": """
        from alpha import save as persist

        def test_target():
            assert persist("record") == "record"
    """,
}

TYPESCRIPT_SOURCES = {
    "src/alpha.ts": """
        export function save(value: string): string {
          return value;
        }
        export function other(value: number): number {
          return value * 2;
        }
    """,
    "src/beta.ts": """
        export function save(value: string): string {
          return value + "beta";
        }
    """,
    "src/named.ts": """
        import { save as persist } from "./alpha";

        export function namedConsumer(): string {
          return persist("named");
        }
    """,
    "src/namespace.ts": """
        import * as a from "./alpha";

        export function namespaceConsumer(): string {
          return a.save("namespace");
        }
    """,
    "src/wrong.ts": """
        import { save } from "./beta";

        export function wrongConsumer(): string {
          return save("different binding");
        }
    """,
    "src/import_only.ts": """
        import * as alpha from "./alpha";

        export function unrelated(): number {
          return alpha.other(2);
        }
    """,
    "src/documentation.ts": """
        // save('only a comment');
        export const note = "alpha.save('only a string')";
    """,
    "src/shadowed.ts": """
        import { save } from "./alpha";

        export function shadowedConsumer(save: (value: string) => string): string {
          return save("parameter, not import");
        }
    """,
}


@pytest.fixture
def scanned_repository(tmp_path):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    try:
        with Session(engine, expire_on_commit=False) as database:
            def create(sources, name="binding-fixture"):
                root = tmp_path / name
                for relative, content in sources.items():
                    path = root / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(dedent(content).strip() + "\n", encoding="utf-8")
                project = create_scanned_project(
                    database, root, f"synthetic-fixture/{name}", name,
                    search_index_root=tmp_path / "indexes" / name,
                )
                return project, root

            yield database, create
    finally:
        engine.dispose()


def selected_symbol(database, project, path, name):
    symbol = database.scalar(select(CodeSymbol).join(ProjectFile, ProjectFile.id == CodeSymbol.file_id).where(
        CodeSymbol.project_id == project.id, ProjectFile.relative_path == path, CodeSymbol.name == name,
    ))
    assert symbol is not None, f"The real parser must index {path}:{name} before the binding test is meaningful."
    return symbol


def symbol_report(database, project, path, name):
    target = selected_symbol(database, project, path, name)
    return analyze_change_impact(database, project.id, "symbol", target.id)


def assert_bound_call_at(relation, root: Path, path: str, line: int, text: str):
    assert relation["file_path"] == path
    assert relation["relation"] == "bound_symbol_call"
    assert relation["confidence"] == "high"
    assert relation["line_numbers"] == [line]
    lines = (root / path).read_text(encoding="utf-8").splitlines()
    assert text in lines[line - 1]
    assert relation["start_line"] <= line <= relation["end_line"]


def test_python_same_name_text_and_module_imports_are_not_target_callers(scanned_repository):
    database, create = scanned_repository
    project, _ = create(PYTHON_SOURCES)
    report = symbol_report(database, project, "alpha.py", "save")
    paths = {item["file_path"] for item in report["direct_callers"]}
    assert paths.isdisjoint({"beta.py", "wrong_target.py", "import_only.py", "documentation.py", "tests/test_other.py"})
    assert {"named.py", "module_alias.py", "direct.py", "tests/test_save.py"} <= paths


@pytest.mark.parametrize("path,text", [
    ("named.py", 'persist("named")'),
    ("module_alias.py", 'a.save("module")'),
    ("direct.py", 'save("direct")'),
])
def test_python_aliases_resolve_to_the_target_and_its_call_line(scanned_repository, path, text):
    database, create = scanned_repository
    project, root = create(PYTHON_SOURCES)
    report = symbol_report(database, project, "alpha.py", "save")
    relations = [item for item in report["direct_callers"] if item["file_path"] == path]
    assert len(relations) == 1
    assert_bound_call_at(relations[0], root, path, 4, text)


def test_parameter_binding_shadows_a_python_imported_symbol(scanned_repository):
    database, create = scanned_repository
    project, _ = create(PYTHON_SOURCES)
    report = symbol_report(database, project, "alpha.py", "save")
    assert "shadowed.py" not in {item["file_path"] for item in report["direct_callers"]}
    assert "direct.py" in {item["file_path"] for item in report["direct_callers"]}


def test_typescript_other_bindings_and_noncall_text_are_not_target_callers(scanned_repository):
    database, create = scanned_repository
    project, _ = create(TYPESCRIPT_SOURCES)
    report = symbol_report(database, project, "src/alpha.ts", "save")
    paths = {item["file_path"] for item in report["direct_callers"]}
    assert paths.isdisjoint({"src/beta.ts", "src/wrong.ts", "src/import_only.ts", "src/documentation.ts", "src/shadowed.ts"})
    assert {"src/named.ts", "src/namespace.ts"} <= paths


@pytest.mark.parametrize("path,text", [
    ("src/named.ts", 'persist("named")'),
    ("src/namespace.ts", 'a.save("namespace")'),
])
def test_typescript_named_and_namespace_alias_calls_keep_exact_locations(scanned_repository, path, text):
    database, create = scanned_repository
    project, root = create(TYPESCRIPT_SOURCES)
    report = symbol_report(database, project, "src/alpha.ts", "save")
    relations = [item for item in report["direct_callers"] if item["file_path"] == path]
    assert len(relations) == 1
    assert_bound_call_at(relations[0], root, path, 4, text)


def test_test_file_importing_only_another_function_cannot_reduce_target_risk(scanned_repository):
    database, create = scanned_repository
    project, _ = create({path: text for path, text in PYTHON_SOURCES.items() if path != "tests/test_save.py"})
    report = symbol_report(database, project, "alpha.py", "save")
    assert report["related_tests"] == []
    assert all(factor["contribution"] >= 0 for factor in report["risk"]["factors"])
    assert "add_regression_test" in {item["code"] for item in report["recommendations"]}


def test_real_test_binding_is_static_evidence_not_measured_test_coverage(scanned_repository):
    database, create = scanned_repository
    project, root = create(PYTHON_SOURCES)
    report = symbol_report(database, project, "alpha.py", "save")
    assert len(report["related_tests"]) == 1
    assert_bound_call_at(report["related_tests"][0], root, "tests/test_save.py", 4, 'persist("record")')
    factors = {item["key"]: item for item in report["risk"]["factors"]}
    assert "test_coverage" not in factors
    evidence = factors["test_evidence"]
    assert evidence["label"] == "静态测试关联"
    assert evidence["unit"] == "个"
    assert evidence["actual"] == 1
    assert "覆盖率" in report["limitations"]
    assert any(word in report["limitations"] for word in ("未执行", "不执行", "没有执行"))


def test_alias_callee_points_to_its_definition_not_a_same_named_symbol(scanned_repository):
    database, create = scanned_repository
    project, root = create(PYTHON_SOURCES)
    alpha = selected_symbol(database, project, "alpha.py", "save")
    beta = selected_symbol(database, project, "beta.py", "save")
    report = symbol_report(database, project, "named.py", "named_consumer")
    bound = [item for item in report["called_objects"] if item["relation"] == "bound_symbol_call"]
    assert {item["symbol_id"] for item in bound} == {alpha.id}
    assert beta.id not in {item.get("symbol_id") for item in report["called_objects"]}
    assert_bound_call_at(bound[0], root, "alpha.py", 1, "def save(value):")


def test_bound_call_lookup_is_project_scoped_and_rejects_a_foreign_target(scanned_repository):
    database, create = scanned_repository
    first, _ = create(PYTHON_SOURCES, "first")
    second, _ = create({"alpha.py": PYTHON_SOURCES["alpha.py"], "foreign.py": PYTHON_SOURCES["direct.py"]}, "second")
    first_target = selected_symbol(database, first, "alpha.py", "save")
    second_target = selected_symbol(database, second, "alpha.py", "save")
    first_report = analyze_change_impact(database, first.id, "symbol", first_target.id)
    second_report = analyze_change_impact(database, second.id, "symbol", second_target.id)
    assert "foreign.py" not in {item["file_path"] for item in first_report["direct_callers"]}
    assert {item["file_path"] for item in second_report["direct_callers"]} == {"foreign.py"}
    for project, report in ((first, first_report), (second, second_report)):
        ids = set(database.scalars(select(ProjectFile.id).where(ProjectFile.project_id == project.id)))
        assert all(item["file_id"] in ids for item in report["direct_callers"])
    with pytest.raises(ImpactTargetNotFoundError):
        analyze_change_impact(database, first.id, "symbol", second_target.id)


def test_file_target_still_exposes_module_import_relations(scanned_repository):
    database, create = scanned_repository
    project, _ = create(PYTHON_SOURCES)
    target = selected_symbol(database, project, "alpha.py", "save")
    report = analyze_change_impact(database, project.id, "file", target.file_id)
    imports = [item for item in report["direct_callers"] if item["file_path"] == "import_only.py"]
    assert len(imports) == 1
    assert imports[0]["relation"] == "imports_target_module"
    assert imports[0]["confidence"] == "high"
    assert imports[0]["line_numbers"] == [1]
