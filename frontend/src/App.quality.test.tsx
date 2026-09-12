// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import App from "./App";
import type { QualityFinding, QualityReport } from "./types";

const timestamp = "2026-09-12T00:00:00Z";
const projects = [1, 2].map((id) => ({ id, name: `quality-repo-${id}`, source_filename: `quality-repo-${id}/`,
  status: "ready", primary_language: "Python", file_count: 250, code_line_count: 25_000,
  created_at: timestamp, updated_at: timestamp }));
const structure = { symbol_count: 250, class_count: 0, function_count: 250, import_count: 0, resolved_import_count: 0, issue_count: 0 };
const size = { file_count: 250, code_line_count: 25_000, symbol_count: 250 };
const severityCounts = { error: 20, warning: 230, info: 0 };

function qualityPage(url: URL, version = "current"): QualityReport {
  const projectId = url.pathname.match(/\/projects\/(\d+)\//)?.[1] ?? "1";
  const rows: QualityFinding[] = Array.from({ length: 250 }, (_, index) => ({
    id: `${projectId}:${version}:${index}`, rule_id: index < 230 ? "LONG_FUNCTION" : "CIRCULAR_DEPENDENCY",
    severity: index < 230 ? "warning" : "error", scope: index < 230 ? "production" : "test",
    title: `project-${projectId}-${version}-finding-${index + 1}`, description: `说明 ${index + 1}`,
    suggestion: "拆分职责并验证行为", file_id: index + 1, file_path: `src/file_${index + 1}.py`,
    start_line: 1, end_line: 100, metric: 100, threshold: 80,
  }));
  const filtered = rows.filter((row) => (!url.searchParams.has("severity") || row.severity === url.searchParams.get("severity"))
    && (!url.searchParams.has("scope") || row.scope === url.searchParams.get("scope"))
    && (!url.searchParams.has("rule") || row.rule_id === url.searchParams.get("rule")));
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const findings = filtered.slice(offset, offset + limit);
  return {
    score: 91, grade: "A", score_scope: "composite", total_findings: rows.length,
    scoring: { model: "fixture", size_factor: 1, scale_units: 1, project_size: size, reference_size: size,
      base_weights: { error: 3, warning: 1, info: 0.2 }, effective_weights: { error: 3, warning: 1, info: 0.2 },
      base_penalty: 9, adjusted_penalty: 9, rule_penalties: { LONG_FUNCTION: 7, CIRCULAR_DEPENDENCY: 2 },
      scope_weights: { production: 0.7, test: 0.2, generated: 0.1 }, effective_scope_weights: { production: 0.8, test: 0.2, generated: 0 },
      excluded_scopes: ["generated"], source_file_count: 250, parser_supported_file_count: 250,
      applicable_rule_count: 2, total_rule_count: 2, parser_coverage: 1, coverage_level: "high", coverage_message: "", explanation: "fixture" },
    scope_scores: {
      production: { scope: "production", label: "生产代码", score: 90, grade: "A", available: true,
        configured_weight: 0.7, effective_weight: 0.8, exclusion_reason: null, finding_count: 230,
        severity_counts: { error: 0, warning: 230, info: 0 }, project_size: size },
      test: { scope: "test", label: "测试代码", score: 95, grade: "A", available: true,
        configured_weight: 0.2, effective_weight: 0.2, exclusion_reason: null, finding_count: 20,
        severity_counts: { error: 20, warning: 0, info: 0 }, project_size: size },
      generated: { scope: "generated", label: "生成/外部代码", score: null, grade: null, available: false,
        configured_weight: 0.1, effective_weight: 0, exclusion_reason: "没有生成或外部代码", finding_count: 0,
        severity_counts: { error: 0, warning: 0, info: 0 }, project_size: { file_count: 0, code_line_count: 0, symbol_count: 0 } },
    },
    severity_counts: severityCounts, rule_counts: { LONG_FUNCTION: 230, CIRCULAR_DEPENDENCY: 20 },
    rules: [{ id: "LONG_FUNCTION", title: "超长函数", description: "fixture", default_severity: "warning" },
      { id: "CIRCULAR_DEPENDENCY", title: "循环依赖", description: "fixture", default_severity: "error" }],
    findings, filtered_findings: filtered.length, offset, limit, has_more: offset + findings.length < filtered.length,
    truncated: offset + findings.length < filtered.length, elapsed_ms: 1,
  };
}

type Interceptor = (url: URL, options?: RequestInit) => Promise<Response | undefined>;
function mockApi(intercept: Interceptor) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const response = await intercept(url, options);
    if (response) return response;
    if (url.pathname === "/api/projects") return Response.json(projects);
    if (/\/projects\/[12]$/.test(url.pathname)) return Response.json(projects[Number(url.pathname.at(-1)) - 1]);
    if (url.pathname.endsWith("/structure/summary")) return Response.json(structure);
    if (url.pathname.endsWith("/quality")) return Response.json(qualityPage(url));
    if (url.pathname.endsWith("/files/tree")) return Response.json({ path: "", items: [], total_files: 250 });
    if (url.pathname.endsWith("/report-generators")) return Response.json([{ id: "local", name: "本地规则分析", available: true,
      configured: true, description: "fixture", base_url: "", model: "" }]);
    if (url.pathname.endsWith("/import-limits")) return Response.json({ max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 });
    return Response.json([]);
  }));
}

function showQuality() { fireEvent.click(screen.getByRole("button", { name: /质量检测/ })); }
function leaveQuality() { fireEvent.click(screen.getByRole("button", { name: /代码搜索/ })); }
function visibleRows() { return document.querySelectorAll(".quality-finding").length; }

async function selectSecondProject() {
  fireEvent.click(document.querySelector(".project-trigger")!);
  fireEvent.click(Array.from(document.querySelectorAll(".project-option"))
    .find((element) => element.textContent?.includes("quality-repo-2"))!);
  await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("quality-repo-2"));
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/?section=quality&project=1");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("retains quality filters and completed pages across menu roundtrips, then loads the correct next offset", async () => {
  const reads: URL[] = [];
  mockApi(async (url) => {
    if (url.pathname.endsWith("/quality")) reads.push(url);
    return undefined;
  });
  render(<App />);
  await screen.findByText("project-1-current-finding-1");
  fireEvent.change(screen.getByLabelText("风险等级"), { target: { value: "warning" } });
  await waitFor(() => expect(reads).toHaveLength(2));
  await screen.findByText("project-1-current-finding-1");
  fireEvent.change(screen.getByLabelText("代码范围"), { target: { value: "production" } });
  await waitFor(() => expect(reads).toHaveLength(3));
  await screen.findByText("project-1-current-finding-1");
  fireEvent.change(screen.getByLabelText("检测规则"), { target: { value: "LONG_FUNCTION" } });
  await waitFor(() => expect(reads).toHaveLength(4));
  await screen.findByText("project-1-current-finding-1");
  fireEvent.click(screen.getByRole("button", { name: /LOAD_NEXT/ }));
  await screen.findByText("project-1-current-finding-200");
  expect(visibleRows()).toBe(200);
  expect(reads).toHaveLength(5);
  leaveQuality();
  expect(document.querySelector(".quality-view")).toBeNull();
  showQuality();
  expect(screen.getByLabelText("风险等级")).toHaveProperty("value", "warning");
  expect(screen.getByLabelText("代码范围")).toHaveProperty("value", "production");
  expect(screen.getByLabelText("检测规则")).toHaveProperty("value", "LONG_FUNCTION");
  expect(visibleRows()).toBe(200);
  expect(reads).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: /LOAD_NEXT/ }));
  await screen.findByText("project-1-current-finding-230");
  expect(visibleRows()).toBe(230);
  expect(reads.at(-1)?.searchParams.get("offset")).toBe("200");
  expect(reads.at(-1)?.searchParams.get("severity")).toBe("warning");
  expect(reads.at(-1)?.searchParams.get("scope")).toBe("production");
  expect(reads.at(-1)?.searchParams.get("rule")).toBe("LONG_FUNCTION");
  expect(screen.queryByRole("button", { name: /LOAD_NEXT/ })).toBeNull();
  expect(screen.getByRole("meter", { name: "综合质量评分 91 分，评级 A" })).toBeTruthy();
  expect(screen.getByText("发现 250 项可改进问题")).toBeTruthy();
});

it.each(["success", "error"])("cancels an initial quality read on menu exit and ignores its late %s", async (outcome) => {
  let release!: (response: Response) => void;
  let oldSignal!: AbortSignal;
  let oldUrl!: URL;
  let reads = 0;
  mockApi(async (url, options) => {
    if (!url.pathname.endsWith("/quality")) return;
    reads += 1;
    if (reads === 1) {
      oldUrl = url;
      oldSignal = options!.signal!;
      return new Promise<Response>((resolve) => { release = resolve; }); // Deliberately ignores cancellation.
    }
    return Response.json(qualityPage(url, "fresh"));
  });
  render(<App />);
  await waitFor(() => expect(reads).toBe(1));
  leaveQuality();
  expect(oldSignal.aborted).toBe(true);
  await act(async () => release(outcome === "success" ? Response.json(qualityPage(oldUrl, "stale"))
    : Response.json({ detail: "obsolete quality failure" }, { status: 500 })));
  expect(document.querySelector(".quality-view")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  showQuality();
  await screen.findByText("project-1-fresh-finding-1");
  expect(screen.queryByText("project-1-stale-finding-1")).toBeNull();
  expect(reads).toBe(2);
});

it("does not restart a pending quality read when the active navigation button is clicked repeatedly", async () => {
  let release!: (response: Response) => void;
  let requestedUrl!: URL;
  let signal!: AbortSignal;
  let reads = 0;
  mockApi(async (url, options) => {
    if (!url.pathname.endsWith("/quality")) return;
    reads += 1; requestedUrl = url; signal = options!.signal!;
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  render(<App />);
  await waitFor(() => expect(reads).toBe(1));
  for (let index = 0; index < 3; index += 1) showQuality();
  expect(reads).toBe(1);
  expect(signal.aborted).toBe(false);
  await act(async () => release(Response.json(qualityPage(requestedUrl))));
  await screen.findByText("project-1-current-finding-1");
});

it.each(["full", "incremental"])("waits for the %s analysis POST before refreshing quality after menu navigation", async (mode) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let analyzing = false;
  let finished = false;
  let analysisSignal: AbortSignal | null | undefined;
  let reads = 0;
  mockApi(async (url, options) => {
    if (url.pathname.endsWith("/quality")) {
      expect(analyzing).toBe(false);
      reads += 1;
      return Response.json(qualityPage(url, finished ? "after" : "before"));
    }
    if (url.pathname.endsWith("/reanalyze") || url.pathname.endsWith("/incremental-reanalyze")) {
      expect(options?.method).toBe("POST");
      analyzing = true; analysisSignal = options?.signal;
      await gate;
      analyzing = false; finished = true;
      return Response.json(mode === "full" ? structure : { project_id: 1, added_file_count: 1, changed_file_count: 0,
        deleted_file_count: 0, unchanged_file_count: 249, parsed_file_count: 1, added_paths: ["after.py"],
        changed_paths: [], deleted_paths: [], elapsed_ms: 1 });
    }
  });
  render(<App />);
  await screen.findByText("project-1-before-finding-1");
  fireEvent.click(screen.getByRole("button", { name: /仓库概览/ }));
  fireEvent.click(screen.getByRole("button", { name: mode === "full" ? "全量" : "增量分析" }));
  await waitFor(() => expect(analyzing).toBe(true));
  showQuality();
  expect(reads).toBe(1);
  expect(analysisSignal?.aborted ?? false).toBe(false);
  expect(screen.getByText("等待仓库分析完成…")).toBeTruthy();
  await act(async () => { release(); await gate; });
  await screen.findByText("project-1-after-finding-1");
  expect(reads).toBe(2);
  expect(analysisSignal?.aborted ?? false).toBe(false);
  expect(screen.queryByText("project-1-before-finding-1")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("clears project-specific filters and pages and rejects a late appended page after switching projects", async () => {
  let release!: (response: Response) => void;
  let oldUrl!: URL;
  let oldSignal!: AbortSignal;
  const reads: URL[] = [];
  mockApi(async (url, options) => {
    if (!url.pathname.endsWith("/quality")) return;
    reads.push(url);
    if (url.pathname.includes("/projects/1/") && url.searchParams.get("offset") === "100") {
      oldUrl = url; oldSignal = options!.signal!;
      return new Promise<Response>((resolve) => { release = resolve; });
    }
  });
  render(<App />);
  await screen.findByText("project-1-current-finding-1");
  fireEvent.change(screen.getByLabelText("风险等级"), { target: { value: "warning" } });
  await waitFor(() => expect(reads).toHaveLength(2));
  await screen.findByText("project-1-current-finding-1");
  fireEvent.click(screen.getByRole("button", { name: /LOAD_NEXT/ }));
  await waitFor(() => expect(oldSignal).toBeDefined());
  await selectSecondProject();
  await screen.findByText("project-2-current-finding-1");
  expect(oldSignal.aborted).toBe(true);
  expect(screen.getByLabelText("风险等级")).toHaveProperty("value", "all");
  expect(screen.getByLabelText("代码范围")).toHaveProperty("value", "all");
  expect(screen.getByLabelText("检测规则")).toHaveProperty("value", "all");
  expect(reads.at(-1)?.searchParams.get("offset")).toBe("0");
  await act(async () => release(Response.json(qualityPage(oldUrl))));
  expect(visibleRows()).toBe(100);
  expect(screen.queryByText("project-1-current-finding-101")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps completed quality rows during a pagination failure and retries the same cursor locally", async () => {
  const offsets: number[] = [];
  let rejectedOnce = false;
  mockApi(async (url) => {
    if (!url.pathname.endsWith("/quality")) return;
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    if (offset === 100 && !rejectedOnce) {
      rejectedOnce = true;
      return Response.json({ detail: "temporary quality page error" }, { status: 500 });
    }
  });
  render(<App />);
  await screen.findByText("project-1-current-finding-1");
  fireEvent.click(screen.getByRole("button", { name: /LOAD_NEXT/ }));
  await screen.findByRole("button", { name: "重试加载" });
  expect(visibleRows()).toBe(100);
  expect(document.querySelector(".workspace-error")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  await screen.findByText("project-1-current-finding-200");
  expect(offsets).toEqual([0, 100, 100]);
  expect(visibleRows()).toBe(200);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("offers a local first-page retry after a quality read failure without leaving the workspace", async () => {
  let reads = 0;
  mockApi(async (url) => {
    if (!url.pathname.endsWith("/quality")) return;
    reads += 1;
    if (reads === 1) return Response.json({ detail: "temporary first-page error" }, { status: 500 });
  });
  render(<App />);
  await screen.findByRole("button", { name: "重新读取" });
  expect(visibleRows()).toBe(0);
  expect(document.querySelector(".workspace-error")).toBeNull();
  expect(new URLSearchParams(window.location.search).get("section")).toBe("quality");
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await screen.findByText("project-1-current-finding-1");
  expect(reads).toBe(2);
  expect(visibleRows()).toBe(100);
  expect(screen.queryByRole("alert")).toBeNull();
});
