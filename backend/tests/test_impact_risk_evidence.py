"""Risk evidence is static association, never an execution-coverage percentage."""

import pytest

from app.services.dependency_graph_service import DependencyFile, DependencyGraphSnapshot
from app.services.impact_analysis_service import (
    _deduplicate_relations_by_file,
    _indirect_callers,
    _risk_summary,
)


def relation(file_id, *, kind="bound_symbol_call", confidence="high", path=None):
    return {
        "file_id": file_id,
        "file_path": path or f"tests/test_case_{file_id}.py",
        "relation": kind,
        "confidence": confidence,
        "line_numbers": [4],
    }


def summarize(tests):
    return _risk_summary(
        target_type="symbol", target_line_count=20, project_file_count=100,
        direct_callers=[], dependencies=[], indirect_impacts=[], related_tests=tests,
        related_apis=[], database_entities=[], cycles=[], has_symbol_references=False,
    )


@pytest.mark.parametrize("candidate", [
    relation(1, kind="imports_target_module"),
    relation(1, kind="transitive_caller"),
    relation(1, kind="symbol_reference", confidence="medium"),
    relation(1, confidence="low"),
    relation(1, path="app/service.py"),
])
def test_unverified_test_candidates_cannot_reduce_risk(candidate):
    baseline = summarize([])
    report = summarize([candidate])
    assert report["score"] == baseline["score"]
    assert all(factor["contribution"] >= 0 for factor in report["factors"])


def test_static_test_signal_is_deduplicated_bounded_and_not_coverage():
    report = summarize([relation(1), relation(1), relation(2)])
    factor = next(item for item in report["factors"] if item["key"] == "test_evidence")
    assert factor["actual"] == 2
    assert factor["unit"] == "个"
    assert factor["label"] == "静态测试关联"
    assert -6 <= factor["contribution"] < 0
    assert "覆盖率" not in factor["label"]
    assert report["model"] == "evidence_v3"
    many = summarize([relation(index) for index in range(30)])
    many_factor = next(item for item in many["factors"] if item["key"] == "test_evidence")
    assert many_factor["contribution"] == factor["contribution"]
    assert report["score"] == max(0, min(100, report["base_score"] + sum(
        item["contribution"] for item in report["factors"]
    )))


def test_symbol_indirect_scope_expands_only_verified_direct_files():
    snapshot = DependencyGraphSnapshot(
        files={index: DependencyFile(index, f"module_{index}.py", "Python", ".py")
               for index in range(1, 6)},
        edge_lines={(2, 1): (1,), (3, 1): (1,), (4, 2): (1,), (5, 3): (1,)},
        participating_ids=frozenset(range(1, 6)), in_degree={}, out_degree={},
        cycles=(), ranked_ids=tuple(range(1, 6)),
        external_import_count=0, unresolved_import_count=0,
    )
    assert {item["file_id"] for item in _indirect_callers(snapshot, 1)} == {4, 5}
    assert {item["file_id"] for item in _indirect_callers(
        snapshot, 1, direct_file_ids={2},
    )} == {4}
    assert _indirect_callers(snapshot, 1, direct_file_ids=set()) == []


def test_file_aggregation_preserves_all_call_lines_without_mutating_evidence():
    earlier, later = relation(1), relation(1)
    earlier["line_numbers"] = [12, 4]
    later["line_numbers"] = [12, 20]
    selected = _deduplicate_relations_by_file([earlier, later])
    assert len(selected) == 1
    assert selected[0]["line_numbers"] == [4, 12, 20]
    assert earlier["line_numbers"] == [12, 4]
    assert later["line_numbers"] == [12, 20]
