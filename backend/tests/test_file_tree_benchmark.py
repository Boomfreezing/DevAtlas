import json
import math

import pytest

from evaluations import benchmark_file_tree as benchmark


def test_metadata_is_deterministic_and_exercises_wide_and_deep_directories():
    rows = benchmark.create_metadata(500)
    assert rows == benchmark.create_metadata(500)
    assert rows != benchmark.create_metadata(500, seed=1)
    assert len({row["relative_path"] for row in rows}) == 500
    summary = benchmark.corpus_summary(rows)
    assert summary == benchmark.corpus_summary(benchmark.create_metadata(500))
    assert summary["file_count"] == 500
    assert summary["maximum_path_segments"] == 11
    assert summary["scenario_counts"]["root"]["recursive_files"] == 500
    assert summary["scenario_counts"]["root"]["immediate_files"] == 50
    assert summary["scenario_counts"]["wide_first_page"]["immediate_files"] == 325
    assert summary["scenario_counts"]["deep_directory"]["recursive_files"] == 100
    assert summary["scenario_counts"]["deep_directory"]["immediate_files"] == 50


def test_distribution_is_nearest_rank_and_preserves_raw_samples():
    values = [7.1, 1.2, 3.4, 2.3, 6.7, 4.5, 5.6]
    result = benchmark.distribution(values, unit="ms")
    assert result == {"unit": "ms", "samples": values, "p50": 4.5, "p95": 7.1}
    assert benchmark.distribution(list(range(1, 21)), unit="bytes")["p95"] == 19
    for invalid in ([], [-1], [math.inf], [math.nan]):
        with pytest.raises(ValueError):
            benchmark.distribution(invalid, unit="ms")


def test_response_bytes_measure_utf8_serialized_response_not_character_count():
    payload = {"items": [{"name": "目录.py"}], "total_files": 1}
    encoded = benchmark.json_bytes(payload)
    assert json.loads(encoded) == payload
    assert len(encoded) > len(encoded.decode("utf-8"))
    assert b": " not in encoded


def sample_pages():
    items = [{"kind": "directory", "name": "deep", "file_count": 8}]
    items += [{"kind": "file", "name": str(index), "file_count": 1} for index in range(6)]
    legacy = {"path": "", "total_files": 14, "items": items}

    def fetch(offset):
        return {
            "path": "", "total_files": 14, "total_items": 7,
            "items": items[offset:offset + 3], "has_more": offset + 3 < 7,
        }

    return legacy, fetch


def test_pagination_validation_covers_all_pages_and_recursive_counts():
    legacy, fetch = sample_pages()
    result = benchmark.validate_pagination(legacy, fetch, expected_limit=3)
    assert result["passed"]
    assert result["pages_checked"] == 3
    assert result["all_items_checked"] == 7
    assert result["first_page"] == fetch(0)


@pytest.mark.parametrize("field", ["items", "total_files", "total_items", "has_more"])
def test_pagination_validation_rejects_later_page_drift(field):
    legacy, fetch = sample_pages()

    def changed(offset):
        page = fetch(offset)
        if offset == 3:
            page[field] = list(reversed(page[field])) if field == "items" else 0
        return page

    with pytest.raises(AssertionError):
        benchmark.validate_pagination(legacy, changed, expected_limit=3)


def test_cli_rejects_too_few_samples_without_starting_benchmark(monkeypatch):
    monkeypatch.setattr("sys.argv", ["benchmark_file_tree", "--output", "unused.json", "--samples", "6"])
    with pytest.raises(SystemExit) as stopped:
        benchmark.main()
    assert stopped.value.code == 2
