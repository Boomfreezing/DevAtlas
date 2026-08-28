from app.services.dependency_classification_service import (
    classify_unresolved_import,
    confidence_level,
    project_module_roots,
)


def test_classifies_unresolved_imports_conservatively() -> None:
    roots = project_module_roots(["src/main.ts", "app/services/user.py", "utils.py"])

    assert classify_unresolved_import(
        source_extension=".ts", target_module="./missing", module_roots=roots
    ) == "unresolved"
    assert classify_unresolved_import(
        source_extension=".ts", target_module="src/missing", module_roots=roots
    ) == "unresolved"
    assert classify_unresolved_import(
        source_extension=".ts", target_module="react", module_roots=roots
    ) == "likely_external"
    assert classify_unresolved_import(
        source_extension=".ts", target_module="@/missing", module_roots=roots
    ) == "unresolved"
    assert classify_unresolved_import(
        source_extension=".py", target_module="json", module_roots=roots
    ) == "likely_external"
    assert classify_unresolved_import(
        source_extension=".py", target_module="app.missing", module_roots=roots
    ) == "unresolved"


def test_maps_dependency_confidence_levels() -> None:
    assert confidence_level(95) == "high"
    assert confidence_level(75) == "medium"
    assert confidence_level(50) == "low"
