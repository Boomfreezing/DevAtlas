"""Synthetic, offline regressions: no benchmark questions or model providers."""

from contextlib import contextmanager

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.database import Base
from app.models.project import ProjectFile
from app.services import repository_qa_service as qa
from app.services.project_service import create_scanned_project


@pytest.fixture
def repository(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Evidence-selection regressions must not call model providers")

    monkeypatch.setattr(qa, "answer_with_report_provider", forbidden)
    monkeypatch.setattr(qa, "semantic_search_project", forbidden)
    monkeypatch.setattr(qa, "semantic_rerank_candidates", forbidden)

    @contextmanager
    def create(sources):
        root = tmp_path / "repository"
        for relative_path, content in sources.items():
            target = root / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        settings = Settings(
            _env_file=None,
            database_url=f"sqlite:///{(tmp_path / 'selection.db').as_posix()}",
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
                project = create_scanned_project(
                    database, root, "synthetic", "evidence-selection",
                    search_index_root=settings.search_index_root,
                )
                files = {
                    file.relative_path: file
                    for file in database.scalars(
                        select(ProjectFile).where(ProjectFile.project_id == project.id)
                    )
                }
                yield database, settings, project, root, files
        finally:
            engine.dispose()

    return create


def candidate(file, content, start, end, *, score=30, symbol="process_order", definition=False):
    return {
        "file_id": file.id,
        "file_path": file.relative_path,
        "start_line": start,
        "end_line": end,
        "symbol_name": symbol,
        "snippet": "\n".join(content.splitlines()[start - 1:end])[:qa.MAX_EVIDENCE_CHARS],
        "source": "symbol_exact",
        "_score": score,
        "_definition": definition,
    }


def test_similar_implementations_in_different_files_remain_distinct_evidence(repository):
    content = "def connect_client():\n    return Client.open_connection()\n"
    with repository({"clients/first.py": content, "clients/second.py": content}) as fixture:
        _, _, _, _, files = fixture
        candidates = [
            candidate(file, content, 1, 2, symbol="connect_client", definition=True)
            for file in files.values()
        ]

        selected = qa._rank_citations(candidates, ["location"], ["connect_client"])

        assert {item["file_path"] for item in selected} == set(files)


def test_invalid_top_candidates_do_not_use_the_valid_evidence_budget(repository, monkeypatch):
    content = "def sentinel_request():\n    return dispatch_payload()\n"
    sources = {f"missing_{index}.py": content for index in range(qa.MAX_CITATIONS)}
    sources["valid.py"] = content
    with repository(sources) as fixture:
        database, settings, project, root, files = fixture
        candidates = [
            candidate(files[path], content, 1, 2, symbol="sentinel_request")
            for path in sources
        ]
        for path in sources:
            if path != "valid.py":
                (root / path).unlink()

        # Isolate final selection/validation from ranking changes: the ninth
        # candidate is valid regardless of how the invalid eight were ranked.
        monkeypatch.setattr(qa, "search_project", lambda *args, **kwargs: {"results": []})
        monkeypatch.setattr(qa, "_citations_from_search", lambda *args: candidates)
        monkeypatch.setattr(qa, "_rank_citations", lambda supplied, *args, **kwargs: supplied)

        evidence = qa.retrieve_repository_evidence(
            database, settings, project, "sentinel_request 如何处理？", retrieval_mode="bm25"
        )

        assert [item["file_path"] for item in evidence.citations] == ["valid.py"]
        assert len(evidence.citations) <= qa.MAX_CITATIONS


def test_overlapping_heads_do_not_displace_a_complementary_body_window(repository):
    lines = [
        "def process_order():",
        "    initialize_alpha()",
        "    initialize_bravo()",
        "    initialize_charlie()",
        *["    pass"] * 20,
        "    setup_delta()",
        "    setup_echo()",
        "    setup_foxtrot()",
        "    setup_golf()",
        *["    pass"] * 51,
        "    try:",
        "        persist_order()",
        "    except StorageError:",
        "        rollback_transaction()",
    ]
    content = "\n".join(lines)
    with repository({"orders.py": content}) as fixture:
        _, _, _, _, files = fixture
        file = files["orders.py"]
        candidates = [
            candidate(file, content, 1, 24, score=100, definition=True),
            candidate(file, content, 5, 28, score=90),
            candidate(file, content, 80, 83, score=80),
        ]

        selected = qa._rank_citations(candidates, ["error"], ["process_order"])

        assert any("rollback_transaction" in item["snippet"] for item in selected)
        assert any(item["start_line"] == 1 for item in selected)
        assert len(selected) <= 2
        for item in selected:
            assert len(item["snippet"]) <= qa.MAX_EVIDENCE_CHARS
            assert item["snippet"] == "\n".join(
                lines[item["start_line"] - 1:item["end_line"]]
            )


def test_body_similarity_does_not_erase_decorator_and_definition_evidence(repository):
    statement = "    output = combine(" + ", ".join(f"slot{index}" for index in range(50)) + ")"
    content = "\n".join([
        '@route("/api/check")', "def check_request():", *[statement] * 25, "    return output",
    ])
    with repository({"handlers.py": content}) as fixture:
        _, _, _, _, files = fixture
        file = files["handlers.py"]
        candidates = [
            candidate(file, content, 3, 26, score=60, symbol="check_request"),
            candidate(file, content, 1, 24, score=40, symbol="check_request", definition=True),
        ]

        selected = qa._rank_citations(candidates, ["general"], ["check_request"])

        assert any('@route("/api/check")' in item["snippet"] for item in selected)
        assert any("def check_request" in item["snippet"] for item in selected)


def test_literal_user_target_precedes_unrelated_topic_alias_definitions(repository, monkeypatch):
    with repository({
        "identity.py": "def load_profile():\n    return read_record()\n",
        "users/create.py": (
            "def create(user):\n    add(user)\n    insert(user)\n    return user\n"
        ),
    }) as fixture:
        database, settings, project, _, _ = fixture
        monkeypatch.setattr(qa, "search_project", lambda *args, **kwargs: {"results": []})

        evidence = qa.retrieve_repository_evidence(
            database, settings, project, "创建用户时 load_profile 如何工作？",
            retrieval_mode="structured",
        )

        assert evidence.citations
        assert evidence.citations[0]["symbol_name"] == "load_profile"


def test_candidate_validation_remains_bounded_before_final_selection(repository, monkeypatch):
    content = "def sentinel_request():\n    return dispatch_payload()\n"
    with repository({"valid.py": content}) as fixture:
        database, settings, project, _, files = fixture
        candidates = [
            candidate(files["valid.py"], content, 1, 2, symbol="sentinel_request")
            for _ in range(100)
        ]
        monkeypatch.setattr(qa, "search_project", lambda *args, **kwargs: {"results": []})
        monkeypatch.setattr(qa, "_citations_from_search", lambda *args: candidates)
        monkeypatch.setattr(qa, "_rank_citations", lambda supplied, *args, **kwargs: supplied)
        validate = qa._validate_citations
        validated_counts = []

        def record_validation(database, project, supplied):
            validated_counts.append(len(supplied))
            return validate(database, project, supplied)

        monkeypatch.setattr(qa, "_validate_citations", record_validation)

        evidence = qa.retrieve_repository_evidence(
            database, settings, project, "sentinel_request 如何处理？", retrieval_mode="bm25"
        )

        assert evidence.citations
        assert validated_counts and max(validated_counts) <= 8
        assert sum(validated_counts) <= 64
        assert len(evidence.citations) <= qa.MAX_CITATIONS


def test_disjoint_similar_windows_keep_their_actual_line_ranges(repository):
    content = "\n".join([
        "def process_order():", "    prepare()", "    submit()", *["    pass"] * 7,
        "    prepare()", "    submit()",
    ])
    with repository({"orders.py": content}) as fixture:
        _, _, _, _, files = fixture
        selected = qa._rank_citations([
            candidate(files["orders.py"], content, 2, 3),
            candidate(files["orders.py"], content, 11, 12),
        ], ["general"], ["process_order"])

        assert [(item["start_line"], item["end_line"]) for item in selected] == [(2, 3), (11, 12)]


@pytest.mark.parametrize("difference", ["truncated", "overlap_text", "hash", "other_file"])
def test_merging_rejects_incomplete_or_inconsistent_windows(repository, difference):
    content = "def process_order():\n    prepare()\n    return submit()\n"
    with repository({"orders.py": content}) as fixture:
        _, _, _, _, files = fixture
        first = candidate(files["orders.py"], content, 1, 2)
        second = candidate(files["orders.py"], content, 2, 3)
        if difference == "truncated":
            first["snippet"] = "x" * qa.MAX_EVIDENCE_CHARS
        elif difference == "overlap_text":
            second["snippet"] = "    changed()\n    return submit()"
        elif difference == "hash":
            first["_content_hash"] = "older"
            second["_content_hash"] = "newer"
        else:
            second["file_id"] += 1

        assert qa._merge_citation_windows(first, second) is None


def test_plain_bm25_order_is_not_replaced_by_structural_literal_priority(repository):
    content = "def process_order():\n    return submit()\n"
    with repository({"first.py": content, "second.py": content}) as fixture:
        _, _, _, _, files = fixture
        supplied = [
            candidate(files["first.py"], content, 1, 2, symbol="topic_alias"),
            candidate(files["second.py"], content, 1, 2, symbol="literal_target"),
        ]

        selected = qa._rank_citations(
            supplied, ["general"], ["literal_target", "topic_alias"],
            apply_weights=False, explicit_targets=["literal_target"],
        )

        assert [item["file_path"] for item in selected] == ["first.py", "second.py"]


def test_literal_priority_preserves_resolved_multihop_database_evidence(repository):
    sources = {
        "entry.py": "def execute_transfer():\n    return fetch_balance()\n",
        "models.py": 'def fetch_balance():\n    return execute("SELECT balance FROM ledger_rows")\n',
        "create.py": "def create():\n    return unrelated_action()\n",
    }
    with repository(sources) as fixture:
        _, _, _, _, files = fixture
        entry = candidate(files["entry.py"], sources["entry.py"], 1, 2, symbol="execute_transfer")
        dependent = candidate(files["models.py"], sources["models.py"], 1, 2, symbol=None)
        dependent["source"] = "dependency_target"
        alias = candidate(files["create.py"], sources["create.py"], 1, 2, symbol="create", score=100)

        selected = qa._rank_citations(
            [entry, dependent, alias], ["database"], ["execute_transfer", "create"],
            explicit_targets=["execute_transfer"],
        )

        assert {item["file_path"] for item in selected[:2]} == {"entry.py", "models.py"}
        assert selected[-1]["file_path"] == "create.py"


def test_identical_physical_evidence_with_different_labels_uses_only_one_slot(repository):
    lines = [
        "def process_order():", "    initialize()", *["    pass"] * 18,
        "    prepare_retry()", "    rollback_transaction()",
    ]
    content = "\n".join(lines)
    with repository({"orders.py": content}) as fixture:
        _, _, _, _, files = fixture
        file = files["orders.py"]
        selected = qa._rank_citations([
            candidate(file, content, 1, 5, score=100, definition=True),
            candidate(file, content, 1, 5, score=90, symbol=None),
            candidate(file, content, 20, 22, score=80),
        ], ["error"], ["process_order"])

        assert len(selected) == 2
        assert any("rollback_transaction" in item["snippet"] for item in selected)
        assert selected[0]["symbol_name"] == "process_order"


def test_declared_range_of_truncated_head_does_not_hide_actual_tail_evidence(repository):
    lines = ["def process_order():"] + [
        f"    stage_{index}('" + "x" * 100 + "')" for index in range(1, 20)
    ] + ["    recover_order()", "    rollback_transaction()", "    record_failure()", "    return None"]
    content = "\n".join(lines)
    with repository({"orders.py": content}) as fixture:
        _, _, _, _, files = fixture
        file = files["orders.py"]
        head = candidate(file, content, 1, 24, score=100, definition=True)
        assert len(head["snippet"]) == qa.MAX_EVIDENCE_CHARS
        assert "rollback_transaction" not in head["snippet"]

        selected = qa._rank_citations([
            head, candidate(file, content, 20, 24, score=80),
        ], ["error"], ["process_order"])

        assert len(selected) == 2
        assert any("rollback_transaction" in item["snippet"] for item in selected)


def test_merge_keeps_a_real_trailing_blank_line(repository):
    content = "def process_order():\n\n    send()\n"
    with repository({"orders.py": content}) as fixture:
        _, _, _, _, files = fixture
        file = files["orders.py"]
        merged = qa._merge_citation_windows(
            candidate(file, content, 1, 2), candidate(file, content, 2, 3)
        )

        assert merged is not None
        assert (merged["start_line"], merged["end_line"]) == (1, 3)
        assert merged["snippet"] == "def process_order():\n\n    send()"


def test_late_bridge_merges_transitively_before_file_slots_are_allocated(repository):
    lines = ["def process_order():"] + [
        f"    step_{index}()" for index in range(2, 85)
    ] + ["    rollback_transaction()"]
    content = "\n".join(lines)
    with repository({"orders.py": content}) as fixture:
        _, _, _, _, files = fixture
        file = files["orders.py"]
        selected = qa._rank_citations([
            candidate(file, content, 1, 10, score=100, definition=True),
            candidate(file, content, 20, 30, score=90),
            candidate(file, content, 8, 22, score=80),
            candidate(file, content, 80, 85, score=70),
        ], ["error"], ["process_order"])

        assert [(item["start_line"], item["end_line"]) for item in selected] == [(1, 30), (80, 85)]
        assert selected[0]["snippet"] == "\n".join(lines[:30])
        assert "rollback_transaction" in selected[1]["snippet"]
