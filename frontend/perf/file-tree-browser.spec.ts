import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, test, type Page } from "@playwright/test";

const PAGE_SIZE = 200;
const SIZES = [450, 2000, 5000];
const REPETITIONS = 3;
const round = (value: number) => Number(value.toFixed(2));

async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(() => resolvePaint()))));
}

async function treeDOM(page: Page) {
  return page.evaluate(() => ({
    live_tree_elements: document.querySelector(".file-tree")?.querySelectorAll("*").length ?? 0,
    live_file_rows: document.querySelectorAll(".file-tree-file").length,
    live_document_elements: document.querySelectorAll("*").length,
  }));
}

test("synthetic paged file-tree browser benchmark", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  const label = process.env.DEVATLAS_TREE_BENCHMARK_LABEL ?? "baseline";
  const hashes = Object.fromEntries(["src/workspaces/FileTree.tsx", "src/workspaces/FileTreeFilePages.tsx", "src/workspaces/fileTreeCache.ts", "src/App.tsx", "src/styles.css", "src/terminal-theme.css", "perf/file-tree-browser.spec.ts"].filter((file) => existsSync(resolve(file))).map((file) => [file, createHash("sha256").update(readFileSync(resolve(file))).digest("hex")]));
  const results: Record<string, unknown>[] = [];
  let environment: Record<string, unknown> = {};
  for (const size of SIZES) {
    for (let repetition = 0; repetition < REPETITIONS; repetition++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const cdp = await page.context().newCDPSession(page);
      const reads: { path: string; offset: number; returned: number }[] = [];
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.addInitScript(() => {
        const target = window as typeof window & { benchmarkLongTasks: { start: number; duration: number }[] };
        target.benchmarkLongTasks = [];
        if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
          new PerformanceObserver((list) => {
            target.benchmarkLongTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })));
          }).observe({ type: "longtask", buffered: true });
        }
      });
      const project = { id: 1, name: `tree-benchmark-${size}`, source_filename: "synthetic/", status: "ready", primary_language: "Python", file_count: size, code_line_count: size * 5, created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z" };
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        let body: unknown = [];
        if (url.pathname === "/api/projects") body = [project];
        else if (url.pathname === "/api/projects/1") body = project;
        else if (url.pathname.endsWith("/structure/summary")) body = { symbol_count: size, class_count: 0, function_count: size, import_count: 0, resolved_import_count: 0, issue_count: 0 };
        else if (url.pathname.endsWith("/files/tree")) {
          const path = url.searchParams.get("path") ?? "";
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? PAGE_SIZE);
          expect(limit).toBe(PAGE_SIZE);
          expect(["", "src"]).toContain(path);
          const total = path ? size : 1;
          const items = path
            ? Array.from({ length: Math.max(0, Math.min(limit, size - offset)) }, (_, index) => ({ id: offset + index + 1, kind: "file", name: `file_${String(offset + index).padStart(5, "0")}.py`, path: `src/file_${String(offset + index).padStart(5, "0")}.py`, file_count: 1, extension: ".py", line_count: 5, size_bytes: 80, language: "Python" }))
            : [{ kind: "directory", name: "src", path: "src", file_count: size, id: null, extension: null, line_count: null, size_bytes: null, language: null }];
          reads.push({ path, offset, returned: items.length });
          body = { path, total_files: size, total_items: total, limit, offset, has_more: offset + items.length < total, items };
        } else if (url.pathname.endsWith("/import-limits")) body = { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 };
        else if (/\/(symbols|imports|issues)$/.test(url.pathname)) body = { items: [], total: 0, limit: 150, offset: 0, has_more: false };
        if (/\/(ask|report|test)$/.test(url.pathname)) throw new Error(`Unexpected model request: ${url.pathname}`);
        await route.fulfill({ json: body });
      });
      const heap = async () => {
        await cdp.send("HeapProfiler.collectGarbage");
        const usage = await cdp.send("Runtime.getHeapUsage");
        const dom = await cdp.send("Memory.getDOMCounters");
        return { used_js_heap_bytes_after_forced_gc: usage.usedSize, total_js_heap_bytes_after_forced_gc: usage.totalSize, cdp_dom_nodes: dom.nodes, cdp_event_listeners: dom.jsEventListeners };
      };
      try {
        // Warm the Vite module graph and application shell; independent browser pages
        // keep a previous sample's accumulated tree/cache from entering this one.
        await page.goto("/?section=search&project=1");
        await expect(page.getByRole("textbox", { name: "代码搜索关键词" })).toBeVisible();
        await paint(page);
        const shellHeap = await heap();
        let started = performance.now();
        await page.locator(".nav-item").filter({ hasText: "仓库概览" }).click();
        await expect(page.getByRole("button", { name: /^src 目录/ })).toBeVisible();
        await paint(page);
        const rootMs = round(performance.now() - started);
        const directory = page.getByRole("button", { name: /^src 目录/ });
        started = performance.now();
        await directory.click();
        const more = page.getByRole("button", { name: "加载src的更多条目", exact: true });
        await expect(more).toContainText(`200 / ${size.toLocaleString("en-US")}`);
        await paint(page);
        const firstPageMs = round(performance.now() - started);
        const firstPageDOM = await treeDOM(page);
        const append: { offset: number; elapsed_ms: number; live_file_rows: number; live_tree_elements: number; live_document_elements: number }[] = [];
        for (let offset = PAGE_SIZE; offset < size; offset += PAGE_SIZE) {
          started = performance.now();
          // Native DOM click avoids including arbitrary automatic scrolling in the
          // append metric; it still invokes the application's real click handler.
          await more.evaluate((button: HTMLButtonElement) => button.click());
          const loaded = Math.min(size, offset + PAGE_SIZE);
          if (loaded < size) await expect(more).toContainText(`${loaded.toLocaleString("en-US")} / ${size.toLocaleString("en-US")}`);
          else await expect(more).toHaveCount(0);
          await paint(page);
          append.push({ offset, elapsed_ms: round(performance.now() - started), ...await treeDOM(page) });
        }
        const loadedReads = reads.filter((entry) => entry.path === "src");
        expect([...new Set(loadedReads.map((entry) => entry.offset))]).toEqual(Array.from({ length: Math.ceil(size / PAGE_SIZE) }, (_, index) => index * PAGE_SIZE));
        const loadedDOM = await treeDOM(page);
        const loadedHeap = await heap();
        const beforeCollapseReads = reads.length;
        started = performance.now();
        await directory.click();
        await expect(directory).toHaveAttribute("aria-expanded", "false");
        await paint(page);
        const collapseMs = round(performance.now() - started);
        const collapsedDOM = await treeDOM(page);
        const collapsedHeap = await heap();
        started = performance.now();
        await directory.click();
        await expect(directory).toHaveAttribute("aria-expanded", "true");
        // A directory larger than the inactive cache budget can be re-fetched.
        // Wait for its actual first page instead of timing only the open chevron.
        await expect(more.or(page.getByText(`已显示全部 ${size.toLocaleString("en-US")} 个直接子项`, { exact: true }))).toBeVisible();
        if (await more.count()) await expect(more).toBeEnabled();
        await paint(page);
        const reopenMs = round(performance.now() - started);
        const reopenDOM = await treeDOM(page);
        const reopenPagination = await more.count() ? await more.innerText() : await page.locator(".file-tree-loading[role='status']").allTextContents();
        const reopenedLoadedRecords = typeof reopenPagination === "string" ? Number(reopenPagination.match(/已显示\s+([\d,]+)\s*\//)?.[1].replaceAll(",", "")) : size;
        expect(Number.isFinite(reopenedLoadedRecords)).toBe(true);
        const reopenReads = reads.length - beforeCollapseReads;
        const beforeMenuReads = reads.length;
        started = performance.now();
        await page.locator(".nav-item").filter({ hasText: "代码搜索" }).click();
        await expect(page.getByRole("textbox", { name: "代码搜索关键词" })).toBeVisible();
        await paint(page);
        const leaveMenuMs = round(performance.now() - started);
        const hiddenDOM = await treeDOM(page);
        const hiddenHeap = await heap();
        started = performance.now();
        await page.locator(".nav-item").filter({ hasText: "仓库概览" }).click();
        await expect(directory).toBeVisible();
        await paint(page);
        const returnMenuMs = round(performance.now() - started);
        const returnedDOM = await treeDOM(page);
        const returnedPagination = await more.count() ? await more.innerText() : await page.locator(".file-tree-loading[role='status']").allTextContents();
        const returnedHeap = await heap();
        expect(pageErrors).toEqual([]);
        const browserState = await page.evaluate(() => ({ user_agent: navigator.userAgent, longtask_supported: PerformanceObserver.supportedEntryTypes.includes("longtask"), longtasks: (window as typeof window & { benchmarkLongTasks: { start: number; duration: number }[] }).benchmarkLongTasks }));
        environment = { browser_version: browser.version(), user_agent: browserState.user_agent, longtask_supported: browserState.longtask_supported, viewport: { width: 1440, height: 1000 }, platform: process.platform, node_version: process.version };
        results.push({ size, repetition: repetition + 1, root_ms: rootMs, first_page_ms: firstPageMs, append_pages: append, collapse_ms: collapseMs, reopen_ms: reopenMs, leave_menu_ms: leaveMenuMs, return_menu_ms: returnMenuMs, first_page_dom: firstPageDOM, loaded_dom: loadedDOM, collapsed_dom: collapsedDOM, reopened_dom: reopenDOM, reopened_loaded_records: reopenedLoadedRecords, reopened_pagination: reopenPagination, hidden_dom: hiddenDOM, returned_dom: returnedDOM, returned_pagination: returnedPagination, shell_heap: shellHeap, loaded_heap: loadedHeap, collapsed_heap: collapsedHeap, hidden_heap: hiddenHeap, returned_heap: returnedHeap, reopen_additional_requests: reopenReads, menu_roundtrip_additional_requests: reads.length - beforeMenuReads, requests: reads, longtasks: browserState.longtasks });
        console.log(`${label}: ${size} files sample ${repetition + 1}; loaded rows=${loadedDOM.live_file_rows}; reopen=${reopenMs}ms; menu=${returnMenuMs}ms`);
      } finally {
        await cdp.detach();
        await page.close();
      }
    }
  }
  const output = resolve("../docs/performance", `file-tree-browser-${label}.json`);
  mkdirSync(resolve("../docs/performance"), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ schema_version: 1, label, captured_at: new Date().toISOString(), implementation_sha256: hashes, environment, repetitions: REPETITIONS, sizes: SIZES, page_size: PAGE_SIZE, method: { isolation: "Synthetic route-fulfilled metadata only; all /api calls intercepted; existing isolated Playwright services at 8011/5175 with per-run D: runtime, no user database, model calls, imports or network repository access.", timings: "Warm Vite application shell, independent browser page per sample. Node monotonic elapsed time includes Playwright IPC, waits and two animation frames. Append uses native DOM click, other interactions use Playwright click. Three samples per size, raw values only, not evidence of statistical significance.", loaded_records: "Validated from page offsets and visible pagination counts, never inferred from mounted DOM rows. Pages requested one at a time through the actual load-more handler.", memory: "Chrome CDP Runtime.getHeapUsage after explicit HeapProfiler.collectGarbage; diagnostic JS heap only, not process RSS and not a measurement of natural automatic GC. CDP DOM counters may include detached nodes. Heap collection excluded from interaction timing.", longtasks: "Optional browser PerformanceObserver longtask entries (>50ms), recorded over the whole sample including setup and diagnostic GC; not attributed to individual interactions." }, results }, null, 2)}\n`);
  await testInfo.attach("file-tree-browser-benchmark", { path: output, contentType: "application/json" });
  console.log(`Browser benchmark output: ${output}`);
});
