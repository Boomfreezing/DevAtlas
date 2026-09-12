import { expect, test, type Page, type Route } from "@playwright/test";
import type { QualityFinding, QualityReport } from "../src/types";

const timestamp = "2026-09-12T00:00:00Z";
const projects = [1, 2].map((id) => ({ id, name: `quality-fixture-${id}`, source_filename: "synthetic/", status: "ready", primary_language: "Python", file_count: 225, code_line_count: 45000, created_at: timestamp, updated_at: timestamp }));
const scopes = ["production", "test", "generated"] as const;
const severities = ["error", "warning", "info"] as const;
const nav = (page: Page, name: string) => page.locator(".nav-item").filter({ hasText: name });
const select = (page: Page, name: string) => page.getByRole("combobox", { name, exact: true });
const isQuality = (url: string) => new URL(url).pathname.endsWith("/quality");
const isFiltered = (url: string, severity: string) => isQuality(url) && new URL(url).searchParams.get("severity") === severity;

function report(url: URL): QualityReport {
  const projectId = Number(url.pathname.split("/")[3]);
  const all: QualityFinding[] = Array.from({ length: 225 }, (_, index) => ({ id: `${projectId}-${index + 1}`, rule_id: "LONG_FUNCTION", severity: severities[index % 3], scope: scopes[Math.floor(index / 3) % 3], title: `Project ${projectId} finding ${index + 1}`, file_id: index + 1, file_path: `src/project_${projectId}/service_${index + 1}.py`, start_line: 10, end_line: 130, metric: 120, threshold: 80, description: "Function responsibilities can be simplified.", suggestion: "补充测试，再拆分校验和持久化逻辑。" }));
  const filtered = all.filter((finding) => ["severity", "scope", "rule"].every((key) => !url.searchParams.has(key) || url.searchParams.get(key) === "all" || finding[key === "rule" ? "rule_id" : key as "severity" | "scope"] === url.searchParams.get(key)));
  const offset = Number(url.searchParams.get("offset"));
  const limit = Number(url.searchParams.get("limit"));
  return {
    score: 75, grade: "B", score_scope: "composite", total_findings: all.length, severity_counts: { error: 75, warning: 75, info: 75 }, rule_counts: { LONG_FUNCTION: 225, CIRCULAR_DEPENDENCY: 0 },
    rules: [{ id: "LONG_FUNCTION", title: "Long function", description: "Function too long", default_severity: "warning" }, { id: "CIRCULAR_DEPENDENCY", title: "Circular dependency", description: "Import cycle", default_severity: "warning" }],
    scoring: { model: "synthetic-e2e", coverage_level: "high", coverage_message: "", applicable_rule_count: 2, total_rule_count: 2 } as QualityReport["scoring"],
    scope_scores: Object.fromEntries(scopes.map((scope) => [scope, { scope, label: scope === "production" ? "生产代码" : scope === "test" ? "测试代码" : "生成/外部代码", score: 75, grade: "B", available: true, configured_weight: scope === "production" ? 0.7 : scope === "test" ? 0.2 : 0.1, effective_weight: scope === "production" ? 0.7 : scope === "test" ? 0.2 : 0.1, exclusion_reason: null, finding_count: 75, severity_counts: { error: 25, warning: 25, info: 25 }, project_size: { file_count: 75, code_line_count: 15000, symbol_count: 450 } }])) as QualityReport["scope_scores"],
    findings: filtered.slice(offset, offset + limit), filtered_findings: filtered.length, offset, limit, has_more: offset + limit < filtered.length, truncated: offset + limit < filtered.length, elapsed_ms: 1,
  };
}

function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function settle(page: Page) { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }

async function mockApi(page: Page, intercept?: (route: Route, url: URL) => Promise<boolean>, displayScale = 100) {
  const errors: string[] = [];
  const mutations: string[] = [];
  const reads: URL[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((scale) => localStorage.setItem("devatlas-display-scale", String(scale)), displayScale);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || /\/(ask|report|test)$/.test(url.pathname)) { mutations.push(`${route.request().method()} ${url.pathname}`); await route.fulfill({ status: 500, json: { detail: "Forbidden real operation in quality fixture" } }); return; }
    if (isQuality(url.toString())) reads.push(url);
    if (await intercept?.(route, url)) return;
    let body: unknown = [];
    if (url.pathname === "/api/projects") body = projects;
    else if (/\/projects\/[12]$/.test(url.pathname)) body = projects[Number(url.pathname.at(-1)) - 1];
    else if (isQuality(url.toString())) body = report(url);
    else if (url.pathname.endsWith("/structure/summary")) body = { symbol_count: 500, class_count: 50, function_count: 450, import_count: 120, resolved_import_count: 100, issue_count: 0 };
    else if (url.pathname.endsWith("/files/tree")) body = { path: "", items: [], total_files: 225, total_items: 0, has_more: false, limit: 200, offset: 0 };
    else if (/\/(symbols|imports|issues)$/.test(url.pathname)) body = { items: [], total: 0, limit: 150, offset: 0, has_more: false };
    else if (url.pathname.endsWith("/import-limits")) body = { max_upload_mb: 200, max_folder_files: 20000, max_source_file_mb: 5 };
    await route.fulfill({ json: body });
  });
  return { errors, mutations, reads };
}

async function counts(page: Page, count: number, total: number) {
  await expect(page.locator(".quality-finding")).toHaveCount(count);
  await expect(page.locator(".quality-toolbar")).toContainText(`当前显示 ${count} / ${total}`);
  await expect(page.locator(".quality-findings")).toHaveAttribute("aria-busy", "false");
}
function noFailures(state: Awaited<ReturnType<typeof mockApi>>) { expect(state.errors).toEqual([]); expect(state.mutations).toEqual([]); }

async function expectQualityWithinPanel(page: Page) {
  const geometry = await page.locator(".quality-view").evaluate((panel) => {
    const bounds = panel.getBoundingClientRect();
    const selectors = ".quality-hero, .quality-overview, .quality-scope-scores article, .quality-rules article, .quality-toolbar, .quality-toolbar label, .quality-toolbar select, .quality-finding, .finding-main, .finding-main header, .finding-suggestion";
    const overflowing = Array.from(panel.querySelectorAll<HTMLElement>(selectors)).flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || element.scrollWidth > element.clientWidth + 1
        ? [`${element.className || element.tagName}: ${rect.left.toFixed(1)}..${rect.right.toFixed(1)} / scroll ${element.scrollWidth}>${element.clientWidth}`]
        : [];
    });
    const overlaps = Array.from(panel.querySelectorAll(".finding-main header")).filter((header) => {
      const title = header.querySelector("div")!.getBoundingClientRect();
      const metric = header.querySelector("small")!.getBoundingClientRect();
      return Math.min(title.right, metric.right) - Math.max(title.left, metric.left) > 1
        && Math.min(title.bottom, metric.bottom) - Math.max(title.top, metric.top) > 1;
    }).length;
    return { left: bounds.left, right: bounds.right, viewport: window.innerWidth, overflowing, overlaps };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.overflowing).toEqual([]);
  expect(geometry.overlaps).toBe(0);
}

// These are the application's real scale settings, not browser/device zoom.
for (const width of [390, 768, 1440]) {
  for (const scale of [100, 120]) {
    test(`质量页 ${width}px / ${scale}% 筛选可操作、长路径与卡片完整换行`, async ({ page }, testInfo) => {
      const longSegment = "repository_quality_analysis_service_with_a_very_long_unbroken_module_name_".repeat(3);
      const state = await mockApi(page, async (route, url) => {
        if (!isQuality(url.toString())) return false;
        const body = report(url);
        body.findings = body.findings.map((finding, index) => index ? finding : {
          ...finding,
          title: `Refactor ${longSegment}`,
          file_path: `src/${longSegment}/service.py`,
          description: `An oversized method in ${longSegment} needs review.`,
          suggestion: `检查 ${longSegment}，保留现有行为并补充边界测试。`,
        });
        await route.fulfill({ json: body });
        return true;
      }, scale);
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/?section=quality&project=1");
      await counts(page, 100, 225);
      await expect(page.locator("html")).toHaveAttribute("data-display-scale", String(scale));
      await expectQualityWithinPanel(page);
      await select(page, "风险等级").selectOption("warning");
      await counts(page, 75, 75);
      await select(page, "代码范围").selectOption("production");
      await counts(page, 25, 25);
      await select(page, "检测规则").selectOption("LONG_FUNCTION");
      await counts(page, 25, 25);
      await expectQualityWithinPanel(page);
      for (const name of ["代码范围", "风险等级", "检测规则"]) {
        const control = select(page, name);
        await control.focus();
        await expect(control).toBeFocused();
        expect(await control.evaluate((element) => getComputedStyle(element).color)).toBe("rgb(51, 255, 0)");
      }
      await page.locator(".quality-toolbar").scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`quality-responsive-${width}-${scale}.png`) });
      await expect(page.getByRole("meter")).toHaveAttribute("aria-valuenow", "75");
      noFailures(state);
    });
  }
}

test("质量页 390px / 120% 检测覆盖不足时保留 N/A 与完整长说明", async ({ page }, testInfo) => {
  const explanation = "当前范围内的文件存在解析失败或超出解析限制，未获得可执行结构规则的有效源码证据，因此不能把未检测的代码视为满分。请先查看仓库概览中的解析问题并重新分析。";
  const state = await mockApi(page, async (route, url) => {
    if (!isQuality(url.toString())) return false;
    const body = report(url);
    body.scoring = { ...body.scoring, coverage_level: "none", coverage_message: explanation, applicable_rule_count: 0 };
    for (const scope of scopes) body.scope_scores[scope] = { ...body.scope_scores[scope], available: false, grade: null, score: null, exclusion_reason: explanation };
    await route.fulfill({ json: body });
    return true;
  }, 120);
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/?section=quality&project=1");
  await counts(page, 100, 225);
  await expect(page.locator("html")).toHaveAttribute("data-display-scale", "120");
  await expect(page.getByRole("meter")).toHaveCount(0);
  await expect(page.locator(".quality-view").getByText("N/A", { exact: true })).toHaveCount(4);
  await expect(page.locator(".quality-coverage-note")).toHaveText(explanation);
  for (const note of await page.locator(".quality-scope-scores small").all()) {
    await expect(note).toHaveText(explanation);
    expect(await note.evaluate((element) => {
      const style = getComputedStyle(element);
      return { overflow: style.overflow, display: style.display, height: element.getBoundingClientRect().height };
    })).toMatchObject({ overflow: "visible", display: "block" });
  }
  await expectQualityWithinPanel(page);
  await page.locator(".quality-hero").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("quality-unavailable-390-120.png") });
  await select(page, "代码范围").selectOption("generated");
  await counts(page, 75, 75);
  await expectQualityWithinPanel(page);
  await page.locator(".quality-toolbar").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("quality-unavailable-filters-390-120.png") });
  noFailures(state);
});

test("质量问题分页完整、筛选与跨菜单缓存一致，保持绿色 Terminal 控件", async ({ page }, testInfo) => {
  const state = await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?section=quality&project=1");
  await counts(page, 100, 225);
  await page.locator(".quality-load-more button").click();
  await counts(page, 200, 225);
  await page.locator(".quality-load-more button").click();
  await counts(page, 225, 225);
  expect(await page.locator(".quality-finding header strong").allTextContents()).toEqual(Array.from({ length: 225 }, (_, index) => `Project 1 finding ${index + 1}`));
  await expect(page.locator(".quality-load-more button")).toHaveCount(0);
  await select(page, "风险等级").selectOption("warning");
  await counts(page, 75, 75);
  await select(page, "代码范围").selectOption("production");
  await counts(page, 25, 25);
  const beforeNavigation = state.reads.length;
  await nav(page, "代码搜索").click();
  await nav(page, "质量检测").click();
  await counts(page, 25, 25);
  await expect(select(page, "风险等级")).toHaveValue("warning");
  await expect(select(page, "代码范围")).toHaveValue("production");
  expect(state.reads).toHaveLength(beforeNavigation);
  await select(page, "检测规则").selectOption("CIRCULAR_DEPENDENCY");
  await counts(page, 0, 0);
  await expect(page.locator(".quality-findings")).toContainText("当前筛选条件下没有质量问题");
  await expect(page.getByRole("meter")).toHaveAttribute("aria-valuenow", "75");
  await select(page, "检测规则").selectOption("all");
  await counts(page, 25, 25);
  await page.locator(".quality-toolbar").scrollIntoViewIfNeeded();
  const color = await select(page, "风险等级").evaluate((element) => getComputedStyle(element).color);
  expect(color).toBe("rgb(51, 255, 0)");
  await page.screenshot({ path: testInfo.outputPath("quality-filtered-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".quality-toolbar").scrollIntoViewIfNeeded();
  await expect(select(page, "风险等级")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("quality-filtered-narrow.png") });
  noFailures(state);
});

test("筛选请求立即清除旧行、可继续改选并取消旧请求", async ({ page }) => {
  const held = gate();
  const state = await mockApi(page, async (route, url) => {
    if (!isFiltered(url.toString(), "warning")) return false;
    await held.promise;
    await route.fulfill({ status: 503, json: { detail: "obsolete warning failure" } });
    return true;
  });
  try {
    await page.goto("/?section=quality&project=1");
    await counts(page, 100, 225);
    const started = page.waitForRequest((request) => isFiltered(request.url(), "warning"));
    await select(page, "风险等级").selectOption("warning");
    await started;
    await expect(page.locator(".quality-finding")).toHaveCount(0);
    await expect(page.locator(".quality-toolbar")).toContainText("当前显示 0 / —");
    await expect(page.locator(".quality-findings")).toContainText("正在读取质量问题");
    await expect(page.locator(".quality-findings")).not.toContainText("当前筛选条件下没有质量问题");
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => isFiltered(request.url(), "warning") });
    await select(page, "风险等级").selectOption("error");
    expect((await aborted).failure()?.errorText).toContain("ERR_ABORTED");
    await counts(page, 75, 75);
    await expect(page.locator(".quality-finding.severity-error")).toHaveCount(75);
    held.release(); await settle(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
    noFailures(state);
  } finally { held.release(); }
});

test("筛选失败保留选择和评分，但不把旧行或空结果伪装成新结果", async ({ page }) => {
  let attempts = 0;
  const state = await mockApi(page, async (route, url) => {
    if (!isFiltered(url.toString(), "warning") || ++attempts !== 1) return false;
    await route.fulfill({ status: 503, json: { detail: "质量筛选暂时失败" } }); return true;
  });
  await page.goto("/?section=quality&project=1"); await counts(page, 100, 225);
  await select(page, "风险等级").selectOption("warning");
  await expect(page.locator(".quality-view").getByRole("alert")).toContainText("质量筛选暂时失败");
  await expect(select(page, "风险等级")).toHaveValue("warning");
  await expect(page.locator(".quality-finding")).toHaveCount(0);
  await expect(page.locator(".quality-toolbar")).toContainText("当前显示 0 / —");
  await expect(page.locator(".quality-findings")).not.toContainText("当前筛选条件下没有质量问题");
  await expect(page.getByRole("meter")).toHaveAttribute("aria-valuenow", "75");
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await counts(page, 75, 75);
  expect(state.reads.filter((url) => isFiltered(url.toString(), "warning")).map((url) => url.searchParams.get("offset"))).toEqual(["0", "0"]);
  await expect(page.getByRole("alert")).toHaveCount(0); noFailures(state);
});

test("下一页失败同游标重试，页内容不一致时拒绝拼接并从头读取", async ({ page }) => {
  let nextCalls = 0;
  const state = await mockApi(page, async (route, url) => {
    if (!isQuality(url.toString())) return false;
    if (url.searchParams.get("offset") === "100" && ++nextCalls === 1) { await route.fulfill({ status: 503, json: { detail: "质量分页暂时失败" } }); return true; }
    if (url.searchParams.get("offset") === "200") { const body = report(url); body.findings[0] = { ...body.findings[0], id: "1-1" }; await route.fulfill({ json: body }); return true; }
    return false;
  });
  await page.goto("/?section=quality&project=1"); await counts(page, 100, 225);
  await page.locator(".quality-load-more button").click();
  await expect(page.getByRole("alert")).toContainText("质量分页暂时失败");
  await counts(page, 100, 225);
  await page.getByRole("button", { name: "重试加载", exact: true }).click();
  await counts(page, 200, 225);
  await page.locator(".quality-load-more button").click();
  await expect(page.getByRole("alert")).toContainText("避免混合不同分析结果");
  await counts(page, 200, 225);
  await expect(page.locator(".quality-load-more button")).toHaveCount(0);
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await counts(page, 100, 225);
  expect(state.reads.map((url) => Number(url.searchParams.get("offset")))).toEqual([0, 100, 100, 200, 0]);
  await expect(page.getByRole("alert")).toHaveCount(0); noFailures(state);
});

for (const lateStatus of [200, 503]) {
  test(`初次读取离页取消，迟到 ${lateStatus} 不污染返回后的新报告`, async ({ page }) => {
    const held = gate(); let reads = 0;
    const state = await mockApi(page, async (route, url) => {
      if (!isQuality(url.toString()) || ++reads !== 1) return false;
      await held.promise;
      await route.fulfill({ status: lateStatus, json: lateStatus === 200 ? { ...report(url), score: 12, grade: "D" } : { detail: "obsolete initial error" } }); return true;
    });
    try {
      const started = page.waitForRequest((request) => isQuality(request.url()));
      await page.goto("/?section=quality&project=1"); await started;
      const aborted = page.waitForEvent("requestfailed", { predicate: (request) => isQuality(request.url()) });
      await nav(page, "代码搜索").click();
      expect((await aborted).failure()?.errorText).toContain("ERR_ABORTED");
      await nav(page, "质量检测").click(); await counts(page, 100, 225);
      held.release(); await settle(page);
      await expect(page.getByRole("meter")).toHaveAttribute("aria-valuenow", "75");
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(reads).toBe(2); noFailures(state);
    } finally { held.release(); }
  });
}

test("切换项目取消质量筛选，新的项目不继承旧项目的行和筛选", async ({ page }) => {
  const held = gate();
  const state = await mockApi(page, async (route, url) => {
    if (!url.pathname.includes("/projects/1/") || !isFiltered(url.toString(), "warning")) return false;
    await held.promise; await route.fulfill({ status: 503, json: { detail: "old project quality failure" } }); return true;
  });
  try {
    await page.goto("/?section=quality&project=1"); await counts(page, 100, 225);
    const started = page.waitForRequest((request) => isFiltered(request.url(), "warning"));
    await select(page, "风险等级").selectOption("warning"); await started;
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => isFiltered(request.url(), "warning") });
    await page.locator(".project-trigger").click();
    await page.locator(".project-option").filter({ hasText: "quality-fixture-2" }).click();
    expect((await aborted).failure()?.errorText).toContain("ERR_ABORTED");
    await counts(page, 100, 225);
    await expect(select(page, "风险等级")).toHaveValue("all");
    await expect(page.locator(".quality-finding header strong").first()).toHaveText("Project 2 finding 1");
    held.release(); await settle(page);
    await expect(page.getByRole("alert")).toHaveCount(0); noFailures(state);
  } finally { held.release(); }
});
