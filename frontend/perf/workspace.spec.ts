import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, test } from "@playwright/test";

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples_ms: values.map((value) => +value.toFixed(2)), p50_ms: +sorted[Math.ceil(sorted.length * 0.5) - 1].toFixed(2), p95_ms: +sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2) };
}

test("isolated real-service workspace timing", async ({ page, request, browser }) => {
  test.setTimeout(180_000);
  const corpusFile = process.env.DEVATLAS_PERF_CORPUS;
  if (!corpusFile) throw new Error("Set DEVATLAS_PERF_CORPUS to evaluations.workspace_performance's result.json");
  const corpus = JSON.parse(readFileSync(corpusFile, "utf8"));
  const projects: Array<{ id: number; name: string; sha256: string; metrics: Record<string, unknown> }> = [];
  expect(await (await request.get("/api/projects")).json()).toEqual([]);
  for (const item of corpus.projects) {
    const response = await request.post("/api/projects", { multipart: { archive: { name: `${item.name}.zip`, mimeType: "application/zip", buffer: readFileSync(item.archive) } }, timeout: 60_000 });
    expect(response.ok()).toBe(true);
    const created = await response.json();
    expect(created.file_count).toBe(item.files);
    projects.push({ id: created.id, name: item.name, sha256: item.sha256, metrics: {} });
  }
  const samples = 10;
  const paint = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const switchTo = async (id: number, name: string) => {
    await page.locator(".project-trigger").click();
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/projects/${id}/files/tree`, { timeout: 10_000 });
    await page.locator(".project-option").filter({ hasText: name }).click();
    expect((await response).ok()).toBe(true);
    await expect(page.locator(".topbar h1")).toHaveText(name);
    await expect(page.getByRole("tree", { name: "仓库文件树" })).toBeVisible();
    await paint();
  };
  for (const [index, project] of projects.entries()) {
    let started = performance.now();
    await page.goto(`/?section=quality&project=${project.id}`);
    await expect(page.locator(".quality-score")).toBeVisible();
    await paint();
    project.metrics.quality_first_navigation_ms = +(performance.now() - started).toFixed(2);
    const quality = [], search = [], switching = [];
    for (let iteration = 0; iteration < samples; iteration++) {
      await page.locator(".nav-item").filter({ hasText: "代码搜索" }).click();
      await page.getByRole("textbox", { name: "代码搜索关键词" }).fill("order validation");
      const response = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/search"), { timeout: 10_000 });
      started = performance.now();
      await page.getByRole("button", { name: /^搜索$/ }).click();
      const payload = await (await response).json();
      expect(payload.total_matches).toBeGreaterThan(0);
      await expect(page.getByRole("status", { name: "代码搜索进行中" })).toHaveCount(0);
      await paint();
      search.push(performance.now() - started);

      started = performance.now();
      await page.locator(".nav-item").filter({ hasText: "质量检测" }).click();
      await expect(page.locator(".quality-score")).toBeVisible();
      await paint();
      quality.push(performance.now() - started);

      await page.locator(".nav-item").filter({ hasText: "仓库概览" }).click();
      const other = projects[(index + 1) % projects.length];
      await switchTo(other.id, other.name);
      started = performance.now();
      await switchTo(project.id, project.name);
      switching.push(performance.now() - started);
    }
    project.metrics.quality_repeat_visit = stats(quality);
    project.metrics.search_submit = stats(search);
    project.metrics.switch_overview = stats(switching);
  }
  const output = join(process.env.DEVATLAS_E2E_RUNTIME!, "browser-performance.json");
  writeFileSync(output, JSON.stringify({ schema_version: 1, browser: browser.version(), viewport: { width: 1440, height: 1000 }, samples, method: "local Vite dev; automation click/wait plus two animation frames; repeated sequential user actions; first navigation single sample", projects }, null, 2));
  console.log(`Browser benchmark: ${output}`);
});
