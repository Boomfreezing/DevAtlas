import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, test, type Page } from "@playwright/test";

const REPETITIONS = 3;
const PAGE_SIZE = 200;
const round = (value: number) => Number(value.toFixed(2));
type Scenario = "wide_directories" | "many_expanded_directories" | "rapid_project_switch";
type Read = { project: number; path: string; offset: number; returned: number; delayed: boolean };

async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function treeDOM(page: Page) {
  return page.evaluate(() => ({
    live_tree_elements: document.querySelector(".file-tree")?.querySelectorAll("*").length ?? 0,
    live_file_rows: document.querySelectorAll(".file-tree-file").length,
    live_directory_rows: document.querySelectorAll(".file-tree-directory-button").length,
    expanded_directory_rows: document.querySelectorAll(".file-tree-directory-button[aria-expanded='true']").length,
    live_document_elements: document.querySelectorAll("*").length,
  }));
}

function directory(name: string, count: number) {
  return { kind: "directory", name, path: name, file_count: count, id: null, extension: null, line_count: null, size_bytes: null, language: null };
}

function file(path: string, index: number, stale = false) {
  const name = stale ? "stale-must-not-appear.py" : `file_${String(index).padStart(4, "0")}.py`;
  return { kind: "file", name, path: `${path}/${name}`, file_count: 1, id: index + 1, extension: ".py", language: "Python", line_count: 5, size_bytes: 80 };
}

test("synthetic dense directories and project-switch benchmark", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  const label = process.env.DEVATLAS_TREE_BENCHMARK_LABEL ?? "baseline";
  if (!["baseline", "after"].includes(label)) throw new Error("Benchmark label must be baseline or after");
  const sources = ["src/workspaces/FileTree.tsx", "src/workspaces/FileTreeFilePages.tsx", "src/workspaces/fileTreeCache.ts", "src/workspaces/treeRenderBudget.ts", "src/workspaces/directoryReadQueue.ts", "src/App.tsx", "src/styles.css", "src/terminal-theme.css", "perf/file-tree-dense.spec.ts"];
  const hashes = Object.fromEntries(sources.filter((name) => existsSync(resolve(name))).map((name) => [name, createHash("sha256").update(readFileSync(resolve(name))).digest("hex")]));
  const results: Record<string, unknown>[] = [];
  let environment: Record<string, unknown> = {};
  for (const scenario of ["wide_directories", "many_expanded_directories", "rapid_project_switch"] as Scenario[]) {
    for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const cdp = await page.context().newCDPSession(page);
      const reads: Read[] = [];
      const failures: { path: string; error: string | null }[] = [];
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("requestfailed", (request) => {
        if (request.url().includes("/files/tree")) failures.push({ path: request.url(), error: request.failure()?.errorText ?? null });
      });
      const directoryCount = scenario === "wide_directories" ? 600 : scenario === "many_expanded_directories" ? 24 : 1;
      const filesPerDirectory = scenario === "many_expanded_directories" ? 100 : 1;
      const fileCount = directoryCount * filesPerDirectory;
      const project = (id: number) => ({ id, name: id === 1 ? "alpha-benchmark" : "beta-benchmark", source_filename: "synthetic/", status: "ready", primary_language: "Python", file_count: fileCount, code_line_count: fileCount * 5, created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z" });
      const name = (index: number, id = 1) => `${id === 1 ? "alpha" : "beta"}_${String(index).padStart(4, "0")}`;
      const releaseDelayed: (() => void)[] = [];
      const delayedReleased: Promise<void>[] = [];
      let delayPhase = true;
      let delayedUsed = false;
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        let body: unknown = [];
        if (url.pathname === "/api/projects") body = [project(1), project(2)];
        else if (/^\/api\/projects\/[12]$/.test(url.pathname)) body = project(Number(url.pathname.split("/").at(-1)));
        else if (url.pathname.endsWith("/structure/summary")) body = { symbol_count: fileCount, class_count: 0, function_count: fileCount, import_count: 0, resolved_import_count: 0, issue_count: 0 };
        else if (url.pathname.endsWith("/files/tree")) {
          const id = Number(url.pathname.split("/")[3]);
          const path = url.searchParams.get("path") ?? "";
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? PAGE_SIZE);
          expect(limit).toBe(PAGE_SIZE);
          const delayed = scenario === "rapid_project_switch" && id === 1 && path !== "" && delayPhase;
          const total = path ? filesPerDirectory : directoryCount;
          const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => path ? file(path, offset + index, delayed) : directory(name(offset + index, id), filesPerDirectory));
          reads.push({ project: id, path, offset, returned: items.length, delayed });
          if (delayed) {
            delayedUsed = true;
            let finish: (() => void) | undefined;
            delayedReleased.push(new Promise<void>((done) => { finish = done; }));
            await new Promise<void>((done) => { releaseDelayed.push(done); });
            body = { path, total_files: filesPerDirectory, total_items: total, limit, offset, has_more: false, items };
            try { await route.fulfill({ json: body }); } catch { /* Browser may already have cancelled this obsolete request. */ }
            finish!();
            return;
          }
          body = { path, total_files: path ? filesPerDirectory : fileCount, total_items: total, limit, offset, has_more: offset + items.length < total, items };
        } else if (url.pathname.endsWith("/import-limits")) body = { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 };
        else if (/\/(symbols|imports|issues)$/.test(url.pathname)) body = { items: [], total: 0, limit: 150, offset: 0, has_more: false };
        if (/\/(ask|report|test)$/.test(url.pathname)) throw new Error(`Unexpected model request: ${url.pathname}`);
        await route.fulfill({ json: body });
      });
      const heap = async () => {
        await cdp.send("HeapProfiler.collectGarbage");
        const usage = await cdp.send("Runtime.getHeapUsage");
        return { used_js_heap_bytes_after_forced_gc: usage.usedSize, total_js_heap_bytes_after_forced_gc: usage.totalSize };
      };
      try {
        await page.goto("/?section=search&project=1");
        await expect(page.getByRole("textbox", { name: "代码搜索关键词" })).toBeVisible();
        await paint(page);
        const shellHeap = await heap();
        let started = performance.now();
        await page.locator(".nav-item").filter({ hasText: "仓库概览" }).click();
        await expect(page.getByRole("button", { name: new RegExp(`^${name(0)} 目录`) })).toBeVisible();
        await paint(page);
        const rootMs = round(performance.now() - started);
        const actions: Record<string, unknown>[] = [];
        if (scenario === "wide_directories") {
          const more = page.getByRole("button", { name: "加载根目录的更多条目", exact: true });
          for (const offset of [200, 400]) {
            started = performance.now();
            await more.evaluate((button: HTMLButtonElement) => button.click());
            if (offset === 200) await expect(more).toContainText("400 / 600");
            else await expect(more).toHaveCount(0);
            await paint(page);
            actions.push({ offset, elapsed_ms: round(performance.now() - started), ...await treeDOM(page) });
          }
          expect([...new Set(reads.filter((entry) => !entry.path).map((entry) => entry.offset))]).toEqual([0, 200, 400]);
        } else if (scenario === "many_expanded_directories") {
          for (let index = 0; index < directoryCount; index++) {
            const button = page.getByRole("button", { name: new RegExp(`^${name(index)} 目录`) });
            started = performance.now();
            await button.click();
            await expect(button).toHaveAttribute("aria-expanded", "true");
            await expect.poll(() => reads.filter((entry) => entry.path === name(index)).length).toBeGreaterThanOrEqual(1);
            await expect(page.getByText("正在读取目录…", { exact: true })).toHaveCount(0);
            await paint(page);
            actions.push({ directory: name(index), elapsed_ms: round(performance.now() - started), ...await treeDOM(page) });
          }
          const childPages = new Map(reads.filter((entry) => entry.path).map((entry) => [`${entry.path}:${entry.offset}`, entry]));
          expect(childPages.size).toBe(24);
          expect([...childPages.values()].reduce((sum, entry) => sum + entry.returned, 0)).toBe(2400);
          expect(await page.locator(".file-tree-directory-button[aria-expanded='true']").count()).toBe(24);
        } else {
          await page.getByRole("button", { name: new RegExp(`^${name(0)} 目录`) }).click();
          await expect.poll(() => delayedUsed).toBe(true);
          await paint(page);
          for (const id of [2, 1]) {
            started = performance.now();
            await page.locator(".project-trigger").click();
            await page.locator(".project-option").filter({ hasText: id === 1 ? "alpha-benchmark" : "beta-benchmark" }).click();
            await expect(page.getByRole("button", { name: new RegExp(`^${name(0, id)} 目录`) })).toBeVisible();
            await paint(page);
            actions.push({ switch_to: id, elapsed_ms: round(performance.now() - started), ...await treeDOM(page) });
          }
          delayPhase = false;
          releaseDelayed.forEach((release) => release());
          await Promise.all(delayedReleased);
          await paint(page);
          await expect(page.getByText("stale-must-not-appear.py", { exact: true })).toHaveCount(0);
          const current = page.getByRole("button", { name: new RegExp(`^${name(0)} 目录`) });
          await current.click();
          await expect(page.getByText("file_0000.py", { exact: true })).toBeVisible();
          await expect(page.getByText("stale-must-not-appear.py", { exact: true })).toHaveCount(0);
          actions.push({ stale_response_contamination: false, final_project: 1, current_file_verified: true });
        }
        await paint(page);
        const loadedDOM = await treeDOM(page);
        const loadedHeap = await heap();
        const uniqueLoaded = new Map(reads.filter((entry) => entry.project === 1 && !entry.delayed).map((entry) => [`${entry.path}:${entry.offset}`, entry]));
        const beforeMenuRequests = reads.length;
        started = performance.now();
        await page.locator(".nav-item").filter({ hasText: "代码搜索" }).click();
        await expect(page.getByRole("textbox", { name: "代码搜索关键词" })).toBeVisible();
        await paint(page);
        const leaveMs = round(performance.now() - started);
        const hiddenDOM = await treeDOM(page);
        const hiddenHeap = await heap();
        started = performance.now();
        await page.locator(".nav-item").filter({ hasText: "仓库概览" }).click();
        await expect(page.locator(".file-tree")).toBeVisible();
        await paint(page);
        const returnMs = round(performance.now() - started);
        const returnedDOM = await treeDOM(page);
        expect(pageErrors).toEqual([]);
        environment = { browser_version: browser.version(), user_agent: await page.evaluate(() => navigator.userAgent), viewport: { width: 1440, height: 1000 }, node_version: process.version, platform: process.platform };
        results.push({ scenario, repetition, expected_directory_count: directoryCount, expected_file_count: fileCount, root_ms: rootMs, actions, unique_loaded_root_items: [...uniqueLoaded.values()].filter((entry) => !entry.path).reduce((sum, entry) => sum + entry.returned, 0), unique_loaded_file_records: [...uniqueLoaded.values()].filter((entry) => entry.path).reduce((sum, entry) => sum + entry.returned, 0), loaded_dom: loadedDOM, returned_dom: returnedDOM, hidden_dom: hiddenDOM, shell_heap: shellHeap, loaded_heap: loadedHeap, hidden_heap: hiddenHeap, leave_menu_ms: leaveMs, return_menu_ms: returnMs, menu_roundtrip_additional_requests: reads.length - beforeMenuRequests, requests: reads, failed_requests: failures, tree_request_abort_observed_including_strictmode: failures.some((entry) => /ERR_ABORTED/.test(entry.error ?? "")), page_errors: pageErrors });
        console.log(`${label}: ${scenario} sample ${repetition}; file rows=${loadedDOM.live_file_rows}; directories=${loadedDOM.live_directory_rows}; heap=${round(loadedHeap.used_js_heap_bytes_after_forced_gc / 1048576)} MiB`);
      } finally {
        releaseDelayed.forEach((release) => release());
        await cdp.detach();
        await page.close();
      }
    }
  }
  const output = resolve("../docs/performance", `file-tree-dense-${label}.json`);
  mkdirSync(resolve("../docs/performance"), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ schema_version: 1, label, captured_at: new Date().toISOString(), implementation_sha256: hashes, environment, repetitions: REPETITIONS, page_size: PAGE_SIZE, method: { isolation: "Synthetic API route mocks only, isolated Playwright services on 8011/5175 and D: runtime. No user repository, database, model or remote network requests.", timings: "Independent browser page per sample, warmed Vite shell. Node monotonic elapsed time includes Playwright IPC, waits, and two animation frames. Append uses real handler via native DOM click; expand and project/menu navigation use Playwright click. Three raw samples per scenario, not statistical significance.", loaded_records: "Counted from unique successfully served project/path/offset responses, not mounted rows. The expanded scenario opens all 24 directories and loads exactly 100 files in each. No automatic collapsing or fewer loaded pages is used for comparison.", memory: "CDP Runtime.getHeapUsage after forced HeapProfiler.collectGarbage, diagnostic JS heap only, not browser process RSS or natural GC. Collection is outside interaction timings.", switch: "A child request is held until UI has switched A→B→A via project picker. Late response must not appear, reopening A must yield fresh current file; failed request events record observed cancellation." }, results }, null, 2)}\n`);
  await testInfo.attach("file-tree-dense-benchmark", { path: output, contentType: "application/json" });
});
