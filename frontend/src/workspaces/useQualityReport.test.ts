// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { QualityFinding, QualityReport } from "../types";
import { DEFAULT_QUALITY_FILTERS, type QualityFilters } from "./qualityReportModel";
import { useQualityReport } from "./useQualityReport";

const finding = (id: number, overrides: Partial<QualityFinding> = {}): QualityFinding => ({
  id: `LONG_FUNCTION:${id}`, rule_id: "LONG_FUNCTION", severity: "warning", scope: "production",
  title: `Long function ${id}`, description: "Function has too many lines.", suggestion: "Extract one responsibility.",
  file_id: id, file_path: `src/module-${id}.py`, start_line: 1, end_line: 100, metric: 100, threshold: 80,
  ...overrides,
});
const weights = { production: 0.7, test: 0.2, generated: 0.1 };
const scopeScore = (scope: "production" | "test" | "generated") => ({
  scope, label: scope === "production" ? "生产代码" : scope === "test" ? "测试代码" : "生成/外部代码",
  score: scope === "production" ? 88 : null, grade: scope === "production" ? "B" : null,
  available: scope === "production", configured_weight: weights[scope], effective_weight: scope === "production" ? 1 : 0,
  exclusion_reason: scope === "production" ? null : "未发现该范围代码。", finding_count: scope === "production" ? 4 : 0,
  severity_counts: { error: 0, warning: scope === "production" ? 4 : 0, info: 0 },
  project_size: { file_count: scope === "production" ? 4 : 0, code_line_count: scope === "production" ? 400 : 0, symbol_count: scope === "production" ? 4 : 0 },
});
const page = (ids = [1, 2], offset = 0, filtered = 4, overrides: Partial<QualityReport> = {}): QualityReport => ({
  score: 88, grade: "B", score_scope: "composite",
  scoring: {
    model: "composite_v3", size_factor: 1, scale_units: 1,
    project_size: { file_count: 4, code_line_count: 400, symbol_count: 4 },
    reference_size: { file_count: 50, code_line_count: 10_000, symbol_count: 500 },
    base_weights: { error: 8, warning: 3, info: 1 }, effective_weights: { error: 8, warning: 3, info: 1 },
    base_penalty: 12, adjusted_penalty: 12, rule_penalties: { LONG_FUNCTION: 12 },
    scope_weights: weights, effective_scope_weights: { production: 1, test: 0, generated: 0 }, excluded_scopes: ["test", "generated"],
    source_file_count: 4, parser_supported_file_count: 4, applicable_rule_count: 6, total_rule_count: 6,
    parser_coverage: 100, coverage_level: "high", coverage_message: "检测覆盖充分。", explanation: "按代码范围加权。",
  },
  scope_scores: { production: scopeScore("production"), test: scopeScore("test"), generated: scopeScore("generated") },
  total_findings: 4, severity_counts: { error: 0, warning: 4, info: 0 }, rule_counts: { LONG_FUNCTION: 4 },
  rules: [{ id: "LONG_FUNCTION", title: "超长函数", description: "函数或方法过长。", default_severity: "warning" }],
  findings: ids.map((id) => finding(id)), filtered_findings: filtered, limit: 100, offset,
  has_more: offset + ids.length < filtered, truncated: offset + ids.length < filtered, elapsed_ms: 1,
  ...overrides,
});

interface Context { projectId: number | null; active: boolean; revision: number; paused: boolean }
const initialContext: Context = { projectId: 1, active: true, revision: 0, paused: false };
const setup = (props: Partial<Context> = {}, strict = false) => renderHook(
  ({ projectId, active, revision, paused }: Context) => useQualityReport(projectId, active, revision, paused),
  { initialProps: { ...initialContext, ...props }, reactStrictMode: strict },
);
function api(handler: (url: URL, options?: RequestInit) => Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => handler(new URL(String(input), "http://localhost"), options));
  vi.stubGlobal("fetch", mock);
  return mock;
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((release) => { resolve = release; });
  return { promise, resolve };
}
const rowIds = (hook: ReturnType<typeof setup>) => hook.result.current.pages.flat().map((item) => item.id);
const severity = (value: string): QualityFilters => ({ ...DEFAULT_QUALITY_FILTERS, severity: value });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("only reads when a project is selected and the workspace is active and unpaused", async () => {
  const requests = api(async () => Response.json(page()));
  const hook = setup({ projectId: null });
  expect(requests).not.toHaveBeenCalled();
  hook.rerender({ ...initialContext, active: false });
  expect(requests).not.toHaveBeenCalled();
  hook.rerender({ ...initialContext, paused: true });
  expect(requests).not.toHaveBeenCalled();
  hook.rerender(initialContext);
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  expect(requests).toHaveBeenCalledTimes(1);
  expect(requests.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  expect(String(requests.mock.calls[0][0])).toContain("/projects/1/quality?limit=100&offset=0");
});

it.each(["success", "error"])("cancels the initial read on menu exit and rejects its late %s after returning", async (outcome) => {
  const old = deferred();
  let signal!: AbortSignal;
  let count = 0;
  api(async (_url, options) => {
    if (++count === 1) { signal = options!.signal!; return old.promise; }
    return Response.json(page([3, 4], 0, 2));
  });
  const hook = setup();
  expect(hook.result.current.loading).toBe(true);
  hook.rerender({ ...initialContext, active: false });
  expect(signal.aborted).toBe(true);
  expect(hook.result.current.loading).toBe(false);
  hook.rerender(initialContext);
  await waitFor(() => expect(rowIds(hook)).toEqual(["LONG_FUNCTION:3", "LONG_FUNCTION:4"]));
  await act(async () => { old.resolve(outcome === "success" ? Response.json(page()) : Response.json({ detail: "obsolete quality error" }, { status: 500 })); });
  expect(rowIds(hook)).toEqual(["LONG_FUNCTION:3", "LONG_FUNCTION:4"]);
  expect(hook.result.current.error).toBeNull();
});

it("resumes a cancelled pending filter on return without presenting the previous condition's rows", async () => {
  const old = deferred();
  let signal!: AbortSignal;
  let filteredReads = 0;
  api(async (url, options) => {
    if (!url.searchParams.has("severity")) return Response.json(page());
    if (++filteredReads === 1) { signal = options!.signal!; return old.promise; }
    return Response.json(page([7], 0, 1, { findings: [finding(7, { severity: "error" })] }));
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  const summary = hook.result.current.summary;
  act(() => hook.result.current.changeFilters(severity("error")));
  expect(hook.result.current.filters.severity).toBe("error");
  expect(hook.result.current.response).toBeNull();
  expect(rowIds(hook)).toEqual([]);
  expect(hook.result.current.summary).toBe(summary);
  hook.rerender({ ...initialContext, active: false });
  expect(signal.aborted).toBe(true);
  hook.rerender(initialContext);
  await waitFor(() => expect(rowIds(hook)).toEqual(["LONG_FUNCTION:7"]));
  await act(async () => { old.resolve(Response.json(page([8], 0, 1, { findings: [finding(8, { severity: "error" })] }))); });
  expect(rowIds(hook)).toEqual(["LONG_FUNCTION:7"]);
  expect(hook.result.current.filters.severity).toBe("error");
  expect(filteredReads).toBe(2);
});

it("keeps completed filtered pages and their next server cursor across menu switches", async () => {
  const requests: Array<{ scope: string | null; severity: string | null; rule: string | null; offset: number }> = [];
  api(async (url) => {
    const offset = Number(url.searchParams.get("offset"));
    requests.push({ scope: url.searchParams.get("scope"), severity: url.searchParams.get("severity"), rule: url.searchParams.get("rule"), offset });
    return Response.json(page(offset ? [3, 4] : [1, 2], offset));
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  const filters = { severity: "warning", rule: "LONG_FUNCTION", scope: "production" };
  act(() => hook.result.current.changeFilters(filters));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  const firstPage = hook.result.current.pages[0];
  hook.rerender({ ...initialContext, active: false });
  hook.rerender(initialContext);
  expect(requests).toHaveLength(2);
  expect(hook.result.current.filters).toEqual(filters);
  expect(hook.result.current.pages[0]).toBe(firstPage);
  await act(() => hook.result.current.loadMore());
  expect(requests.at(-1)).toEqual({ ...filters, offset: 2 });
  expect(rowIds(hook)).toEqual([1, 2, 3, 4].map((id) => `LONG_FUNCTION:${id}`));
  expect(hook.result.current.pages[0]).toBe(firstPage);
  expect(hook.result.current.count).toBe(4);
  expect(hook.result.current.response?.has_more).toBe(false);
});

it.each(["success", "error"])("a newer filter wins over an aborted filter's late %s", async (outcome) => {
  const old = deferred();
  let signal!: AbortSignal;
  api(async (url, options) => {
    if (url.searchParams.get("severity") === "error") { signal = options!.signal!; return old.promise; }
    return Response.json(page(url.searchParams.has("severity") ? [3, 4] : [1, 2], 0, 2));
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  act(() => hook.result.current.changeFilters(severity("error")));
  act(() => hook.result.current.changeFilters(severity("warning")));
  expect(signal.aborted).toBe(true);
  await waitFor(() => expect(rowIds(hook)).toEqual(["LONG_FUNCTION:3", "LONG_FUNCTION:4"]));
  await act(async () => { old.resolve(outcome === "success" ? Response.json(page([9], 0, 1, { findings: [finding(9, { severity: "error" })] })) : Response.json({ detail: "obsolete filter failure" }, { status: 500 })); });
  expect(hook.result.current.filters.severity).toBe("warning");
  expect(rowIds(hook)).toEqual(["LONG_FUNCTION:3", "LONG_FUNCTION:4"]);
  expect(hook.result.current.error).toBeNull();
});

it("keeps summary but removes obsolete rows on filter failure and retries the same condition", async () => {
  let fail = true;
  const requests = api(async (url) => !url.searchParams.has("severity") ? Response.json(page())
    : fail ? Response.json({ detail: "temporary filter failure" }, { status: 500 })
      : Response.json(page([], 0, 0)));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  const summary = hook.result.current.summary;
  act(() => hook.result.current.changeFilters(severity("error")));
  await waitFor(() => expect(hook.result.current.error?.retry).toBe("first"));
  expect(hook.result.current.summary).toBe(summary);
  expect(hook.result.current.response).toBeNull();
  expect(rowIds(hook)).toEqual([]);
  await act(() => hook.result.current.loadMore());
  expect(requests).toHaveBeenCalledTimes(2);
  fail = false;
  act(() => hook.result.current.retry());
  await waitFor(() => expect(hook.result.current.response?.filtered_findings).toBe(0));
  expect(hook.result.current.filters.severity).toBe("error");
  expect(hook.result.current.error).toBeNull();
  expect(String(requests.mock.calls.at(-1)![0])).toContain("offset=0&severity=error");
});

it("retains completed pages after a page failure and retries precisely the failed offset", async () => {
  const offsets: number[] = [];
  api(async (url) => {
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    if (offset && offsets.length === 2) return Response.json({ detail: "temporary page failure" }, { status: 500 });
    return Response.json(page(offset ? [3, 4] : [1, 2], offset));
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  const firstPage = hook.result.current.pages[0];
  await act(() => hook.result.current.loadMore());
  expect(hook.result.current.error?.retry).toBe("more");
  expect(hook.result.current.pages[0]).toBe(firstPage);
  expect(hook.result.current.count).toBe(2);
  act(() => hook.result.current.retry());
  await waitFor(() => expect(hook.result.current.count).toBe(4));
  expect(offsets).toEqual([0, 2, 2]);
  expect(hook.result.current.pages[0]).toBe(firstPage);
  expect(hook.result.current.error).toBeNull();
});

it("cancels a pending next page on exit while preserving completed pages without silently resuming pagination", async () => {
  const more = deferred();
  let signal!: AbortSignal;
  const requests = api(async (url, options) => {
    if (url.searchParams.get("offset") === "0") return Response.json(page());
    signal = options!.signal!;
    return more.promise;
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  act(() => { void hook.result.current.loadMore(); });
  hook.rerender({ ...initialContext, active: false });
  expect(signal.aborted).toBe(true);
  hook.rerender(initialContext);
  await act(async () => { more.resolve(Response.json(page([3, 4], 2))); });
  expect(hook.result.current.count).toBe(2);
  expect(hook.result.current.loadingMore).toBe(false);
  expect(requests).toHaveBeenCalledTimes(2);
});

it("guards double clicks synchronously for initial retries and pagination", async () => {
  const first = deferred();
  const more = deferred();
  const requests = api(async (url) => url.searchParams.get("offset") === "0" ? first.promise : more.promise);
  const hook = setup();
  act(() => { hook.result.current.retry(); hook.result.current.retry(); void hook.result.current.loadMore(); });
  expect(requests).toHaveBeenCalledTimes(1);
  await act(async () => { first.resolve(Response.json(page())); });
  act(() => { void hook.result.current.loadMore(); void hook.result.current.loadMore(); hook.result.current.retry(); });
  expect(requests).toHaveBeenCalledTimes(2);
  await act(async () => { more.resolve(Response.json(page([3, 4], 2))); });
  expect(rowIds(hook)).toHaveLength(4);
});

it.each([
  { label: "project", next: { ...initialContext, projectId: 2 } },
  { label: "revision", next: { ...initialContext, revision: 1 } },
])("invalidates old pages and filters immediately on $label changes and ignores late completion", async ({ next }) => {
  const stale = deferred();
  let signal!: AbortSignal;
  let filteredReads = 0;
  api(async (url, options) => {
    if (url.searchParams.has("severity") && ++filteredReads === 1) { signal = options!.signal!; return stale.promise; }
    return Response.json(page(url.pathname.includes("/2/") || filteredReads ? [3, 4] : [1, 2], 0, 2));
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  act(() => hook.result.current.changeFilters(severity("error")));
  hook.rerender(next);
  expect(signal.aborted).toBe(true);
  expect(hook.result.current.filters).toEqual(DEFAULT_QUALITY_FILTERS);
  expect(hook.result.current.summary).toBeNull();
  await waitFor(() => expect(rowIds(hook)).toEqual(["LONG_FUNCTION:3", "LONG_FUNCTION:4"]));
  await act(async () => { stale.resolve(Response.json({ detail: "obsolete index error" }, { status: 500 })); });
  expect(hook.result.current.error).toBeNull();
  expect(rowIds(hook)).toEqual(["LONG_FUNCTION:3", "LONG_FUNCTION:4"]);
});

it("pauses reads during analysis, rejects old success, and reads the new revision only after resume", async () => {
  const old = deferred();
  let signal!: AbortSignal;
  let reads = 0;
  api(async (_url, options) => {
    if (++reads === 1) { signal = options!.signal!; return old.promise; }
    return Response.json(page([3, 4], 0, 2));
  });
  const hook = setup();
  hook.rerender({ ...initialContext, paused: true });
  expect(signal.aborted).toBe(true);
  await act(async () => { old.resolve(Response.json(page())); });
  expect(hook.result.current.response).toBeNull();
  hook.rerender({ ...initialContext, revision: 1, paused: true });
  expect(reads).toBe(1);
  hook.rerender({ ...initialContext, revision: 1 });
  await waitFor(() => expect(rowIds(hook)).toEqual(["LONG_FUNCTION:3", "LONG_FUNCTION:4"]));
  expect(reads).toBe(2);
});

it("invalidates an existing report before full analysis and reloads only after pause ends", async () => {
  const requests = api(async () => Response.json(page()));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  act(() => hook.result.current.invalidate());
  hook.rerender({ ...initialContext, paused: true });
  expect(hook.result.current.summary).toBeNull();
  expect(hook.result.current.response).toBeNull();
  expect(requests).toHaveBeenCalledTimes(1);
  hook.rerender(initialContext);
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  expect(requests).toHaveBeenCalledTimes(2);
});

it("survives StrictMode effect replay and cancels the live read on unmount", async () => {
  const pending: Array<{ signal: AbortSignal; request: ReturnType<typeof deferred> }> = [];
  api(async (_url, options) => {
    const request = deferred();
    pending.push({ signal: options!.signal!, request });
    return request.promise;
  });
  const hook = setup({}, true);
  expect(pending).toHaveLength(2);
  expect(pending[0].signal.aborted).toBe(true);
  expect(pending[1].signal.aborted).toBe(false);
  await act(async () => { pending[0].request.resolve(Response.json(page([8], 0, 1))); });
  expect(hook.result.current.response).toBeNull();
  expect(hook.result.current.loading).toBe(true);
  hook.unmount();
  expect(pending[1].signal.aborted).toBe(true);
  await act(async () => { pending[1].request.resolve(Response.json(page())); });
});

it.each([
  { name: "score changed", mutate: (value: QualityReport) => ({ ...value, score: 72 }) },
  { name: "coverage changed", mutate: (value: QualityReport) => ({ ...value, scoring: { ...value.scoring, parser_supported_file_count: 2 } }) },
  { name: "scope scoring changed", mutate: (value: QualityReport) => ({ ...value, scope_scores: { ...value.scope_scores, production: { ...value.scope_scores.production, score: 72 } } }) },
  { name: "total changed", mutate: (value: QualityReport) => ({ ...value, total_findings: 8 }) },
  { name: "filtered total changed", mutate: (value: QualityReport) => ({ ...value, filtered_findings: 5, has_more: true, truncated: true }) },
  { name: "wrong offset", mutate: (value: QualityReport) => ({ ...value, offset: 0 }) },
  { name: "wrong limit", mutate: (value: QualityReport) => ({ ...value, limit: 2 }) },
  { name: "repeated previous row", mutate: (value: QualityReport) => ({ ...value, findings: [finding(2), finding(3)] }) },
  { name: "duplicate within page", mutate: (value: QualityReport) => ({ ...value, findings: [finding(3), finding(3)] }) },
  { name: "empty nonterminal page", mutate: (value: QualityReport) => ({ ...value, findings: [], has_more: true, truncated: true }) },
  { name: "premature terminal page", mutate: (value: QualityReport) => ({ ...value, findings: [finding(3)], has_more: false, truncated: false }) },
])("rejects $name without merging rows and requires a fresh first-page retry", async ({ mutate }) => {
  let initialReads = 0;
  const offsets: number[] = [];
  api(async (url) => {
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    if (offset) return Response.json(mutate(page([3, 4], 2)));
    initialReads += 1;
    return Response.json(page(initialReads > 1 ? [7, 8] : [1, 2]));
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  const firstPage = hook.result.current.pages[0];
  await act(() => hook.result.current.loadMore());
  expect(hook.result.current.pages).toHaveLength(1);
  expect(hook.result.current.pages[0]).toBe(firstPage);
  expect(hook.result.current.count).toBe(2);
  expect(hook.result.current.error?.retry).toBe("first");
  expect(hook.result.current.error?.message).toContain("重新读取当前筛选");
  await act(() => hook.result.current.loadMore());
  expect(offsets).toEqual([0, 2]);
  act(() => hook.result.current.retry());
  await waitFor(() => expect(rowIds(hook)).toEqual(["LONG_FUNCTION:7", "LONG_FUNCTION:8"]));
  expect(offsets).toEqual([0, 2, 0]);
  expect(hook.result.current.error).toBeNull();
});

it.each([
  { name: "severity", filters: severity("error") },
  { name: "rule", filters: { ...DEFAULT_QUALITY_FILTERS, rule: "CIRCULAR_DEPENDENCY" } },
  { name: "scope", filters: { ...DEFAULT_QUALITY_FILTERS, scope: "test" } },
])("rejects rows that do not match the requested $name", async ({ filters }) => {
  api(async () => Response.json(page()));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  act(() => hook.result.current.changeFilters(filters));
  await waitFor(() => expect(hook.result.current.error?.retry).toBe("first"));
  expect(hook.result.current.filters).toEqual(filters);
  expect(hook.result.current.response).toBeNull();
  expect(rowIds(hook)).toEqual([]);
});

it("allows elapsed-time changes between pages without changing the summary or earlier page references", async () => {
  api(async (url) => {
    const offset = Number(url.searchParams.get("offset"));
    return Response.json(page(offset ? [3, 4] : [1, 2], offset, 4, { elapsed_ms: offset ? 19.7 : 1 }));
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.count).toBe(2));
  const summary = hook.result.current.summary;
  const firstPage = hook.result.current.pages[0];
  await act(() => hook.result.current.loadMore());
  expect(hook.result.current.count).toBe(4);
  expect(hook.result.current.summary).toBe(summary);
  expect(hook.result.current.pages[0]).toBe(firstPage);
  expect(hook.result.current.response?.elapsed_ms).toBe(19.7);
  expect(hook.result.current.error).toBeNull();
});

it("preserves insufficient-coverage metadata and unavailable scopes instead of inventing a perfect score", async () => {
  const report = page([], 0, 0, { total_findings: 0,
    scoring: { ...page().scoring, coverage_level: "limited", applicable_rule_count: 1, parser_supported_file_count: 0, parser_coverage: 0, coverage_message: "检测覆盖不足，暂不评级。" },
  });
  api(async () => Response.json(report));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.response).not.toBeNull());
  expect(hook.result.current.summary).toEqual(report);
  expect(hook.result.current.summary?.scoring.coverage_level).toBe("limited");
  expect(hook.result.current.summary?.scope_scores.test.score).toBeNull();
  expect(hook.result.current.summary?.scope_scores.test.exclusion_reason).toBe("未发现该范围代码。");
  expect(hook.result.current.count).toBe(0);
  expect(hook.result.current.error).toBeNull();
});

it("distinguishes an initial failure from an empty valid report and waits for explicit retry", async () => {
  let fail = true;
  const requests = api(async () => fail ? Response.json({ detail: "quality service unavailable" }, { status: 503 }) : Response.json(page([], 0, 0)));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.error?.retry).toBe("first"));
  expect(hook.result.current.summary).toBeNull();
  expect(hook.result.current.response).toBeNull();
  hook.rerender({ ...initialContext, active: false });
  hook.rerender(initialContext);
  expect(requests).toHaveBeenCalledTimes(1);
  fail = false;
  act(() => hook.result.current.retry());
  await waitFor(() => expect(hook.result.current.response?.filtered_findings).toBe(0));
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.response?.has_more).toBe(false);
});
