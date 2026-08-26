from pathlib import Path

from app.services.repository_scanner import scan_repository


def test_scan_repository_counts_source_files_and_ignores_dependencies(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hello')\nprint('world')\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("# Demo\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "ignored.js").write_text("ignored();\n", encoding="utf-8")

    result = scan_repository(tmp_path)

    assert result.primary_language == "Python"
    assert result.code_line_count == 2
    assert [item.relative_path for item in result.files] == ["README.md", "src/main.py"]


def test_scan_repository_detects_primary_language_by_lines(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("one\ntwo\n", encoding="utf-8")
    (tmp_path / "app.ts").write_text("one\ntwo\nthree\nfour\n", encoding="utf-8")

    result = scan_repository(tmp_path)

    assert result.primary_language == "TypeScript"
    assert result.code_line_count == 6

