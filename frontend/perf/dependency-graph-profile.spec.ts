import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
// This opt-in diagnostic reuses Vite's installed source-map tooling; it adds no
// runtime dependency. Raw profiles stay under the ignored D: workspace tmp root.
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import type { DependencyGraph } from "../src/types";

const round = (value: number) => Number(value.toFixed(2));
async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}
async function graphDOM(page: Page) {
  return page.evaluate(() => {
    const graph = document.querySelector(".dependency-view");
    const countText = (root: Node | null) => {
      if (!root) return 0;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let count = 0;
      while (walker.nextNode()) count++;
      return count;
    };
    return {
      live_graph_elements: document.querySelector(".dependency-view")?.querySelectorAll("*").length ?? 0,
      live_nodes: document.querySelectorAll(".dependency-node").length,
      live_edges: document.querySelectorAll(".dependency-edge").length,
      live_cycle_rows: document.querySelectorAll(".cycle-row").length,
      live_node_labels: document.querySelectorAll(".dependency-node text").length,
      live_edge_labels: document.querySelectorAll(".dependency-edge text").length,
      live_document_elements: document.querySelectorAll("*").length,
      live_graph_text_nodes: countText(graph),
      live_graph_title_text_nodes: Array.from(graph?.querySelectorAll("title") ?? []).reduce((sum, title) => sum + countText(title), 0),
      live_graph_svg_label_text_nodes: Array.from(graph?.querySelectorAll("text") ?? []).reduce((sum, label) => sum + countText(label), 0),
    };
  });
}

function fixture(focusSize: number) {
  const nodes: DependencyGraph["nodes"] = [];
  const edges: DependencyGraph["edges"] = [];
  const cycles: DependencyGraph["cycles"] = [];
  // One large SCC and 19 small, disjoint SCCs match the service's 20-row cap.
  for (let component = 0; component < 20; component++) {
    const count = component === 0 ? focusSize : 3;
    const members = Array.from({ length: count }, (_, index) => ({
      id: nodes.length + index + 1,
      path: `src/${component === 0 ? "domain" : `plugin_${String(component).padStart(2, "0")}`}/module_${String(index).padStart(4, "0")}.py`,
      language: "Python",
      in_degree: component === 0 ? 5 : 2,
      out_degree: component === 0 ? 5 : 2,
    }));
    nodes.push(...members);
    cycles.push({ file_ids: members.map((node) => node.id), paths: members.map((node) => node.path) });
    members.forEach((source, index) => {
      for (const hop of component === 0 ? [1, -1, 3, 7, 13] : [1, -1]) {
        const target = members[(index + hop + count) % count];
        const lineNumbers = [5 + (index % 30), 60 + Math.abs(hop), 120 + (index % 50)];
        edges.push({ source_id: source.id, target_id: target.id, source_path: source.path, target_path: target.path, import_count: lineNumbers.length, line_numbers: lineNumbers });
      }
    });
  }
  const common = {
    total_node_count: nodes.length, total_edge_count: edges.length,
    internal_import_count: edges.length * 3, external_import_count: 20, unresolved_import_count: 2,
    classified_import_count: edges.length * 3 + 20,
    classification_confidence: round((edges.length * 3 + 20) / (edges.length * 3 + 22) * 100),
    confidence_level: "high" as const, cycle_count: cycles.length, cycles,
  };
  const initial: DependencyGraph = { ...common, truncated: true, nodes: nodes.slice(0, 40), edges: edges.filter((edge) => edge.source_id <= 40 && edge.target_id <= 40) };
  const focused: DependencyGraph = { ...common, truncated: false, nodes: nodes.slice(0, focusSize), edges: edges.filter((edge) => edge.source_id <= focusSize && edge.target_id <= focusSize) };
  return { initial, focused };
}


type ProfileNode = {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children?: number[];
};
type Profile = { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[]; startTime: number; endTime: number };

function summarize(profile: Profile) {
  const maps = new Map(readdirSync(resolve("dist/assets")).filter((name) => name.endsWith(".js.map")).map((name) => [
    name.slice(0, -4), new TraceMap(JSON.parse(readFileSync(resolve("dist/assets", name), "utf8"))),
  ]));
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const self = new Map<number, number>();
  const inclusive = new Map<number, number>();
  for (const [index, sample] of (profile.samples ?? []).entries()) {
    const duration = (profile.timeDeltas?.[index] ?? 0) / 1000;
    self.set(sample, (self.get(sample) ?? 0) + duration);
    let current: number | undefined = sample;
    const visited = new Set<number>();
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      inclusive.set(current, (inclusive.get(current) ?? 0) + duration);
      current = parents.get(current);
    }
  }
  const describe = (id: number) => {
    const frame = nodes.get(id)!.callFrame;
    const fileName = frame.url ? basename(new URL(frame.url, "http://localhost").pathname) : "";
    const map = maps.get(fileName);
    const original = map && frame.lineNumber >= 0
      ? originalPositionFor(map, { line: frame.lineNumber + 1, column: frame.columnNumber }) : null;
    return { function: original?.name || frame.functionName || "(anonymous)", source: original?.source ?? (frame.url || "(browser)"), line: original?.line ?? frame.lineNumber + 1, column: original?.column ?? frame.columnNumber, generated_function: frame.functionName };
  };
  const ranked = (durations: Map<number, number>) => [...durations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([id, ms]) => ({ ...describe(id), sampled_ms: round(ms) }));
  const sourceTotals = new Map<string, number>();
  for (const [id, duration] of self) {
    const item = describe(id);
    const key = item.source === "(browser)" ? item.function : item.source;
    sourceTotals.set(key, (sourceTotals.get(key) ?? 0) + duration);
  }
  return {
    samples: profile.samples?.length ?? 0,
    sampled_duration_ms: round([...self.values()].reduce((sum, value) => sum + value, 0)),
    profiler_duration_ms: round((profile.endTime - profile.startTime) / 1000),
    self_by_source: [...sourceTotals.entries()].sort((a, b) => b[1] - a[1]).map(([source, ms]) => ({ source, sampled_ms: round(ms) })),
    top_self: ranked(self), top_inclusive: ranked(inclusive),
  };
}

test("production dependency graph isolated CPU profiles", async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000);
  if (process.env.DEVATLAS_GRAPH_BENCHMARK_BUILD !== "production") test.skip(true, "Requires a fixed production bundle");
  const label = process.env.DEVATLAS_GRAPH_BENCHMARK_LABEL ?? "baseline";
  if (!["baseline", "after"].includes(label)) throw new Error("Invalid profile label");
  const outputDirectory = resolve(process.env.DEVATLAS_GRAPH_BENCHMARK_OUTPUT_DIR ?? "../docs/performance");
  const output = resolve(outputDirectory, `dependency-graph-production-${label}-profile.json`);
  if (existsSync(output)) throw new Error(`Refusing to overwrite historical profile: ${output}`);
  const benchmark = JSON.parse(readFileSync(resolve(outputDirectory, `dependency-graph-production-${label}.json`), "utf8"));
  const actualBundle = Object.fromEntries(readdirSync(resolve("dist/assets")).filter((name) => /\.(js|css|map)$/.test(name)).sort().map((name) => [
    `dist/assets/${name}`, createHash("sha256").update(readFileSync(resolve("dist/assets", name))).digest("hex"),
  ]));
  expect(actualBundle).toEqual(benchmark.bundle_sha256);
  const { initial, focused } = fixture(400);
  const fixtureSha = createHash("sha256").update(JSON.stringify({ initial, focused })).digest("hex");
  expect(fixtureSha).toBe(benchmark.results.find((result: { focus_size: number }) => result.focus_size === 400).fixture_sha256);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests: string[] = [];
  const project = { id: 1, name: "graph-benchmark", source_filename: "synthetic/", status: "ready", primary_language: "Python", file_count: initial.total_node_count, code_line_count: initial.total_node_count * 180, created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z" };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") {
      errors.push(`${route.request().method()} ${url.pathname}`); await route.abort(); return;
    }
    let body: unknown = [];
    if (url.pathname === "/api/projects") body = [project];
    else if (url.pathname === "/api/projects/1") body = project;
    else if (url.pathname.endsWith("/structure/summary")) body = { symbol_count: project.file_count, class_count: 0, function_count: project.file_count, import_count: initial.internal_import_count, resolved_import_count: initial.internal_import_count, issue_count: 0 };
    else if (url.pathname.endsWith("/dependency-graph")) {
      requests.push(url.pathname + url.search);
      expect(url.searchParams.get("limit")).toBe("40");
      const cycle = url.searchParams.get("cycle");
      expect(cycle === null || cycle === "1").toBe(true);
      body = cycle === "1" ? focused : initial;
    } else if (url.pathname.endsWith("/files/tree")) body = { path: "", total_files: project.file_count, total_items: 0, limit: 200, offset: 0, has_more: false, items: [] };
    else if (url.pathname.endsWith("/import-limits")) body = { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 };
    else if (/\/(symbols|imports|issues)$/.test(url.pathname)) body = { items: [], total: 0, limit: 150, offset: 0, has_more: false };
    await route.fulfill({ json: body });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  const rawParent = resolve("../data/tmp/graph-profiles");
  mkdirSync(rawParent, { recursive: true });
  const rawDirectory = mkdtempSync(resolve(rawParent, `production-${label}-`));
  const records: Record<string, unknown>[] = [];
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]));
  const profileAction = async (name: string, action: () => Promise<void>) => {
    const before = await metrics();
    await cdp.send("Profiler.start");
    await action();
    await paint(page);
    const { profile } = await cdp.send("Profiler.stop");
    const after = await metrics();
    const raw = JSON.stringify(profile);
    const rawPath = resolve(rawDirectory, `${name}.cpuprofile`);
    writeFileSync(rawPath, raw);
    records.push({
      action: name, ...summarize(profile), ...await graphDOM(page),
      browser_script_ms: round((after.ScriptDuration - before.ScriptDuration) * 1000),
      browser_task_ms: round((after.TaskDuration - before.TaskDuration) * 1000),
      browser_layout_ms: round((after.LayoutDuration - before.LayoutDuration) * 1000),
      browser_recalc_style_ms: round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000),
      raw_profile: relative(resolve(".."), rawPath).replaceAll("\\", "/"),
      raw_profile_sha256: createHash("sha256").update(raw).digest("hex"),
    });
  };
  try {
    await page.goto("/?section=search&project=1");
    await expect(page.getByRole("textbox", { name: "代码搜索关键词" })).toBeVisible();
    await page.locator(".nav-item").filter({ hasText: "依赖图谱" }).click();
    await expect(page.locator(".dependency-node")).toHaveCount(40);
    // Warm the ordinary graph and leave the same cleared filter state as timed runs.
    await page.locator(".dependency-node").nth(30).dispatchEvent("click");
    await page.getByPlaceholder("输入文件名或路径").fill("no_such_dependency_module");
    await expect(page.locator(".dependency-node")).toHaveCount(0);
    await page.getByPlaceholder("输入文件名或路径").fill("");
    await expect(page.locator(".dependency-node")).toHaveCount(40);
    await paint(page);
    await profileAction("cycle_focus_400", async () => {
      await page.locator(".cycle-row").first().click();
      await expect(page.locator(".dependency-node")).toHaveCount(400);
      await expect(page.locator(".dependency-edge")).toHaveCount(2000);
      await expect(page.locator(".graph-focus-status")).toHaveAttribute("aria-busy", "false");
    });
    await page.getByPlaceholder("输入文件名或路径").fill("module_000");
    await expect(page.locator(".dependency-node")).toHaveCount(10);
    await page.getByPlaceholder("输入文件名或路径").fill("no_such_dependency_module");
    await expect(page.locator(".dependency-node")).toHaveCount(0);
    await paint(page);
    await profileAction("filter_clear_400", async () => {
      await page.getByPlaceholder("输入文件名或路径").fill("");
      await expect(page.locator(".dependency-node")).toHaveCount(400);
      await expect(page.locator(".dependency-edge")).toHaveCount(2000);
    });
    expect(errors).toEqual([]);
    writeFileSync(output, JSON.stringify({
      schema_version: 1, label, build_mode: "production", captured_at: new Date().toISOString(),
      bundle_sha256: actualBundle, fixture_sha256: fixtureSha, browser_version: browser.version(),
      method: "Independent diagnostic pass, NOT one of the 3 timed samples. CDP CPU sampling interval 500 microseconds; sourcemaps resolve locally built bundle positions. Inclusive samples overlap and must not be summed. Browser native work can be attributed to the active JavaScript frame; style/layout counters are independent cumulative metrics. One profile per action is diagnostic, not a statistical performance claim. All API requests mocked; raw profiles stay in ignored D: workspace temporary storage. App source can change after the frozen benchmark build: bundle hashes, not current working tree hashes, identify this profile.",
      requests, errors, profiles: records,
    }, null, 2) + "\n");
    await testInfo.attach("dependency-graph-production-profile", { path: output, contentType: "application/json" });
  } finally {
    await cdp.detach();
  }
});
