"""Conservative classification for imports that the structure parser could not resolve."""

import re
import sys


JAVASCRIPT_EXTENSIONS = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"}
NODE_BUILTINS = {
    "assert", "buffer", "child_process", "cluster", "crypto", "dns", "events",
    "fs", "http", "https", "module", "net", "os", "path", "perf_hooks",
    "process", "querystring", "readline", "stream", "string_decoder", "timers",
    "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
}


def project_module_roots(paths: list[str]) -> set[str]:
    roots: set[str] = set()
    for path in paths:
        normalized = path.replace("\\", "/").strip("/")
        if not normalized:
            continue
        first = normalized.split("/", 1)[0]
        roots.add(first.lower())
        roots.add(first.rsplit(".", 1)[0].lower())
    return roots


def classify_unresolved_import(
    *, source_extension: str, target_module: str, module_roots: set[str]
) -> str:
    """Return ``likely_external`` or ``unresolved`` without pretending certainty."""
    target = target_module.strip().strip("'\"")
    lowered = target.lower()
    if not target or lowered.startswith((".", "/")):
        return "unresolved"

    extension = source_extension.lower()
    if extension == ".py":
        root = lowered.lstrip(".").split(".", 1)[0]
        if root in module_roots:
            return "unresolved"
        return "likely_external" if root in sys.stdlib_module_names or root else "unresolved"

    if extension in JAVASCRIPT_EXTENSIONS:
        if lowered.startswith("node:"):
            return "likely_external"
        if lowered.startswith(("@/", "~/")):
            return "unresolved"
        package_root = _javascript_package_root(lowered)
        if package_root in module_roots:
            return "unresolved"
        return "likely_external" if package_root else "unresolved"

    root = re.split(r"[./:]", lowered, maxsplit=1)[0]
    if root in module_roots:
        return "unresolved"
    return "likely_external" if root else "unresolved"


def confidence_level(confidence: float) -> str:
    if confidence >= 90:
        return "high"
    if confidence >= 70:
        return "medium"
    return "low"


def _javascript_package_root(target: str) -> str:
    parts = [part for part in target.split("/") if part]
    if not parts:
        return ""
    if parts[0].startswith("@") and len(parts) > 1:
        return f"{parts[0]}/{parts[1]}"
    return parts[0]
