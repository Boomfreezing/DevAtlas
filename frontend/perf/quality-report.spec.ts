import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, test, type Page } from "@playwright/test";
import type { QualityFinding, QualityReport } from "../src/types";

const repetitions = 3;
const scopes = ["production", "test", "generated"] as const;
const severities = ["error", "warning", "info"] as const;
const ruleIds = ["LONG_FUNCTION", "COMPLEX_FUNCTION", "LARGE_FILE", "HIGH_FAN_OUT", "DUPLICATE_CODE", "CIRCULAR_DEPENDENCY"];
const round = (value: number) => Number(value.toFixed(2));
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const findings: QualityFinding[] = Array.from({ length: 1500 }, (_, index) => ({
    id: `quality-finding-${index + 1}`,
    rule_id: ruleIds[Math.floor(index / 9) % 5],
    severity: severities[index % 3],
    scope: scopes[Math.floor(index / 3) % 3],
    title: `Function responsibility can be simplified ${String(index + 1).padStart(4, "0")}`,
    description: "This function combines validation, persistence and output formatting. Split cohesive responsibilities into independently verifiable units while preserving the existing behavior.",
    suggestion: "先保留当前行为并增加边界测试，再拆分参数校验和持久化逻辑；检查相关调用位置，避免改变返回值和异常处理契约。",
    file_id: index + 1,
    file_path: `${scopes[Math.floor(index / 3) % 3] === "production" ? "src" : scopes[Math.floor(index / 3) % 3]}/domain_${Math.floor(index / 50)}/service_${String(index + 1).padStart(4, "0")}.py`,
    start_line: 21 + index % 100,
    end_line: 140 + index % 100,
    metric: 120 + index % 200,
    threshold: 80,
  }));
  const size = { file_count: 1500, code_line_count: 320000, symbol_count: 9000 };
  const rules = ruleIds.map((id) => ({ id, title: id.replaceAll("_", " "), description: "Synthetic quality rule", default_severity: "warning" as const }));
  const common: Omit<QualityReport, "findings" | "filtered_findings" | "limit" | "offset" | "has_more" | "truncated"> = {
    score: 72, grade: "B", score_scope: "composite", total_findings: 1500,
    severity_counts: { error: 500, warning: 500, info: 500 },
    rule_counts: Object.fromEntries(ruleIds.map((rule) => [rule, findings.filter((finding) => finding.rule_id === rule).length])),
    rules, elapsed_ms: 17.2,
    scoring: { model: "scope-weighted", size_factor: 3, scale_units: 3, project_size: size, reference_size: size, base_weights: { error: 3, warning: 1, info: 0.25 }, effective_weights: { error: 1, warning: 0.33, info: 0.08 }, base_penalty: 100, adjusted_penalty: 28, rule_penalties: {}, scope_weights: { production: 0.7, test: 0.2, generated: 0.1 }, effective_scope_weights: { production: 0.7, test: 0.2, generated: 0.1 }, excluded_scopes: [], source_file_count: 1500, parser_supported_file_count: 1500, applicable_rule_count: 6, total_rule_count: 6, parser_coverage: 100, coverage_level: "high", coverage_message: "", explanation: "Synthetic benchmark; not a scoring calibration." },
    scope_scores: Object.fromEntries(scopes.map((scope) => [scope, { scope, label: scope === "production" ? "生产代码" : scope === "test" ? "测试代码" : "生成/外部代码", score: 72, grade: "B", available: true, configured_weight: scope === "production" ? 0.7 : scope === "test" ? 0.2 : 0.1, effective_weight: scope === "production" ? 0.7 : scope === "test" ? 0.2 : 0.1, exclusion_reason: null, finding_count: findings.filter((finding) => finding.scope === scope).length, severity_counts: Object.fromEntries(severities.map((severity) => [severity, findings.filter((finding) => finding.scope === scope && finding.severity === severity).length])), project_size: { file_count: 500, code_line_count: 106666, symbol_count: 3000 } }])) as QualityReport["scope_scores"],
  };
  return { findings, common };
}

async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function qualityDOM(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector(".quality-view");
    const walker = root ? document.createTreeWalker(root, NodeFilter.SHOW_TEXT) : null;
    let textNodes = 0;
    while (walker?.nextNode()) textNodes++;
    const findings = Array.from(document.querySelectorAll(".quality-finding"));
    return { quality_elements: root?.querySelectorAll("*").length ?? 0, quality_text_nodes: textNodes, document_elements: document.querySelectorAll("*").length, finding_count: findings.length, finding_text_characters: findings.reduce((sum, row) => sum + (row.textContent?.length ?? 0), 0), first_finding: findings[0]?.querySelector("header strong")?.textContent ?? null, last_finding: findings.at(-1)?.querySelector("header strong")?.textContent ?? null };
  });
}

test("synthetic quality report pagination and filtering", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  const label = process.env.DEVATLAS_QUALITY_BENCHMARK_LABEL ?? "baseline";
  if (!["baseline", "after"].includes(label)) throw new Error("Label must be baseline or after");
  if (process.env.DEVATLAS_GRAPH_BENCHMARK_BUILD !== "production") throw new Error("Run this benchmark with the production performance build");
  const directory = resolve(process.env.DEVATLAS_QUALITY_BENCHMARK_OUTPUT_DIR ?? "../docs/performance");
  const output = resolve(directory, `quality-report-production-${label}.json`);
  if (existsSync(output)) throw new Error(`Refusing to overwrite historical benchmark: ${output}`);
  const assets = readdirSync(resolve("dist/assets")).filter((name) => /\.(js|css|map)$/.test(name)).sort();
  const bundleHashes = Object.fromEntries(assets.map((name) => [`dist/assets/${name}`, sha(readFileSync(resolve("dist/assets", name)))]));
  // Source content is read from the frozen bundle, not the concurrently edited workspace.
  const sourceHashes: Record<string, string> = {};
  for (const name of assets.filter((name) => name.endsWith(".js.map"))) {
    const map = JSON.parse(readFileSync(resolve("dist/assets", name), "utf8"));
    map.sources.forEach((source: string, index: number) => { if (source.includes("/src/") && typeof map.sourcesContent[index] === "string") sourceHashes[source] = sha(map.sourcesContent[index]); });
  }
  const { findings, common } = fixture();
  const results: Record<string, unknown>[] = [];
  let environment: Record<string, unknown> = {};
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const requests: Record<string, unknown>[] = [];
    const errors: string[] = [];
    const unexpected: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const project = { id: 1, name: "quality-benchmark", source_filename: "synthetic/", status: "ready", primary_language: "Python", file_count: 1500, code_line_count: 320000, created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z" };
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET") { unexpected.push(`${route.request().method()} ${url.pathname}`); await route.abort(); return; }
      let body: unknown = [];
      if (url.pathname === "/api/projects") body = [project];
      else if (url.pathname === "/api/projects/1") body = project;
      else if (url.pathname.endsWith("/structure/summary")) body = { symbol_count: 9000, class_count: 1000, function_count: 8000, import_count: 4000, resolved_import_count: 3900, issue_count: 1500 };
      else if (url.pathname.endsWith("/quality")) {
        const limit = Number(url.searchParams.get("limit"));
        const offset = Number(url.searchParams.get("offset"));
        const severity = url.searchParams.get("severity") ?? "all";
        const scope = url.searchParams.get("scope") ?? "all";
        const rule = url.searchParams.get("rule") ?? "all";
        expect(limit).toBe(100);
        const filtered = findings.filter((finding) => (severity === "all" || finding.severity === severity) && (scope === "all" || finding.scope === scope) && (rule === "all" || finding.rule_id === rule));
        const selected = filtered.slice(offset, offset + limit);
        requests.push({ limit, offset, severity, scope, rule, returned: selected.length, filtered_total: filtered.length });
        body = { ...common, findings: selected, filtered_findings: filtered.length, limit, offset, has_more: offset + limit < filtered.length, truncated: offset + limit < filtered.length };
      } else if (url.pathname.endsWith("/files/tree")) body = { path: "", total_files: 1500, total_items: 0, limit: 200, offset: 0, has_more: false, items: [] };
      else if (url.pathname.endsWith("/import-limits")) body = { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 };
      else if (/\/(symbols|imports|issues)$/.test(url.pathname)) body = { items: [], total: 0, limit: 150, offset: 0, has_more: false };
      await route.fulfill({ json: body });
    });
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]));
    const heap = async () => { await cdp.send("HeapProfiler.collectGarbage"); const result = await cdp.send("Runtime.getHeapUsage"); return { used_js_heap_bytes_after_forced_gc: result.usedSize, total_js_heap_bytes_after_forced_gc: result.totalSize }; };
    const actions: Record<string, unknown>[] = [];
    const heaps: Record<string, unknown> = {};
    const measure = async (name: string, action: () => Promise<void>) => {
      const before = await metrics();
      const start = performance.now();
      await action();
      await paint(page);
      const elapsed = performance.now() - start;
      const after = await metrics();
      actions.push({ action: name, automation_and_two_frames_ms: round(elapsed), browser_script_ms: round((after.ScriptDuration - before.ScriptDuration) * 1000), browser_task_ms: round((after.TaskDuration - before.TaskDuration) * 1000), browser_layout_ms: round((after.LayoutDuration - before.LayoutDuration) * 1000), browser_recalc_style_ms: round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000), ...await qualityDOM(page) });
    };
    const counts = async (count: number, total: number) => {
      await expect(page.locator(".quality-finding")).toHaveCount(count);
      await expect(page.locator(".quality-toolbar")).toContainText(`当前显示 ${count} / ${total}`);
      await expect(page.getByRole("combobox", { name: "风险等级", exact: true })).toBeEnabled();
      await expect(page.locator(".quality-findings")).not.toContainText("正在读取质量问题");
    };
    const choose = async (label: string, value: string, total: number) => { await page.getByRole("combobox", { name: label, exact: true }).selectOption(value); await counts(Math.min(100, total), total); };
    try {
      await page.goto("/?section=search&tab=files&project=1");
      await expect(page.locator(".project-trigger")).toContainText(project.name);
      await paint(page);
      heaps.shell = await heap();
      await measure("initial_100", async () => { await page.locator(".nav-item").filter({ hasText: "质量检测" }).click(); await counts(100, 1500); });
      heaps.initial_100 = await heap();
      for (let size = 200; size <= 1500; size += 100) {
        await measure(`append_${size}`, async () => { await page.locator(".quality-load-more button").click(); await counts(size, 1500); await expect(page.locator(".quality-finding").last().locator("header strong")).toHaveText(findings[size - 1].title); });
        if (size === 500 || size === 1500) heaps[`loaded_${size}`] = await heap();
      }
      await expect(page.locator(".quality-load-more button")).toHaveCount(0);
      const mounted = await page.locator(".quality-finding header strong").allTextContents();
      expect(mounted).toEqual(findings.map((finding) => finding.title));
      await measure("filter_severity_hit", async () => choose("风险等级", "warning", 500));
      const scopedTotal = findings.filter((finding) => finding.severity === "warning" && finding.scope === "production").length;
      await measure("filter_scope_hit", async () => choose("代码范围", "production", scopedTotal));
      await measure("filter_rule_no_hit", async () => { await choose("检测规则", "CIRCULAR_DEPENDENCY", 0); await expect(page.locator(".quality-findings")).toContainText("当前筛选条件下没有质量问题"); });
      heaps.filtered_empty = await heap();
      await measure("filter_rule_clear", async () => choose("检测规则", "all", scopedTotal));
      await measure("filter_scope_clear", async () => choose("代码范围", "all", 500));
      await measure("filter_severity_clear", async () => choose("风险等级", "all", 1500));
      heaps.cleared_100 = await heap();
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
      expect(requests).toHaveLength(21);
      environment = { browser_version: browser.version(), user_agent: await page.evaluate(() => navigator.userAgent), viewport: { width: 1440, height: 1000 }, node_version: process.version, platform: process.platform };
      results.push({ repetition, actions, heaps, quality_requests: requests, page_errors: errors, unexpected_requests: unexpected });
      console.log(`${label} sample ${repetition}: all 1500 findings verified; ${actions.length} measured actions; ${requests.length} quality reads`);
    } finally { await cdp.detach(); await page.close(); }
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(output, `${JSON.stringify({ schema_version: 1, label, build_mode: "production", captured_at: new Date().toISOString(), repetitions, fixture_sha256: sha(JSON.stringify({ findings, common })), fixture_findings: findings.length, benchmark_sha256: sha(readFileSync(resolve("perf/quality-report.spec.ts"))), bundle_sha256: bundleHashes, bundled_source_sha256: sourceHashes, environment, method: { isolation: "Synthetic GET API mocks, production preview on isolated 5175 with isolated 8011 service. No mutation, user repository or model requests. TEMP/TMP on D:.", timing: "Independent page for each of three samples. Node monotonic time includes Playwright actions/assertions/IPC and two animation frames; CDP cumulative deltas are diagnostic, not isolated application CPU. No timing pass/fail threshold.", fixture: "1500 findings, 100 per page, production/test/generated and error/warning/info server filters. Six advertised rules, one intentionally has zero hits. All 1500 title texts are asserted in exact order; no row count reduction or virtualization.", memory: "CDP Runtime.getHeapUsage after forced GC outside timed intervals. JS heap only, not browser RSS or natural GC.", identity: "Source hashes are extracted from frozen production sourcemap sourcesContent so concurrent workspace edits cannot mislabel the measured bundle. Benchmark script hash and full bundle hashes retained.", interpretation: "Three samples are descriptive; no statistical significance implied. Appending to 500 or 1500 is a sequence of normal 100-row LOAD_NEXT interactions, not a single larger response. Filtering replaces results and clear returns the first 100 rows by existing pagination contract." }, results }, null, 2)}\n`);
  await testInfo.attach("quality-benchmark", { path: output, contentType: "application/json" });
});
