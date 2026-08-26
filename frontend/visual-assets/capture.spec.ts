import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

test("生成 DevAtlas 项目展示截图", async ({ page, request }, testInfo) => {
  const projectName = "devatlas-demo-repository";
  const projectDirectory = testInfo.outputPath(projectName);
  const assetsDirectory = resolve(process.cwd(), "../docs/assets");

  await mkdir(projectDirectory, { recursive: true });
  await mkdir(`${projectDirectory}/src`, { recursive: true });
  await mkdir(`${projectDirectory}/web`, { recursive: true });
  await mkdir(assetsDirectory, { recursive: true });

  const existingResponse = await request.get("/api/projects");
  const existingProjects = await existingResponse.json() as Array<{ id: number }>;
  for (const project of existingProjects) {
    await request.delete(`/api/projects/${project.id}`);
  }
  await writeFile(`${projectDirectory}/README.md`, "# DevAtlas demo repository\n", "utf8");
  await writeFile(
    `${projectDirectory}/src/models.py`,
    "class Repository:\n    def __init__(self, name: str):\n        self.name = name\n        self.files = []\n\n    def add_file(self, path: str):\n        self.files.append(path)\n",
    "utf8",
  );
  await writeFile(
    `${projectDirectory}/src/api.py`,
    "from src.services import analyze_repository\n\ndef create_analysis(name: str):\n    return analyze_repository(name)\n",
    "utf8",
  );
  await writeFile(
    `${projectDirectory}/src/services.py`,
    "from src.api import create_analysis\nfrom src.models import Repository\n\ndef analyze_repository(name: str):\n    repository = Repository(name)\n    repository.add_file('src/api.py')\n    return repository\n",
    "utf8",
  );
  await writeFile(
    `${projectDirectory}/web/dashboard.ts`,
    "import { formatMetric } from './metrics';\n\nexport class DashboardController {\n  render(value: number): string {\n    return formatMetric(value);\n  }\n}\n",
    "utf8",
  );
  await writeFile(
    `${projectDirectory}/web/metrics.ts`,
    "import { DashboardController } from './dashboard';\n\nexport function formatMetric(value: number): string {\n  return `${value.toLocaleString()} files`;\n}\n\nexport const controller = DashboardController;\n",
    "utf8",
  );

  await page.goto("/");
  await page.locator(".primary-button").click();
  await page.getByRole("button", { name: /本地文件夹/ }).click();
  await page.locator("input[webkitdirectory]").setInputFiles(projectDirectory);
  await expect(page.locator(".topbar h1")).toHaveText(projectName, { timeout: 30_000 });
  await expect(page.locator(".analysis-strip")).not.toContainText("—");
  await page.screenshot({ path: `${assetsDirectory}/devatlas-dashboard.png` });

  await page.getByRole("button", { name: /代码搜索/ }).click();
  await page.getByRole("textbox", { name: "代码搜索关键词" }).fill("analyze_repository");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator(".search-result").first()).toContainText("analyze_repository");
  await page.screenshot({ path: `${assetsDirectory}/devatlas-search.png` });

  await page.getByRole("button", { name: /依赖图谱/ }).click();
  await expect(page.locator('svg[aria-label="项目模块依赖图"]')).toBeVisible();
  await page.screenshot({ path: `${assetsDirectory}/devatlas-graph.png`, fullPage: true });

  await page.getByRole("button", { name: /质量检测/ }).click();
  await expect(page.locator(".quality-view")).toContainText("循环依赖");
  await page.screenshot({ path: `${assetsDirectory}/devatlas-quality.png`, fullPage: true });

  await page.getByRole("button", { name: /分析报告/ }).click();
  await expect(page.getByLabel("Markdown 报告预览")).toContainText("智能分析结论");
  await page.screenshot({ path: `${assetsDirectory}/devatlas-report.png`, fullPage: true });
  const ollamaCard = page.locator(".report-generator-card").filter({ hasText: "Ollama 本地模型服务" });
  await ollamaCard.getByRole("button", { name: "配置 API" }).click();
  await expect(page.getByRole("heading", { name: "配置 Ollama 本地模型服务" })).toBeVisible();
  await page.screenshot({ path: `${assetsDirectory}/devatlas-provider-config.png`, fullPage: true });

  await page.getByRole("button", { name: /仓库概览/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${assetsDirectory}/devatlas-mobile.png`, fullPage: true });
});
