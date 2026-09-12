import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest

from app.services import repository_qa_service as qa
from app.services import semantic_search_service as semantic
from evaluations import real_corpus, real_repository_qa
from evaluations.local_embeddings import local_embeddings


def test_real_annotations_have_repository_level_splits_and_linked_turns():
    manifest = real_corpus.load_manifest()
    data = json.loads((real_corpus.MANIFEST_ROOT / "cases.json").read_text(encoding="utf-8"))
    assert len(data["cases"]) == 60
    assert {repo["split"] for repo in manifest["repositories"]} == {"development", "validation", "holdout"}
    seen = {}
    for case in data["cases"]:
        assert case["id"] not in seen
        if parent := case.get("follow_up_to"):
            assert seen[parent]["repository"] == case["repository"]
            assert case["history"]
        assert case["expected_facts"]
        assert bool(case["expected_evidence"]) == (case["expected_behavior"] == "evidence")
        seen[case["id"]] = case
    assert sum(case["expected_behavior"] == "insufficient" for case in data["cases"]) == 6


def test_archive_checks_both_full_bytes_and_commit():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.comment = b"a" * 40
        archive.writestr("repo/source.py", "print('source only')")
    content = buffer.getvalue()
    item = {"archive_sha256": hashlib.sha256(content).hexdigest(), "commit": "a" * 40}
    real_corpus.validate_archive(content, item)
    with pytest.raises(ValueError, match="hash mismatch"):
        real_corpus.validate_archive(content + b"changed", item)
    with pytest.raises(ValueError, match="commit differs"):
        real_corpus.validate_archive(content, {**item, "commit": "b" * 40})


def test_missing_corpus_never_downloads_implicitly(tmp_path, monkeypatch):
    monkeypatch.setattr(real_corpus, "download_archive", lambda *_: pytest.fail("Implicit network call"))
    with pytest.raises(ValueError, match="--download"):
        real_corpus.prepare_corpus(root=tmp_path)


def test_existing_unverified_sources_are_not_overwritten(tmp_path):
    target = tmp_path / "repos" / "flask"
    target.mkdir(parents=True)
    path = target / "user.py"
    path.write_text("user content", encoding="utf-8")
    with pytest.raises(ValueError, match="Unverified corpus"):
        real_corpus.prepare_corpus(root=tmp_path, allow_download=True)
    assert path.read_text(encoding="utf-8") == "user content"


def test_annotation_anchors_reject_ambiguity_and_resolve_exact_lines(tmp_path):
    (tmp_path / "code.py").write_text("def first():\n    return 1\ndef second():\n    return 1\n", encoding="utf-8")
    ref = {"file_path": "code.py", "anchor": "return 1"}
    with pytest.raises(ValueError, match="ambiguous"):
        real_repository_qa.resolve_reference(tmp_path, ref)
    result = real_repository_qa.resolve_reference(tmp_path, {**ref, "after": "def second():"})
    assert result["start_line"] == result["end_line"] == 4
    with pytest.raises(ValueError, match="Invalid fixture path"):
        real_repository_qa.resolve_reference(tmp_path, {**ref, "file_path": "../outside.py"})


@pytest.mark.parametrize("arguments", [
    ["--modes", "hybrid"], ["--provider", "ollama"], ["--allow-model-calls"],
    ["--generated-history"], ["--provider-config", "private.json"],
])
def test_cli_requires_explicit_model_configuration_before_reading_corpus(monkeypatch, arguments):
    monkeypatch.setattr("sys.argv", ["real_repository_qa", *arguments])
    monkeypatch.setattr(real_repository_qa, "prepare_corpus", lambda: pytest.fail("Validation should precede source loading"))
    with pytest.raises(SystemExit) as stopped:
        real_repository_qa.main()
    assert stopped.value.code == 2


def test_offline_embeddings_prohibit_fallback_and_restore_runtime(tmp_path, monkeypatch):
    for name in ("model_optimized.onnx", "config.json", "tokenizer.json"):
        (tmp_path / name).write_text("unit test stub", encoding="utf-8")
    calls = []
    monkeypatch.setattr("fastembed.TextEmbedding", lambda **kwargs: calls.append(kwargs) or object())
    monkeypatch.setattr(semantic, "_embed_texts", lambda *args, **kwargs: None)
    previous = semantic._MODEL
    with pytest.raises(ValueError, match="silent BM25 fallback"):
        with local_embeddings(tmp_path, tmp_path / "indexes"):
            pytest.fail("Failed embedding must not yield an apparently successful experiment")
    assert calls[0]["local_files_only"] is True
    assert Path(calls[0]["specific_model_path"]) == tmp_path.resolve()
    assert semantic._MODEL is previous


def test_rank_fusion_uses_positions_and_does_not_double_count_duplicate_results():
    first = {"file_id": 1, "start_line": 1, "end_line": 3, "_score": 9999}
    second = {"file_id": 2, "start_line": 1, "end_line": 3, "_score": 0.01}
    third = {"file_id": 3, "start_line": 1, "end_line": 3, "_score": 0.9}
    result = qa._reciprocal_rank_fusion([first, second], [third, second, third])
    assert [item["file_id"] for item in result] == [2, 1, 3]


def test_bm25_ablation_does_not_apply_extra_qa_scope_weights():
    candidates = [
        {"file_id": 1, "file_path": "tests/a.py", "start_line": 1, "end_line": 1,
         "snippet": "test alpha beta", "source": "code_search", "_score": 20},
        {"file_id": 2, "file_path": "src/b.py", "start_line": 1, "end_line": 1,
         "snippet": "production gamma delta", "source": "code_search", "_score": 19},
    ]
    assert qa._rank_citations(candidates, ["location"], [], apply_weights=False)[0]["file_id"] == 1


def test_generated_history_uses_model_output_not_annotated_answer(tmp_path, monkeypatch):
    from evaluations import repository_qa as evaluation

    dataset = evaluation.load_dataset()
    first, followup = [dict(dataset["cases"][index]) for index in (5, 8)]
    followup["follow_up_to"] = first["id"]
    received = []
    monkeypatch.setattr(evaluation, "list_report_providers", lambda _: [{"id": "ollama", "configured": True, "model": "stub"}])

    def answer(*args, **kwargs):
        received.append(args[5])
        return {"answer": "actual generated output", "grounding_status": "insufficient", "citations": [], "reference_count": 0}

    monkeypatch.setattr(evaluation, "answer_repository_question", answer)
    evaluation.run_evaluation(tmp_path, {**dataset, "cases": [first, followup]}, provider="ollama", generated_history=True)
    assert received[1][-1] == {"role": "assistant", "content": "actual generated output"}
    assert received[1] != followup.get("history")


@pytest.fixture
def fingerprint_workspace(tmp_path, monkeypatch):
    """Only mutate disposable files, never the source being benchmarked concurrently."""
    from evaluations import repository_qa as evaluation

    root = tmp_path / "fingerprint-source"
    paths = [
        "backend/app/services/repository_qa_service.py",
        "backend/app/services/search_service.py",
        "backend/app/services/code_parser.py",
        "backend/app/services/report_provider_service.py",
        "backend/app/services/semantic_search_service.py",
        "backend/app/services/code_scope_service.py",
        "backend/app/core/config.py",
        "backend/evaluations/repository_qa.py",
        "backend/evaluations/real_repository_qa.py",
        "backend/evaluations/local_embeddings.py",
        "backend/evaluations/real_corpus.py",
        "benchmarks/repository_qa/cases.json",
        "benchmarks/repository_qa/sources.json",
        "benchmarks/repository_qa_real/cases.json",
        "benchmarks/repository_qa_real/repositories.json",
    ]
    for relative in paths:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}\n" if path.suffix == ".json" else "# original implementation\n", encoding="utf-8")
    monkeypatch.setattr(evaluation, "ROOT", root)
    return root, paths


def test_implementation_fingerprint_covers_transitive_sources_and_existing_dataset_json(fingerprint_workspace):
    from evaluations import repository_qa as evaluation

    root, paths = fingerprint_workspace
    # Files outside implementation/dataset scope must not bring credentials or run output into fingerprints.
    for relative in (".env", "data/report-providers.json", "data/tmp/result.json", "backend/tests/irrelevant.py"):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("not implementation input", encoding="utf-8")
    hashes = evaluation.implementation_source_hashes()
    assert set(hashes) == set(paths)
    assert list(hashes) == sorted(hashes)
    assert all(len(digest) == 64 for digest in hashes.values())


def test_implementation_fingerprints_normalize_newlines_for_every_tracked_text_kind(fingerprint_workspace):
    from evaluations import repository_qa as evaluation

    root, paths = fingerprint_workspace
    before = evaluation.implementation_source_hashes()
    for relative in paths:
        path = root / relative
        path.write_bytes(path.read_text(encoding="utf-8").replace("\n", "\r\n").encode("utf-8"))
    assert evaluation.implementation_source_hashes() == before


def test_implementation_fingerprint_excludes_benchmark_reports_but_tracks_annotation_inputs(fingerprint_workspace):
    from evaluations import repository_qa as evaluation

    root, _ = fingerprint_workspace
    before = evaluation.implementation_source_hashes()
    for directory in ("repository_qa", "repository_qa_real"):
        for name in ("baseline.json", "recheck.json", "recheck-2026-09-12.json"):
            (root / "benchmarks" / directory / name).write_text(
                '{"implementation_hashes": "evaluation output, not an input"}\n', encoding="utf-8",
            )
    assert evaluation.implementation_source_hashes() == before
    relative = "benchmarks/repository_qa_real/cases.json"
    (root / relative).write_text('{"annotation": "changed"}\n', encoding="utf-8")
    after = evaluation.implementation_source_hashes()
    assert evaluation.changed_implementation_paths(before, after) == [relative]


@pytest.mark.parametrize("operation,relative", [
    ("change", "backend/app/services/semantic_search_service.py"),
    ("change", "backend/app/services/code_scope_service.py"),
    ("change", "backend/evaluations/local_embeddings.py"),
    ("change", "backend/evaluations/real_repository_qa.py"),
    ("change", "benchmarks/repository_qa_real/cases.json"),
    ("change", "benchmarks/repository_qa_real/repositories.json"),
    ("add", "backend/app/services/new_retrieval_dependency.py"),
    ("delete", "backend/evaluations/real_corpus.py"),
])
def test_evaluation_detects_dependency_drift_during_run(
    tmp_path, monkeypatch, fingerprint_workspace, operation, relative,
):
    from evaluations import repository_qa as evaluation

    root, _ = fingerprint_workspace
    target = root / relative
    before = hashlib.sha256(target.read_text(encoding="utf-8").encode("utf-8")).hexdigest() if target.exists() else None
    corpus = tmp_path / "isolated-corpus"
    repository = corpus / "repos" / "fixture"
    repository.mkdir(parents=True)
    (repository / "README.md").write_text("# Fixture\nSource-only evaluation.\n", encoding="utf-8")
    dataset = {"version": "fingerprint-test", "source_hashes": evaluation.source_hashes(corpus / "repos"),
               "cases": [{"id": "context", "repository": "fixture", "question": "hello",
                          "category": "context", "expected_behavior": "project_context", "expected_evidence": []}]}
    retrieve = evaluation.retrieve_repository_evidence

    def mutate_owned_fixture(*args, **kwargs):
        if operation == "delete":
            target.unlink()
        else:
            target.write_text("# changed during retrieval\n", encoding="utf-8")
        return retrieve(*args, **kwargs)

    def forbid_generation(*args, **kwargs):
        pytest.fail("Fingerprint regression must not invoke generation or embedding")

    monkeypatch.setattr(evaluation, "retrieve_repository_evidence", mutate_owned_fixture)
    monkeypatch.setattr(evaluation, "answer_repository_question", forbid_generation)
    monkeypatch.setattr(qa, "semantic_search_project", forbid_generation)
    report = evaluation.run_evaluation(tmp_path / "evaluation-output", dataset, dataset_root=corpus)
    assert report["summary"]["retrieval_passed"] == 1  # Scoring is not modified to make drift look like a retrieval failure.
    assert report["implementation_unchanged_during_run"] is False
    if before is not None:
        assert report["implementation_hashes"][relative] == before  # Preserve the beginning, not an after-run replacement.
    else:
        assert relative not in report["implementation_hashes"]


def _fingerprint_cli_report(evaluation, mode="production", *, changed_paths=()):
    return {"dataset_version": "fingerprint-stub", "measured_at": "fixture-time", "mode": "retrieval_only",
            "retrieval_mode": mode, "summary": evaluation.summarize([]), "results": [],
            "implementation_fingerprint_version": 2,
            "implementation_hashes": evaluation.implementation_source_hashes(),
            "implementation_unchanged_during_run": not changed_paths,
            "implementation_changed_paths": list(changed_paths)}


@pytest.mark.parametrize("phase", ["prepare", "between-groups", "restored-after-group", "stable"])
def test_real_cli_detects_suite_drift_without_changing_group_scores(
    monkeypatch, fingerprint_workspace, capsys, phase,
):
    from evaluations import repository_qa as evaluation

    root, _ = fingerprint_workspace
    relative = "backend/app/services/semantic_search_service.py"
    before = evaluation.implementation_source_hashes()
    runs = []
    comparisons = 0
    render = real_repository_qa.render_comparison

    def prepare():
        if phase == "prepare":
            (root / relative).write_text("# changed during corpus preparation\n", encoding="utf-8")
        return root / "unused-corpus"

    def run(run_root, *args, retrieval_mode, **kwargs):
        run_root.mkdir(parents=True)
        changed = [relative] if phase == "restored-after-group" and not runs else []
        report = _fingerprint_cli_report(evaluation, retrieval_mode, changed_paths=changed)
        runs.append(report)
        return report

    def comparison(reports):
        nonlocal comparisons
        comparisons += 1
        if phase == "between-groups" and comparisons == 1:
            (root / relative).write_text("# changed between individually stable groups\n", encoding="utf-8")
        return render(reports)

    monkeypatch.setattr(real_repository_qa, "ROOT", root)
    monkeypatch.setattr(real_repository_qa, "prepare_corpus", prepare)
    monkeypatch.setattr(real_repository_qa, "load_real_dataset", lambda *args, **kwargs: {
        "cases": [], "repositories": [], "annotation_status": "stub; no real questions loaded",
    })
    monkeypatch.setattr(real_repository_qa, "run_evaluation", run)
    monkeypatch.setattr(real_repository_qa, "render_comparison", comparison)
    monkeypatch.setattr("sys.argv", ["real_repository_qa", "--modes", "bm25", "structured"])
    status = real_repository_qa.main()
    assert status == (0 if phase == "stable" else 3)
    assert len(runs) == 2
    saved = [json.loads(path.read_text(encoding="utf-8")) for path in
             sorted((root / "data/tmp/qa-real-runs").glob("run-*/*/result.json"))]
    assert len(saved) == 2
    for report in saved:
        assert report["summary"] == evaluation.summarize([])
        assert report["suite_implementation_hashes"] == before
        assert report["suite_implementation_unchanged"] is (phase == "stable")
        assert report["suite_implementation_changed_paths"] == ([] if phase == "stable" else [relative])
    if phase == "between-groups":
        assert all(report["implementation_unchanged_during_run"] for report in saved)
        assert saved[0]["implementation_hashes"] == before
        assert saved[1]["implementation_hashes"] != before
    output = capsys.readouterr().out
    assert ("Implementation drift detected" in output) is (phase != "stable")


def test_single_group_cli_fails_on_fingerprint_drift_even_when_retrieval_passes(
    monkeypatch, fingerprint_workspace, capsys,
):
    from evaluations import repository_qa as evaluation

    root, _ = fingerprint_workspace
    report = _fingerprint_cli_report(evaluation, changed_paths=["backend/evaluations/local_embeddings.py"])
    monkeypatch.setattr(evaluation, "load_dataset", lambda: {"cases": []})
    monkeypatch.setattr(evaluation, "run_evaluation", lambda *args, **kwargs: report)
    monkeypatch.setattr("sys.argv", ["repository_qa"])
    assert evaluation.main() == 3
    assert "Implementation drift detected" in capsys.readouterr().out
    saved = next((root / "data/tmp/qa-eval").glob("run-*/result.json"))
    assert json.loads(saved.read_text(encoding="utf-8"))["summary"] == evaluation.summarize([])
