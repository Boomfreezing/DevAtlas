import { expect, test, type Page, type Route } from "@playwright/test";

const timestamp = "2026-09-12T00:00:00Z";
const directoryName = (index: number) => `branch-${String(index).padStart(2, "0")}`;
const fileName = (index: number) => `file-${String(index).padStart(3, "0")}.py`;
const directoryButton = (page: Page, index: number) => page.getByRole("button", { name: new RegExp(`^${directoryName(index)} 目录`) });
const directoryGroup = (page: Page, index: number) => directoryButton(page, index).locator("..");
const fileRow = (page: Page, directory: number, index: number) => page.locator(`.file-tree-file[title="${directoryName(directory)}/${fileName(index)}"]`);

type TreeRead = { projectId: number; path: string; offset: number };
type TreeHook = (route: Route, read: TreeRead, body: object) => Promise<boolean>;

function file(path: string, id = 1) {
  return { id, kind: "file", path, name: path.split("/").at(-1), file_count: 1,
    line_count: 5, size_bytes: 50, language: "Python", extension: ".py" };
}

function treeBody(path: string, items: object[], totalFiles = items.length) {
  return { path, total_files: totalFiles, total_items: items.length, items, offset: 0, limit: 200, has_more: false };
}

async function prepareTree(page: Page, { directories = 24, files = 100, onTree }: {
  directories?: number; files?: number; onTree?: TreeHook;
} = {}) {
  const reads: TreeRead[] = [];
  const pageErrors: string[] = [];
  const modelRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => window.localStorage.setItem("devatlas-display-scale", "100"));
  const projects = [1, 2].map((id) => ({
    id, name: `dense-project-${id}`, source_filename: `dense-project-${id}/`, status: "ready",
    primary_language: "Python", file_count: directories * files, code_line_count: directories * files * 5,
    created_at: timestamp, updated_at: timestamp,
  }));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: object = [];
    if (/\/(ask|report|test)$/.test(url.pathname)) {
      modelRequests.push(url.pathname);
      await route.fulfill({ status: 500, json: { detail: "Model requests are forbidden in the dense-tree fixture" } });
      return;
    }
    if (url.pathname === "/api/projects") body = projects;
    else if (/\/api\/projects\/[12]$/.test(url.pathname)) body = projects[Number(url.pathname.at(-1)) - 1];
    else if (url.pathname.endsWith("/structure/summary")) {
      body = { symbol_count: 0, class_count: 0, function_count: 0, import_count: 0, resolved_import_count: 0, issue_count: 0 };
    } else if (url.pathname.endsWith("/files/tree")) {
      const read = { projectId: Number(url.pathname.split("/")[3]), path: url.searchParams.get("path") ?? "", offset: Number(url.searchParams.get("offset") ?? 0) };
      reads.push(read);
      expect(Number(url.searchParams.get("limit"))).toBe(200);
      expect(read.offset).toBe(0);
      const items = read.path
        ? Array.from({ length: files }, (_, index) => file(`${read.path}/${fileName(index)}`, Number(read.path.split("-").at(-1)) * files + index + 1))
        : Array.from({ length: directories }, (_, index) => ({
          kind: "directory", name: directoryName(index), path: directoryName(index), file_count: files,
          id: null, extension: null, language: null, size_bytes: null, line_count: null,
        }));
      body = treeBody(read.path, items, read.path ? files : directories * files);
      if (await onTree?.(route, read, body)) return;
    } else if (url.pathname.endsWith("/import-limits")) {
      body = { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 };
    } else if (/\/(symbols|imports|issues)$/.test(url.pathname)) {
      body = { items: [], total: 0, limit: 150, offset: 0, has_more: false };
    }
    await route.fulfill({ json: body });
  });
  return { reads, pageErrors, modelRequests };
}

async function expandAll(page: Page) {
  // One burst deliberately exercises the shared read queue, without Playwright
  // scrolling and waiting between twenty-four separate button interactions.
  await page.locator('.file-tree-directory-button[aria-expanded="false"]').evaluateAll((buttons) => {
    buttons.forEach((button) => (button as HTMLButtonElement).click());
  });
}

async function settleFrames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function scrollToFile(page: Page, directory: number, index: number) {
  const pageBox = directoryGroup(page, directory).locator(".file-tree-file-page").first();
  await pageBox.evaluate((element) => element.scrollIntoView({ block: "start" }));
  const row = fileRow(page, directory, index);
  await expect(row).toBeAttached();
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeInViewport();
  return row;
}

test("多个小目录共享渲染预算，目录与跨目录键盘导航保持可用", async ({ page }, testInfo) => {
  const state = await prepareTree(page);
  await page.goto("/?section=projects&project=1&tab=files");
  await expect(directoryButton(page, 23)).toBeAttached();
  await expandAll(page);
  await expect(page.locator(".file-tree-directory .file-tree-file-page")).toHaveCount(24);
  await expect(page.locator('.file-tree-directory-button[aria-expanded="true"]')).toHaveCount(24);
  // Each directory has only 100 files: a per-directory 600-row threshold would
  // leave all 2,400 rows mounted, which is the regression this test detects.
  await expect.poll(() => page.locator(".file-tree-file").count()).toBeLessThanOrEqual(600);
  await expect(page.locator('.file-tree-file-page[data-materialized="false"]').first()).toBeAttached();
  await expect(page.locator(".file-tree-directory")).toHaveCount(24);
  const readsAfterLoad = state.reads.filter((read) => read.path).length;

  for (const [directory, index] of [[23, 99], [0, 99], [12, 50], [0, 99]]) {
    await scrollToFile(page, directory, index);
    await expect.poll(() => page.locator(".file-tree-file").count()).toBeLessThanOrEqual(600);
  }
  const lastFirstDirectory = fileRow(page, 0, 99).getByRole("button", { name: "影响", exact: true });
  await lastFirstDirectory.focus();
  await page.keyboard.press("Tab");
  await expect(directoryButton(page, 1)).toBeFocused();
  await page.keyboard.press("Tab");
  const firstNextDirectory = fileRow(page, 1, 0).getByRole("button", { name: "影响", exact: true });
  await expect(firstNextDirectory).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(directoryButton(page, 1)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(lastFirstDirectory).toBeFocused();
  expect(state.reads.filter((read) => read.path)).toHaveLength(readsAfterLoad);
  await page.screenshot({ path: testInfo.outputPath("file-tree-dense-windowed.png") });

  await page.locator('.file-tree-directory-button[aria-expanded="true"]').evaluateAll((buttons) => {
    buttons.forEach((button) => (button as HTMLButtonElement).click());
  });
  await expect(page.locator(".file-tree-file")).toHaveCount(0);
  await expect(page.locator(".file-tree-directory")).toHaveCount(24);
  await directoryButton(page, 23).click();
  await expect(page.locator(".file-tree-file")).toHaveCount(100);
  expect(state.reads.filter((read) => read.path)).toHaveLength(readsAfterLoad);
  expect(state.pageErrors).toEqual([]);
  expect(state.modelRequests).toEqual([]);
});

test("突发展开最多并行读取四个目录，排队目录折叠后不发送请求", async ({ page }) => {
  let holding = true;
  const releases: (() => void)[] = [];
  const startedPaths = new Set<string>();
  const state = await prepareTree(page, { directories: 10, files: 10, onTree: async (route, read, body) => {
    if (!read.path || !holding) return false;
    startedPaths.add(read.path);
    await new Promise<void>((resolve) => releases.push(resolve));
    // StrictMode may already have cancelled an intercepted first-mount read.
    try { await route.fulfill({ json: body }); } catch (error) {
      if (!page.isClosed() && !route.request().failure()) throw error;
    }
    return true;
  } });
  try {
    await page.goto("/?section=projects&project=1&tab=files");
    await expect(directoryButton(page, 9)).toBeAttached();
    await expandAll(page);
    await expect(page.locator('.file-tree-directory-button[aria-expanded="true"]')).toHaveCount(10);
    await expect.poll(() => startedPaths.size).toBe(4);
    await settleFrames(page);
    expect(startedPaths.size).toBe(4);
    const cancelledIndex = Array.from({ length: 10 }, (_, index) => index).find((index) => !startedPaths.has(directoryName(index)))!;
    const cancelledPath = directoryName(cancelledIndex);
    await directoryButton(page, cancelledIndex).click();
    await expect(directoryButton(page, cancelledIndex)).toHaveAttribute("aria-expanded", "false");

    holding = false;
    releases.splice(0).forEach((release) => release());
    await expect(page.locator(".file-tree-file")).toHaveCount(90);
    expect(state.reads.filter((read) => read.path === cancelledPath)).toHaveLength(0);
    expect(new Set(state.reads.filter((read) => read.path).map((read) => read.path)).size).toBe(9);
    expect(state.pageErrors).toEqual([]);
    expect(state.modelRequests).toEqual([]);
  } finally {
    holding = false;
    releases.splice(0).forEach((release) => release());
  }
});

for (const outcome of ["success", "error"] as const) {
  test(`快速 A/B/A 切换隔离旧子目录与根目录的迟到 ${outcome}`, async ({ page }) => {
    let phase: "first-a" | "b" | "second-a" = "first-a";
    let delaying = true;
    let completedOldReads = 0;
    const releases: (() => void)[] = [];
    const held: TreeRead[] = [];
    const state = await prepareTree(page, { directories: 1, files: 1, onTree: async (route, read) => {
      if (phase === "second-a" && read.projectId === 1 && !read.path) {
        await route.fulfill({ json: treeBody("", [file("fresh-A.py")]) });
        return true;
      }
      if (!(read.projectId === 1 && read.path && phase === "first-a") && !(read.projectId === 2 && !read.path)) return false;
      held.push(read);
      if (delaying) await new Promise<void>((resolve) => releases.push(resolve));
      const oldPath = read.path ? `${read.path}/stale-A.py` : "stale-B.py";
      try {
        await route.fulfill(outcome === "success"
          ? { json: treeBody(read.path, [file(oldPath)]) }
          : { status: 500, json: { detail: `obsolete-${read.projectId}-tree-failure` } });
      } catch (error) {
        if (!page.isClosed() && !route.request().failure()) throw error;
      }
      completedOldReads += 1;
      return true;
    } });
    try {
      await page.goto("/?section=projects&project=1&tab=files");
      await directoryButton(page, 0).click();
      await expect.poll(() => held.some((read) => read.projectId === 1 && !!read.path)).toBe(true);
      phase = "b";
      await page.locator(".project-trigger").click();
      await page.locator(".project-option").filter({ hasText: "dense-project-2" }).click();
      await expect.poll(() => held.some((read) => read.projectId === 2)).toBe(true);
      await expect(page.locator(".file-tree-directory")).toHaveCount(0);
      phase = "second-a";
      await page.locator(".project-trigger").click();
      await page.locator(".project-option").filter({ hasText: "dense-project-1" }).click();
      await expect(page.locator('.file-tree-file[title="fresh-A.py"]')).toBeVisible();
      delaying = false;
      releases.splice(0).forEach((release) => release());
      await expect.poll(() => completedOldReads).toBe(held.length);
      await settleFrames(page);
      await expect(page.locator(".file-tree-file")).toHaveCount(1);
      await expect(page.locator('.file-tree-file[title="fresh-A.py"]')).toBeVisible();
      await expect(page.getByText(/stale-[AB]\.py|obsolete-[12]-tree-failure/)).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get("project")).toBe("1");
      expect(state.pageErrors).toEqual([]);
      expect(state.modelRequests).toEqual([]);
    } finally {
      delaying = false;
      releases.splice(0).forEach((release) => release());
    }
  });
}
