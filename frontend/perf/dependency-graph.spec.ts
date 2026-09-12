import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, test, type Page } from "@playwright/test";
import type { DependencyGraph } from "../src/types";

const REPETITIONS = 3;
const FOCUS_SIZES = [240, 400];
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

function buildMetadata() {
  const build = process.env.DEVATLAS_GRAPH_BENCHMARK_BUILD === "production" ? "production" : "development";
  const assets = build === "production" && existsSync(resolve("dist/assets")) ? readdirSync(resolve("dist/assets")).filter((name) => /\.(js|css|map)$/.test(name)).sort() : [];
  return { build_mode: build, bundle_sha256: Object.fromEntries(assets.map((name) => [`dist/assets/${name}`, createHash("sha256").update(readFileSync(resolve("dist/assets", name))).digest("hex")])) };
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

test("synthetic dependency graph rendering and interactions", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  const label = process.env.DEVATLAS_GRAPH_BENCHMARK_LABEL ?? "baseline";
  if (!["baseline", "after"].includes(label)) throw new Error("Benchmark label must be baseline or after");
  const build = buildMetadata();
  // Reproductions can target a fresh D: tmp directory without overwriting the
  // checked-in historical runs. The profiler reads from the same directory.
  const outputDirectory = resolve(process.env.DEVATLAS_GRAPH_BENCHMARK_OUTPUT_DIR ?? "../docs/performance");
  const output = resolve(outputDirectory, `dependency-graph-${build.build_mode === "production" ? "production-" : ""}${label}.json`);
  if (build.build_mode === "production" && existsSync(output)) throw new Error(`Refusing to overwrite historical benchmark: ${output}`);
  const sources = ["src/App.tsx", "src/api.ts", "src/workspaces/DependencyGraphView.tsx", "src/workspaces/dependencyGraphModel.ts", "src/styles.css", "src/terminal-theme.css", "perf/dependency-graph.spec.ts"];
  const hashes = Object.fromEntries(sources.filter((name) => existsSync(resolve(name))).map((name) => [name, createHash("sha256").update(readFileSync(resolve(name))).digest("hex")]));
  const results: Record<string, unknown>[] = [];
  let environment: Record<string, unknown> = {};
  for (const focusSize of FOCUS_SIZES) {
    const { initial, focused } = fixture(focusSize);
    for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      const graphRequests: { limit: string | null; cycle: string | null; nodes: number; edges: number }[] = [];
      const pageErrors: string[] = [];
      const unexpectedRequests: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const project = { id: 1, name: "graph-benchmark", source_filename: "synthetic/", status: "ready", primary_language: "Python", file_count: initial.total_node_count, code_line_count: initial.total_node_count * 180, created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z" };
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        let body: unknown = [];
        if (route.request().method() !== "GET") {
          unexpectedRequests.push(`${route.request().method()} ${url.pathname}`);
          await route.abort();
          return;
        }
        if (url.pathname === "/api/projects") body = [project];
        else if (url.pathname === "/api/projects/1") body = project;
        else if (url.pathname.endsWith("/structure/summary")) body = { symbol_count: project.file_count, class_count: 0, function_count: project.file_count, import_count: initial.internal_import_count, resolved_import_count: initial.internal_import_count, issue_count: 0 };
        else if (url.pathname.endsWith("/dependency-graph")) {
          const cycle = url.searchParams.get("cycle");
          expect(url.searchParams.get("limit")).toBe("40");
          if (cycle !== null) expect(cycle).toBe("1");
          const graph = cycle === "1" ? focused : initial;
          graphRequests.push({ limit: url.searchParams.get("limit"), cycle, nodes: graph.nodes.length, edges: graph.edges.length });
          body = graph;
        } else if (url.pathname.endsWith("/files/tree")) body = { path: "", total_files: project.file_count, total_items: 0, limit: 200, offset: 0, has_more: false, items: [] };
        else if (url.pathname.endsWith("/import-limits")) body = { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 };
        else if (/\/(symbols|imports|issues)$/.test(url.pathname)) body = { items: [], total: 0, limit: 150, offset: 0, has_more: false };
        await route.fulfill({ json: body });
      });
      const heap = async () => {
        await cdp.send("HeapProfiler.collectGarbage");
        const usage = await cdp.send("Runtime.getHeapUsage");
        return { used_js_heap_bytes_after_forced_gc: usage.usedSize, total_js_heap_bytes_after_forced_gc: usage.totalSize };
      };
      const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((entry) => [entry.name, entry.value]));
      const actions: Record<string, unknown>[] = [];
      const measure = async (name: string, action: () => Promise<void>) => {
        const before = await metrics();
        const started = performance.now();
        await action();
        await paint(page);
        const elapsed = performance.now() - started;
        const after = await metrics();
        actions.push({ action: name, automation_and_two_frames_ms: round(elapsed), browser_script_ms: round((after.ScriptDuration - before.ScriptDuration) * 1000), browser_task_ms: round((after.TaskDuration - before.TaskDuration) * 1000), browser_layout_ms: round((after.LayoutDuration - before.LayoutDuration) * 1000), browser_recalc_style_ms: round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000), ...await graphDOM(page) });
      };
      const counts = async (graph: DependencyGraph) => {
        await expect(page.locator(".dependency-node")).toHaveCount(graph.nodes.length);
        await expect(page.locator(".dependency-edge")).toHaveCount(graph.edges.length);
        await expect(page.locator(".cycle-row")).toHaveCount(20);
        await expect(page.locator(".graph-toolbar small")).toHaveText(`当前显示 ${graph.nodes.length} 个模块 / ${graph.edges.length} 条边`);
      };
      const interact = async (graph: DependencyGraph, prefix: string) => {
        const target = graph.nodes[30];
        await measure(`${prefix}_node_select`, async () => {
          // Dense rings overlap: dispatch the existing SVG click handler directly.
          await page.locator(".dependency-node").nth(30).dispatchEvent("click");
          await expect(page.locator(".node-inspector > code")).toHaveText(target.path);
          await expect(page.locator(".dependency-node.selected title")).toContainText(target.path);
        });
        await measure(`${prefix}_edge_select`, async () => {
          await page.locator(".dependency-edge").first().press("Enter");
          await expect(page.locator(".node-inspector .eyebrow")).toHaveText("SELECTED DEPENDENCY");
          await expect(page.locator(".dependency-edge.selected")).toHaveCount(1);
          await expect(page.locator(".edge-direction-detail code").first()).toHaveText(graph.edges[0].source_path);
          await expect(page.locator(".edge-lines")).toContainText(`第 ${graph.edges[0].line_numbers[0]} 行`);
        });
        await measure(`${prefix}_edge_back`, async () => {
          await page.getByRole("button", { name: "返回模块详情" }).click();
          await expect(page.locator(".node-inspector > code")).toHaveText(target.path);
        });
        await measure(`${prefix}_zoom_in`, async () => {
          await page.locator(".zoom-controls button").last().click();
          await expect(page.locator(".zoom-controls span")).toHaveText("125%");
          await counts(graph);
        });
        await measure(`${prefix}_zoom_out`, async () => {
          await page.locator(".zoom-controls button").first().click();
          await expect(page.locator(".zoom-controls span")).toHaveText("100%");
        });
        const query = "module_000";
        const filteredNodes = graph.nodes.filter((node) => node.path.includes(query));
        const filteredIds = new Set(filteredNodes.map((node) => node.id));
        const filteredEdges = graph.edges.filter((edge) => filteredIds.has(edge.source_id) && filteredIds.has(edge.target_id));
        await measure(`${prefix}_filter_hit`, async () => {
          await page.getByPlaceholder("输入文件名或路径").fill(query);
          await expect(page.locator(".dependency-node")).toHaveCount(filteredNodes.length);
          await expect(page.locator(".dependency-edge")).toHaveCount(filteredEdges.length);
        });
        await measure(`${prefix}_filter_nohit`, async () => {
          await page.getByPlaceholder("输入文件名或路径").fill("no_such_dependency_module");
          await expect(page.locator(".dependency-node")).toHaveCount(0);
          await expect(page.locator(".dependency-edge")).toHaveCount(0);
          await expect(page.locator(".no-filter-result")).toHaveText("没有匹配的模块");
        });
        await measure(`${prefix}_filter_clear`, async () => {
          await page.getByPlaceholder("输入文件名或路径").fill("");
          await counts(graph);
        });
      };
      try {
        await page.goto("/?section=search&project=1");
        await expect(page.getByRole("textbox", { name: "代码搜索关键词" })).toBeVisible();
        await paint(page);
        const shellHeap = await heap();
        await measure("initial_graph_open", async () => {
          await page.locator(".nav-item").filter({ hasText: "依赖图谱" }).click();
          await counts(initial);
        });
        const initialDOM = await graphDOM(page);
        const initialHeap = await heap();
        await interact(initial, "default_40");
        await measure("cycle_focus", async () => {
          await page.locator(".cycle-row").first().click();
          await counts(focused);
          await expect(page.locator(".graph-focus-status")).toHaveAttribute("aria-busy", "false");
        });
        const focusedDOM = await graphDOM(page);
        const focusedHeap = await heap();
        await interact(focused, `focused_${focusSize}`);
        await measure("cycle_exit", async () => {
          await page.getByRole("button", { name: "退出循环聚焦" }).click();
          await counts(initial);
          await expect(page.locator(".graph-focus-status")).toHaveCount(0);
        });
        const exitedHeap = await heap();
        expect(graphRequests.filter((request) => request.cycle === "1")).toHaveLength(1);
        expect(pageErrors).toEqual([]);
        expect(unexpectedRequests).toEqual([]);
        environment = { browser_version: browser.version(), user_agent: await page.evaluate(() => navigator.userAgent), viewport: { width: 1440, height: 1000 }, node_version: process.version, platform: process.platform };
        results.push({ focus_size: focusSize, repetition, fixture_sha256: createHash("sha256").update(JSON.stringify({ initial, focused })).digest("hex"), total_nodes: initial.total_node_count, total_edges: initial.total_edge_count, initial_nodes: initial.nodes.length, initial_edges: initial.edges.length, focused_nodes: focused.nodes.length, focused_edges: focused.edges.length, cycle_rows: initial.cycles.length, initial_dom: initialDOM, focused_dom: focusedDOM, shell_heap: shellHeap, initial_heap: initialHeap, focused_heap: focusedHeap, exited_heap: exitedHeap, actions, graph_requests: graphRequests, page_errors: pageErrors, unexpected_requests: unexpectedRequests });
        console.log(`${label}: focus ${focusSize}, sample ${repetition}; default ${initial.nodes.length}/${initial.edges.length}; focused ${focused.nodes.length}/${focused.edges.length}; ${actions.length} verified actions`);
      } finally {
        await cdp.detach();
        await page.close();
      }
    }
  }
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(output, `${JSON.stringify({ schema_version: 2, label, ...build, captured_at: new Date().toISOString(), implementation_sha256: hashes, environment, repetitions: REPETITIONS, focus_sizes: FOCUS_SIZES, method: { isolation: "Synthetic GET API route mocks only; mutation requests fail. Playwright uses isolated 8011/5175 services and D: runtime; no user repository or model requests.", limits: "Default UI requests limit=40. Focused cycle endpoint returns all SCC members regardless of limit, matching existing service behavior. Two fixtures focus 240 or 400 nodes; all 20 reported SCCs are disjoint and connected internally. Each large SCC node has 5 outgoing edges, each edge has 3 import line numbers.", timings: "Each of 3 samples per fixture uses an independent browser page. Node monotonic elapsed time includes Playwright IPC, action, assertions and two animation frames. Browser script/task milliseconds are CDP cumulative metric deltas over the same interval; these include benchmark browser work and are diagnostic, not isolated application CPU. Dense SVG node selection dispatches click directly; edge selection uses Enter; other interactions use normal Playwright click/fill. No timing is asserted as a pass/fail threshold.", counts: "Every sample verifies all 40 default nodes, all 240/400 focused nodes, all induced edges, 20 cycle rows and identical filtered counts. No culling, reduced fixtures, pagination, or hidden graph elements are used as performance shortcuts. Fixture and implementation SHA-256 hashes permit comparison.", memory: "CDP Runtime.getHeapUsage after forced HeapProfiler.collectGarbage; diagnostic JS heap only, not browser RSS or natural GC. Collections are outside timed interaction intervals.", interpretation: "Three raw samples are descriptive only and do not establish statistical significance; first graph navigation can include browser/application warmup. Build mode and bundle hashes distinguish production preview from Vite development. Production sourcemaps are local profiling artifacts, not a published configuration change." }, results }, null, 2)}\n`);
  await testInfo.attach("dependency-graph-benchmark", { path: output, contentType: "application/json" });
});
