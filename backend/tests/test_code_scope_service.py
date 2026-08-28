from app.services.code_scope_service import classify_code_scope


def test_classifies_root_level_test_entrypoints_as_test_code() -> None:
    assert classify_code_scope("test.py") == "test"
    assert classify_code_scope("spec.ts") == "test"
    assert classify_code_scope("src/test_helpers.py") == "test"
    assert classify_code_scope("src/main.py") == "production"
