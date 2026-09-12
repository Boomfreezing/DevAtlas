"""Coverage describes usable persisted parser evidence, not extension support."""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import CodeSymbol, ParseIssue
from app.models.project import Project, ProjectFile
from app.services.analysis_cache import clear_analysis_cache
from app.services.quality_service import build_quality_snapshot
from app.services.structure_analyzer import MAX_PARSE_FILE_BYTES, _parse_project_files


@pytest.fixture
def database():
    clear_analysis_cache()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    try:
        with Session(engine) as session:
            yield session
    finally:
        clear_analysis_cache()
        engine.dispose()


def source(path="main.py", *, extension=".py", language="Python", size=100, lines=10):
    return ProjectFile(
        relative_path=path, extension=extension, language=language,
        size_bytes=size, line_count=lines, content_hash=f"fixture-{path}",
    )


def project_with(database, tmp_path, files):
    project = Project(name="coverage", source_filename="fixture", storage_path=str(tmp_path))
    project.files = files
    database.add(project)
    database.flush()
    return project


def issue(database, project, project_file, message):
    database.add(ParseIssue(
        project_id=project.id, file_id=project_file.id,
        file_path=project_file.relative_path, message=message,
    ))


@pytest.mark.parametrize("message", [
    "File exceeds the 2 MB parser limit.",
    "Parser failed: permission denied",
    "File path is outside the managed repository.",
    "Tree-sitter found one or more syntax errors.",
])
def test_recorded_failures_exclude_files_even_when_recovery_left_symbols(database, tmp_path, message):
    project = project_with(database, tmp_path, [source()])
    project_file = project.files[0]
    issue(database, project, project_file, message)
    issue(database, project, project_file, "A second issue for the same file")
    database.add(CodeSymbol(
        project_id=project.id, file_id=project_file.id, name="recovered",
        qualified_name="recovered", kind="function", start_line=1, end_line=100,
    ))
    database.flush()
    report = build_quality_snapshot(database, project.id)
    scoring = report["scoring"]
    assert scoring["coverage_model"] == "recorded_parse_outcomes_v2"
    assert scoring["parser_supported_file_count"] == 1
    assert scoring["parser_analyzed_file_count"] == 0
    assert scoring["parser_issue_file_count"] == 1
    assert scoring["parser_coverage"] == 0
    assert scoring["coverage_level"] == "limited"
    assert scoring["applicable_rule_count"] == 1
    assert report["total_findings"] == 1  # Partial findings remain useful evidence.
    assert report["scope_scores"]["production"]["score"] is None
    assert report["scope_scores"]["production"]["finding_count"] == 1
    assert report["scope_scores"]["production"]["effective_weight"] == 0


@pytest.mark.parametrize("size, expected_count", [
    (MAX_PARSE_FILE_BYTES, 1), (MAX_PARSE_FILE_BYTES + 1, 0),
])
def test_legacy_oversized_files_without_an_issue_record_are_not_certified(database, tmp_path, size, expected_count):
    project = project_with(database, tmp_path, [source(size=size)])
    report = build_quality_snapshot(database, project.id)
    assert report["scoring"]["parser_supported_file_count"] == 1
    assert report["scoring"]["parser_analyzed_file_count"] == expected_count
    assert report["scoring"]["parser_issue_file_count"] == 0
    assert report["scoring"]["coverage_level"] == ("high" if expected_count else "limited")


@pytest.mark.parametrize("content", ["", "ANSWER = 42\n"])
def test_successful_structure_parsing_does_not_require_symbols_or_imports(database, tmp_path, content):
    (tmp_path / "main.py").write_text(content, encoding="utf-8")
    project = project_with(database, tmp_path, [source(size=len(content))])
    _parse_project_files(database, project, project.files, project.files)
    database.flush()
    report = build_quality_snapshot(database, project.id)
    assert report["scoring"]["project_size"]["symbol_count"] == 0
    assert report["scoring"]["parser_analyzed_file_count"] == 1
    assert report["scoring"]["coverage_level"] == "high"
    assert report["scope_scores"]["production"]["available"] is True


@pytest.mark.parametrize("failure", ["missing", "syntax", "oversized"])
def test_real_parser_outcomes_feed_quality_coverage(database, tmp_path, failure):
    project = project_with(database, tmp_path, [source(
        size=MAX_PARSE_FILE_BYTES + 1 if failure == "oversized" else 100,
    )])
    if failure == "syntax":
        (tmp_path / "main.py").write_text("def broken(:\n    pass\n", encoding="utf-8")
    _parse_project_files(database, project, project.files, project.files)
    database.flush()
    report = build_quality_snapshot(database, project.id)
    assert report["scoring"]["parser_supported_file_count"] == 1
    assert report["scoring"]["parser_analyzed_file_count"] == 0
    assert report["scoring"]["parser_issue_file_count"] == 1
    assert report["scope_scores"]["production"]["grade"] is None


@pytest.mark.parametrize("files, expected_level", [
    ([], "none"),
    ([source("README.md", extension=".md", language=None)], "none"),
    ([source("unknown.xyz", extension=".xyz", language=None)], "none"),
    ([source("unknown.xyz", extension=".xyz", language="Unknown")], "limited"),
])
def test_no_source_and_unknown_languages_do_not_receive_a_scope_grade(database, tmp_path, files, expected_level):
    project = project_with(database, tmp_path, files)
    report = build_quality_snapshot(database, project.id)
    assert report["scoring"]["coverage_level"] == expected_level
    assert report["scoring"]["parser_coverage"] == 0
    assert report["scoring"]["parser_analyzed_file_count"] == 0
    assert all(scope["score"] is None for scope in report["scope_scores"].values())
    assert all(weight == 0 for weight in report["scoring"]["effective_scope_weights"].values())


def test_failed_scope_does_not_contribute_a_false_100_or_discard_findings(database, tmp_path):
    project = project_with(database, tmp_path, [
        source("src/main.py", lines=1200), source("tests/test_main.py"),
    ])
    issue(database, project, project.files[0], "Parser failed: unavailable")
    database.add(CodeSymbol(
        project_id=project.id, file_id=project.files[1].id, name="long_test",
        qualified_name="long_test", kind="function", start_line=1, end_line=100,
    ))
    database.flush()
    report = build_quality_snapshot(database, project.id)
    production, test = (report["scope_scores"][scope] for scope in ("production", "test"))
    assert report["scoring"]["parser_coverage"] == 0.5
    assert report["scoring"]["coverage_level"] == "partial"
    assert production["available"] is False
    assert production["coverage_level"] == "limited"
    assert production["score"] is None
    assert production["finding_count"] == 1
    assert test["available"] is True
    assert test["configured_weight"] == 0.2
    assert test["effective_weight"] == 1
    assert test["coverage_level"] == "high"
    assert report["score"] == test["score"] < 100
    assert report["scoring"]["excluded_scopes"] == ["production", "generated"]


@pytest.mark.parametrize("success_count, expected_level", [(7, "partial"), (8, "high")])
def test_coverage_threshold_uses_usable_evidence_not_supported_extensions(database, tmp_path, success_count, expected_level):
    project = project_with(database, tmp_path, [source(f"module_{index}.py") for index in range(10)])
    for project_file in project.files[success_count:]:
        issue(database, project, project_file, "Syntax error")
    other = project_with(database, tmp_path, [source("other.py")])
    issue(database, other, other.files[0], "Do not count another project's error")
    database.flush()
    report = build_quality_snapshot(database, project.id)
    assert report["scoring"]["parser_supported_file_count"] == 10
    assert report["scoring"]["parser_analyzed_file_count"] == success_count
    assert report["scoring"]["parser_issue_file_count"] == 10 - success_count
    assert report["scoring"]["parser_coverage"] == success_count / 10
    assert report["scoring"]["coverage_level"] == expected_level
