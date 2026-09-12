"""Probe validation must not turn missing targets or source drift into successes."""

import json

import pytest

from evaluations import coupling_real as evaluation


def reference(path="source.py", anchor="def target():", **extra):
    return {"file_path": path, "anchor": anchor, **extra}


def probe(**extra):
    return {"id": "flask-01", "repository": "flask", "direction": "incoming",
            "expected": "bound", "target": reference(qualified_name="target"),
            "evidence": reference(anchor="    return target()"), "reason": "Same-file direct call", **extra}


@pytest.fixture
def corpus(tmp_path):
    sources, annotations = tmp_path / "repos", tmp_path / "annotations"
    annotations.mkdir()
    for name in evaluation.REPOSITORIES:
        root = sources / name
        root.mkdir(parents=True)
        (root / "source.py").write_text(
            "def target():\n    return 1\ndef caller():\n    return target()\n", encoding="utf-8",
        )
        (annotations / f"{name}.json").write_text(json.dumps([
            probe(id=f"{name}-01", repository=name),
        ]), encoding="utf-8")
    return sources, annotations


def test_resolves_unique_source_anchors_and_rejects_ambiguous_ones(tmp_path):
    (tmp_path / "source.py").write_text("def first():\n    same()\ndef second():\n    same()\n")
    assert evaluation.resolve_anchor(tmp_path, reference(anchor="same()", after="def second():")) == 4
    with pytest.raises(ValueError, match="ambiguous"):
        evaluation.resolve_anchor(tmp_path, reference(anchor="same()"))
    with pytest.raises(ValueError, match="unique"):
        evaluation.resolve_anchor(tmp_path, reference(anchor="same()", after="missing"))
    with pytest.raises(ValueError, match="Empty"):
        evaluation.resolve_anchor(tmp_path, reference(anchor=" "))


def test_source_anchor_rejects_path_escape(tmp_path):
    (tmp_path / "secret.py").write_text("def target(): pass")
    root = tmp_path / "repo"
    root.mkdir()
    with pytest.raises(ValueError, match="Invalid fixture path"):
        evaluation.resolve_anchor(root, reference(path="../secret.py"))


@pytest.mark.parametrize("change", [
    {"direction": "any"}, {"expected": "absent"}, {"reason": ""}, {"repository": "elsewhere"},
])
def test_rejects_invalid_annotations(corpus, change):
    sources, annotations = corpus
    (annotations / "flask.json").write_text(json.dumps([probe(**change)]))
    with pytest.raises(ValueError, match="Invalid/duplicate"):
        evaluation.load_cases(sources, annotations)


def test_duplicate_ids_are_rejected(corpus):
    sources, annotations = corpus
    (annotations / "flask.json").write_text(json.dumps([probe(), probe()]))
    with pytest.raises(ValueError, match="duplicate"):
        evaluation.load_cases(sources, annotations)


@pytest.mark.parametrize("kind,confidence,confirmed", [
    ("bound_symbol_call", "high", True), ("candidate_symbol_call", "low", False),
    ("bound_symbol_call", "low", False), ("imports_target_module", "high", False),
])
def test_only_matching_high_confidence_static_call_satisfies_probe(kind, confidence, confirmed):
    case = probe(evidence={"file_path": "source.py", "line": 4})
    row = {"file_path": "source.py", "line_numbers": [4], "relation": kind, "confidence": confidence}
    assert evaluation.assess_probe(case, [row])["confirmed"] is confirmed
    assert not evaluation.assess_probe(case, [{**row, "file_path": "other.py"}])["confirmed"]
    assert not evaluation.assess_probe(case, [{**row, "line_numbers": [3]}])["confirmed"]


def test_outgoing_probe_checks_definition_name_and_location():
    case = probe(direction="outgoing", evidence={"file_path": "source.py", "line": 4, "qualified_name": "target"})
    row = {"file_path": "source.py", "line_numbers": [4], "symbol_name": "other",
           "relation": "bound_symbol_call", "confidence": "high"}
    assert not evaluation.assess_probe(case, [row])["passed"]
    assert evaluation.assess_probe(case, [{**row, "symbol_name": "target"}])["passed"]


def test_invalid_relation_paths_and_line_numbers_are_detected(tmp_path):
    (tmp_path / "source.py").write_text("one\ntwo\n")
    good = {"file_path": "source.py", "line_numbers": [1], "start_line": 1, "end_line": 2}
    assert evaluation.validate_locations(tmp_path, [good]) == []
    bad = [{**good, "file_path": "../missing"}, {**good, "line_numbers": [0]},
           {**good, "end_line": 3}, {**good, "line_numbers": [True]}]
    assert evaluation.validate_locations(tmp_path, bad) == bad


def test_real_pipeline_is_isolated_and_missing_negative_target_does_not_pass(corpus, tmp_path):
    sources, annotations = corpus
    cases = evaluation.load_cases(sources, annotations)
    cases.append({**cases[0], "id": "missing-target", "expected": "not_bound",
                  "target": {**cases[0]["target"], "qualified_name": "not_indexed"}})
    result = evaluation.run_probes(tmp_path / "run", sources, cases, annotations)
    assert result["summary"]["positive_confirmed"] == 3
    assert result["summary"]["evaluation_errors"] == 1
    assert result["summary"]["negative_rejected"] == 0
    assert result["summary"]["failed_ids"] == ["missing-target"]
    assert result["sources_unchanged"] and result["implementation_unchanged"]
    assert (tmp_path / "run" / "result.json").is_file()
    with pytest.raises(FileExistsError):
        evaluation.run_probes(tmp_path / "run", sources, cases, annotations)


def test_detects_implementation_or_annotation_drift(corpus, tmp_path, monkeypatch):
    sources, annotations = corpus
    hashes = iter([{"input": "before"}, {"input": "after"}])
    monkeypatch.setattr(evaluation, "fingerprints", lambda _: next(hashes))
    report = evaluation.run_probes(tmp_path / "run", sources, evaluation.load_cases(sources, annotations), annotations)
    assert not report["implementation_unchanged"]
    assert report["implementation_changed_paths"] == ["input"]


def test_summary_reports_probe_counts_not_graph_precision():
    summary = evaluation.summarize([
        {"id": "hit", "expected": "bound", "confirmed": True, "passed": True},
        {"id": "miss", "expected": "bound", "confirmed": False, "passed": False},
        {"id": "false", "expected": "not_bound", "confirmed": True, "passed": False},
    ])
    assert summary["positive_confirmed"] == 1 and summary["positive_probes"] == 2
    assert summary["incorrect_confirmations"] == 1 and summary["negative_rejected"] == 0
    assert "precision" not in summary and "recall" not in summary
