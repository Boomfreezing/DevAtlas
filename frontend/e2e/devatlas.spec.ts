import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

interface ProjectSummary {
  id: number;
  name: string;
}

test("导入文件夹、搜索代码并执行无变化增量分析", async ({ page, request }, testInfo) => {
  const projectName = `e2e-sample-${Date.now()}`;
  const projectDirectory = testInfo.outputPath(projectName);
  const helperFunctions = [
    "def calculate_total(values):\n    return sum(values)",
    ...Array.from(
      { length: 11 },
      (_, index) => `def calculate_order_${index + 1}(values):\n    return calculate_total(values)`,
    ),
  ].join("\n\n");
  let projectId: number | undefined;

  await mkdir(projectDirectory, { recursive: true });
  await writeFile(
    `${projectDirectory}/main.py`,
    "from helper import calculate_total\n\nclass Cart:\n    def total(self):\n        return calculate_total([1, 2, 3])\n",
    "utf8",
  );
  await writeFile(
    `${projectDirectory}/helper.py`,
    `${helperFunctions}\n`,
    "utf8",
  );
  await writeFile(`${projectDirectory}/README.md`, "# DevAtlas E2E fixture\n", "utf8");

  try {
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("项目管理");
    await expect(page.locator(".version")).toContainText("v0.9.0");

    await page
      .locator(".topbar-actions")
      .getByRole("button", { name: /导入仓库/ })
      .click();
    await page.getByRole("button", { name: /本地文件夹/ }).click();
    await page.locator("input[webkitdirectory]").setInputFiles(projectDirectory);

    await expect(page.locator(".topbar h1")).toHaveText(projectName, { timeout: 30_000 });
    await expect(page.locator(".project-trigger")).toContainText(projectName);
    await expect(page.locator(".analysis-strip")).toContainText("1");

    await expect.poll(async () => {
      const response = await request.get("/api/projects");
      const projects = await response.json() as ProjectSummary[];
      projectId = projects.find((project) => project.name === projectName)?.id;
      return projectId;
    }).toBeDefined();

    await page.getByRole("button", { name: /分析报告/ }).click();
    await expect(page.getByRole("heading", { name: "选择分析接口" })).toBeVisible();
    await expect(page.getByText("本地智能分析")).toBeVisible();
    await expect(page.getByLabel("Markdown 报告预览")).toContainText("智能分析结论");
    await expect(page.locator(".detail-metrics")).toHaveCount(0);
    const viewport = page.viewportSize();
    const workspaceBox = await page.locator(".detail-panel").boundingBox();
    expect(viewport).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect(workspaceBox!.y + workspaceBox!.height).toBeGreaterThanOrEqual(viewport!.height - 45);
    expect(workspaceBox!.y + workspaceBox!.height).toBeLessThanOrEqual(viewport!.height);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /导出 MD/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    const reportPath = await download.path();
    expect(reportPath).not.toBeNull();
    const report = await readFile(reportPath!, "utf8");
    expect(report).toContain(`${projectName} 代码仓库分析报告`);
    expect(report).toContain("无需大模型");
    expect(report).toContain("智能分析结论");

    await page.getByRole("button", { name: /代码搜索/ }).click();
    await page.getByRole("textbox", { name: "代码搜索关键词" }).fill("calculate_total");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".search-result").first()).toContainText("calculate_total");
    await expect(page.locator(".search-result")).toHaveCount(10);
    await expect(page.locator(".search-summary")).toContainText(/显示 10 \/ \d+ 条匹配/);
    await page.getByRole("button", { name: /加载更多/ }).click();
    await expect.poll(async () => page.locator(".search-result").count()).toBeGreaterThan(10);
    await expect(page.getByRole("button", { name: /加载更多/ })).toHaveCount(0);
    await expect.poll(async () => {
      const summary = await page.locator(".search-summary").textContent();
      const match = summary?.match(/显示 ([\d,]+) \/ ([\d,]+) 条匹配/);
      return Boolean(match && match[1] === match[2]);
    }).toBe(true);
    await page.getByRole("button", { name: "查看代码" }).first().click();
    const codeViewer = page.getByRole("dialog");
    await expect(codeViewer).toBeVisible();
    await expect(codeViewer.getByRole("region", { name: /源代码/ })).toBeVisible();
    await expect(codeViewer.locator(".code-viewer-line.highlighted").first()).toBeVisible();
    await expect(codeViewer.locator("mark").first()).toContainText("calculate_total");
    await codeViewer.getByRole("button", { name: "关闭代码查看器" }).click();
    await expect(codeViewer).toHaveCount(0);

    await page.getByRole("button", { name: /仓库概览/ }).click();
    const overviewPanelBox = await page.locator(".detail-panel").boundingBox();
    const overviewListBox = await page.locator(".file-list").boundingBox();
    expect(overviewPanelBox).not.toBeNull();
    expect(overviewListBox).not.toBeNull();
    const overviewBottomInset = overviewPanelBox!.y + overviewPanelBox!.height - overviewListBox!.y - overviewListBox!.height;
    expect(overviewBottomInset).toBeGreaterThanOrEqual(19);
    expect(overviewBottomInset).toBeLessThanOrEqual(22);
    await page.getByRole("button", { name: "增量分析" }).click();
    const summary = page.locator(".incremental-summary");
    await expect(summary).toContainText("仓库没有文件变化");
    await expect(summary).toContainText("3");
  } finally {
    if (projectId === undefined) {
      const response = await request.get("/api/projects");
      if (response.ok()) {
        const projects = await response.json() as ProjectSummary[];
        projectId = projects.find((project) => project.name === projectName)?.id;
      }
    }
    if (projectId !== undefined) {
      await request.delete(`/api/projects/${projectId}`);
    }
  }
});
