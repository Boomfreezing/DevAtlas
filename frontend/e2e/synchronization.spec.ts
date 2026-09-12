import { expect, test, type Page } from "@playwright/test";
import type { AnalysisJob } from "../src/types";

const timestamp = "2026-09-12T00:00:00Z";
const projects = [1, 2].map((id) => ({ id, name: `sync-fixture-${id}`, source_filename: `github.com/example/sync-fixture-${id}`,
  status: "ready", primary_language: "Python", file_count: 1, code_line_count: 100, created_at: timestamp, updated_at: timestamp }));
const navigation = (page: Page, label: string) => page.locator(".nav-item").filter({ hasText: label });
const syncButton = (page: Page) => page.getByRole("region", { name: "GitHub 版本同步与对比" }).getByRole("button", { name: /同步远程仓库/ });
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function settle(page: Page) { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }

function job(status: "running" | "completed"): AnalysisJob {
  return { id: "mock-sync-1", project_id: 1, source_type: "github_sync", source_label: "synthetic fixture",
    status, stage: status, progress: status === "completed" ? 100 : 30,
    message: status === "completed" ? "远程同步已完成" : "正在检查远端", error: null,
    created_at: timestamp, updated_at: timestamp, completed_at: status === "completed" ? timestamp : null };
}

function qualityReport(projectId: number, version: string) {
  return { score: 90, grade: "A", score_scope: "composite", total_findings: 1,
    scoring: { coverage_level: "high", coverage_message: "fixture", applicable_rule_count: 1, total_rule_count: 1 },
    scope_scores: Object.fromEntries(["production", "test", "generated"].map((scope) => [scope, {
      scope, label: scope, score: scope === "production" ? 90 : null, grade: scope === "production" ? "A" : null,
      available: scope === "production", configured_weight: 1, effective_weight: scope === "production" ? 1 : 0,
      exclusion_reason: null, finding_count: scope === "production" ? 1 : 0,
      severity_counts: { error: 0, warning: scope === "production" ? 1 : 0, info: 0 },
      project_size: { file_count: scope === "production" ? 1 : 0, code_line_count: 100, symbol_count: 1 },
    }])),
    severity_counts: { error: 0, warning: 1, info: 0 }, rule_counts: { LONG_FUNCTION: 1 },
    rules: [{ id: "LONG_FUNCTION", title: "超长函数", description: "fixture", default_severity: "warning" }],
    findings: [{ id: `${projectId}:${version}`, rule_id: "LONG_FUNCTION", severity: "warning", scope: "production",
      title: `Quality ${projectId} ${version}`, description: "fixture", suggestion: "验证修改", file_id: 1,
      file_path: `${version}.py`, start_line: 1, end_line: 100, metric: 100, threshold: 80 }],
    offset: 0, limit: 100, filtered_findings: 1, has_more: false, truncated: false, elapsed_ms: 1 };
}

async function mockSynchronization(page: Page) {
  const submitted = gate();
  const completion = gate();
  const errors: string[] = [];
  const forbidden: string[] = [];
  const requests: URL[] = [];
  const abortedSyncRequests: string[] = [];
  let version = "before";
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => {
    if (/\/(sync-github|jobs\/mock-sync-1)$/.test(new URL(request.url()).pathname)) abortedSyncRequests.push(request.url());
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(url);
    // Every API request is intercepted. No repository is downloaded or model called.
    if (url.pathname === "/api/projects/1/sync-github" && request.method() === "POST") {
      await submitted.promise;
      await route.fulfill({ json: job("running") });
      return;
    }
    if (request.method() !== "GET" || /\/(ask|report|test)$/.test(url.pathname)) {
      forbidden.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 500, json: { detail: "Operation forbidden in synchronization fixture" } });
      return;
    }
    if (url.pathname === "/api/projects/jobs/mock-sync-1") {
      await completion.promise;
      version = "after";
      await route.fulfill({ json: job("completed") });
      return;
    }
    const projectId = Number(url.pathname.match(/\/projects\/(\d+)/)?.[1] ?? 1);
    let body: unknown = [];
    if (url.pathname === "/api/projects") body = projects;
    else if (/\/projects\/[12]$/.test(url.pathname)) body = projects[projectId - 1];
    else if (url.pathname.endsWith("/quality")) body = qualityReport(projectId, version);
    else if (url.pathname.endsWith("/structure/summary")) body = {
      symbol_count: projectId === 1 && version === "after" ? 9 : 1, class_count: 0,
      function_count: projectId === 1 && version === "after" ? 9 : 1, import_count: 0, resolved_import_count: 0, issue_count: 0,
    };
    else if (url.pathname.endsWith("/git-summary")) body = { available: false, refreshable: true, recent_commits: [], message: "fixture" };
    else if (url.pathname.endsWith("/files/tree")) body = { path: "", items: [], total_files: 1, total_items: 0, has_more: false, limit: 200, offset: 0 };
    else if (url.pathname.endsWith("/import-limits")) body = { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 };
    await route.fulfill({ json: body });
  });
  return { submitted, completion, errors, forbidden, abortedSyncRequests,
    count: (suffix: string, projectId = 1) => requests.filter((url) => url.pathname === `/api/projects/${projectId}${suffix}`).length,
    projectListReads: () => requests.filter((url) => url.pathname === "/api/projects").length };
}

async function expectQuality(page: Page, projectId: number, version: string) {
  await expect(page.locator(".quality-finding header strong")).toHaveText(`Quality ${projectId} ${version}`);
  await expect(page.locator(".quality-findings")).toHaveAttribute("aria-busy", "false");
}
function expectSafe(state: Awaited<ReturnType<typeof mockSynchronization>>) {
  expect(state.errors).toEqual([]);
  expect(state.forbidden).toEqual([]);
  expect(state.abortedSyncRequests).toEqual([]);
  expect(state.count("/sync-github")).toBe(1);
}

test("远程同步提交后离开版本页仍追踪任务，完成后质量缓存自动刷新", async ({ page }) => {
  const state = await mockSynchronization(page);
  try {
    await page.goto("/?section=quality&project=1");
    await expectQuality(page, 1, "before");
    await navigation(page, "版本对比").click();
    const submitStarted = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/sync-github"));
    await syncButton(page).click();
    await submitStarted;
    await expect(page.getByRole("region", { name: "GitHub 版本同步与对比" }).getByRole("button", { name: /正在同步…/ })).toBeDisabled();
    await navigation(page, "质量检测").click();
    await expectQuality(page, 1, "before");
    const pollStarted = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/jobs/mock-sync-1"));
    state.submitted.release();
    await pollStarted;
    expect(state.count("/quality")).toBe(1);
    state.completion.release();
    await expectQuality(page, 1, "after");
    expect(state.count("/quality")).toBe(2);
    await navigation(page, "版本对比").click();
    await expect(page.locator(".snapshot-git-message.success")).toContainText("远程同步已完成");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expectSafe(state);
  } finally { state.submitted.release(); state.completion.release(); }
});

test("项目 A 后台同步完成不刷新或污染项目 B，返回 A 重新读取结构和质量", async ({ page }) => {
  const state = await mockSynchronization(page);
  try {
    await page.goto("/?section=quality&project=1");
    await expectQuality(page, 1, "before");
    await navigation(page, "版本对比").click();
    await syncButton(page).click();
    const pollStarted = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/jobs/mock-sync-1"));
    state.submitted.release();
    await pollStarted;
    await page.locator(".project-trigger").click();
    await page.locator(".project-option").filter({ hasText: "sync-fixture-2" }).click();
    await navigation(page, "质量检测").click();
    await expectQuality(page, 2, "before");
    const secondQualityReads = state.count("/quality", 2);
    const refreshFinished = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/projects");
    state.completion.release();
    await refreshFinished;
    await settle(page);
    await expectQuality(page, 2, "before");
    expect(state.count("/quality", 2)).toBe(secondQualityReads);
    await expect(page.locator(".topbar h1")).toHaveText("sync-fixture-2");
    await page.locator(".project-trigger").click();
    await page.locator(".project-option").filter({ hasText: "sync-fixture-1" }).click();
    await expectQuality(page, 1, "after");
    expect(state.count("/structure/summary", 1)).toBe(2);
    await navigation(page, "仓库概览").click();
    await expect(page.locator(".analysis-strip > div").filter({ hasText: "函数 / 方法" }).locator("strong")).toHaveText("9");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expectSafe(state);
  } finally { state.submitted.release(); state.completion.release(); }
});
