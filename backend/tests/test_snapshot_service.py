import json
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.analysis import AnalysisSnapshot
from app.services import snapshot_service
from app.services.incremental_analyzer import incrementally_analyze_project
from app.services.project_service import create_scanned_project


@pytest.fixture
def snapshots(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    (root / "main.py").write_text("def oversized():\n" + "    value = 1\n" * 90, encoding="utf-8")
    engine = create_engine("sqlite:///:memory:")
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as database:
            project = create_scanned_project(database, root, "fixture", "snapshot-demo", search_index_root=tmp_path / "indexes")
            first = snapshot_service.list_analysis_snapshots(database, project.id)[0]
            second = snapshot_service.create_analysis_snapshot(database, project, label="after")
            yield database, project, first, second
    finally:
        engine.dispose()


def compare(snapshots):
    database, project, first, second = snapshots
    return snapshot_service.compare_analysis_snapshots(database, project.id, first["id"], second["id"])


def alter_target(snapshots, change):
    database, _, _, second = snapshots
    row = database.get(AnalysisSnapshot, second["id"])
    payload = json.loads(row.data_json)
    change(payload)
    row.data_json = json.dumps(payload)
    database.commit()


def test_same_basis_snapshots_store_provenance_and_compare_normally(snapshots):
    result = compare(snapshots)
    context = result["base"]["analysis_context"]
    assert context["scoring_model"] == "source_scope_weighted_size_normalized_v5"
    assert context["coverage"]["source_file_count"] == 1
    assert context["coverage"]["parser_coverage"] == 1
    assert context["coverage"]["coverage_model"] == "recorded_parse_outcomes_v2"
    assert context["coverage"]["parser_analyzed_file_count"] == 1
    assert len(context["rules_signature"]) == 64
    assert context["parser"]["packages"]["tree-sitter"] != "unknown"
    assert result["comparable"] is True
    assert result["base"]["score_available"] is True
    assert result["comparison_warnings"] == []
    assert all(item["delta"] == 0 for item in result["metric_changes"])


@pytest.mark.parametrize("field", ["scoring_model", "rules_signature", "parser_signature"])
def test_algorithm_changes_do_not_become_quality_improvements(snapshots, field):
    def change(payload):
        payload["analysis_context"][field] = "future-version"
        payload["quality"]["score"] = 100
        payload["quality"]["findings"] = []
        payload["quality"]["total_findings"] = 0

    alter_target(snapshots, change)
    result = compare(snapshots)
    assert result["comparable"] is False
    assert result["comparison_warnings"]
    assert result["metric_changes"][0]["delta"] is None
    assert result["quality"]["fixed_count"] > 0  # Set difference only, not a fix claim.
    assert next(item for item in result["metric_changes"] if item["key"] == "files")["delta"] == 0


@pytest.mark.parametrize("field,value", [("parser_coverage", 0.5), ("parse_issue_file_count", 1), ("source_file_count", 0)])
def test_coverage_change_or_no_source_blocks_score_delta(snapshots, field, value):
    alter_target(snapshots, lambda payload: payload["analysis_context"]["coverage"].update({field: value}))
    assert compare(snapshots)["metric_changes"][0]["delta"] is None


def test_legacy_snapshots_remain_readable_without_fabricated_provenance(snapshots):
    database, project, first, second = snapshots
    original = database.get(AnalysisSnapshot, first["id"])
    payload = json.loads(original.data_json)
    payload.pop("analysis_context")
    payload["version"] = 1
    original.data_json = json.dumps(payload)
    database.commit()
    stored_json = original.data_json
    result = compare(snapshots)
    assert result["base"]["analysis_context"] is None
    assert result["base"]["score_available"] is None
    assert "历史快照" in result["comparison_warnings"][0]
    assert result["metric_changes"][0]["delta"] is None
    assert original.data_json == stored_json
    assert len(snapshot_service.list_analysis_snapshots(database, project.id)) == 2
    with pytest.raises(snapshot_service.SnapshotNotFoundError):
        snapshot_service.compare_analysis_snapshots(database, project.id + 1, first["id"], second["id"])


@pytest.mark.parametrize("legacy_model", [None, "extension_support_v1"])
def test_coverage_basis_change_cannot_be_reported_as_a_quality_improvement(snapshots, legacy_model):
    database, _, first, _ = snapshots
    row = database.get(AnalysisSnapshot, first["id"])
    payload = json.loads(row.data_json)
    coverage = payload["analysis_context"]["coverage"]
    if legacy_model is None:
        coverage.pop("coverage_model")
    else:
        coverage["coverage_model"] = legacy_model
    row.data_json = json.dumps(payload)
    database.commit()
    original_json = row.data_json
    result = compare(snapshots)
    assert result["comparable"] is False
    assert any("计算口径不同" in item for item in result["comparison_warnings"])
    assert result["metric_changes"][0]["delta"] is None
    assert row.data_json == original_json
    assert result["base"]["score_available"] is None


@pytest.mark.parametrize("content, filename", [
    ("def broken(:\n    pass\n", "main.py"),
    ("class Main {}\n", "Main.java"),
    ("# Documentation only\n", "README.md"),
])
def test_unrateable_snapshots_do_not_expose_placeholder_score_as_a_grade(tmp_path, content, filename):
    root = tmp_path / "repo"
    root.mkdir()
    (root / filename).write_text(content, encoding="utf-8")
    engine = create_engine("sqlite:///:memory:")
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as database:
            project = create_scanned_project(
                database, root, "fixture", "unrateable", search_index_root=tmp_path / "indexes",
            )
            initial = snapshot_service.list_analysis_snapshots(database, project.id)[0]
            manual = snapshot_service.create_analysis_snapshot(database, project)
            assert initial["score_available"] is False
            assert manual["score_available"] is False
            comparison = snapshot_service.compare_analysis_snapshots(
                database, project.id, initial["id"], manual["id"],
            )
            assert comparison["comparable"] is False
            assert comparison["metric_changes"][0]["delta"] is None
    finally:
        engine.dispose()


def test_threshold_change_is_captured_without_rewriting_old_snapshots(snapshots, monkeypatch):
    database, project, first, _ = snapshots
    monkeypatch.setattr(snapshot_service.quality_service, "LONG_FUNCTION_LINES", 200)
    newest = snapshot_service.create_analysis_snapshot(database, project, use_runtime_cache=False)
    result = snapshot_service.compare_analysis_snapshots(database, project.id, first["id"], newest["id"])
    assert result["base"]["analysis_context"]["rules_signature"] != result["target"]["analysis_context"]["rules_signature"]
    assert result["comparable"] is False


def test_manual_capture_cannot_upgrade_the_parser_provenance_of_old_data(snapshots, monkeypatch):
    database, project, first, _ = snapshots
    monkeypatch.setattr(snapshot_service, "PARSER_ANALYSIS_VERSION", "future-parser")
    manual = snapshot_service.create_analysis_snapshot(database, project)
    assert manual["analysis_context"]["parser_signature"] == first["analysis_context"]["parser_signature"]
    row = database.get(AnalysisSnapshot, first["id"])
    payload = json.loads(row.data_json)
    payload.pop("analysis_context")
    row.data_json = json.dumps(payload)
    database.commit()
    unknown = snapshot_service.create_analysis_snapshot(database, project)
    assert unknown["analysis_context"]["parser_signature"] is None
    assert unknown["analysis_context"]["parser"] is None


@pytest.mark.parametrize("basis", ["same", "changed", "legacy"])
def test_incremental_analysis_does_not_certify_unchanged_symbols_after_parser_upgrade(snapshots, monkeypatch, tmp_path, basis):
    database, project, first, _ = snapshots
    if basis == "changed":
        monkeypatch.setattr(snapshot_service, "PARSER_ANALYSIS_VERSION", "future-parser")
    elif basis == "legacy":
        row = database.get(AnalysisSnapshot, first["id"])
        payload = json.loads(row.data_json)
        payload.pop("analysis_context")
        row.data_json = json.dumps(payload)
        database.commit()
    (Path(project.storage_path) / "new.py").write_text("def added():\n    return 1\n", encoding="utf-8")
    incrementally_analyze_project(database, project, search_index_root=tmp_path / "indexes")
    incremental = snapshot_service.create_analysis_snapshot(database, project, reason="incremental", use_runtime_cache=False)
    manual = snapshot_service.create_analysis_snapshot(database, project)
    if basis == "same":
        assert incremental["analysis_context"]["parser_signature"] == first["analysis_context"]["parser_signature"]
    else:
        assert incremental["analysis_context"]["parser_signature"] is None
        assert manual["analysis_context"]["parser_signature"] is None
        result = snapshot_service.compare_analysis_snapshots(database, project.id, first["id"], incremental["id"])
        assert result["comparable"] is False
