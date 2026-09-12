import { expect, test, type Page } from "@playwright/test";

const FILE_COUNT = 1000;
const PAGE_SIZE = 200;
const timestamp = "2026-09-12T00:00:00Z";
const fileName = (index: number) => `file-${String(index).padStart(4, "0")}.py`;
const fileRow = (page: Page, index: number) => page.locator(`.file-tree-file[title="${fileName(index)}"]`);
const filePage = (page: Page, index: number) => page.locator(`.file-tree-file-page[data-file-page="${index}"]`);

async function prepareTree(page: Page) {
  const offsets: number[] = [];
  const impactIds: number[] = [];
  const unexpectedModelRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => window.localStorage.setItem("devatlas-display-scale", "100"));
  const project = {
    id: 1, name: "windowing-fixture", source_filename: "windowing-fixture/", status: "ready",
    primary_language: "Python", file_count: FILE_COUNT, code_line_count: FILE_COUNT * 5,
    created_at: timestamp, updated_at: timestamp,
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown = [];
    if (/\/(ask|report|test)$/.test(url.pathname)) {
      unexpectedModelRequests.push(url.pathname);
      await route.fulfill({ status: 500, json: { detail: "Model requests are forbidden in this fixture" } });
      return;
    }
    if (url.pathname === "/api/projects") body = [project];
    else if (url.pathname === "/api/projects/1") body = project;
    else if (url.pathname.endsWith("/structure/summary")) {
      body = { symbol_count: 0, class_count: 0, function_count: 0, import_count: 0, resolved_import_count: 0, issue_count: 0 };
    } else if (url.pathname.endsWith("/files/tree")) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 0);
      expect(limit).toBe(PAGE_SIZE);
      expect(url.searchParams.get("path") ?? "").toBe("");
      offsets.push(offset);
      body = {
        path: "", total_files: FILE_COUNT, total_items: FILE_COUNT, limit, offset,
        has_more: offset + limit < FILE_COUNT,
        items: Array.from({ length: Math.min(limit, FILE_COUNT - offset) }, (_, position) => {
          const index = offset + position;
          return { id: index + 1, kind: "file", path: fileName(index), name: fileName(index),
            file_count: 1, line_count: 5, size_bytes: 50, language: "Python", extension: ".py" };
        }),
      };
    } else if (url.pathname.endsWith("/impact")) {
      const id = Number(url.searchParams.get("target_id"));
      expect(url.searchParams.get("target_type")).toBe("file");
      impactIds.push(id);
      const path = fileName(id - 1);
      const target = { target_type: "file", target_id: id, file_id: id, file_path: path, name: path, kind: "file", start_line: 1, end_line: 5 };
      body = {
        target,
        definition: { file_id: id, file_path: path, relation: "definition", confidence: "high", depth: 0, line_numbers: [1], start_line: 1, end_line: 5 },
        risk: { level: "low", score: 18, confidence: "medium", reasons: [] },
        direct_callers: [], called_objects: [], dependencies: [], indirect_impacts: [], related_tests: [], related_apis: [], database_entities: [], cycles: [], limitations: "Synthetic browser fixture",
      };
    } else if (/\/(symbols|imports|issues)$/.test(url.pathname)) {
      body = { items: [], total: 0, limit: 150, offset: 0, has_more: false };
    } else if (url.pathname.endsWith("/import-limits")) {
      body = { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 };
    }
    await route.fulfill({ json: body });
  });
  await page.goto("/?section=projects&project=1&tab=files");
  const more = page.getByRole("button", { name: "加载根目录的更多条目", exact: true });
  for (let loaded = PAGE_SIZE; loaded < FILE_COUNT; loaded += PAGE_SIZE) {
    // Loaded metadata is deliberately distinct from the smaller live DOM window.
    await expect(more).toContainText(`${loaded.toLocaleString("zh-CN")} / 1,000 个直接子项`);
    await more.click();
  }
  await expect(page.getByText("已显示全部 1,000 个直接子项", { exact: true })).toBeVisible();
  await expect(more).toHaveCount(0);
  await expect(filePage(page, 4)).toHaveCount(1);
  expect(offsets.filter((offset) => offset > 0)).toEqual([200, 400, 600, 800]);
  return { offsets, impactIds, unexpectedModelRequests, pageErrors };
}

async function scrollToFile(page: Page, index: number) {
  // A virtual file is absent until its persistent page placeholder intersects.
  await filePage(page, Math.floor(index / PAGE_SIZE)).evaluate((element) => element.scrollIntoView({ block: "start" }));
  const row = fileRow(page, index);
  await expect(row).toBeAttached();
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeInViewport();
  return row;
}

async function expectBoundedFiles(page: Page) {
  await expect.poll(() => page.locator(".file-tree-file").count()).toBeLessThanOrEqual(600);
  await expect(page.locator('.file-tree-file-page[data-materialized="false"]').first()).toBeAttached();
}

test("千文件逐页读取，首中尾可达且影响操作保持目标", async ({ page }, testInfo) => {
  const state = await prepareTree(page);
  const readsAfterLoad = state.offsets.length;
  for (const index of [999, 0, 450, 999]) {
    await scrollToFile(page, index);
    await expectBoundedFiles(page);
  }
  expect(state.offsets).toHaveLength(readsAfterLoad);
  await page.screenshot({ path: testInfo.outputPath("file-tree-windowed-tail.png") });
  await fileRow(page, 999).getByRole("button", { name: "影响", exact: true }).click();
  await expect(page.locator(".impact-report-header h3")).toHaveText(fileName(999));
  // Development StrictMode may cancel and repeat the mounted workspace read.
  expect([...new Set(state.impactIds)]).toEqual([1000]);
  expect(state.pageErrors).toEqual([]);
  expect(state.unexpectedModelRequests).toEqual([]);
});

test("分页边界使用 Tab 时保留焦点并进入下一个文件", async ({ page }) => {
  const state = await prepareTree(page);
  const button = (await scrollToFile(page, 199)).getByRole("button", { name: "影响", exact: true });
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(fileRow(page, 200).getByRole("button", { name: "影响", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(button).toBeFocused();
  // Focus keeps this page alive even when a mouse-independent scroll moves away.
  await filePage(page, 4).evaluate((element) => element.scrollIntoView({ block: "end" }));
  await expect(fileRow(page, 999)).toBeInViewport();
  await expect(button).toBeFocused();
  expect(state.pageErrors).toEqual([]);
});

test("显示比例和窄屏变化后占位高度正确且末尾文件可读", async ({ page }) => {
  const state = await prepareTree(page);
  await page.getByRole("button", { name: "缩小页面字号", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-display-scale", "90");
  await scrollToFile(page, 999);
  await expectBoundedFiles(page);
  const heightAt90 = await filePage(page, 0).evaluate((element) => (element as HTMLElement).offsetHeight);
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole("button", { name: "放大页面字号", exact: true }).click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-display-scale", "120");
  await scrollToFile(page, 999);
  await expectBoundedFiles(page);
  const heightAt120 = await filePage(page, 0).evaluate((element) => (element as HTMLElement).offsetHeight);
  // CSS zoom must not be applied twice to a cached layout-pixel placeholder.
  expect(heightAt90).toBeGreaterThan(0);
  expect(Math.abs(heightAt120 - heightAt90)).toBeLessThanOrEqual(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await scrollToFile(page, 0);
  await scrollToFile(page, 999);
  await expect(fileRow(page, 999).locator("strong")).toHaveText(fileName(999));
  await expectBoundedFiles(page);
  expect(state.pageErrors).toEqual([]);
  expect(state.unexpectedModelRequests).toEqual([]);
});

test("选中的文件名滚出视口后仍可复制，取消选择后可以回收", async ({ page }) => {
  const state = await prepareTree(page);
  const row = await scrollToFile(page, 10);
  await row.locator("strong").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(fileName(10));
  await filePage(page, 4).evaluate((element) => element.scrollIntoView({ block: "end" }));
  await expect(fileRow(page, 999)).toBeInViewport();
  await expect(filePage(page, 0)).toHaveAttribute("data-materialized", "true");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(fileName(10));
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(filePage(page, 0)).toHaveAttribute("data-materialized", "false");
  await expectBoundedFiles(page);
  expect(state.pageErrors).toEqual([]);
});
