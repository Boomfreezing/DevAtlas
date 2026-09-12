import { expect, test, type Page, type Route } from "@playwright/test";
import type { ReportGenerator, RepositoryAnswer } from "../src/types";

const timestamp = "2026-09-12T00:00:00Z";
const project = { id: 1, name: "qa-fixture", source_filename: "synthetic/", status: "ready", primary_language: "Python",
  file_count: 1, code_line_count: 10, created_at: timestamp, updated_at: timestamp };
const providers: ReportGenerator[] = ["ollama", "openai"].map((id) => ({
  id, name: id === "ollama" ? "Mock Local Model" : "Mock Alternate Model", description: "Synthetic provider only",
  endpoint: "", available: true, requires_configuration: true, cost_label: "fixture", configured: true,
  base_url: "http://127.0.0.1:19999/mock-only", model: `fixture-${id}`, has_api_key: false,
  connection_status: "ready", connection_message: "fixture", tested_at: timestamp,
}));
type AskRequest = { question: string; provider: string; history: { role: string; content: string }[] };
function answer(request: AskRequest): RepositoryAnswer {
  return { question: request.question, answer: "启动入口在 src/main.py。[1]", provider: request.provider,
    engine_name: "mock-only", citations: [{ file_id: 7, file_path: "src/main.py", start_line: 1, end_line: 2,
      symbol_name: "main", snippet: "def main():\n    return True", source: "symbol_exact" }],
    evidence_count: 1, reference_count: 1, confidence: "high", grounding_status: "grounded", elapsed_ms: 1 };
}
async function settle(page: Page) { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }

async function mockApi(page: Page, intercept?: (route: Route, url: URL) => Promise<boolean>) {
  const errors: string[] = [];
  const forbidden: string[] = [];
  const external: string[] = [];
  const asks: AskRequest[] = [];
  const sourceReads: string[] = [];
  const origin = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:5175").origin;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("devatlas-qa-provider", "ollama"));
  // No browser request may escape this isolated local fixture.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (/^https?:$/.test(url.protocol) && url.origin !== origin) {
      external.push(url.origin);
      await route.abort("blockedbyclient");
    } else await route.fallback();
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.origin); await route.abort("blockedbyclient"); return; }
    if (url.pathname === "/api/projects/1/ask" && request.method() === "POST") {
      const body = request.postDataJSON() as AskRequest;
      asks.push(body);
      if (await intercept?.(route, url)) return;
      await route.fulfill({ json: answer(body) });
      return;
    }
    if (request.method() !== "GET" || /\/(ask|report|test)$/.test(url.pathname)) {
      forbidden.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 500, json: { detail: "Unexpected operation in QA fixture" } });
      return;
    }
    if (url.pathname.endsWith("/content")) sourceReads.push(url.pathname);
    if (await intercept?.(route, url)) return;
    let body: unknown = [];
    if (url.pathname === "/api/projects") body = [project];
    else if (url.pathname === "/api/projects/1") body = project;
    else if (url.pathname.endsWith("/structure/summary")) body = { symbol_count: 1, class_count: 0, function_count: 1,
      import_count: 0, resolved_import_count: 0, issue_count: 0 };
    else if (url.pathname.endsWith("/files/tree")) body = { path: "", items: [], total_files: 1, total_items: 0, has_more: false, limit: 200, offset: 0 };
    else if (url.pathname.endsWith("/import-limits")) body = { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 };
    else if (url.pathname.endsWith("/report-generators")) body = providers;
    await route.fulfill({ json: body });
  });
  return { errors, forbidden, external, asks, sourceReads };
}

async function openTerminal(page: Page) {
  await page.goto("/?section=projects&tab=files&project=1");
  await expect(page.locator(".topbar h1")).toHaveText("qa-fixture");
  await page.locator(".qa-terminal-toggle").click();
  await expect(page.getByRole("textbox", { name: "输入仓库问题" })).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "智能问答模型" })).toHaveValue("ollama");
}
async function ask(page: Page, question: string) {
  const input = page.getByRole("textbox", { name: "输入仓库问题" });
  await input.fill(question);
  await input.press("Enter");
}
function expectSafe(state: Awaited<ReturnType<typeof mockApi>>) {
  expect(state.errors).toEqual([]);
  expect(state.forbidden).toEqual([]);
  expect(state.external).toEqual([]);
}

test("关闭重开智能问答保留完成回答和草稿，不自动重新请求模型", async ({ page }) => {
  const state = await mockApi(page);
  await openTerminal(page);
  await ask(page, "项目如何启动？");
  await expect(page.locator(".qa-assistant .qa-answer-text")).toHaveText("启动入口在 src/main.py。[1]");
  const draft = "接下来想了解数据库配置";
  await page.getByRole("textbox", { name: "输入仓库问题" }).fill(draft);
  await page.getByRole("button", { name: "关闭智能问答面板" }).click();
  await expect(page.locator(".qa-side-panel")).toBeHidden();
  await page.locator(".nav-item").filter({ hasText: "代码搜索" }).click();
  await page.locator(".qa-terminal-toggle").click();
  await expect(page.locator(".qa-side-panel")).toBeVisible();
  await expect(page.locator(".qa-user")).toHaveCount(1);
  await expect(page.locator(".qa-assistant")).toHaveCount(1);
  await expect(page.locator(".qa-assistant .qa-answer-text")).toHaveText("启动入口在 src/main.py。[1]");
  await expect(page.getByRole("textbox", { name: "输入仓库问题" })).toHaveValue(draft);
  await settle(page);
  expect(state.asks).toEqual([{ question: "项目如何启动？", provider: "ollama", history: [] }]);
  expectSafe(state);
});

test("回答失败后切换模型手动重试，同一用户问题不重复且保留下一条草稿", async ({ page }) => {
  let attempts = 0;
  const state = await mockApi(page, async (route, url) => {
    if (!url.pathname.endsWith("/ask") || ++attempts !== 1) return false;
    await route.fulfill({ status: 503, json: { detail: "模拟模型暂时失败" } });
    return true;
  });
  await openTerminal(page);
  await ask(page, "登录功能在哪里？");
  await expect(page.locator(".qa-system .qa-answer-text")).toContainText("模拟模型暂时失败");
  await page.getByRole("combobox", { name: "智能问答模型" }).selectOption("openai");
  await page.getByRole("textbox", { name: "输入仓库问题" }).fill("这是下一条问题草稿");
  await settle(page);
  expect(state.asks).toHaveLength(1); // Changing a model alone never generates a reply.
  await page.locator(".qa-retry-button").click();
  await expect(page.locator(".qa-assistant")).toHaveCount(1);
  await expect(page.locator(".qa-system")).toHaveCount(0);
  await expect(page.locator(".qa-user")).toHaveCount(1);
  await expect(page.locator(".qa-user .qa-message-prompt strong")).toHaveText("登录功能在哪里？");
  await expect(page.getByRole("textbox", { name: "输入仓库问题" })).toHaveValue("这是下一条问题草稿");
  expect(state.asks).toEqual([
    { question: "登录功能在哪里？", provider: "ollama", history: [] },
    { question: "登录功能在哪里？", provider: "openai", history: [] },
  ]);
  expectSafe(state);
});

test("问答引用的文件 ID 被复用时拒绝展示另一文件正文并禁用复制代码", async ({ page }) => {
  const wrongBody = "WRONG_FILE_SECRET_SHOULD_NEVER_RENDER";
  const state = await mockApi(page, async (route, url) => {
    if (url.pathname !== "/api/projects/1/files/7/content") return false;
    await route.fulfill({ json: { file_id: 7, file_path: "src/reassigned.py", language: "Python",
      size_bytes: wrongBody.length, total_lines: 1, lines: [wrongBody] } });
    return true;
  });
  await openTerminal(page);
  await ask(page, "项目如何启动？");
  await expect(page.locator(".qa-citations button")).toHaveCount(1);
  await page.locator(".qa-citations button").click();
  const viewer = page.getByRole("dialog", { name: "src/main.py" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("alert")).toContainText("引用文件与当前索引不一致");
  await expect(viewer.locator(".code-viewer-code")).toHaveCount(0);
  await expect(page.getByText(wrongBody, { exact: true })).toHaveCount(0);
  await expect(viewer.locator(".code-viewer-actions button").filter({ hasText: "复制代码" })).toBeDisabled();
  // Development StrictMode may start, cancel and repeat the initial GET.
  // Both reads must target the expected file; validation must not retry in a loop.
  expect(state.sourceReads.length).toBeGreaterThanOrEqual(1);
  expect(state.sourceReads.length).toBeLessThanOrEqual(2);
  expect(new Set(state.sourceReads)).toEqual(new Set(["/api/projects/1/files/7/content"]));
  const readCount = state.sourceReads.length;
  await settle(page);
  expect(state.sourceReads).toHaveLength(readCount);
  expect(state.asks).toHaveLength(1);
  expectSafe(state);
});
