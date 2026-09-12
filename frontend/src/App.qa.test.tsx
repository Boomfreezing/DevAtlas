// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import App from "./App";
import type { RepositoryAnswer, RepositoryConversationItem } from "./types";

const timestamp = "2026-09-12T00:00:00Z";
const projects = [1, 2].map((id) => ({ id, name: `qa-state-${id}`, source_filename: `qa-state-${id}/`,
  status: "ready", primary_language: "Python", file_count: 2, code_line_count: 20,
  created_at: timestamp, updated_at: timestamp }));
const structure = { symbol_count: 1, class_count: 0, function_count: 1, import_count: 0, resolved_import_count: 0, issue_count: 0 };
const providers = [
  { id: "local", name: "本地规则分析", available: true, configured: true, description: "fixture", base_url: "local://", model: "rules" },
  { id: "ollama", name: "Ollama 本地模型服务", available: true, configured: true, description: "fixture", base_url: "http://localhost:11434", model: "fixture" },
  { id: "openai-chat-compatible", name: "Chat Completions 兼容接口", available: true, configured: true, description: "fixture", base_url: "https://example.invalid", model: "fixture" },
];

function answer(question: string, content = `答复：${question}`): RepositoryAnswer {
  return { question, answer: content, provider: "ollama", engine_name: "mock", citations: [],
    confidence: "high", grounding_status: "project_context", evidence_count: 0, reference_count: 0, elapsed_ms: 1 };
}
function increment(changed: boolean) {
  return { project_id: 1, added_file_count: 0, changed_file_count: changed ? 1 : 0, deleted_file_count: 0,
    unchanged_file_count: changed ? 1 : 2, parsed_file_count: changed ? 1 : 0,
    added_paths: [], changed_paths: changed ? ["main.py"] : [], deleted_paths: [], elapsed_ms: 1 };
}
interface AskPayload { question: string; provider: string; history: RepositoryConversationItem[] }
interface AskRequest { projectId: number; payload: AskPayload; signal: AbortSignal | null | undefined }
type Interceptor = (url: URL, options?: RequestInit) => Promise<Response | undefined>;
function mockApi(intercept: Interceptor = async () => undefined) {
  const asks: AskRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const id = Number(url.pathname.match(/\/projects\/(\d+)/)?.[1] ?? 1);
    if (url.pathname.endsWith("/ask")) asks.push({ projectId: id,
      payload: JSON.parse(String(options?.body)) as AskPayload, signal: options?.signal });
    const response = await intercept(url, options);
    if (response) return response;
    if (url.pathname === "/api/projects") return Response.json(projects);
    if (/\/projects\/[12]$/.test(url.pathname)) return Response.json(projects[id - 1]);
    if (url.pathname.endsWith("/structure/summary")) return Response.json(structure);
    if (url.pathname.endsWith("/files/tree")) return Response.json({ path: "", items: [], total_files: 2 });
    if (url.pathname.endsWith("/report-generators")) return Response.json(providers);
    if (url.pathname.endsWith("/import-limits")) return Response.json({ max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 });
    if (url.pathname.endsWith("/ask")) return Response.json(answer(asks.at(-1)!.payload.question));
    if (url.pathname.endsWith("/reanalyze")) return Response.json(structure);
    if (url.pathname.endsWith("/incremental-reanalyze")) return Response.json(increment(false));
    return Response.json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { asks, fetchMock };
}
async function openTerminal() {
  await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("qa-state-1"));
  fireEvent.click(screen.getByRole("button", { name: /智能问答/ }));
  await waitFor(() => expect(screen.getByLabelText("输入仓库问题")).toHaveProperty("disabled", false));
}
function submit(question: string) {
  const input = screen.getByLabelText("输入仓库问题");
  fireEvent.change(input, { target: { value: question } });
  fireEvent.submit(input.closest("form")!);
}
function closeTerminal() { fireEvent.click(screen.getByRole("button", { name: "关闭智能问答面板" })); }
function reopenTerminal() { fireEvent.click(screen.getByRole("button", { name: /智能问答/ })); }
function successfulHistory(question: string, content = `答复：${question}`): RepositoryConversationItem[] {
  return [{ role: "user", content: question }, { role: "assistant", content }];
}
async function selectSecondProject() {
  fireEvent.click(document.querySelector(".project-trigger")!);
  fireEvent.click(Array.from(document.querySelectorAll(".project-option"))
    .find((element) => element.textContent?.includes("qa-state-2"))!);
  await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("qa-state-2"));
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/?section=projects&tab=files&project=1");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("preserves completed terminal turns and the draft on close/reopen without another model request", async () => {
  const api = mockApi();
  render(<App />);
  await openTerminal();
  submit("项目如何启动？");
  await screen.findByText("答复：项目如何启动？");
  fireEvent.change(screen.getByLabelText("输入仓库问题"), { target: { value: "尚未提交的问题" } });
  closeTerminal();
  expect(screen.queryByRole("region", { name: "智能问答终端" })).toBeNull();
  reopenTerminal();
  expect(screen.getByText("答复：项目如何启动？")).toBeTruthy();
  expect(screen.getByLabelText("输入仓库问题")).toHaveProperty("value", "尚未提交的问题");
  expect(api.asks).toHaveLength(1);
  submit("启动参数在哪里？");
  await screen.findByText("答复：启动参数在哪里？");
  expect(api.asks[1].payload.history).toEqual(successfulHistory("项目如何启动？"));
});

it.each(["success", "failure"])("ignores a closed request's late %s and excludes its incomplete turn from the next history", async (outcome) => {
  let release!: (response: Response) => void;
  const api = mockApi(async (url, options) => {
    if (url.pathname.endsWith("/ask") && JSON.parse(String(options?.body)).question === "等待中的旧问题") {
      return new Promise<Response>((resolve) => { release = resolve; }); // Simulates a transport that ignores abort.
    }
  });
  render(<App />);
  await openTerminal();
  submit("第一条成功问题");
  await screen.findByText("答复：第一条成功问题");
  submit("等待中的旧问题");
  await waitFor(() => expect(release).toBeDefined());
  closeTerminal();
  expect(api.asks[1].signal?.aborted).toBe(true);
  reopenTerminal();
  expect(screen.getByText("等待中的旧问题", { exact: true })).toBeTruthy();
  submit("返回后的新问题");
  await screen.findByText("答复：返回后的新问题");
  expect(api.asks[2].payload.history).toEqual(successfulHistory("第一条成功问题"));
  await act(async () => release(outcome === "success" ? Response.json(answer("等待中的旧问题", "迟到的旧回答"))
    : Response.json({ detail: "迟到的旧错误" }, { status: 502 })));
  expect(screen.queryByText("迟到的旧回答")).toBeNull();
  expect(screen.queryByText(/迟到的旧错误/)).toBeNull();
  expect(screen.getByText("答复：返回后的新问题")).toBeTruthy();
  expect(api.asks).toHaveLength(3);
});

it("isolates project contexts and fences a pending answer when the selected project changes", async () => {
  let release!: (response: Response) => void;
  const api = mockApi(async (url, options) => {
    if (url.pathname.endsWith("/ask") && JSON.parse(String(options?.body)).question === "旧项目还在回答") {
      return new Promise<Response>((resolve) => { release = resolve; });
    }
  });
  render(<App />);
  await openTerminal();
  submit("旧项目已完成问题");
  await screen.findByText("答复：旧项目已完成问题");
  submit("旧项目还在回答");
  await waitFor(() => expect(release).toBeDefined());
  await selectSecondProject();
  expect(api.asks[1].signal?.aborted).toBe(true);
  expect(screen.queryByText("答复：旧项目已完成问题")).toBeNull();
  submit("新项目的问题");
  await screen.findByText("答复：新项目的问题");
  expect(api.asks[2]).toMatchObject({ projectId: 2, payload: { history: [] } });
  await act(async () => release(Response.json(answer("旧项目还在回答", "绝不能显示的旧项目回答"))));
  expect(screen.queryByText("绝不能显示的旧项目回答")).toBeNull();
  expect(screen.getByText("答复：新项目的问题")).toBeTruthy();
});

it.each(["full", "incremental"])("separates QA context after a successful %s source update while keeping the old completed transcript", async (mode) => {
  let releaseAsk!: (response: Response) => void;
  let releaseAnalysis!: (response: Response) => void;
  let analysisSignal: AbortSignal | null | undefined;
  const api = mockApi(async (url, options) => {
    if (url.pathname.endsWith("/ask") && JSON.parse(String(options?.body)).question === "更新前等待的问题") {
      return new Promise<Response>((resolve) => { releaseAsk = resolve; });
    }
    if (url.pathname.endsWith(mode === "full" ? "/reanalyze" : "/incremental-reanalyze")) {
      analysisSignal = options?.signal;
      return new Promise<Response>((resolve) => { releaseAnalysis = resolve; });
    }
  });
  render(<App />);
  await openTerminal();
  submit("更新前成功的问题");
  await screen.findByText("答复：更新前成功的问题");
  submit("更新前等待的问题");
  await waitFor(() => expect(releaseAsk).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: mode === "full" ? "全量" : "增量分析" }));
  await waitFor(() => expect(releaseAnalysis).toBeDefined());
  await act(async () => releaseAnalysis(Response.json(mode === "full" ? structure : increment(true))));
  await waitFor(() => expect(api.asks[1].signal?.aborted).toBe(true));
  expect(analysisSignal?.aborted ?? false).toBe(false);
  expect(screen.getByText("答复：更新前成功的问题")).toBeTruthy();
  expect(api.asks).toHaveLength(2); // Index invalidation does not automatically retry a potentially billed request.
  submit("更新后的新问题");
  await screen.findByText("答复：更新后的新问题");
  expect(api.asks[2].payload.history).toEqual([]);
  await act(async () => releaseAsk(Response.json(answer("更新前等待的问题", "过期索引的迟到答案"))));
  expect(screen.queryByText("过期索引的迟到答案")).toBeNull();
  expect(screen.getByText("答复：更新后的新问题")).toBeTruthy();
});

it("does not let an old revision's answer clear the loading state of a newer pending question", async () => {
  let releaseOld!: (response: Response) => void;
  let releaseNew!: (response: Response) => void;
  const api = mockApi(async (url, options) => {
    if (!url.pathname.endsWith("/ask")) return;
    const question = JSON.parse(String(options?.body)).question;
    if (question === "旧版本等待回答") return new Promise<Response>((resolve) => { releaseOld = resolve; });
    return new Promise<Response>((resolve) => { releaseNew = resolve; });
  });
  render(<App />);
  await openTerminal();
  submit("旧版本等待回答");
  await waitFor(() => expect(releaseOld).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "全量" }));
  await waitFor(() => expect(api.asks[0].signal?.aborted).toBe(true));
  submit("新版本仍在回答");
  await waitFor(() => expect(releaseNew).toBeDefined());
  await act(async () => releaseOld(Response.json(answer("旧版本等待回答", "不得覆盖新请求的旧结果"))));
  expect(screen.queryByText("不得覆盖新请求的旧结果")).toBeNull();
  expect(screen.getByLabelText("输入仓库问题")).toHaveProperty("disabled", true);
  expect(document.querySelector(".qa-thinking")).toBeTruthy();
  expect(api.asks[1].signal?.aborted).toBe(false);
  await act(async () => releaseNew(Response.json(answer("新版本仍在回答"))));
  await screen.findByText("答复：新版本仍在回答");
  expect(screen.getByLabelText("输入仓库问题")).toHaveProperty("disabled", false);
  expect(api.asks[1].payload.history).toEqual([]);
});

it("keeps valid conversation context after an incremental check with no source changes", async () => {
  const api = mockApi();
  render(<App />);
  await openTerminal();
  submit("无需重新解析的问题");
  await screen.findByText("答复：无需重新解析的问题");
  fireEvent.click(screen.getByRole("button", { name: "增量分析" }));
  await screen.findByText("仓库没有文件变化");
  submit("继续沿用上文追问");
  await screen.findByText("答复：继续沿用上文追问");
  expect(api.asks[1].payload.history).toEqual(successfulHistory("无需重新解析的问题"));
  expect(api.asks).toHaveLength(2);
});

it("retries an older failure with its original successful context and the newly selected model", async () => {
  let failedAttempts = 0;
  const api = mockApi(async (url, options) => {
    if (url.pathname.endsWith("/ask") && JSON.parse(String(options?.body)).question === "稍后重试的问题" && ++failedAttempts === 1) {
      return Response.json({ detail: "首次模型调用失败" }, { status: 502 });
    }
  });
  render(<App />);
  await openTerminal();
  submit("共同的成功上文");
  await screen.findByText("答复：共同的成功上文");
  submit("稍后重试的问题");
  await screen.findByRole("button", { name: /使用当前模型重试/ });
  submit("失败后的另一条问题");
  await screen.findByText("答复：失败后的另一条问题");
  expect(api.asks[2].payload.history).toEqual(successfulHistory("共同的成功上文"));
  fireEvent.change(screen.getByLabelText("智能问答模型"), { target: { value: "openai-chat-compatible" } });
  fireEvent.click(screen.getByRole("button", { name: /使用当前模型重试/ }));
  await screen.findByText("答复：稍后重试的问题");
  expect(api.asks[3].payload).toEqual({ question: "稍后重试的问题", provider: "openai-chat-compatible",
    history: successfulHistory("共同的成功上文") });
  expect(api.asks).toHaveLength(4);
});

it("bounds successful history to five complete turns and clips long answers without truncating their display", async () => {
  const content = `${"长".repeat(4_200)}完整尾部`;
  const api = mockApi(async (url, options) => {
    if (url.pathname.endsWith("/ask")) {
      const question = JSON.parse(String(options?.body)).question as string;
      return Response.json(answer(question, question === "第六轮问题" ? content : `答复：${question}`));
    }
  });
  render(<App />);
  await openTerminal();
  const questions = ["第一轮问题", "第二轮问题", "第三轮问题", "第四轮问题", "第五轮问题", "第六轮问题"];
  for (const question of questions) {
    submit(question);
    await screen.findByText(question === "第六轮问题" ? content : `答复：${question}`);
  }
  submit("第七轮问题");
  await screen.findByText("答复：第七轮问题");
  const history = api.asks[6].payload.history;
  expect(history).toHaveLength(10);
  expect(history.map((item) => item.role)).toEqual(Array.from({ length: 5 }, () => ["user", "assistant"]).flat());
  expect(history[0]).toEqual({ role: "user", content: "第二轮问题" });
  expect(history[8]).toEqual({ role: "user", content: "第六轮问题" });
  expect(history[9].content.length).toBeLessThanOrEqual(4_000);
  expect(history[9].content).toBe(content.slice(0, 4_000));
  expect(screen.getByText(content)).toBeTruthy();
});
