import json
import shutil
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.database import Base
from app.services import repository_qa_service as qa
from app.services.project_service import create_scanned_project
from app.services.report_provider_service import ReportProviderError
from evaluations import repository_qa as evaluation

DATASET = evaluation.load_dataset()


@pytest.fixture(scope="module")
def benchmark_report(tmp_path_factory):
    def forbidden(*args, **kwargs):
        pytest.fail("Offline evaluation must not call generation or embedding providers")

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(qa, "answer_with_report_provider", forbidden)
        patch.setattr(qa, "semantic_search_project", forbidden)
        patch.setattr(qa, "semantic_rerank_candidates", forbidden)
        return evaluation.run_evaluation(tmp_path_factory.mktemp("qa-benchmark"), DATASET)


@pytest.mark.parametrize("case_id", [case["id"] for case in DATASET["cases"]])
def test_fixed_repository_qa_evidence_case(benchmark_report, case_id):
    row = next(item for item in benchmark_report["results"] if item["id"] == case_id)
    assert row["retrieval_pass"], {
        "case": case_id,
        "actual_behavior": row["actual_behavior"],
        "missing": row["missing_evidence_at_5"],
        "citations": [(item["file_path"], item["start_line"], item["end_line"]) for item in row["citations"]],
    }


def test_benchmark_is_explicit_about_what_it_does_not_measure(benchmark_report):
    assert len({case["repository"] for case in DATASET["cases"]}) == 3
    assert len(DATASET["cases"]) >= 30
    assert benchmark_report["summary"]["answer_quality"] == "not_measured"
    assert benchmark_report["provider"] is None
    assert benchmark_report["semantic_search_enabled"] is False
    assert not any("answer" in row for row in benchmark_report["results"])
    assert benchmark_report["implementation_fingerprint_version"] == 2
    assert set(benchmark_report["implementation_hashes"]) == set(evaluation.implementation_source_hashes())
    assert {"backend/app/services/semantic_search_service.py", "backend/evaluations/local_embeddings.py",
            "benchmarks/repository_qa_real/cases.json"} <= benchmark_report["implementation_hashes"].keys()
    assert "不等于回答正确" in evaluation.render_markdown(benchmark_report)


def test_dataset_lock_and_evidence_annotations_detect_drift(tmp_path):
    root = tmp_path / "dataset"
    shutil.copytree(evaluation.DATASET_ROOT, root)
    path = root / "cases.json"
    dataset = json.loads(path.read_text(encoding="utf-8"))
    dataset["cases"][0]["expected_evidence"][0]["contains"] = ["not a startup command"]
    path.write_text(json.dumps(dataset), encoding="utf-8")
    with pytest.raises(ValueError, match="Annotation text drift"):
        evaluation.load_dataset(root)
    source = root / "repos/accounts/README.md"
    source.write_text("changed fixture", encoding="utf-8")
    with pytest.raises(ValueError, match="source hashes changed"):
        evaluation.load_dataset(root)


def test_evidence_metric_requires_file_lines_and_actual_text(tmp_path):
    (tmp_path / "source.py").write_text("first\nrequired\nlast\n", encoding="utf-8")
    expected = {"file_path": "source.py", "start_line": 2, "end_line": 2, "contains": ["required"]}
    citation = {"file_path": "source.py", "start_line": 1, "end_line": 3, "snippet": "first"}
    assert not evaluation.evidence_matches(citation, expected)
    assert not evaluation.citation_is_valid(tmp_path, citation)
    citation["snippet"] = "first\nrequired\nlast"
    assert evaluation.evidence_matches(citation, expected)
    assert evaluation.citation_is_valid(tmp_path, citation)
    citation["file_path"] = "../outside.py"
    assert not evaluation.citation_is_valid(tmp_path, citation)


def test_metrics_do_not_count_unanswerable_questions_as_recall_hits(tmp_path):
    case = {"category": "unanswerable", "expected_behavior": "insufficient", "expected_evidence": []}
    row = {"id": "absent", **case, **evaluation.score_case(case, [], "insufficient", tmp_path), "citations": [], "elapsed_ms": 1}
    summary = evaluation.summarize([row])
    assert summary["insufficient_correct"] == 1
    assert summary["mean_evidence_recall_at_5"] is None
    assert summary["mean_reciprocal_rank"] is None


@pytest.mark.parametrize("arguments", [
    ["--provider", "ollama"],
    ["--allow-model-calls"],
    ["--provider", "ollama", "--allow-model-calls", "--provider-config", "missing.json"],
    ["--case", "unknown-case"],
])
def test_cli_rejects_accidental_model_calls_or_invalid_cases(monkeypatch, arguments):
    monkeypatch.setattr("sys.argv", ["repository_qa", *arguments])
    with pytest.raises(SystemExit) as stopped:
        evaluation.main()
    assert stopped.value.code == 2


@pytest.fixture
def qa_project(tmp_path):
    root = tmp_path / "repository"
    shutil.copytree(evaluation.DATASET_ROOT / "repos/accounts", root)
    settings = Settings(
        _env_file=None,
        database_url="sqlite:///:memory:",
        repository_root=root,
        temporary_root=tmp_path / "tmp",
        search_index_root=tmp_path / "indexes",
        provider_config_path=tmp_path / "providers.json",
        semantic_search_enabled=False,
    )
    engine = create_engine(settings.database_url)
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as database:
            project = create_scanned_project(database, root, "fixture", "accounts", search_index_root=settings.search_index_root)
            yield database, settings, project, root
    finally:
        engine.dispose()


def test_nonexistent_named_test_target_never_reaches_the_model(qa_project, monkeypatch):
    database, settings, project, _ = qa_project

    def forbidden(*args, **kwargs):
        pytest.fail("Missing target must be rejected before generation")

    monkeypatch.setattr(qa, "answer_with_report_provider", forbidden)
    result = qa.answer_repository_question(database, settings, project, "quantumTeleport 的测试在哪里？", "ollama")
    assert result["grounding_status"] == "insufficient"
    assert result["citations"] == []


def test_citation_validation_rejects_changed_and_deleted_sources(qa_project):
    database, settings, project, root = qa_project
    evidence = qa.retrieve_repository_evidence(database, settings, project, "login_user 在哪里？")
    citations = [item for item in evidence.citations if item["file_path"] == "src/auth.py"]
    assert citations
    source = root / "src/auth.py"
    # Still has enough lines: range-only validation would attach unrelated code.
    source.write_text("# replaced after indexing\n" * 12, encoding="utf-8")
    assert qa._validate_citations(database, project, citations) == []
    source.unlink()
    assert qa._validate_citations(database, project, citations) == []


def test_citation_validation_reads_each_file_only_once(qa_project, monkeypatch):
    database, settings, project, root = qa_project
    evidence = qa.retrieve_repository_evidence(database, settings, project, "login_user 在哪里？")
    citation = next(item for item in evidence.citations if item["file_path"] == "src/auth.py")
    read_bytes = Path.read_bytes
    reads = []

    def counted(path):
        reads.append(path)
        return read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", counted)
    assert len(qa._validate_citations(database, project, [citation, citation])) == 2
    assert reads == [root / "src/auth.py"]


def test_question_change_does_not_inherit_old_target():
    history = [{"role": "user", "content": "login_user 在哪里？"}, {"role": "assistant", "content": "见 `src/auth.py`。"}]
    assert qa._contextual_question("如何启动项目？", history) == "如何启动项目？"
    assert qa._contextual_question("configure a server with TLS", history) == "configure a server with TLS"
    assert "login_user" in qa._contextual_question("What about its tests?", history)


def test_followup_paths_from_assistant_are_hints_not_mandatory_targets(qa_project):
    database, settings, project, _ = qa_project
    history = [{"role": "user", "content": "登录功能如何实现？"},
               {"role": "assistant", "content": "可能在 `nonexistent/production_login.py`。"}]
    result = qa.retrieve_repository_evidence(database, settings, project, "它的相关测试呢？", history)
    assert result.citations
    assert any("test" in item["file_path"] for item in result.citations)


def test_explicit_missing_user_target_still_blocks_followup(qa_project):
    database, settings, project, _ = qa_project
    history = [{"role": "user", "content": "quantumTeleport 的登录逻辑在哪里？"},
               {"role": "assistant", "content": "猜测为 `src/auth.py` 的 `login_user`。"}]
    result = qa.retrieve_repository_evidence(database, settings, project, "它的测试呢？", history)
    assert not result.citations


def test_explicit_targets_precede_aliases_but_protocol_names_do_not_gate():
    assert qa._meaningful_identifiers("登录接口的用户权限配置中 SESSION_TTL 有何用途？")[0] == "session_ttl"
    assert qa._explicit_question_targets("异常为什么返回 HTTP 401 而不是 JSON？") == []
    assert qa._explicit_question_targets("见 worker/jobs.py:4-8 的 process_export") == ["worker/jobs.py", "process_export"]


def test_model_evaluation_preserves_manual_review_and_never_claims_answer_accuracy(tmp_path, monkeypatch):
    # Only verifies evaluation plumbing with a stub, not real model quality.
    dataset = {**DATASET, "cases": [DATASET["cases"][5]]}
    monkeypatch.setattr(evaluation, "list_report_providers", lambda settings: [{"id": "ollama", "configured": True, "model": "unit-test-stub"}])
    monkeypatch.setattr(qa, "answer_with_report_provider", lambda *args, **kwargs: "SESSION_TTL 默认 1800 秒。[1]")
    report = evaluation.run_evaluation(tmp_path, dataset, provider="ollama")
    row = report["results"][0]
    assert row["retrieval_pass"]
    assert row["reference_count"] == 1
    assert row["manual_review"]["facts_supported_by_cited_text"] is None
    assert report["summary"]["answer_quality"] == "pending_human_review"


def test_model_errors_are_separate_from_evidence_insufficiency(tmp_path, monkeypatch):
    dataset = {**DATASET, "cases": [DATASET["cases"][5]]}
    monkeypatch.setattr(evaluation, "list_report_providers", lambda settings: [{"id": "ollama", "configured": True, "model": "unit-test-stub"}])

    def failed(*args, **kwargs):
        raise ReportProviderError("private upstream detail")

    monkeypatch.setattr(qa, "answer_with_report_provider", failed)
    report = evaluation.run_evaluation(tmp_path, dataset, provider="ollama")
    assert report["summary"]["model_errors"] == 1
    assert report["results"][0]["actual_behavior"] == "model_error"
    assert "private upstream detail" not in json.dumps(report)
