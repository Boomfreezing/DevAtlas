"""Real-source QA experiments. No download or paid model calls by default."""

import argparse
import json
import tempfile
from pathlib import Path

from evaluations.real_corpus import CORPUS_ROOT, MANIFEST_ROOT, load_manifest, prepare_corpus
from evaluations.repository_qa import (
    ROOT,
    changed_implementation_paths,
    implementation_source_hashes,
    run_evaluation,
    source_hashes,
    source_path,
    summarize,
    validate_annotations,
)

MODES = ("bm25", "structured", "hybrid", "hybrid-rerank")


def resolve_reference(root: Path, ref: dict) -> dict:
    """Resolve human-authored unique text anchors in SHA-locked sources, not retrieval output."""
    lines = source_path(root, ref["file_path"]).read_text(encoding="utf-8").splitlines()
    lower_bound = 0
    if ref.get("after"):
        matches = [i for i, line in enumerate(lines) if ref["after"] in line]
        if len(matches) != 1:
            raise ValueError(f"Ambiguous scope anchor: {ref['file_path']}")
        lower_bound = matches[0]
    matches = [i for i in range(lower_bound, len(lines)) if ref["anchor"] in lines[i]]
    if not matches or (len(matches) != 1 and not ref.get("after")):
        raise ValueError(f"Missing/ambiguous anchor: {ref['file_path']} :: {ref['anchor']}")
    start = end = matches[0]
    if ref.get("end_anchor"):
        end_matches = [i for i in range(start, min(len(lines), start + 24)) if ref["end_anchor"] in lines[i]]
        if not end_matches:
            raise ValueError(f"End anchor missing or annotation exceeds 24 lines: {ref['file_path']}")
        end = end_matches[0]
    return {"file_path": ref["file_path"], "start_line": start + 1, "end_line": end + 1,
            "contains": [ref["anchor"], *([ref["end_anchor"]] if ref.get("end_anchor") else [])]}


def load_real_dataset(corpus: Path = CORPUS_ROOT, *, split: str = "development") -> dict:
    manifest = load_manifest()
    dataset = json.loads((MANIFEST_ROOT / "cases.json").read_text(encoding="utf-8"))
    repositories = {item["name"]: item for item in manifest["repositories"]}
    # Validate all splits before running, but never tune or remove holdout failures.
    for case in dataset["cases"]:
        repo = repositories[case["repository"]]
        case["split"] = repo["split"]
        case["source_commit"] = repo["commit"]
        root = corpus / "repos" / case["repository"]
        case["expected_evidence"] = [resolve_reference(root, ref) for ref in case["expected_evidence"]]
        if case.get("absent_target"):
            for path in root.rglob("*"):
                if path.is_file() and case["absent_target"].casefold() in path.read_text(encoding="utf-8").casefold():
                    raise ValueError(f"Supposedly absent target exists: {case['id']}")
    validate_annotations(dataset, corpus / "repos")
    dataset["cases"] = [case for case in dataset["cases"] if split == "all" or case["split"] == split]
    dataset["source_hashes"] = source_hashes(corpus / "repos")
    dataset["source_urls"] = {name: f"https://github.com/{repo['github']}/tree/{repo['commit']}"
                              for name, repo in repositories.items()}
    dataset["repositories"] = manifest["repositories"]
    return dataset


def render_comparison(reports: list[dict]) -> str:
    lines = ["# 真实仓库证据检索对照", "",
             "固定版本公开源码，未执行仓库代码。引用合法不等于回答正确。",
             "题目由维护者标注，尚未独立人工复核。BM25 组沿用项目已有分块、查询扩展和搜索排序，并非原始 BM25 算法。",
             "各组共用意图路由、目标守卫、去重与引用校验，最多 8 条证据，每条最多 1600 字符。", "",
             "| 组别 | 数据划分 | 通过 | Recall@5 | MRR | 无证据拦截 | 非法引用 | P50/P95 ms |",
             "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for report in reports:
        for split in sorted({row["split"] for row in report["results"]}):
            summary = summarize([row for row in report["results"] if row["split"] == split])
            lines.append(f"| {report['retrieval_mode']} | {split} | {summary['retrieval_passed']}/{summary['cases']} | "
                         f"{summary['mean_evidence_recall_at_5']} | {summary['mean_reciprocal_rank']} | "
                         f"{summary['insufficient_correct']}/{summary['insufficient_cases']} | {summary['invalid_citations']} | "
                         f"{summary['elapsed_p50_ms']}/{summary['elapsed_p95_ms']} |")
    lines.extend(["", "耗时为单次顺序实验，不含导入、嵌入模型加载和索引建立。不能据此宣称稳定的性能优势。",
                  "structured 为不启用语义模型的现有结构检索；hybrid 使用词法与语义候选的 RRF 融合；",
                  "hybrid-rerank 使用现有结构候选扩充、稠密相似度和规则重排，是组合消融而非单因素实验。",
                  "离线模式不测生成回答、模型 token 或费用；模型模式需要逐题人工复核。", ""])
    if any(not report.get("suite_implementation_unchanged", True) for report in reports):
        lines.extend(["**实现或题库在本轮对照期间发生变化（包括组间变化），各组不可作为同一固定实现直接对比。**",
                      "检索分数未修改，仅保留供诊断；请冻结输入后重新运行。", ""])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--split", choices=["development", "validation", "holdout", "all"], default="development")
    parser.add_argument("--modes", nargs="+", choices=MODES, default=["bm25", "structured"])
    parser.add_argument("--embedding-model-dir", type=Path, help="Existing local BGE model; never downloaded")
    parser.add_argument("--provider")
    parser.add_argument("--provider-config", type=Path)
    parser.add_argument("--allow-model-calls", action="store_true")
    parser.add_argument("--generated-history", action="store_true", help="Use preceding real answers for linked follow-up cases")
    parser.add_argument("--case", action="append", dest="case_ids")
    args = parser.parse_args()
    if args.provider and not (args.allow_model_calls and args.provider_config and args.provider_config.is_file()):
        parser.error("Generation requires explicit --allow-model-calls and --provider-config; public source evidence will be sent")
    if not args.provider and (args.allow_model_calls or args.provider_config or args.generated_history):
        parser.error("Select a provider before enabling generation or generated conversation history")
    if any(mode.startswith("hybrid") for mode in args.modes) and not args.embedding_model_dir:
        parser.error("Hybrid experiments require --embedding-model-dir; silent fallback is prohibited")
    try:
        suite_hashes = implementation_source_hashes()
        suite_changes: set[str] = set()
        corpus = prepare_corpus()  # verification only; no network
        dataset = load_real_dataset(corpus, split=args.split)
        if args.case_ids:
            known = {case["id"] for case in dataset["cases"]}
            if set(args.case_ids) - known:
                parser.error("Unknown case ID in the selected split")
            dataset["cases"] = [case for case in dataset["cases"] if case["id"] in args.case_ids]
        if args.generated_history:
            selected = {case["id"] for case in dataset["cases"]}
            if any(case.get("follow_up_to") not in selected for case in dataset["cases"] if case.get("follow_up_to")):
                parser.error("Generated follow-up evaluation must include preceding cases")
        parent = ROOT / "data" / "tmp" / "qa-real-runs"
        parent.mkdir(parents=True, exist_ok=True)
        run_root = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
        print(f"Results: {run_root}", flush=True)
        reports = []
        for mode in dict.fromkeys(args.modes):
            print(f"Running {mode}: {len(dataset['cases'])} cases ({args.split})", flush=True)
            report = run_evaluation(
                run_root / mode, dataset, dataset_root=corpus, retrieval_mode=mode,
                embedding_model_dir=args.embedding_model_dir if mode.startswith("hybrid") else None,
                provider=args.provider, provider_config=args.provider_config,
                generated_history=args.generated_history,
            )
            report["repositories"] = dataset["repositories"]
            report["annotation_status"] = dataset["annotation_status"]
            suite_changes.update(changed_implementation_paths(suite_hashes, report["implementation_hashes"]))
            suite_changes.update(changed_implementation_paths(suite_hashes, implementation_source_hashes()))
            suite_changes.update(report["implementation_changed_paths"])
            reports.append(report)
            # Preserve each group's starting hashes, and make suite drift sticky
            # even when every group was internally stable or a file was restored.
            for saved in reports:
                saved["suite_implementation_hashes"] = suite_hashes
                saved["suite_implementation_unchanged"] = not suite_changes and all(
                    item["implementation_unchanged_during_run"] for item in reports
                )
                saved["suite_implementation_changed_paths"] = sorted(suite_changes)
                (run_root / saved["retrieval_mode"] / "result.json").write_text(
                    json.dumps(saved, ensure_ascii=False, indent=2), encoding="utf-8",
                )
            # Save after every group so an interrupted later group cannot erase completed measurements.
            (run_root / "comparison.md").write_text(render_comparison(reports), encoding="utf-8")
            print(json.dumps(report["summary"], ensure_ascii=False), flush=True)
        print(f"Comparison: {run_root / 'comparison.md'}")
        if any(not report["suite_implementation_unchanged"] for report in reports):
            print("Implementation drift detected during/between groups; comparison is invalid. Freeze inputs and rerun.")
            return 3
        return int(any(report["summary"]["failed_ids"] or report["summary"]["model_errors"]
                       or report["summary"]["reference_failed_cases"] for report in reports))
    except (ValueError, OSError) as error:
        parser.error(str(error))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
