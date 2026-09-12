import { expect, test, type Page, type Route } from "@playwright/test";
import type { DependencyEdge, DependencyGraph, DependencyNode } from "../src/types";

const timestamp = "2026-09-12T00:00:00Z";
const projects = [1, 2].map((id) => ({
  id, name: `graph-fixture-${id}`, source_filename: `graph-fixture-${id}/`, status: "ready",
  primary_language: "Python", file_count: 6, code_line_count: 60, created_at: timestamp, updated_at: timestamp,
}));
const node = (id: number, path: string): DependencyNode => ({ id, path, language: "Python", in_degree: 1, out_degree: 1 });
const nodes = [node(1, "src/global.py"), node(2, "src/a.py"), node(3, "src/b.py"), node(4, "src/offscreen.py"), node(5, "src/c.py"), node(6, "src/d.py")];
const edge = (source: DependencyNode, target: DependencyNode): DependencyEdge => ({
  source_id: source.id, target_id: target.id, source_path: source.path, target_path: target.path,
  import_count: 2, line_numbers: [3, 8],
});
const graph: DependencyGraph = {
  total_node_count: 6, total_edge_count: 5, internal_import_count: 10, external_import_count: 2,
  unresolved_import_count: 1, classified_import_count: 12, classification_confidence: 92.3,
  confidence_level: "high", cycle_count: 2, truncated: true, nodes: nodes.slice(0, 3),
  edges: [edge(nodes[1], nodes[2]), edge(nodes[2], nodes[1])],
  cycles: [{ file_ids: [2, 3, 4], paths: nodes.slice(1, 4).map((item) => item.path) },
    { file_ids: [5, 6], paths: nodes.slice(4).map((item) => item.path) }],
};
const focusedGraph = (cycle: number): DependencyGraph => ({
  ...graph, truncated: false, nodes: cycle === 1 ? nodes.slice(1, 4) : nodes.slice(4),
  edges: cycle === 1 ? [edge(nodes[1], nodes[2]), edge(nodes[2], nodes[3]), edge(nodes[3], nodes[1])]
    : [edge(nodes[4], nodes[5]), edge(nodes[5], nodes[4])],
});
const focus = (page: Page, cycle: number) => page.getByRole("button", { name: new RegExp(`^(?:取消)?聚焦环 ${cycle}：`) });
const graphUrl = (url: string) => new URL(url).pathname.endsWith("/dependency-graph");
const cycleUrl = (url: string, cycle: number) => graphUrl(url) && new URL(url).searchParams.get("cycle") === String(cycle);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function mockApi(page: Page, intercept?: (route: Route, url: URL) => Promise<boolean>) {
  const pageErrors: string[] = [];
  const unexpectedModelRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => window.localStorage.setItem("devatlas-display-scale", "100"));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (/\/(ask|report|test)$/.test(url.pathname) || route.request().method() !== "GET") {
      unexpectedModelRequests.push(`${route.request().method()} ${url.pathname}`);
      await route.fulfill({ status: 500, json: { detail: "Model calls and mutations are forbidden in this synthetic graph fixture" } });
      return;
    }
    if (await intercept?.(route, url)) return;
    let body: unknown = [];
    if (url.pathname === "/api/projects") body = projects;
    else if (/\/projects\/[12]$/.test(url.pathname)) body = projects[Number(url.pathname.at(-1)) - 1];
    else if (url.pathname.endsWith("/dependency-graph")) {
      const cycle = Number(url.searchParams.get("cycle"));
      body = cycle ? focusedGraph(cycle) : graph;
    } else if (url.pathname.endsWith("/structure/summary")) {
      body = { symbol_count: 0, class_count: 0, function_count: 0, import_count: 10, resolved_import_count: 10, issue_count: 0 };
    } else if (url.pathname.endsWith("/files/tree")) body = { project_id: 1, path: "", items: [], total_files: 6 };
    else if (/\/(symbols|imports|issues)$/.test(url.pathname)) body = { items: [], total: 0, limit: 150, offset: 0, has_more: false };
    else if (url.pathname.endsWith("/import-limits")) body = { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 };
    await route.fulfill({ json: body });
  });
  return { pageErrors, unexpectedModelRequests };
}

async function expectNoFailures(page: Page, state: Awaited<ReturnType<typeof mockApi>>) {
  await expect(page.locator(".workspace-error")).toHaveCount(0);
  expect(state.pageErrors).toEqual([]);
  expect(state.unexpectedModelRequests).toEqual([]);
}

async function settleRender(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("双向依赖分居连线两侧，自依赖具有可见闭环和箭头", async ({ page }, testInfo) => {
  const geometryGraph: DependencyGraph = {
    ...graph, truncated: false, total_node_count: 3, total_edge_count: 3, internal_import_count: 6,
    nodes: [nodes[1], nodes[2], nodes[0]],
    edges: [edge(nodes[1], nodes[2]), edge(nodes[2], nodes[1]), edge(nodes[0], nodes[0])],
    cycles: [{ file_ids: [2, 3], paths: [nodes[1].path, nodes[2].path] }, { file_ids: [1], paths: [nodes[0].path] }],
  };
  const state = await mockApi(page, async (route, url) => {
    if (!graphUrl(url.toString())) return false;
    await route.fulfill({ json: geometryGraph });
    return true;
  });
  await page.setViewportSize({ width: 1440, height: 1800 });
  await page.goto("/?section=graph&project=1");
  await expect(page.locator(".dependency-edge")).toHaveCount(3);
  const forward = page.getByRole("button", { name: "src/a.py 导入并依赖 src/b.py，2 条导入" });
  const reverse = page.getByRole("button", { name: "src/b.py 导入并依赖 src/a.py，2 条导入" });
  const centerX = Number(await page.getByRole("button", { name: "选择模块 src/a.py" }).locator("circle").getAttribute("cx"));
  const forwardOffset = Number(await forward.locator(".edge-label").getAttribute("x")) - centerX;
  const reverseOffset = Number(await reverse.locator(".edge-label").getAttribute("x")) - centerX;
  expect(forwardOffset * reverseOffset).toBeLessThan(0);
  expect(Math.abs(forwardOffset - reverseOffset)).toBeGreaterThan(20);
  const loop = page.getByRole("button", { name: "src/global.py 导入并依赖 src/global.py，2 条导入" });
  const loopGeometry = await loop.locator(".edge-line").evaluate((path) => {
    const line = path as SVGPathElement;
    const bounds = line.getBBox();
    return { d: line.getAttribute("d"), length: line.getTotalLength(), width: bounds.width, height: bounds.height, marker: line.getAttribute("marker-end") };
  });
  expect(loopGeometry.d).toContain(" C ");
  expect(loopGeometry.length).toBeGreaterThan(40);
  expect(loopGeometry.width).toBeGreaterThan(15);
  expect(loopGeometry.height).toBeGreaterThan(15);
  expect(loopGeometry.marker).toBe("url(#dependency-arrow-cyclic)");
  await loop.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".edge-direction-detail code")).toHaveText(["src/global.py", "src/global.py"]);
  await page.locator(".dependency-view").screenshot({ path: testInfo.outputPath("dependency-graph-reciprocal-self-loop.png") });
  await expectNoFailures(page, state);
});

test("截断图中的完整循环可聚焦，模块和边支持键盘，筛选和缩放可恢复", async ({ page }, testInfo) => {
  const cycleReads: number[] = [];
  const state = await mockApi(page, async (_route, url) => {
    if (url.pathname.endsWith("/dependency-graph") && url.searchParams.has("cycle")) {
      expect(url.searchParams.get("limit")).toBe("40");
      cycleReads.push(Number(url.searchParams.get("cycle")));
    }
    return false;
  });
  await page.setViewportSize({ width: 1440, height: 1800 });
  await page.goto("/?section=graph&project=1");
  await expect(page.locator(".dependency-node")).toHaveCount(3);
  await expect(page.locator(".graph-notice")).toBeVisible();
  const module = page.getByRole("button", { name: "选择模块 src/b.py" });
  await module.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".node-inspector > code")).toHaveText("src/b.py");
  const dependency = page.getByRole("button", { name: "src/a.py 导入并依赖 src/b.py，2 条导入" });
  await dependency.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".node-inspector")).toContainText("SELECTED DEPENDENCY");
  await expect(page.locator(".edge-lines")).toContainText("第 3 行、第 8 行");
  await module.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".node-inspector > code")).toHaveText("src/b.py");
  await focus(page, 1).click();
  await expect(page.getByRole("button", { name: "选择模块 src/offscreen.py" })).toBeVisible();
  await expect(page.getByRole("button", { name: "选择模块 src/global.py" })).toHaveCount(0);
  await expect(page.locator(".graph-focus-status")).toContainText("3 个节点和 3 条内部依赖边");
  await page.locator(".dependency-view").screenshot({ path: testInfo.outputPath("dependency-graph-focused.png") });
  await page.getByRole("textbox", { name: "筛选模块" }).fill(" NO-SUCH-MODULE ");
  await expect(page.getByText("没有匹配的模块", { exact: true })).toBeVisible();
  await expect(page.locator(".dependency-edge")).toHaveCount(0);
  await expect(page.locator(".node-inspector")).toBeEmpty();
  await page.getByRole("button", { name: "放大依赖图", exact: true }).click();
  await expect(page.locator(".zoom-controls")).toContainText("125%");
  await page.getByRole("button", { name: "退出循环聚焦", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "筛选模块" })).toHaveValue("");
  await expect(page.locator(".zoom-controls")).toContainText("100%");
  await expect(page.locator(".dependency-node")).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(focus(page, 1)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("dependency-graph-narrow.png"), fullPage: true });
  expect(cycleReads).toEqual([1]);
  await expectNoFailures(page, state);
});

test("加载循环时不显示全局模块，取消后立即可重新聚焦", async ({ page }) => {
  const pending = gate();
  const started = gate();
  const finished = gate();
  let calls = 0;
  const state = await mockApi(page, async (route, url) => {
    if (!cycleUrl(url.toString(), 1) || ++calls > 1) return false;
    started.release();
    await pending.promise;
    await route.fulfill({ status: 503, json: { detail: "旧循环迟到错误" } });
    finished.release();
    return true;
  });
  try {
    await page.goto("/?section=graph&project=1");
    await focus(page, 1).click();
    await started.promise;
    await expect(page.locator(".dependency-canvas")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".dependency-node")).toHaveCount(0);
    await expect(page.locator(".node-inspector")).toBeEmpty();
    await expect(page.getByText("没有匹配的模块", { exact: true })).toHaveCount(0);
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => cycleUrl(request.url(), 1) });
    await page.getByRole("button", { name: "退出循环聚焦", exact: true }).click();
    expect((await aborted).failure()?.errorText).toContain("ERR_ABORTED");
    await expect(page.getByRole("button", { name: "选择模块 src/global.py" })).toBeVisible();
    await focus(page, 1).click();
    await expect(page.getByRole("button", { name: "选择模块 src/offscreen.py" })).toBeVisible();
    pending.release();
    await finished.promise;
    await settleRender(page);
    await expect(focus(page, 1)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".graph-focus-error")).toHaveCount(0);
    expect(calls).toBe(2);
    await expectNoFailures(page, state);
  } finally { pending.release(); }
});

test("快速改选取消旧循环，失败循环保持空图且可重试", async ({ page }) => {
  const pending = gate();
  const started = gate();
  const finished = gate();
  let secondCalls = 0;
  const state = await mockApi(page, async (route, url) => {
    if (cycleUrl(url.toString(), 1)) {
      started.release();
      await pending.promise;
      await route.fulfill({ json: focusedGraph(1) });
      finished.release();
      return true;
    }
    if (cycleUrl(url.toString(), 2) && ++secondCalls === 1) {
      await route.fulfill({ status: 503, json: { detail: "当前循环读取失败" } });
      return true;
    }
    return false;
  });
  try {
    await page.goto("/?section=graph&project=1");
    await focus(page, 1).click();
    await started.promise;
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => cycleUrl(request.url(), 1) });
    await focus(page, 2).click();
    expect((await aborted).failure()?.errorText).toContain("ERR_ABORTED");
    await expect(page.locator(".graph-focus-error")).toContainText("当前循环读取失败");
    await expect(page.locator(".dependency-node")).toHaveCount(0);
    await expect(page.locator(".node-inspector")).toBeEmpty();
    await expect(page.getByText("没有匹配的模块", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByRole("button", { name: "选择模块 src/c.py" })).toBeVisible();
    pending.release();
    await finished.promise;
    await settleRender(page);
    await expect(page.locator(".dependency-node")).toHaveCount(2);
    await expect(focus(page, 2)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".graph-focus-error")).toHaveCount(0);
    expect(secondCalls).toBe(2);
    await expectNoFailures(page, state);
  } finally { pending.release(); }
});

for (const outcome of ["success", "error"] as const) {
  test(`离开图谱取消初次读取，迟到${outcome === "success" ? "结果" : "错误"}不污染其他菜单，返回后重读`, async ({ page }) => {
    const pending = gate();
    const started = gate();
    const finished = gate();
    let allowFresh = false;
    const state = await mockApi(page, async (route, url) => {
      if (!graphUrl(url.toString()) || allowFresh) return false;
      started.release();
      await pending.promise;
      await route.fulfill(outcome === "success"
        ? { json: { ...graph, nodes: [node(99, "src/obsolete.py")], edges: [] } }
        : { status: 500, json: { detail: "已离开菜单的图谱失败" } });
      finished.release();
      return true;
    });
    try {
      await page.goto("/?section=graph&project=1");
      await started.promise;
      const aborted = page.waitForEvent("requestfailed", { predicate: (request) => graphUrl(request.url()) });
      await page.locator(".sidebar").getByRole("button", { name: /代码搜索/ }).click();
      expect((await aborted).failure()?.errorText).toContain("ERR_ABORTED");
      await expect(page.getByRole("textbox", { name: "代码搜索关键词" })).toBeVisible();
      allowFresh = true;
      pending.release();
      await finished.promise;
      await settleRender(page);
      await expect(page.locator(".dependency-view")).toHaveCount(0);
      await expectNoFailures(page, state);
      await page.locator(".sidebar").getByRole("button", { name: /依赖图谱/ }).click();
      await expect(page.getByRole("button", { name: "选择模块 src/global.py" })).toBeVisible();
      await expect(page.getByRole("button", { name: "选择模块 src/obsolete.py" })).toHaveCount(0);
      await expectNoFailures(page, state);
    } finally { pending.release(); }
  });
}

test("切换项目取消聚焦请求，图谱状态重置到新项目", async ({ page }) => {
  const pending = gate();
  const started = gate();
  const state = await mockApi(page, async (route, url) => {
    if (!cycleUrl(url.toString(), 1)) return false;
    started.release();
    await pending.promise;
    await route.fulfill({ json: focusedGraph(1) });
    return true;
  });
  try {
    await page.goto("/?section=graph&project=1");
    await focus(page, 1).click();
    await started.promise;
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => cycleUrl(request.url(), 1) });
    await page.locator(".project-trigger").click();
    await page.locator(".project-option").filter({ hasText: "graph-fixture-2" }).click();
    expect((await aborted).failure()?.errorText).toContain("ERR_ABORTED");
    await expect(page.locator(".topbar h1")).toHaveText("graph-fixture-2");
    await expect(page.getByRole("button", { name: "选择模块 src/global.py" })).toBeVisible();
    await expect(focus(page, 1)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".graph-focus-status")).toHaveCount(0);
    await expectNoFailures(page, state);
  } finally { pending.release(); }
});
