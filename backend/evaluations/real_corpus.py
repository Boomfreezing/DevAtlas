"""Fetch locked public source archives for developer evaluations; never run code."""

import argparse
import hashlib
import io
import json
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

import httpx

from app.core.config import Settings
from app.services.archive_service import extract_archive_path
from evaluations.repository_qa import ROOT, source_hashes

MANIFEST_ROOT = ROOT / "benchmarks" / "repository_qa_real"
CORPUS_ROOT = ROOT / "data" / "tmp" / "qa-real-corpus"
MAX_ARCHIVE_BYTES = 20 * 1024 * 1024


def load_manifest(root: Path = MANIFEST_ROOT) -> dict:
    manifest = json.loads((root / "repositories.json").read_text(encoding="utf-8"))
    names = set()
    for item in manifest["repositories"]:
        if (
            not re.fullmatch(r"[a-z0-9_-]+", item["name"])
            or item["name"] in names
            or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", item["github"])
            or not re.fullmatch(r"[A-Za-z0-9_.-]+", item["tag"])
            or not re.fullmatch(r"[a-f0-9]{40}", item["commit"])
            or not re.fullmatch(r"[a-f0-9]{64}", item["archive_sha256"])
            or item["split"] not in {"development", "validation", "holdout"}
        ):
            raise ValueError("Invalid or duplicate locked repository")
        names.add(item["name"])
    return manifest


def validate_archive(content: bytes, item: dict) -> None:
    if len(content) > MAX_ARCHIVE_BYTES:
        raise ValueError("Archive exceeds evaluation download budget")
    if hashlib.sha256(content).hexdigest() != item["archive_sha256"]:
        raise ValueError("Archive hash mismatch; do not silently update the source lock")
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        if archive.comment.decode("ascii") != item["commit"]:
            raise ValueError("Archive commit differs from the locked source revision")


def download_archive(item: dict) -> bytes:
    # Only a validated public GitHub archive host. No credentials, redirects or code execution.
    url = f"https://codeload.github.com/{item['github']}/zip/refs/tags/{item['tag']}"
    content = bytearray()
    with httpx.stream("GET", url, timeout=30, follow_redirects=False) as response:
        response.raise_for_status()
        for chunk in response.iter_bytes():
            content.extend(chunk)
            if len(content) > MAX_ARCHIVE_BYTES:
                raise ValueError("Archive exceeds evaluation download budget")
    return bytes(content)


def prepare_corpus(*, allow_download: bool = False, root: Path = CORPUS_ROOT) -> Path:
    manifest = load_manifest()
    root.mkdir(parents=True, exist_ok=True)
    repos = root / "repos"
    repos.mkdir(exist_ok=True)
    for item in manifest["repositories"]:
        target = repos / item["name"]
        marker = root / f"{item['name']}.lock.json"
        if target.exists():
            if not marker.is_file():
                raise ValueError(f"Unverified corpus directory: {item['name']}")
            locked = json.loads(marker.read_text(encoding="utf-8"))
            if locked != {"repository": item, "files": source_hashes(target)}:
                raise ValueError(f"Corpus changed after preparation: {item['name']}")
            continue
        if not allow_download:
            raise ValueError("Real sources missing; prepare with --download explicitly first")
        content = download_archive(item)
        validate_archive(content, item)
        # Each staging directory is newly allocated beneath the explicit workspace cache.
        # TemporaryDirectory removes only this owned staging tree, never an existing repo.
        with tempfile.TemporaryDirectory(prefix="staging-", dir=root) as temporary:
            staging = Path(temporary)
            archive = staging / "source.zip"
            archive.write_bytes(content)
            settings = Settings(
                _env_file=None, repository_root=staging / "extracted",
                temporary_root=staging, max_upload_mb=20, max_extracted_mb=100,
            )
            source = extract_archive_path(archive, settings)
            shutil.copytree(source, target)
        marker.write_text(json.dumps({"repository": item, "files": source_hashes(target)},
                                     ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Prepared {item['name']} @ {item['commit']}", flush=True)
    return root


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="Download only the three locked public archives")
    args = parser.parse_args()
    try:
        print(prepare_corpus(allow_download=args.download))
    except (ValueError, OSError, httpx.HTTPError, zipfile.BadZipFile) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
