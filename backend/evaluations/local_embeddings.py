"""Strict offline embedding runtime for experiments, isolated from the app process."""

import hashlib
from contextlib import contextmanager
from pathlib import Path

from app.services import semantic_search_service as semantic


@contextmanager
def local_embeddings(model_dir: Path, index_root: Path):
    from fastembed import TextEmbedding

    model_dir = model_dir.resolve()
    required = ["model_optimized.onnx", "tokenizer.json", "config.json"]
    if not all((model_dir / name).is_file() for name in required):
        raise ValueError("An existing complete local embedding model directory is required")
    fingerprint = {}
    for path in sorted(model_dir.iterdir()):
        if path.is_file():
            with path.open("rb") as stream:
                fingerprint[path.name] = hashlib.file_digest(stream, "sha256").hexdigest()
    previous = (semantic._MODEL, semantic._MODEL_CACHE_PATH, semantic._MODEL_FAILED,
                semantic._embed_texts, semantic._SEMANTIC_CACHE)
    try:
        semantic._MODEL = TextEmbedding(
            model_name=semantic.SEMANTIC_MODEL_NAME,
            specific_model_path=str(model_dir), local_files_only=True,
            cache_dir=str(index_root.parent / "models" / "fastembed"), threads=4,
        )
        semantic._MODEL_CACHE_PATH = semantic._model_cache_root(index_root)
        semantic._MODEL_FAILED = False
        semantic._SEMANTIC_CACHE = {}

        def strict_embed(*args, **kwargs):
            result = previous[3](*args, **kwargs)
            if result is None:
                raise ValueError("Semantic experiment failed; refusing to report a silent BM25 fallback")
            return result

        semantic._embed_texts = strict_embed
        if not strict_embed(["offline readiness probe"], semantic._MODEL_CACHE_PATH, query=True):
            raise ValueError("Local embedding readiness check failed")
        yield {"model": semantic.SEMANTIC_MODEL_NAME, "files_sha256": fingerprint,
               "network": "disabled: local_files_only + specific_model_path"}
    finally:
        (semantic._MODEL, semantic._MODEL_CACHE_PATH, semantic._MODEL_FAILED,
         semantic._embed_texts, semantic._SEMANTIC_CACHE) = previous
