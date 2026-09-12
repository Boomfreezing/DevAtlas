// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import App from "./App";

const timestamp = "2026-09-12T00:00:00Z";
const projects = [1, 2].map((id) => ({ id, name: `repo-${id}`, source_filename: `repo-${id}/`, status: "ready", primary_language: "Python", file_count: 1, code_line_count: 10, created_at: timestamp, updated_at: timestamp }));
const summary = { symbol_count: 1, class_count: 0, function_count: 1, import_count: 0, resolved_import_count: 0, issue_count: 0 };
const graphFixture = (path: string) => ({ total_node_count: 1, total_edge_count: 0, internal_import_count: 0,
  external_import_count: 0, cycle_count: 0, truncated: false, cycles: [], edges: [],
  nodes: [{ id: 1, path, language: "Python", in_degree: 0, out_degree: 0 }] });

function mockApi(handler: (url: URL, options?: RequestInit) => Promise<Response | undefined>) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const response = await handler(url, options);
    if (response) return response;
    if (url.pathname === "/api/projects") return Response.json(projects);
    if (/\/projects\/[12]$/.test(url.pathname)) return Response.json(projects[Number(url.pathname.at(-1)) - 1]);
    if (url.pathname.endsWith("/structure/summary")) return Response.json(summary);
    if (url.pathname.endsWith("/files/tree")) return Response.json({ path: "", items: [], total_files: 1 });
    if (url.pathname.endsWith("/report-generators")) return Response.json([{ id: "local", name: "本地规则分析", available: true, configured: true, description: "fixture", base_url: "", model: "" }]);
    if (url.pathname.endsWith("/import-limits")) return Response.json({ max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 });
    return Response.json([]);
  }));
}

async function selectSecondProject() {
  fireEvent.click(document.querySelector(".project-trigger")!);
  fireEvent.click(Array.from(document.querySelectorAll(".project-option")).find((element) => element.textContent?.includes("repo-2"))!);
  await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("repo-2"));
}

it.each(["success", "error"])("cancels an initial graph read on menu exit and ignores its late %s after returning", async (outcome) => {
  let release!: (response: Response) => void;
  let oldSignal!: AbortSignal;
  let reads = 0;
  mockApi(async (url, options) => {
    if (!url.pathname.endsWith("/dependency-graph")) return;
    reads += 1;
    if (reads === 1) {
      oldSignal = options!.signal!;
      return new Promise<Response>((resolve) => { release = resolve; }); // Ignores abort deliberately.
    }
    return Response.json(graphFixture("fresh.py"));
  });
  window.history.replaceState({}, "", "/?section=graph&project=1");
  render(<App />);
  await waitFor(() => expect(reads).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: /代码搜索/ }));
  expect(oldSignal.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /依赖图谱/ }));
  await screen.findByRole("button", { name: "选择模块 fresh.py" });
  await act(async () => { release(outcome === "success" ? Response.json(graphFixture("stale.py"))
    : Response.json({ detail: "obsolete graph failure" }, { status: 500 })); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "选择模块 stale.py" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /代码搜索/ }));
  fireEvent.click(screen.getByRole("button", { name: /依赖图谱/ }));
  expect(screen.getByRole("button", { name: "选择模块 fresh.py" })).toBeTruthy();
  expect(reads).toBe(2); // Completed graph is still reused on menu roundtrips.
});

it.each(["full", "incremental"])("waits for %s reanalysis to finish before reading the graph after a menu switch", async (mode) => {
  let releaseAnalysis!: () => void;
  const gate = new Promise<void>((resolve) => { releaseAnalysis = resolve; });
  let analyzing = false;
  let reads = 0;
  mockApi(async (url) => {
    if (url.pathname.endsWith("/dependency-graph")) {
      expect(analyzing).toBe(false);
      reads += 1;
      return Response.json(graphFixture(reads === 1 ? "before.py" : "after.py"));
    }
    if (url.pathname.endsWith("/reanalyze") || url.pathname.endsWith("/incremental-reanalyze")) {
      analyzing = true;
      await gate;
      analyzing = false;
      return Response.json(mode === "full" ? summary : { project_id: 1, added_file_count: 1, changed_file_count: 0,
        deleted_file_count: 0, unchanged_file_count: 0, parsed_file_count: 1, added_paths: ["after.py"],
        changed_paths: [], deleted_paths: [], elapsed_ms: 1 });
    }
  });
  window.history.replaceState({}, "", "/?section=graph&project=1");
  render(<App />);
  await screen.findByRole("button", { name: "选择模块 before.py" });
  fireEvent.click(screen.getByRole("button", { name: /仓库概览/ }));
  fireEvent.click(screen.getByRole("button", { name: mode === "full" ? "全量" : "增量分析" }));
  await waitFor(() => expect(analyzing).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: /依赖图谱/ }));
  expect(reads).toBe(1);
  await act(async () => { releaseAnalysis(); await gate; });
  await screen.findByRole("button", { name: "选择模块 after.py" });
  expect(reads).toBe(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["full", "incremental"])("refreshes the visible file tree after %s analysis changes the index", async (mode) => {
  let analyzed = false;
  mockApi(async (url) => {
    if (url.pathname.endsWith("/files/tree")) return Response.json({ path: "", total_files: 1,
      items: [{ id: analyzed ? 2 : 1, kind: "file", path: analyzed ? "new.py" : "old.py", name: analyzed ? "new.py" : "old.py", file_count: 1, line_count: 1, size_bytes: 10, language: "Python" }] });
    if (url.pathname.endsWith("/reanalyze") || url.pathname.endsWith("/incremental-reanalyze")) {
      analyzed = true;
      return Response.json(mode === "full" ? summary : { project_id: 1, added_file_count: 1, changed_file_count: 0, deleted_file_count: 1, unchanged_file_count: 0, parsed_file_count: 1, added_paths: ["new.py"], changed_paths: [], deleted_paths: ["old.py"], elapsed_ms: 1 });
    }
  });
  window.history.replaceState({}, "", "/?section=projects&project=1&tab=files");
  render(<App />);
  await screen.findByText("old.py");
  fireEvent.click(screen.getByRole("button", { name: mode === "full" ? "全量" : "增量分析" }));
  await waitFor(() => expect(document.querySelector(".file-tree-file strong")?.textContent).toBe("new.py"));
  expect(document.querySelector(".file-tree")?.textContent).not.toContain("old.py");
});

const impactTarget = { target_type: "symbol", target_id: 10, file_id: 1, file_path: "app.py", name: "old_calculate", kind: "function", start_line: 1, end_line: 2 };

it("does not restart a pending graph request when its navigation button is clicked again", async () => {
  let release!: (response: Response) => void;
  let reads = 0;
  mockApi(async (url) => {
    if (url.pathname.endsWith("/dependency-graph")) {
      reads += 1;
      return new Promise<Response>((resolve) => { release = resolve; });
    }
  });
  window.history.replaceState({}, "", "/?section=graph&project=1");
  render(<App />);
  await waitFor(() => expect(reads).toBe(1));
  for (let index = 0; index < 3; index += 1) fireEvent.click(screen.getByRole("button", { name: /依赖图谱/ }));
  expect(reads).toBe(1);
  await act(async () => release(Response.json(graphFixture("once.py"))));
  await screen.findByRole("button", { name: "选择模块 once.py" });
});

it("preserves a failed analysis notification when navigation triggers a graph refresh afterward", async () => {
  let release!: (response: Response) => void;
  let analyzing = false;
  let reads = 0;
  mockApi(async (url) => {
    if (url.pathname.endsWith("/dependency-graph")) {
      reads += 1;
      return Response.json(graphFixture("unchanged.py"));
    }
    if (url.pathname.endsWith("/reanalyze")) {
      analyzing = true;
      return new Promise<Response>((resolve) => { release = resolve; });
    }
  });
  window.history.replaceState({}, "", "/?section=graph&project=1");
  render(<App />);
  await screen.findByRole("button", { name: "选择模块 unchanged.py" });
  fireEvent.click(screen.getByRole("button", { name: /仓库概览/ }));
  fireEvent.click(screen.getByRole("button", { name: "全量" }));
  await waitFor(() => expect(analyzing).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: /依赖图谱/ }));
  await act(async () => release(Response.json({ detail: "analysis failed" }, { status: 500 })));
  await screen.findByRole("button", { name: "选择模块 unchanged.py" });
  expect(reads).toBe(2);
  expect(screen.getByRole("alert").textContent).toContain("分析");
});
const impactReport = {
  target: impactTarget,
  definition: { ...impactTarget, relation: "definition", symbol_name: "old_calculate", line_numbers: [1], symbol_id: 10, symbol_kind: "function", confidence: "high", depth: 0 },
  risk: { level: "low", score: 18, confidence: "medium", reasons: [] },
  direct_callers: [], called_objects: [], indirect_impacts: [], related_tests: [], related_apis: [], database_entities: [], cycles: [], limitations: "fixture",
};

it.each(["bound_symbol_call", "candidate_symbol_call"])("opens %s at its own evidence line and keeps callee definition locations", async (relationName) => {
  const caller = { file_id: 2, file_path: "caller.py", relation: relationName,
    confidence: relationName === "bound_symbol_call" ? "high" : "low", depth: 1,
    symbol_id: 20, symbol_name: "caller_entry", symbol_kind: "function",
    start_line: 1, end_line: 20, line_numbers: [17] };
  const callee = { ...caller, file_id: 3, file_path: "callee.py", symbol_id: 30,
    symbol_name: "persist_record", start_line: 31, end_line: 35, line_numbers: [31] };
  const sourceReads: string[] = [];
  mockApi(async (url) => {
    if (url.pathname.endsWith("/impact-targets")) return Response.json([impactTarget]);
    if (url.pathname.endsWith("/impact")) return Response.json({ ...impactReport,
      direct_callers: [caller], called_objects: [callee] });
    if (url.pathname.endsWith("/content")) {
      sourceReads.push(url.pathname);
      const relation = url.pathname.endsWith("/2/content") ? caller : callee;
      const lines = Array.from({ length: 40 }, (_, index) => `# ${relation.file_path} line ${index + 1}`);
      return Response.json({ file_id: relation.file_id, file_path: relation.file_path,
        language: "Python", size_bytes: 800, total_lines: lines.length, lines });
    }
  });
  window.history.replaceState({}, "", "/?section=impact&project=1");
  render(<App />);
  fireEvent.change(await screen.findByLabelText(/选择要修改的文件、类或函数/), { target: { value: "calculate" } });
  fireEvent.click(screen.getByRole("button", { name: "查找对象" }));
  fireEvent.click(await screen.findByRole("button", { name: /old_calculate.*ANALYZE/ }));
  fireEvent.click(await screen.findByRole("button", { name: /caller_entry/ }));
  const callerSource = await screen.findByRole("region", { name: "caller.py 源代码" });
  expect(Array.from(callerSource.querySelectorAll(".highlighted .code-viewer-line-number"), (line) => line.textContent)).toEqual(["17"]);
  expect(screen.getByRole("dialog").textContent).toContain("匹配第 17–17 行");
  fireEvent.click(screen.getByRole("button", { name: "关闭代码查看器" }));
  fireEvent.click(screen.getByRole("button", { name: /persist_record/ }));
  const calleeSource = await screen.findByRole("region", { name: "callee.py 源代码" });
  expect(Array.from(calleeSource.querySelectorAll(".highlighted .code-viewer-line-number"), (line) => line.textContent)).toEqual(["31"]);
  expect(screen.getByRole("dialog").textContent).toContain("匹配第 31–31 行");
  expect(sourceReads).toEqual(["/api/projects/1/files/2/content", "/api/projects/1/files/3/content"]);
});

it.each(["full", "incremental"])("invalidates a selected coupling object after %s reanalysis", async (mode) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let analysisStarted = false;
  mockApi(async (url) => {
    if (url.pathname.endsWith("/impact-targets")) return Response.json([impactTarget]);
    if (url.pathname.endsWith("/impact")) return Response.json(impactReport);
    if (url.pathname.endsWith("/reanalyze") || url.pathname.endsWith("/incremental-reanalyze")) {
      analysisStarted = true;
      await gate;
      return Response.json(mode === "full" ? summary : { project_id: 1, added_file_count: 0, changed_file_count: 1, deleted_file_count: 0, unchanged_file_count: 0, parsed_file_count: 1, added_paths: [], changed_paths: ["app.py"], deleted_paths: [], elapsed_ms: 1 });
    }
  });
  window.history.replaceState({}, "", "/?section=impact&project=1");
  render(<App />);
  fireEvent.change(await screen.findByLabelText(/选择要修改的文件、类或函数/), { target: { value: "calculate" } });
  fireEvent.click(screen.getByRole("button", { name: "查找对象" }));
  fireEvent.click(await screen.findByRole("button", { name: /old_calculate.*ANALYZE/ }));
  await screen.findByRole("heading", { name: "old_calculate" });
  fireEvent.click(screen.getByRole("button", { name: /仓库概览/ }));
  fireEvent.click(screen.getByRole("button", { name: mode === "full" ? "全量" : "增量分析" }));
  await waitFor(() => expect(analysisStarted).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: /耦合分析/ }));
  await screen.findByRole("heading", { name: "old_calculate" });
  await act(async () => { release(); await gate; });
  await waitFor(() => expect(document.querySelector(".impact-report")).toBeNull());
  expect(screen.getByLabelText(/选择要修改的文件、类或函数/)).toHaveProperty("value", "");
  expect(document.querySelector(".workspace-error")).toBeNull();
});

it.each(["full", "incremental"])("cancels coupling search after %s reanalysis even without a selected object", async (mode) => {
  let releaseAnalysis!: () => void;
  let releaseSearch!: (response: Response) => void;
  let searchSignal!: AbortSignal;
  let analysisStarted = false;
  const gate = new Promise<void>((resolve) => { releaseAnalysis = resolve; });
  mockApi(async (url, options) => {
    if (url.pathname.endsWith("/impact-targets")) {
      searchSignal = options!.signal!;
      return new Promise<Response>((resolve) => { releaseSearch = resolve; });
    }
    if (url.pathname.endsWith("/reanalyze") || url.pathname.endsWith("/incremental-reanalyze")) {
      analysisStarted = true;
      await gate;
      return Response.json(mode === "full" ? summary : { project_id: 1, added_file_count: 0, changed_file_count: 1, deleted_file_count: 0, unchanged_file_count: 0, parsed_file_count: 1, added_paths: [], changed_paths: ["app.py"], deleted_paths: [], elapsed_ms: 1 });
    }
  });
  window.history.replaceState({}, "", "/?section=projects&project=1");
  render(<App />);
  await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("repo-1"));
  fireEvent.click(screen.getByRole("button", { name: mode === "full" ? "全量" : "增量分析" }));
  await waitFor(() => expect(analysisStarted).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: /耦合分析/ }));
  fireEvent.change(screen.getByLabelText(/选择要修改的文件、类或函数/), { target: { value: "calculate" } });
  fireEvent.click(screen.getByRole("button", { name: "查找对象" }));
  await waitFor(() => expect(searchSignal).toBeDefined());
  await act(async () => { releaseAnalysis(); await gate; });
  await waitFor(() => expect(searchSignal.aborted).toBe(true));
  await act(async () => { releaseSearch(Response.json([impactTarget])); });
  expect(screen.queryByText("old_calculate")).toBeNull();
  expect(screen.getByLabelText(/选择要修改的文件、类或函数/)).toHaveProperty("value", "");
  expect(document.querySelector(".workspace-error")).toBeNull();
});

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["success", "error"])("ignores a manual report's late %s after switching projects", async (outcome) => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  mockApi(async (url) => {
    if (!url.pathname.endsWith("/report")) return;
    if (url.pathname.includes("/projects/1/") && ++calls > 1) {
      await gate;
      if (outcome === "error") return Response.json({ detail: "obsolete report failed" }, { status: 500 });
      return Response.json({ generator: "local", mode: "summary", content: "过期报告不能出现", filename: "old.md", generated_at: timestamp });
    }
    return Response.json({ generator: "local", mode: "summary", content: url.pathname.includes("/projects/1/") ? "项目一原始报告" : "项目二当前报告", filename: "report.md", generated_at: timestamp });
  });
  window.history.replaceState({}, "", "/?section=report&project=1");
  render(<App />);
  await screen.findByText("项目一原始报告");
  fireEvent.click(screen.getByRole("button", { name: /重新生成/ }));
  await waitFor(() => expect(calls).toBe(2));
  await selectSecondProject();
  await screen.findByText("项目二当前报告");
  await act(async () => { release(); await gate; });
  expect(screen.queryByText("过期报告不能出现")).toBeNull();
  expect(document.querySelector(".workspace-error")).toBeNull();
  expect(screen.getByText("项目二当前报告")).toBeTruthy();
});

it("allows a new project's search while the old search is still pending", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  mockApi(async (url) => {
    if (!url.pathname.endsWith("/search")) return;
    if (url.pathname.includes("/projects/1/")) await gate;
    return Response.json({ query: url.searchParams.get("q"), indexed_chunks: 1, total_matches: 0, limit: 10, offset: 0, has_more: false, elapsed_ms: 1, results: [] });
  });
  window.history.replaceState({}, "", "/?section=search&project=1");
  render(<App />);
  await waitFor(() => {
    expect(document.querySelector(".topbar h1")?.textContent).toBe("repo-1");
    expect(document.querySelector(".detail-panel")?.getAttribute("aria-busy")).toBe("false");
  });
  fireEvent.change(screen.getByRole("textbox", { name: "代码搜索关键词" }), { target: { value: "old-query" } });
  expect(screen.getByRole("button", { name: /^搜索$/ })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: /^搜索$/ }));
  await screen.findByRole("status", { name: "代码搜索进行中" });
  await selectSecondProject();
  await waitFor(() => expect(document.querySelector(".detail-panel")?.getAttribute("aria-busy")).toBe("false"));
  fireEvent.change(screen.getByRole("textbox", { name: "代码搜索关键词" }), { target: { value: "fresh-query" } });
  expect(screen.getByRole("button", { name: /^搜索$/ })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: /^搜索$/ }));
  await waitFor(() => expect(screen.queryByRole("status", { name: "代码搜索进行中" })).toBeNull());
  await act(async () => { release(); await gate; });
  expect(screen.getByRole("textbox", { name: "代码搜索关键词" })).toHaveProperty("value", "fresh-query");
  expect(document.querySelector(".workspace-error")).toBeNull();
});
