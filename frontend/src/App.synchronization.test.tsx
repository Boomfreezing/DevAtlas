// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import App from "./App";
import type { AnalysisJob } from "./types";

const timestamp = "2026-09-12T00:00:00Z";
const projects = [1, 2].map((id) => ({ id, name: `sync-repo-${id}`, source_filename: `github.com/example/sync-repo-${id}`,
  status: "ready", primary_language: "Python", file_count: 1, code_line_count: 100,
  created_at: timestamp, updated_at: timestamp }));
const structure = { symbol_count: 1, class_count: 0, function_count: 1, import_count: 1, resolved_import_count: 0, issue_count: 1 };
const gitSummary = { available: false, refreshable: true, recent_commits: [], message: "fixture" };

function syncJob(status: AnalysisJob["status"], projectId = 1, stage: string = status): AnalysisJob {
  return { id: `sync-${projectId}`, project_id: projectId, source_type: "github_sync", source_label: "fixture",
    status, stage, progress: status === "completed" ? 100 : 30, message: status === "completed" ? "远程同步已完成" : "正在检查远端",
    error: status === "failed" ? "同步失败，原有分析仍保留" : null, created_at: timestamp, updated_at: timestamp,
    completed_at: status === "completed" ? timestamp : null };
}

function qualityReport(projectId: number, version: string) {
  const size = { file_count: 1, code_line_count: 100, symbol_count: 1 };
  const counts = { error: 0, warning: 1, info: 0 };
  return { score: 90, grade: "A", score_scope: "composite", total_findings: 1,
    scoring: { coverage_level: "high", coverage_message: "fixture" },
    scope_scores: Object.fromEntries(["production", "test", "generated"].map((scope) => [scope, {
      scope, label: scope, score: scope === "production" ? 90 : null, grade: scope === "production" ? "A" : null,
      available: scope === "production", configured_weight: 1, effective_weight: scope === "production" ? 1 : 0,
      exclusion_reason: null, finding_count: scope === "production" ? 1 : 0, severity_counts: counts, project_size: size,
    }])),
    severity_counts: counts, rule_counts: { LONG_FUNCTION: 1 },
    rules: [{ id: "LONG_FUNCTION", title: "超长函数", description: "fixture", default_severity: "warning" }],
    findings: [{ id: `${projectId}:${version}`, rule_id: "LONG_FUNCTION", severity: "warning", scope: "production",
      title: `quality-${projectId}-${version}`, description: "fixture", suggestion: "验证修改", file_id: 1,
      file_path: `${version}.py`, start_line: 1, end_line: 100, metric: 100, threshold: 80 }],
    offset: 0, limit: 100, filtered_findings: 1, has_more: false, truncated: false, elapsed_ms: 1 };
}

function graph(version: string) {
  return { total_node_count: 1, total_edge_count: 0, internal_import_count: 0, external_import_count: 0,
    unresolved_import_count: 0, classified_import_count: 0, classification_confidence: 1, confidence_level: "high",
    cycle_count: 0, truncated: false, cycles: [], edges: [],
    nodes: [{ id: 1, path: `${version}.py`, language: "Python", in_degree: 0, out_degree: 0 }] };
}

type Interceptor = (url: URL, options?: RequestInit) => Promise<Response | undefined>;
function mockApi(intercept: Interceptor = async () => undefined) {
  let version = "before";
  const reads: URL[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    reads.push(url);
    const response = await intercept(url, options);
    if (response) return response;
    const id = Number(url.pathname.match(/\/projects\/(\d+)/)?.[1] ?? 1);
    if (url.pathname === "/api/projects") return Response.json(projects);
    if (/\/projects\/[12]$/.test(url.pathname)) return Response.json(projects[id - 1]);
    if (url.pathname.endsWith("/structure/summary")) return Response.json(structure);
    if (url.pathname.endsWith("/quality")) return Response.json(qualityReport(id, version));
    if (url.pathname.endsWith("/dependency-graph")) return Response.json(graph(version));
    if (url.pathname.endsWith("/files/tree")) return Response.json({ path: "", total_files: 1,
      items: [{ id: 1, kind: "file", path: `${version}.py`, name: `${version}.py`, file_count: 1, line_count: 100, size_bytes: 100, language: "Python" }] });
    if (url.pathname.endsWith("/symbols")) return Response.json({ total: 1, offset: 0, limit: 200, has_more: false,
      items: [{ id: 1, file_id: 1, name: `symbol_${version}`, qualified_name: `symbol_${version}`, kind: "function", start_line: 1, end_line: 2, file_path: `${version}.py` }] });
    if (url.pathname.endsWith("/imports")) return Response.json({ total: 1, offset: 0, limit: 200, has_more: false,
      items: [{ id: 1, file_id: 1, resolved_file_id: null, source_path: `${version}.py`, target_module: `import_${version}`, line_number: 1 }] });
    if (url.pathname.endsWith("/issues")) return Response.json({ total: 1, offset: 0, limit: 200, has_more: false,
      items: [{ id: 1, file_id: 1, file_path: `${version}.py`, message: `issue_${version}` }] });
    if (url.pathname.endsWith("/report")) return Response.json({ project_id: id, generator: "local", mode: "summary", generated_at: timestamp, filename: "report.md", content: `report-${id}-${version}` });
    if (url.pathname.endsWith("/search")) return Response.json({ query: url.searchParams.get("q"), total_matches: 1,
      indexed_chunks: 1, offset: 0, limit: 10, has_more: false, elapsed_ms: 1,
      results: [{ chunk_id: 1, file_id: 1, file_path: `search_${version}.py`, symbol_name: null, kind: "file",
        start_line: 1, end_line: 1, snippet_start_line: 1, snippet_end_line: 1, snippet: `search_${version}`, score: 1 }] });
    if (url.pathname.endsWith("/git-summary")) return Response.json(gitSummary);
    if (url.pathname.endsWith("/report-generators")) return Response.json([{ id: "local", name: "本地规则分析", available: true,
      configured: true, description: "fixture", base_url: "", model: "" }]);
    if (url.pathname.endsWith("/import-limits")) return Response.json({ max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 });
    return Response.json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { reads, fetchMock, update: () => { version = "after"; }, count: (suffix: string, projectId = 1) =>
    reads.filter((url) => url.pathname.startsWith(`/api/projects/${projectId}/`) && url.pathname.endsWith(suffix)).length };
}

function navigate(label: string) { fireEvent.click(screen.getByRole("button", { name: new RegExp(label) })); }
async function startSync() {
  navigate("版本对比");
  const button = await screen.findByRole("button", { name: "同步远程仓库" });
  fireEvent.click(button);
  return button;
}
async function selectProject(id: number) {
  fireEvent.click(document.querySelector(".project-trigger")!);
  fireEvent.click(Array.from(document.querySelectorAll(".project-option"))
    .find((element) => element.textContent?.includes(`sync-repo-${id}`))!);
  await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe(`sync-repo-${id}`));
}
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/?section=quality&project=1");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps polling after leaving version comparison and refreshes cached quality on completion", async () => {
  let release!: (response: Response) => void;
  let signal!: AbortSignal;
  const api = mockApi(async (url, options) => {
    if (url.pathname.endsWith("/sync-github")) {
      expect(options?.method).toBe("POST");
      expect(options?.signal).toBeUndefined();
      return Response.json(syncJob("running"));
    }
    if (url.pathname.endsWith("/jobs/sync-1")) {
      signal = options!.signal!;
      return new Promise<Response>((resolve) => { release = resolve; });
    }
  });
  render(<App />);
  await screen.findByText("quality-1-before");
  const button = await startSync();
  fireEvent.click(button); // A disabled/double click must never submit a second write.
  navigate("质量检测");
  expect(screen.getByText("quality-1-before")).toBeTruthy();
  await waitFor(() => expect(release).toBeDefined(), { timeout: 2_000 });
  expect(signal.aborted).toBe(false);
  await act(async () => { api.update(); release(Response.json(syncJob("completed"))); });
  await screen.findByText("quality-1-after");
  expect(api.count("/sync-github")).toBe(1);
  expect(api.count("/quality")).toBe(2);
  expect(screen.queryByText("quality-1-before")).toBeNull();
  navigate("版本对比");
  await screen.findByText(/\[OK\] 远程同步已完成/);
  expect(api.count("/git-summary")).toBeGreaterThanOrEqual(2);
  expect(api.count("/snapshots")).toBeGreaterThanOrEqual(2);
});

it("finishes a background project's sync without replacing the selected project's quality or caching stale structure", async () => {
  let release!: (response: Response) => void;
  const api = mockApi(async (url) => {
    if (url.pathname.endsWith("/sync-github")) return Response.json(syncJob("running"));
    if (url.pathname.endsWith("/jobs/sync-1")) return new Promise<Response>((resolve) => { release = resolve; });
  });
  render(<App />);
  await screen.findByText("quality-1-before");
  await startSync();
  await selectProject(2);
  navigate("质量检测");
  await screen.findByText("quality-2-before");
  const secondReads = api.count("/quality", 2);
  await waitFor(() => expect(release).toBeDefined(), { timeout: 2_000 });
  await act(async () => { api.update(); release(Response.json(syncJob("completed"))); });
  await waitFor(() => expect(api.reads.filter((url) => url.pathname === "/api/projects")).toHaveLength(2));
  expect(screen.getByText("quality-2-before")).toBeTruthy();
  expect(api.count("/quality", 2)).toBe(secondReads);
  expect(screen.queryByText("quality-1-after")).toBeNull();
  await selectProject(1);
  await screen.findByText("quality-1-after");
  expect(api.count("/structure/summary", 1)).toBe(2);
  expect(document.querySelector(".workspace-error")).toBeNull();
});

it.each(["failed", "up_to_date"])("preserves indexed quality when synchronization returns %s", async (outcome) => {
  const api = mockApi(async (url) => {
    if (url.pathname.endsWith("/sync-github")) return Response.json(syncJob("running"));
    if (url.pathname.endsWith("/jobs/sync-1")) return Response.json(syncJob(outcome === "failed" ? "failed" : "completed", 1, outcome));
  });
  render(<App />);
  await screen.findByText("quality-1-before");
  await startSync();
  navigate("质量检测");
  await waitFor(() => expect(api.reads.some((url) => url.pathname.endsWith("/jobs/sync-1"))).toBe(true), { timeout: 2_000 });
  navigate("版本对比");
  await screen.findByText(outcome === "failed" ? /同步失败，原有分析仍保留/ : /\[OK\] 远程同步已完成/);
  navigate("质量检测");
  expect(screen.getByText("quality-1-before")).toBeTruthy();
  expect(api.count("/quality")).toBe(1);
  expect(api.count("/structure/summary")).toBe(1);
  expect(api.count("/sync-github")).toBe(1);
  expect(document.querySelector(".workspace-error")).toBeNull();
});

it.each(["files", "symbols", "imports", "issues", "graph", "report", "search"])("invalidates the existing %s index view when a sync finishes on that page", async (view) => {
  let release!: (response: Response) => void;
  const api = mockApi(async (url) => {
    if (url.pathname.endsWith("/sync-github")) return Response.json(syncJob("running"));
    if (url.pathname.endsWith("/jobs/sync-1")) return new Promise<Response>((resolve) => { release = resolve; });
  });
  render(<App />);
  await screen.findByText("quality-1-before");
  async function openView(version: string) {
    if (["files", "symbols", "imports", "issues"].includes(view)) {
      navigate("仓库概览");
      const labels: Record<string, string> = { files: "文件", symbols: "符号", imports: "依赖", issues: "问题" };
      fireEvent.click(Array.from(document.querySelectorAll(".inspector-tabs button"))
        .find((button) => button.textContent?.startsWith(labels[view]))!);
      await waitFor(() => expect(document.querySelector(view === "files" ? ".file-tree" : ".structure-list")?.textContent).toContain(`${version}.py`));
    } else if (view === "graph") {
      navigate("依赖图谱");
      await screen.findByRole("button", { name: `选择模块 ${version}.py` });
    } else if (view === "report") {
      navigate("分析报告");
      await screen.findByText(`report-1-${version}`);
    } else {
      navigate("代码搜索");
      fireEvent.change(screen.getByRole("textbox", { name: "代码搜索关键词" }), { target: { value: "target" } });
      fireEvent.click(screen.getByRole("button", { name: /^搜索$/ }));
      await screen.findByText(`search_${version}.py`);
    }
  }
  await openView("before");
  await startSync();
  await openView("before");
  await waitFor(() => expect(release).toBeDefined(), { timeout: 2_000 });
  await act(async () => { api.update(); release(Response.json(syncJob("completed"))); });
  if (view === "search") {
    await waitFor(() => expect(screen.queryByText("search_before.py")).toBeNull());
    expect(screen.getByRole("textbox", { name: "代码搜索关键词" })).toHaveProperty("value", "target");
  }
  await openView("after");
  expect(api.count("/sync-github")).toBe(1);
  expect(document.querySelector(".workspace-error")).toBeNull();
});

it("fences a report response started before synchronization even when it resolves after the refresh", async () => {
  let releaseJob!: (response: Response) => void;
  let releaseReport!: (response: Response) => void;
  let reportReads = 0;
  const api = mockApi(async (url) => {
    if (url.pathname.endsWith("/sync-github")) return Response.json(syncJob("running"));
    if (url.pathname.endsWith("/jobs/sync-1")) return new Promise<Response>((resolve) => { releaseJob = resolve; });
    if (url.pathname.endsWith("/report") && ++reportReads === 1) return new Promise<Response>((resolve) => { releaseReport = resolve; });
  });
  render(<App />);
  await screen.findByText("quality-1-before");
  await startSync();
  navigate("分析报告");
  await waitFor(() => expect(releaseReport).toBeDefined());
  await waitFor(() => expect(releaseJob).toBeDefined(), { timeout: 2_000 });
  await act(async () => { api.update(); releaseJob(Response.json(syncJob("completed"))); });
  await waitFor(() => expect(api.count("/structure/summary")).toBe(2));
  navigate("分析报告");
  await screen.findByText("report-1-after");
  await act(async () => releaseReport(Response.json({ project_id: 1, generator: "local", mode: "summary",
    generated_at: timestamp, filename: "old.md", content: "stale-report-must-not-return" })));
  expect(screen.queryByText("stale-report-must-not-return")).toBeNull();
  expect(screen.getByText("report-1-after")).toBeTruthy();
});

it("clears the selected coupling object instead of reusing an old symbol identity after synchronization", async () => {
  let release!: (response: Response) => void;
  const target = { target_type: "symbol", target_id: 1, file_id: 1, file_path: "before.py", name: "symbol_before", kind: "function", start_line: 1, end_line: 2 };
  const api = mockApi(async (url) => {
    if (url.pathname.endsWith("/sync-github")) return Response.json(syncJob("running"));
    if (url.pathname.endsWith("/jobs/sync-1")) return new Promise<Response>((resolve) => { release = resolve; });
    if (url.pathname.endsWith("/impact")) return Response.json({ target,
      definition: { ...target, relation: "definition", symbol_name: target.name, line_numbers: [1], symbol_id: 1, symbol_kind: "function", confidence: "high", depth: 0 },
      risk: { level: "low", score: 18, confidence: "medium", reasons: [] }, direct_callers: [], called_objects: [],
      indirect_impacts: [], related_tests: [], related_apis: [], database_entities: [], cycles: [], limitations: "fixture" });
  });
  render(<App />);
  await screen.findByText("quality-1-before");
  navigate("仓库概览");
  fireEvent.click(Array.from(document.querySelectorAll(".inspector-tabs button"))
    .find((button) => button.textContent?.startsWith("符号"))!);
  fireEvent.click(await screen.findByRole("button", { name: "影响" }));
  await screen.findByRole("heading", { name: "symbol_before" });
  await startSync();
  navigate("耦合分析");
  await screen.findByRole("heading", { name: "symbol_before" });
  await waitFor(() => expect(release).toBeDefined(), { timeout: 2_000 });
  await act(async () => { api.update(); release(Response.json(syncJob("completed"))); });
  await waitFor(() => expect(document.querySelector(".impact-report")).toBeNull());
  expect(screen.getByLabelText(/选择要修改的文件、类或函数/)).toHaveProperty("value", "");
  expect(screen.queryByText("symbol_before")).toBeNull();
});

it("evicts old caches before a failed post-sync refresh and retries that refresh without another POST", async () => {
  let summaries = 0;
  const api = mockApi(async (url) => {
    if (url.pathname.endsWith("/sync-github")) return Response.json(syncJob("running"));
    if (url.pathname.endsWith("/jobs/sync-1")) { api.update(); return Response.json(syncJob("completed")); }
    if (url.pathname.endsWith("/structure/summary") && ++summaries === 2) {
      return Response.json({ detail: "summary refresh unavailable" }, { status: 503 });
    }
  });
  render(<App />);
  await screen.findByText("quality-1-before");
  await startSync();
  await screen.findByText(/同步已完成，但刷新分析数据失败/, {}, { timeout: 2_000 });
  navigate("质量检测");
  await screen.findByText("quality-1-after");
  expect(screen.queryByText("quality-1-before")).toBeNull();
  navigate("版本对比");
  const retry = await screen.findByRole("button", { name: "重试刷新" });
  fireEvent.click(retry);
  await screen.findByText(/\[OK\] 远程同步已完成/);
  expect(api.count("/sync-github")).toBe(1);
  expect(summaries).toBe(3);
});

it("ignores an initial structure response that returns after its project synchronized in the background", async () => {
  let releaseStructure!: (response: Response) => void;
  let releaseJob!: (response: Response) => void;
  let firstReads = 0;
  const api = mockApi(async (url) => {
    if (url.pathname === "/api/projects/1/structure/summary") {
      firstReads += 1;
      if (firstReads === 1) return new Promise<Response>((resolve) => { releaseStructure = resolve; });
      return Response.json({ ...structure, function_count: 999 });
    }
    if (url.pathname.endsWith("/sync-github")) return Response.json(syncJob("running"));
    if (url.pathname.endsWith("/jobs/sync-1")) return new Promise<Response>((resolve) => { releaseJob = resolve; });
  });
  render(<App />);
  await screen.findByText("quality-1-before");
  await startSync();
  await selectProject(2);
  await waitFor(() => expect(releaseJob).toBeDefined(), { timeout: 2_000 });
  await act(async () => { api.update(); releaseJob(Response.json(syncJob("completed"))); });
  await waitFor(() => expect(api.reads.filter((url) => url.pathname === "/api/projects")).toHaveLength(2));
  await selectProject(1);
  navigate("仓库概览");
  await waitFor(() => expect(document.querySelector(".analysis-strip")?.textContent).toContain("999"));
  await act(async () => releaseStructure(Response.json({ ...structure, function_count: 777 })));
  expect(document.querySelector(".analysis-strip")?.textContent).toContain("999");
  expect(document.querySelector(".analysis-strip")?.textContent).not.toContain("777");
  await selectProject(2);
  await selectProject(1);
  expect(firstReads).toBe(2); // The good post-sync cache, not the delayed old one, is reused.
  expect(document.querySelector(".analysis-strip")?.textContent).toContain("999");
});
