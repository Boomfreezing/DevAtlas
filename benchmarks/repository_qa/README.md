# Repository QA regression corpus

Three synthetic, non-deployable source fixtures and 36 annotated questions for DevAtlas's existing repository QA retrieval pipeline. These fixtures are authored for evaluation, not copied from private projects or downloaded repositories. They contain no real credentials.

Run from `backend` with `python -m evaluations.repository_qa`. No web server, API key, generation provider or embedding download is required. Results and temporary indexes stay under the project's `data/tmp/qa-eval` directory.

See [the evaluation guide](../../docs/QA_EVALUATION.md) for metrics, limitations, baseline results and opt-in model evaluation.

- `cases.json`: independently inspectable expected paths, line ranges, literal anchors and answer facts. Annotations still need independent human review.
- `sources.json`: SHA-256 lock of fixture files with canonical LF newlines. Review this lock and annotations together when changing sources.
- `repos/`: Python and TypeScript source examples. Never execute fixture code as part of evaluation.
- `phase1-comparison.json`: measured retrieval baseline and optimized results. This is a development/regression set, not a held-out accuracy benchmark.

Do not add real keys, secrets or personal repositories here. Default evaluation measures retrieval and evidence routing only; it does not measure generated answer correctness.
