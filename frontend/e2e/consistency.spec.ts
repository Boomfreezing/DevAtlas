import { expect, test, type Page, type Route } from "@playwright/test";

const timestamp = "2026-09-12T00:00:00Z";
const projects = [1, 2].map((id) => ({
  id, name: `consistency-${id}`, source_filename: `fixture-${id}/`, status: "ready",
  primary_language: "Python", file_count: 1, code_line_count: 10,
  created_at: timestamp, updated_at: timestamp,
}));
const structure = (count: number) => ({ symbol_count: count, class_count: 0, function_count: count, import_count: 0, resolved_import_count: 0, issue_count: 0 });
const snapshots = [3, 2, 1].map((id) => ({
  id, project_id: 1, label: `snapshot-${id}`, reason: "manual", created_at: timestamp,
  score: 80, grade: "B", file_count: 1, symbol_count: 2, import_count: 0,
  finding_count: 1, cycle_count: 0, parse_issue_count: 0,
}));
const group = { new_count: 0, fixed_count: 1, persistent_count: 0, new_items: [], fixed_items: [{ key: "risk", file_path: "main.py", title: "超长函数" }], persistent_items: [], truncated: false };

function comparison(base: number, target: number, comparable = true) {
  return {
    base: snapshots.find((item) => item.id === base), target: snapshots.find((item) => item.id === target),
    comparable, comparison_warnings: comparable ? [] : ["评分模型或规则参数不同，分数与问题差异不能直接归因于代码修改。"],
    metric_changes: [{ key: "score", label: "综合质量分", base: 80, target: 100, delta: comparable ? 20 : null }],
    quality: group, parse_issues: group, cycles: group,
  };
}

async function mockApi(page: Page, intercept?: (route: Route, url: URL) => Promise<boolean>) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (await intercept?.(route, url)) return;
    let body: unknown = [];
    if (url.pathname === "/api/projects") body = projects;
    else if (/\/projects\/[12]$/.test(url.pathname)) body = projects[Number(url.pathname.at(-1)) - 1];
    else if (url.pathname.endsWith("/structure/summary")) body = structure(22);
    else if (url.pathname.endsWith("/files/tree")) body = { project_id: 1, path: "", items: [], total_files: 1 };
    else if (url.pathname.endsWith("/snapshots")) body = snapshots;
    else if (url.pathname.endsWith("/snapshots/compare")) body = comparison(Number(url.searchParams.get("base_id")), Number(url.searchParams.get("target_id")));
    else if (url.pathname.endsWith("/git-summary")) body = { project_id: 1, available: false, refreshable: false, message: "本地样例没有 Git 元数据", recent_commits: [] };
    else if (/\/(symbols|imports|issues)$/.test(url.pathname)) body = { items: [], total: 0, limit: 150, offset: 0, has_more: false };
    else if (url.pathname.endsWith("/import-limits")) body = { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 };
    await route.fulfill({ json: body });
  });
}

async function settleRender(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("搜索改词会取消旧请求，下一页失败后保留结果并原位重试", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let releaseOld!: () => void;
  const gate = new Promise<void>((resolve) => { releaseOld = resolve; });
  let moreCalls = 0;
  const offsets: number[] = [];
  await mockApi(page, async (route, url) => {
    if (!url.pathname.endsWith("/search")) return false;
    const query = url.searchParams.get("q")!;
    const offset = Number(url.searchParams.get("offset"));
    if (query === "obsolete") await gate;
    if (query === "fresh") offsets.push(offset);
    if (offset && ++moreCalls === 1) {
      await route.fulfill({ status: 503, json: { detail: "分页读取暂时失败" } });
      return true;
    }
    const results = Array.from({ length: offset ? 2 : 10 }, (_, index) => ({
      chunk_id: offset + index + 1, file_id: offset + index + 1, file_path: `src/${query}-${offset + index}.py`,
      symbol_name: `${query}_${offset + index}`, kind: "function", start_line: 1, end_line: 2,
      snippet_start_line: 1, snippet_end_line: 2, snippet: `return "${query}"`, score: 1,
    }));
    await route.fulfill({ json: { query, offset, limit: 10, results, total_matches: 12, indexed_chunks: 20, has_more: !offset, elapsed_ms: 1 } });
    return true;
  });
  try {
    await page.goto("/?section=search&project=1");
    const query = page.getByRole("textbox", { name: "代码搜索关键词" });
    await query.fill("obsolete");
    const started = page.waitForRequest((request) => request.url().includes("q=obsolete"));
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await started;
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request.url().includes("q=obsolete") });
    await query.fill("fresh");
    expect((await aborted).failure()?.errorText).toContain("ERR_ABORTED");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".search-result")).toHaveCount(10);
    await page.getByRole("button", { name: /加载更多/ }).click();
    await expect(page.locator(".search-pane").getByRole("alert")).toContainText("分页读取暂时失败");
    await expect(page.locator(".search-result")).toHaveCount(10);
    await page.getByRole("button", { name: "重试加载", exact: true }).click();
    await expect(page.locator(".search-result")).toHaveCount(12);
    await expect(page.locator(".search-summary")).toContainText("显示 12 / 12 条匹配");
    await expect(page.locator(".search-pane").getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /加载更多/ })).toHaveCount(0);
    releaseOld();
    await settleRender(page);
    await expect(page.locator(".search-result")).not.toContainText(["obsolete"]);
    expect(offsets).toEqual([0, 10, 10]);
    expect(pageErrors).toEqual([]);
  } finally { releaseOld(); }
});

test("大目录服务端分页并保持绿色 Terminal 控件", async ({ page }, testInfo) => {
  let reads = 0;
  const offsets: number[] = [];
  await mockApi(page, async (route, url) => {
    const project = { ...projects[0], file_count: 450, code_line_count: 2250 };
    if (url.pathname === "/api/projects" || url.pathname === "/api/projects/1") {
      await route.fulfill({ json: url.pathname === "/api/projects" ? [project] : project });
      return true;
    }
    if (!url.pathname.endsWith("/files/tree")) return false;
    reads += 1;
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 0);
    expect(limit).toBe(200);
    offsets.push(offset);
    await route.fulfill({ json: {
      path: "", total_files: 450, total_items: 450, limit, offset, has_more: offset + limit < 450,
      items: Array.from({ length: Math.min(limit, 450 - offset) }, (_, index) => ({ id: offset + index + 1, kind: "file", path: `file_${offset + index + 1}.py`, name: `file_${offset + index + 1}.py`, file_count: 1, line_count: 5, size_bytes: 50, language: "Python" })),
    } });
    return true;
  });
  await page.goto("/?section=projects&project=1&tab=files");
  await expect(page.locator(".file-tree-file")).toHaveCount(200);
  const loadMore = page.getByRole("button", { name: "加载根目录的更多条目", exact: true });
  await expect(loadMore).toContainText("200 / 450 个直接子项");
  const initialReads = reads; // Dev StrictMode may cancel and restart the initial read.
  await loadMore.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("file-tree-batched.png") });
  const style = await loadMore.evaluate((button) => {
    const computed = getComputedStyle(button);
    return { background: computed.backgroundColor, radius: computed.borderRadius, font: computed.fontFamily };
  });
  expect(style.background).not.toBe("rgb(255, 255, 255)");
  expect(style.radius).toBe("0px");
  expect(style.font.toLowerCase()).toContain("mono");
  await loadMore.click();
  await expect(page.locator(".file-tree-file")).toHaveCount(400);
  await loadMore.click();
  await expect(page.locator(".file-tree-file")).toHaveCount(450);
  await expect(page.getByText("已显示全部 450 个直接子项")).toBeVisible();
  await expect(loadMore).toHaveCount(0);
  expect(reads).toBe(initialReads + 2);
  expect(offsets.slice(initialReads)).toEqual([200, 400]);
});

test("搜索、耦合分析与源码跳转保持上下文，切换项目后不沿用旧对象", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const unexpectedModelRequests: string[] = [];
  const target = { target_type: "symbol", target_id: 2, file_id: 2, file_path: "src/helper.py", name: "helper", kind: "function", start_line: 2, end_line: 5 };
  const definition = { file_id: 2, file_path: target.file_path, relation: "definition", confidence: "high", depth: 0, line_numbers: [2], symbol_id: 2, symbol_name: "helper", symbol_kind: "function", start_line: 2, end_line: 5 };
  await mockApi(page, async (route, url) => {
    if (url.pathname.endsWith("/ask") || url.pathname.endsWith("/report") || url.pathname.endsWith("/test")) {
      unexpectedModelRequests.push(url.pathname);
      await route.fulfill({ status: 500, json: { detail: "No model requests in this workflow" } });
      return true;
    }
    if (url.pathname.endsWith("/search")) {
      await route.fulfill({ json: { query: "calculate", total_matches: 1, indexed_chunks: 1, limit: 10, offset: 0, has_more: false, elapsed_ms: 1,
        results: [{ chunk_id: 1, file_id: 1, file_path: "src/calculate.py", symbol_name: "calculate", kind: "function", start_line: 1, end_line: 20, snippet_start_line: 1, snippet_end_line: 2, snippet: "def calculate():\n    return helper()", score: 1 }] } });
      return true;
    }
    if (url.pathname.endsWith("/impact-targets")) {
      await route.fulfill({ json: [target] });
      return true;
    }
    if (url.pathname.endsWith("/impact")) {
      const isSymbol = url.searchParams.get("target_type") === "symbol";
      await route.fulfill({ json: {
        target: isSymbol ? target : { ...target, target_type: "file", target_id: 1, file_id: 1, file_path: "src/calculate.py", name: "src/calculate.py", kind: "file" },
        definition,
        risk: { level: "low", score: 18, confidence: "medium", reasons: [] },
        direct_callers: [{ ...definition, file_id: 1, file_path: "src/calculate.py", symbol_name: "calculate", relation: "bound_symbol_call", start_line: 1, end_line: 20, line_numbers: [17] }],
        called_objects: [], dependencies: [], indirect_impacts: [], related_tests: [], related_apis: [], database_entities: [], cycles: [], limitations: "静态分析测试数据",
      } });
      return true;
    }
    if (url.pathname.endsWith("/files/1/content")) {
      await route.fulfill({ json: { file_id: 1, file_path: "src/calculate.py", language: "Python", total_lines: 20, lines: Array.from({ length: 20 }, (_, index) => index === 16 ? "    return helper()" : "# fixture"), truncated: false } });
      return true;
    }
    return false;
  });
  await page.goto("/?section=search&project=1");
  await page.getByRole("textbox", { name: "代码搜索关键词" }).fill("calculate");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator(".search-result")).toHaveCount(1);
  await page.getByRole("button", { name: "分析影响", exact: true }).click();
  await expect(page.locator(".impact-report-header h3")).toHaveText("src/calculate.py");
  await page.getByLabel(/选择要修改的文件、类或函数/).fill("helper");
  await page.getByRole("button", { name: "查找对象", exact: true }).click();
  await page.locator(".impact-target-list button").click();
  await expect(page.locator(".impact-report-header h3")).toHaveText("helper");
  await page.locator(".impact-group").filter({ hasText: "直接调用者" }).getByRole("button").click();
  await expect(page.getByRole("dialog", { name: "src/calculate.py" })).toBeVisible();
  await expect(page.locator(".code-viewer-line.highlighted")).toHaveCount(1);
  await expect(page.locator(".code-viewer-line.highlighted .code-viewer-line-number")).toHaveText("17");
  await page.getByRole("button", { name: "关闭代码查看器" }).click();
  await page.locator(".sidebar").getByRole("button", { name: /代码搜索/ }).click();
  await expect(page.getByRole("textbox", { name: "代码搜索关键词" })).toHaveValue("calculate");
  await expect(page.locator(".search-result")).toHaveCount(1);
  await page.locator(".sidebar").getByRole("button", { name: /耦合分析/ }).click();
  await expect(page.locator(".impact-report-header h3")).toHaveText("helper");
  await page.locator(".project-trigger").click();
  await page.locator(".project-option").filter({ hasText: "consistency-2" }).click();
  await expect(page.locator(".topbar h1")).toHaveText("consistency-2");
  await expect(page.locator(".impact-report")).toHaveCount(0);
  await expect(page.getByLabel(/选择要修改的文件、类或函数/)).toHaveValue("");
  expect(pageErrors).toEqual([]);
  expect(unexpectedModelRequests).toEqual([]);
});

for (const outcome of ["success", "error"] as const) {
  test(`切换项目后忽略旧结构请求的延迟${outcome === "success" ? "结果" : "错误"}`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await mockApi(page, async (route, url) => {
      if (url.pathname !== "/api/projects/1/structure/summary") return false;
      started();
      await gate;
      await route.fulfill(outcome === "success" ? { json: structure(999) } : { status: 500, json: { detail: "old-project-request-failed" } });
      return true;
    });
    try {
      await page.goto("/?section=projects&tab=symbols&project=1");
      await pending;
      await page.locator(".project-trigger").click();
      await page.locator(".project-option").filter({ hasText: "consistency-2" }).click();
      await expect(page.locator(".topbar h1")).toHaveText("consistency-2");
      await expect(page.locator(".detail-panel")).toHaveAttribute("aria-busy", "false");
      const completed = page.waitForResponse((response) => response.url().includes("/projects/1/structure/summary"));
      release();
      await (await completed).finished();
      await settleRender(page);
      await expect(page.locator(".topbar h1")).toHaveText("consistency-2");
      await expect(page.locator(".analysis-strip")).not.toContainText("999");
      await expect(page.locator(".workspace-error")).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get("project")).toBe("2");
      expect(pageErrors).toEqual([]);
    } finally {
      release();
    }
  });
}

test("对比过程中改选快照不会展示旧组合的结果", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  await mockApi(page, async (route, url) => {
    if (!url.pathname.endsWith("/snapshots/compare") || !first) return false;
    first = false;
    await gate;
    await route.fulfill({ json: comparison(2, 3) });
    return true;
  });
  try {
    await page.goto("/?section=snapshots&project=1");
    const selectors = page.locator(".snapshot-compare-controls select");
    await expect(selectors.nth(0)).toHaveValue("2");
    const requested = page.waitForRequest((request) => request.url().includes("/snapshots/compare"));
    await page.locator(".snapshot-compare-controls").getByRole("button").click();
    await requested;
    const cancelled = page.waitForEvent("requestfailed", { predicate: (request) => request.url().includes("/snapshots/compare"), timeout: 10_000 });
    await selectors.nth(0).selectOption("1");
    expect((await cancelled).failure()?.errorText).toContain("ERR_ABORTED");
    await expect(page.locator(".snapshot-compare-controls").getByRole("button")).toBeEnabled();
    await expect(page.locator(".snapshot-comparison")).toHaveCount(0);
    // A fresh comparison must work before the old server-side handler finishes.
    await page.locator(".snapshot-compare-controls").getByRole("button").click();
    await expect(page.locator(".snapshot-comparison > header")).toContainText("snapshot-1");
    release();
    await expect(page.locator(".snapshot-comparison > header")).not.toContainText("snapshot-2");
  } finally {
    release();
  }
});

test("不同评分口径显示中性提示而不是已修复和加分", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1800 });
  await mockApi(page, async (route, url) => {
    if (!url.pathname.endsWith("/snapshots/compare")) return false;
    await route.fulfill({ json: comparison(2, 3, false) });
    return true;
  });
  await page.goto("/?section=snapshots&project=1");
  await page.locator(".snapshot-compare-controls").getByRole("button").click();
  await expect(page.getByRole("status", { name: "版本对比口径提示" })).toBeVisible();
  await expect(page.locator(".snapshot-metrics")).toContainText("不计差值");
  await expect(page.locator(".snapshot-metrics .good")).toHaveCount(0);
  await expect(page.locator(".snapshot-comparison")).not.toContainText("已修复");
  await expect(page.locator(".snapshot-comparison")).toContainText("不再检出");
  await page.locator(".snapshot-comparison").screenshot({ path: testInfo.outputPath("comparison-not-comparable.png") });
});
