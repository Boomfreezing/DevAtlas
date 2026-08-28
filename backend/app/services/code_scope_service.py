"""Shared source-file scope classification used by quality and report services."""

from pathlib import PurePosixPath

CODE_SCOPES = ("production", "test", "generated")
SCOPE_LABELS = {
    "production": "生产代码",
    "test": "测试代码",
    "generated": "生成/外部代码",
}
TEST_DIRECTORIES = {"test", "tests", "spec", "specs", "__tests__"}
GENERATED_DIRECTORIES = {
    "build",
    "coverage",
    "dist",
    "generated",
    "node_modules",
    "vendor",
}


def classify_code_scope(path: object) -> str:
    normalized = str(path).replace("\\", "/").lower()
    parts = [part for part in PurePosixPath(normalized).parts if part not in {"", "/"}]
    filename = parts[-1] if parts else ""
    if (
        any(part in TEST_DIRECTORIES for part in parts)
        or filename in {"test.py", "tests.py", "spec.py", "spec.ts", "spec.js"}
        or filename.startswith("test_")
        or filename.endswith("_test.py")
        or ".test." in filename
        or ".spec." in filename
    ):
        return "test"
    if any(part in GENERATED_DIRECTORIES for part in parts) or ".min." in filename:
        return "generated"
    return "production"


def code_scope_label(scope: str) -> str:
    return SCOPE_LABELS.get(scope, scope)
