import zipfile

import pytest

from evaluations.workspace_performance import create_corpus, distribution


def test_performance_quantiles_use_documented_nearest_rank():
    result = distribution(list(range(20, 0, -1)))
    assert result["p50_ms"] == 10
    assert result["p95_ms"] == 19
    assert result["samples_ms"][0] == 20
    with pytest.raises(ValueError):
        distribution([])


def test_synthetic_corpus_is_reproducible_and_archives_source_only(tmp_path):
    first = create_corpus(tmp_path / "one", 3)
    second = create_corpus(tmp_path / "two", 3)
    assert first["sha256"] == second["sha256"]
    assert first["lines"] == second["lines"]
    with zipfile.ZipFile(first["archive"]) as archive:
        assert len(archive.namelist()) == first["files"] == 3
        assert all(name.startswith("one/services/") and name.endswith(".py") for name in archive.namelist())
    with pytest.raises(FileExistsError):
        create_corpus(tmp_path / "one", 3)
