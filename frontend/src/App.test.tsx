// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App, { qualityMetricSummary } from "./App";


describe("App", () => {
  it("describes threshold excess and circular dependencies without calling them errors", () => {
    expect(qualityMetricSummary({
      id: "LONG_FUNCTION:1",
      rule_id: "LONG_FUNCTION",
      severity: "warning",
      scope: "production",
      title: "超长函数",
      description: "函数过长",
      suggestion: "拆分函数",
      file_id: 1,
      file_path: "main.py",
      start_line: 1,
      end_line: 100,
      metric: 100,
      threshold: 80,
    })).toBe("实际 100 / 建议 ≤ 80 · 超出 25%");
    expect(qualityMetricSummary({
      id: "CIRCULAR_DEPENDENCY:1",
      rule_id: "CIRCULAR_DEPENDENCY",
      severity: "error",
      scope: "production",
      title: "循环依赖",
      description: "形成依赖环",
      suggestion: "调整依赖方向",
      file_id: 1,
      file_path: "main.py",
      start_line: 1,
      end_line: 1,
      metric: 3,
      threshold: 0,
    })).toBe("结构性风险 · 涉及 3 个模块");
  });

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    window.localStorage.clear();
    Object.defineProperty(window.URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:devatlas-report") });
    Object.defineProperty(window.URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        new Response(JSON.stringify(String(input).endsWith("/api/import-limits")
          ? { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 5 }
          : []), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
    Reflect.deleteProperty(window, "showSaveFilePicker");
    Reflect.deleteProperty(navigator, "clipboard");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the empty repository state after loading", async () => {
    render(<App />);

    expect(await screen.findByText("还没有导入仓库")).toBeTruthy();
    expect(screen.getAllByText("项目管理").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /代码搜索/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /API 配置/ })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: /API 配置/ }));
    expect(await screen.findByText("统一模型与 API 配置")).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("section")).toBe("providers");
  });

  it("persists an app-specific display scale across reloads", async () => {
    const firstRender = render(<App />);
    await screen.findByText("还没有导入仓库");

    expect(document.documentElement.dataset.displayScale).toBe("100");
    fireEvent.click(screen.getByRole("button", { name: "放大页面字号" }));
    expect(document.documentElement.dataset.displayScale).toBe("110");
    expect(window.localStorage.getItem("devatlas-display-scale")).toBe("110");

    firstRender.unmount();
    render(<App />);
    await screen.findByText("还没有导入仓库");
    expect(screen.getByText("110%")).toBeTruthy();
  });

  it("offers ZIP, folder and GitHub import sources", async () => {
    render(<App />);
    await screen.findByText("还没有导入仓库");

    fireEvent.click(document.querySelector(".primary-button") as HTMLButtonElement);

    expect(screen.getByRole("button", { name: /压缩包/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /本地文件夹/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /GitHub/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /本地文件夹/ }));
    expect(screen.getByText("从文件管理器拖入项目文件夹")).toBeTruthy();
  });

  it("previews the analyzable source set before uploading a folder", async () => {
    render(<App />);
    await screen.findByText("还没有导入仓库");
    fireEvent.click(document.querySelector(".primary-button") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: /本地文件夹/ }));

    const source = new File(["export const value = 1;"], "value.ts");
    const binary = new File(["image"], "logo.png");
    const dependency = new File(["generated"], "index.js");
    Object.defineProperty(source, "webkitRelativePath", { value: "demo/src/value.ts" });
    Object.defineProperty(binary, "webkitRelativePath", { value: "demo/assets/logo.png" });
    Object.defineProperty(dependency, "webkitRelativePath", { value: "demo/node_modules/pkg/index.js" });

    fireEvent.change(document.querySelector("input[webkitdirectory]") as HTMLInputElement, {
      target: { files: [source, binary, dependency] },
    });

    expect(await screen.findByText("安全扫描完成")).toBeTruthy();
    const preview = document.querySelector(".folder-preview") as HTMLElement;
    expect(preview.textContent).toContain("原始文件夹");
    expect(preview.textContent).toContain("自动排除");
    expect(preview.textContent).toContain("待分析源码");
    expect(preview.textContent).toContain("跳过目录 1");
    expect(preview.textContent).toContain("非源码/二进制 1");
    expect(screen.getByRole("button", { name: "确认并开始分析" })).toBeTruthy();
  });

  it("keeps the feature section and project list stable while switching projects", async () => {
    const timestamp = "2026-08-26T10:00:00Z";
    const projects = [1, 2].map((id) => ({
      id,
      name: id === 1 ? "alpha" : "beta",
      source_filename: `${id === 1 ? "alpha" : "beta"}/`,
      status: "ready",
      primary_language: "Python",
      file_count: 1,
      code_line_count: 8,
      created_at: timestamp,
      updated_at: timestamp,
    }));
    const symbols = Array.from({ length: 151 }, (_, index) => ({
      id: index + 1,
      file_id: 1,
      name: `symbol_${index + 1}`,
      qualified_name: `module.symbol_${index + 1}`,
      kind: "function" as const,
      start_line: index + 1,
      end_line: index + 1,
      file_path: "src/core/main.py",
    }));
    const structure = {
      symbol_count: symbols.length,
      class_count: 0,
      function_count: symbols.length,
      import_count: 0,
      resolved_import_count: 0,
      issue_count: 1,
      symbols,
      imports: [],
      issues: [{ id: 1, file_id: 1, file_path: "src/core/main.py", message: "Tree-sitter found one or more syntax errors." }],
    };
    const graph = {
      total_node_count: 0,
      total_edge_count: 0,
      internal_import_count: 0,
      external_import_count: 0,
      cycle_count: 0,
      truncated: false,
      nodes: [],
      edges: [],
      cycles: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json(projects);
      if (url.includes("/dependency-graph")) return Response.json(graph);
      if (url.endsWith("/structure/summary")) return Response.json(structure);
      if (url.includes("/symbols?")) {
        const params = new URL(url, "http://localhost").searchParams;
        const offset = Number(params.get("offset") ?? "0");
        const limit = Number(params.get("limit") ?? "150");
        const items = symbols.slice(offset, offset + limit);
        return Response.json({ total: symbols.length, limit, offset, has_more: offset + items.length < symbols.length, items });
      }
      if (url.includes("/issues?")) {
        const items = structure.issues;
        return Response.json({ total: items.length, limit: 150, offset: 0, has_more: false, items });
      }
      if (url.endsWith("/api/projects/1/files/tree")) {
        return Response.json({ path: "", total_files: 1, items: [{ kind: "directory", name: "src", path: "src", file_count: 1, id: null, extension: null, language: null, size_bytes: null, line_count: null }] });
      }
      if (url.endsWith("/api/projects/1/files/tree?path=src")) {
        return Response.json({ path: "src", total_files: 1, items: [{ kind: "directory", name: "core", path: "src/core", file_count: 1, id: null, extension: null, language: null, size_bytes: null, line_count: null }] });
      }
      if (url.endsWith("/api/projects/1/files/tree?path=src%2Fcore")) {
        return Response.json({ path: "src/core", total_files: 1, items: [{ kind: "file", name: "main.py", path: "src/core/main.py", file_count: 1, id: 1, extension: ".py", language: "Python", size_bytes: 80, line_count: 8 }] });
      }
      const project = projects.find((item) => url.endsWith(`/api/projects/${item.id}`));
      if (project) {
        return Response.json({
          ...project,
          files: [{ id: project.id, relative_path: "src/core/main.py", extension: ".py", language: "Python", size_bytes: 80, line_count: 8, content_hash: "hash" }],
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByText("alpha"));
    await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("alpha"));
    expect(document.querySelector(".panel-heading h2")?.textContent).toBe("仓库概览");
    expect(document.querySelector(".detail-title h3")?.textContent).toBe("仓库扫描已完成");
    expect(await screen.findByRole("tree", { name: "仓库文件树" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /src 目录/ }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /src 目录/ }));
    expect((await screen.findByRole("button", { name: /core 目录/ })).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /core 目录/ }));
    expect(await screen.findByText("main.py")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/1/files/tree?path=src%2Fcore", undefined);
    fireEvent.click(screen.getByRole("button", { name: /^符号 / }));
    await waitFor(() => expect(document.querySelectorAll(".symbol-row")).toHaveLength(150));
    expect(document.querySelector(".structure-list-summary")?.textContent).toContain("shown150/ total 151 rows");
    fireEvent.click(screen.getByRole("button", { name: /LOAD_NEXT/ }));
    await waitFor(() => expect(document.querySelectorAll(".symbol-row")).toHaveLength(151));
    expect(document.querySelector(".structure-list-summary")?.textContent).toContain("shown151/ total 151 rows");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/symbols?limit=150&offset=150"), undefined);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/structure"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^问题 / }));
    expect(await screen.findByText("Tree-sitter found one or more syntax errors.")).toBeTruthy();
    expect(document.querySelector(".issue-chinese-note")?.textContent).toContain("符号和依赖统计可能不完整");
    expect(screen.queryByText("处理建议")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("project")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: /依赖图谱/ }));

    expect(await screen.findByText("没有项目内依赖")).toBeTruthy();
    expect(document.querySelector(".topbar h1")?.textContent).toBe("alpha");
    expect(document.querySelector(".panel-heading h2")?.textContent).toBe("依赖图谱");
    expect(document.querySelector(".project-panel")).toBeNull();
    expect(document.querySelector(".content-grid")?.className).toContain("workspace-single");
    expect(document.querySelector(".workspace-breadcrumb")?.textContent).toContain("alpha/依赖图谱");
    expect(new URLSearchParams(window.location.search).get("section")).toBe("graph");

    fireEvent.click(document.querySelector(".project-trigger") as HTMLButtonElement);
    fireEvent.click(screen.getByText("beta"));
    await waitFor(() => expect(document.querySelector(".workspace-breadcrumb")?.textContent).toContain("beta"));
    expect(screen.getByRole("button", { name: /依赖图谱/ }).className).toContain("active");
    expect(document.querySelector(".workspace-breadcrumb")?.textContent).toContain("beta/依赖图谱");
    expect(new URLSearchParams(window.location.search).get("project")).toBe("2");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/projects/2/dependency-graph"), undefined);

    fireEvent.click(document.querySelector(".project-trigger") as HTMLButtonElement);
    fireEvent.click(screen.getByText("alpha"));
    await waitFor(() => expect(document.querySelector(".workspace-breadcrumb")?.textContent).toContain("alpha/依赖图谱"));
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/projects/1/structure/summary"))).toHaveLength(1);
  });

  it("opens repository QA as a workspace terminal and links citations to source", async () => {
    const timestamp = "2026-08-26T10:00:00Z";
    const project = { id: 11, name: "qa-repo", source_filename: "qa-repo/", status: "ready", primary_language: "Python", file_count: 2, code_line_count: 20, created_at: timestamp, updated_at: timestamp };
    let askAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json([project]);
      if (url.endsWith("/api/projects/11")) return Response.json({ ...project, files: [] });
      if (url.endsWith("/structure/summary")) return Response.json({ symbol_count: 1, class_count: 0, function_count: 1, import_count: 0, resolved_import_count: 0, issue_count: 0 });
      if (url.endsWith("/report-generators")) return Response.json([
        { id: "local", name: "本地智能分析", description: "本地检索", endpoint: "", cost_label: "免费", requires_configuration: false, available: true, configured: true, base_url: "local://", model: "DevAtlas", has_api_key: false, connection_status: "ready", connection_message: "ready", tested_at: null },
        { id: "ollama", name: "Ollama 本地模型服务", description: "本地模型", endpoint: "/api/generate", cost_label: "免费", requires_configuration: true, available: true, configured: true, base_url: "http://127.0.0.1:11434", model: "qwen", has_api_key: false, connection_status: "success", connection_message: "ready", tested_at: timestamp },
        { id: "openai-chat-compatible", name: "Chat Completions 兼容接口", description: "在线模型", endpoint: "/chat/completions", cost_label: "按量", requires_configuration: true, available: true, configured: true, base_url: "https://example.test", model: "code-model", has_api_key: true, connection_status: "success", connection_message: "ready", tested_at: timestamp },
      ]);
      if (url.endsWith("/api/projects/11/files/1/content")) return Response.json({ file_id: 1, file_path: "README.md", language: "Markdown", size_bytes: 12, total_lines: 3, lines: ["# QA Repo", "", "npm run dev"] });
      if (url.endsWith("/api/projects/11/ask")) {
        askAttempts += 1;
        if (askAttempts === 1) return Response.json({ detail: "Ollama 模型调用失败" }, { status: 502 });
        return Response.json({
          question: "这个项目如何启动？",
          answer: "启动命令记录在 README。\n[1] `README.md:3-3`",
          provider: "openai-chat-compatible",
          engine_name: "openai-chat-compatible",
          evidence_count: 1,
          reference_count: 1,
          confidence: "high",
          grounding_status: "grounded",
          elapsed_ms: 12.4,
          citations: [{ file_id: 1, file_path: "README.md", start_line: 3, end_line: 3, symbol_name: null, snippet: "npm run dev", source: "project_file" }],
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByText("qa-repo"));
    await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("qa-repo"));
    expect(document.querySelector(".sidebar")?.textContent).not.toContain("智能问答");
    const qaToggle = screen.getByRole("button", { name: /智能问答/ });
    expect(qaToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });

    expect(await screen.findByText("DevAtlas Repository Shell")).toBeTruthy();
    expect(qaToggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".app-shell")?.classList.contains("qa-side-open")).toBe(true);
    expect(document.querySelector(".qa-side-panel")?.parentElement).toBe(document.querySelector(".app-shell"));
    const qaProviderSelect = screen.getByLabelText("智能问答模型");
    expect(qaProviderSelect).toHaveProperty("value", "ollama");
    const qaInput = screen.getByLabelText("输入仓库问题");
    fireEvent.change(qaInput, { target: { value: "这个项目如何启动？" } });
    fireEvent.submit(qaInput.closest("form") as HTMLFormElement);
    expect(await screen.findByRole("button", { name: /使用当前模型重试/ })).toBeTruthy();
    fireEvent.change(qaProviderSelect, { target: { value: "openai-chat-compatible" } });
    fireEvent.click(screen.getByRole("button", { name: /使用当前模型重试/ }));
    expect(await screen.findByText("README.md:3-3")).toBeTruthy();
    expect(screen.getByText("启动命令记录在 README。", { exact: false })).toBeTruthy();
    expect(screen.getByText("[证据已校验]")).toBeTruthy();
    expect(screen.getByText("高置信")).toBeTruthy();
    expect(screen.getByText("1 条证据 · 1 个有效引用 · 12.4 ms")).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("section")).toBe("projects");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/11/ask",
      expect.objectContaining({ method: "POST" }),
    );
    const askCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/projects/11/ask"));
    expect(askCalls).toHaveLength(2);
    expect(JSON.parse(String(askCalls[0]?.[1]?.body))).toMatchObject({ provider: "ollama" });
    expect(JSON.parse(String(askCalls[1]?.[1]?.body))).toMatchObject({ provider: "openai-chat-compatible" });
    fireEvent.click(screen.getByRole("button", { name: /README\.md:3-3/ }));
    expect(await screen.findByRole("dialog", { name: "README.md" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/11/files/1/content", undefined);
  });

  it("shows the displayed search count and loads more results", async () => {
    const timestamp = "2026-08-26T10:00:00Z";
    const project = {
      id: 5,
      name: "searchable-repo",
      source_filename: "searchable-repo/",
      status: "ready",
      primary_language: "TypeScript",
      file_count: 12,
      code_line_count: 120,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const makeResult = (index: number) => ({
      chunk_id: index + 1,
      file_id: index + 1,
      file_path: `src/result-${index + 1}.ts`,
      symbol_name: `result${index + 1}`,
      kind: "function",
      start_line: 1,
      end_line: 3,
      snippet_start_line: 1,
      snippet_end_line: 3,
      snippet: `function result${index + 1}() { return "needle"; }`,
      score: 1 / (index + 1),
    });
    let finishInitialSearch!: () => void;
    const initialSearchPending = new Promise<void>((resolve) => {
      finishInitialSearch = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json([project]);
      if (url.endsWith("/api/projects/5")) return Response.json({ ...project, files: [] });
      if (url.endsWith("/structure/summary")) return Response.json({ symbol_count: 0, class_count: 0, function_count: 0, import_count: 0, resolved_import_count: 0, issue_count: 0 });
      if (url.endsWith("/files/1/content")) return Response.json({ file_id: 1, file_path: "src/result-1.ts", language: "TypeScript", size_bytes: 72, total_lines: 3, lines: ["export function result1() {", "  return \"needle\";", "}"] });
      if (url.includes("/search?")) {
        const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") ?? "0");
        if (offset === 0) await initialSearchPending;
        const results = Array.from({ length: offset === 0 ? 10 : 2 }, (_, index) => makeResult(offset + index));
        return Response.json({ query: "needle", indexed_chunks: 12, total_matches: 12, limit: 10, offset, has_more: offset + results.length < 12, elapsed_ms: 1.2, results });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByText("searchable-repo"));
    await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("searchable-repo"));
    fireEvent.click(screen.getByRole("button", { name: /代码搜索/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "代码搜索关键词" }), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: /^搜索$/ }));

    expect(await screen.findByRole("status", { name: "代码搜索进行中" })).toBeTruthy();
    expect(screen.getByText("正在当前仓库中检索“needle”")).toBeTruthy();
    finishInitialSearch();
    expect(await screen.findByText("显示 10 / 12 条匹配")).toBeTruthy();
    expect(document.querySelectorAll(".search-result")).toHaveLength(10);
    fireEvent.click(screen.getAllByRole("button", { name: "查看代码" })[0]);
    expect(await screen.findByRole("dialog", { name: "src/result-1.ts" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "src/result-1.ts 源代码" })).toBeTruthy();
    expect(document.querySelectorAll(".code-viewer-line")).toHaveLength(3);
    expect(document.querySelector(".code-viewer-line.highlighted mark")?.textContent).toBe("needle");
    fireEvent.click(screen.getByRole("button", { name: "复制路径" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("src/result-1.ts"));
    fireEvent.click(screen.getByRole("button", { name: "关闭代码查看器" }));
    expect(screen.queryByRole("dialog", { name: "src/result-1.ts" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /加载更多/ }));
    await waitFor(() => expect(document.querySelectorAll(".search-result")).toHaveLength(12));
    expect(screen.getByText("显示 12 / 12 条匹配")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /加载更多/ })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("offset=10"), undefined);
  });

  it("restores the project and feature section from the URL", async () => {
    const timestamp = "2026-08-26T10:00:00Z";
    const project = {
      id: 7,
      name: "restored-repo",
      source_filename: "restored-repo/",
      status: "ready",
      primary_language: "TypeScript",
      file_count: 1,
      code_line_count: 12,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json([project]);
      if (url.endsWith("/api/projects/7")) return Response.json({ ...project, files: [] });
      if (url.endsWith("/structure/summary")) return Response.json({ symbol_count: 0, class_count: 0, function_count: 0, import_count: 0, resolved_import_count: 0, issue_count: 0 });
      if (url.includes("/dependency-graph")) return Response.json({ total_node_count: 0, total_edge_count: 0, internal_import_count: 0, external_import_count: 0, cycle_count: 0, truncated: false, nodes: [], edges: [], cycles: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/?section=graph&project=7&tab=imports");

    render(<App />);

    expect(await screen.findByText("没有项目内依赖")).toBeTruthy();
    expect(document.querySelector(".project-trigger")?.textContent).toContain("restored-repo");
    expect(screen.getByRole("button", { name: /依赖图谱/ }).className).toContain("active");
    expect(document.querySelector(".workspace-breadcrumb")?.textContent).toContain("restored-repo/依赖图谱");

    window.history.pushState({}, "", "/?section=projects&project=7&tab=imports");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() => expect(screen.getByRole("button", { name: /^依赖 / }).className).toContain("active"));
    expect(document.querySelector(".workspace-breadcrumb")?.textContent).toContain("restored-repo/依赖");
  });

  it("shows feature loading errors inside the workspace", async () => {
    const timestamp = "2026-08-26T10:00:00Z";
    const project = { id: 3, name: "broken-graph", source_filename: "broken-graph/", status: "ready", primary_language: "Python", file_count: 0, code_line_count: 0, created_at: timestamp, updated_at: timestamp };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json([project]);
      if (url.endsWith("/api/projects/3")) return Response.json({ ...project, files: [] });
      if (url.endsWith("/structure/summary")) return Response.json({ symbol_count: 0, class_count: 0, function_count: 0, import_count: 0, resolved_import_count: 0, issue_count: 0 });
      if (url.includes("/dependency-graph")) return Response.json({ detail: "图谱服务暂时不可用" }, { status: 503 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByText("broken-graph"));
    await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("broken-graph"));
    fireEvent.click(screen.getByRole("button", { name: /依赖图谱/ }));

    expect((await screen.findByRole("alert")).className).toContain("workspace-error");
    expect(document.querySelector(".error-banner")).toBeNull();
  });

  it("explains directed dependency edges and opens their import details", async () => {
    const timestamp = "2026-08-26T10:00:00Z";
    const project = { id: 8, name: "dependency-demo", source_filename: "dependency-demo/", status: "ready", primary_language: "Python", file_count: 2, code_line_count: 20, created_at: timestamp, updated_at: timestamp };
    const graph = {
      total_node_count: 3,
      total_edge_count: 3,
      internal_import_count: 4,
      external_import_count: 2,
      unresolved_import_count: 1,
      classified_import_count: 6,
      classification_confidence: 85.7,
      confidence_level: "medium",
      cycle_count: 1,
      truncated: false,
      nodes: [
        { id: 1, path: "src/a.py", language: "Python", in_degree: 1, out_degree: 1 },
        { id: 2, path: "src/b.py", language: "Python", in_degree: 1, out_degree: 2 },
        { id: 3, path: "src/c.py", language: "Python", in_degree: 1, out_degree: 0 },
      ],
      edges: [
        { source_id: 1, target_id: 2, source_path: "src/a.py", target_path: "src/b.py", import_count: 2, line_numbers: [2, 5] },
        { source_id: 2, target_id: 1, source_path: "src/b.py", target_path: "src/a.py", import_count: 1, line_numbers: [3] },
        { source_id: 2, target_id: 3, source_path: "src/b.py", target_path: "src/c.py", import_count: 1, line_numbers: [8] },
      ],
      cycles: [{ file_ids: [1, 2], paths: ["src/a.py", "src/b.py"] }],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json([project]);
      if (url.endsWith("/api/projects/8")) return Response.json({ ...project, files: [] });
      if (url.endsWith("/structure/summary")) return Response.json({ symbol_count: 0, class_count: 0, function_count: 0, import_count: 3, resolved_import_count: 3, issue_count: 0 });
      if (url.includes("/dependency-graph") && url.includes("cycle=1")) {
        return Response.json({ ...graph, truncated: false, nodes: graph.nodes.slice(0, 2), edges: graph.edges.slice(0, 2) });
      }
      if (url.includes("/dependency-graph")) return Response.json(graph);
      return new Response(null, { status: 404 });
    }));
    render(<App />);

    fireEvent.click(await screen.findByText("dependency-demo"));
    await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("dependency-demo"));
    fireEvent.click(screen.getByRole("button", { name: /依赖图谱/ }));

    expect(await screen.findByText("A → B 表示 A 导入并依赖 B")).toBeTruthy();
    expect(screen.getByText("依赖分类可信度 85.7%")).toBeTruthy();
    expect(screen.getByText(/推定外部 2 · 待确认 1/)).toBeTruthy();
    expect(screen.getByText("普通模块")).toBeTruthy();
    expect(screen.getByText("选中的循环模块")).toBeTruthy();
    expect(screen.getByText("循环依赖边")).toBeTruthy();
    expect(screen.queryByText(/橙黄色虚线/)).toBeNull();
    expect(screen.queryByText(/节点越大表示入度与出度总和越高/)).toBeNull();
    expect(screen.queryByText(/“待确认”表示导入看起来指向项目代码/)).toBeNull();
    const inspector = document.querySelector(".node-inspector");
    expect(inspector?.textContent).toContain("当前模块依赖");
    expect(inspector?.textContent).toContain("依赖当前模块");
    expect(document.querySelectorAll(".dependency-edge")).toHaveLength(3);
    expect(document.querySelectorAll(".dependency-edge.cyclic")).toHaveLength(2);
    expect(document.querySelector(".dependency-edge .edge-line")?.getAttribute("d")).toContain(" Q ");
    expect(screen.getByText("×2")).toBeTruthy();

    const cycleButton = screen.getByRole("button", { name: /聚焦环 1/ });
    fireEvent.click(cycleButton);
    expect(await screen.findByText("图中仅保留该循环的 2 个节点和 2 条内部依赖边")).toBeTruthy();
    expect(document.querySelectorAll(".dependency-node")).toHaveLength(2);
    expect(document.querySelectorAll(".dependency-edge")).toHaveLength(2);
    expect(cycleButton.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "src/a.py 导入并依赖 src/b.py，2 条导入" }));
    expect(await screen.findByText("a.py → b.py")).toBeTruthy();
    expect(screen.getByText("第 2 行、第 5 行")).toBeTruthy();
    expect(screen.getByRole("button", { name: "返回模块详情" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "退出循环聚焦" }));
    expect(document.querySelectorAll(".dependency-node")).toHaveLength(3);
    expect(document.querySelectorAll(".dependency-edge")).toHaveLength(3);
  });

  it("keeps full analysis in the overview and reloads quality when reopened", async () => {
    const timestamp = "2026-08-26T10:00:00Z";
    const project = { id: 9, name: "quality-repo", source_filename: "quality-repo/", status: "ready", primary_language: "Python", file_count: 1, code_line_count: 20, created_at: timestamp, updated_at: timestamp };
    const structure = { symbol_count: 1, class_count: 0, function_count: 1, import_count: 0, resolved_import_count: 0, issue_count: 0, symbols: [], imports: [], issues: [] };
    const qualityReport = {
      score: 100,
      grade: "A",
      score_scope: "composite",
      scope_scores: {
        production: { scope: "production", label: "生产代码", score: 100, grade: "A", available: true, configured_weight: .7, effective_weight: 1, exclusion_reason: null, finding_count: 0, severity_counts: { error: 0, warning: 0, info: 0 }, project_size: { file_count: 1, code_line_count: 20, symbol_count: 1 } },
        test: { scope: "test", label: "测试代码", score: null, grade: null, available: false, configured_weight: .2, effective_weight: 0, exclusion_reason: "未检测到测试代码文件，不参与综合评分。", finding_count: 0, severity_counts: { error: 0, warning: 0, info: 0 }, project_size: { file_count: 0, code_line_count: 0, symbol_count: 0 } },
        generated: { scope: "generated", label: "生成/外部代码", score: null, grade: null, available: false, configured_weight: .1, effective_weight: 0, exclusion_reason: "未检测到生成/外部代码文件，不参与综合评分。", finding_count: 0, severity_counts: { error: 0, warning: 0, info: 0 }, project_size: { file_count: 0, code_line_count: 0, symbol_count: 0 } },
      },
      scoring: {
        model: "size_normalized_v2",
        size_factor: 1,
        scale_units: 1,
        project_size: { file_count: 1, code_line_count: 20, symbol_count: 1 },
        reference_size: { file_count: 50, code_line_count: 10_000, symbol_count: 500 },
        base_weights: { error: 8, warning: 3, info: 1 },
        effective_weights: { error: 8, warning: 3, info: 1 },
        base_penalty: 0,
        adjusted_penalty: 0,
        rule_penalties: {},
        explanation: "项目超过参考规模后，单项权重按规模单位线性递减。",
      },
      total_findings: 0,
      severity_counts: { error: 0, warning: 0, info: 0 },
      rule_counts: { long_function: 0 },
      rules: [{ id: "long_function", title: "超长函数", description: "检测过长函数", default_severity: "warning" }],
      findings: [],
      truncated: false,
      elapsed_ms: 1.2,
    };
    let qualityRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json([project]);
      if (url.endsWith("/reanalyze")) return Response.json(structure);
      if (url.includes("/quality?")) {
        qualityRequests += 1;
        return Response.json(qualityReport);
      }
      if (url.endsWith("/structure/summary")) return Response.json(structure);
      if (url.endsWith("/api/projects/9")) return Response.json({ ...project, files: [] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByText("quality-repo"));
    await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("quality-repo"));
    fireEvent.click(screen.getByRole("button", { name: /质量检测/ }));
    expect(await screen.findByText("未发现规则命中的质量问题")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "综合质量评分 100 分，评级 A" }).classList.contains("grade-a")).toBe(true);
    expect(screen.getAllByText("N/A")).toHaveLength(2);
    expect(screen.getByText("未检测到测试代码文件，不参与综合评分。")).toBeTruthy();
    expect(screen.queryByText(/1 文件 · 0 项风险 · 权重/)).toBeNull();
    expect(screen.queryByText("检测过长函数")).toBeNull();
    expect(screen.queryByRole("region", { name: "质量评分依据" })).toBeNull();
    expect(screen.queryByRole("button", { name: "全量" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /仓库概览/ }));
    const fullAnalysisButton = await screen.findByRole("button", { name: "全量" });
    fireEvent.click(fullAnalysisButton);
    await waitFor(() => expect(fullAnalysisButton.hasAttribute("disabled")).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: /质量检测/ }));
    await waitFor(() => expect(qualityRequests).toBe(2));
    expect(await screen.findByText("未发现规则命中的质量问题")).toBeTruthy();
    expect(document.querySelector(".quality-view")).not.toBeNull();
    expect(document.querySelector(".workspace-error")).toBeNull();
  });

  it("loads quality findings in server-filtered pages", async () => {
    const timestamp = "2026-08-26T10:00:00Z";
    const project = { id: 10, name: "large-quality-repo", source_filename: "large-quality-repo/", status: "ready", primary_language: "TypeScript", file_count: 200, code_line_count: 80_000, created_at: timestamp, updated_at: timestamp };
    const structure = { symbol_count: 2_000, class_count: 100, function_count: 1_900, import_count: 600, resolved_import_count: 550, issue_count: 0 };
    const findings = Array.from({ length: 150 }, (_, index) => ({
      id: `LONG_FUNCTION:${index + 1}`,
      rule_id: "LONG_FUNCTION",
      severity: "warning",
      title: "超长函数",
      description: `函数包含 ${100 + index} 行代码。`,
      suggestion: "拆分为职责单一的辅助函数。",
      file_id: index + 1,
      file_path: `src/module-${index + 1}.ts`,
      start_line: 1,
      end_line: 100 + index,
      metric: 100 + index,
      threshold: 80,
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json([project]);
      if (url.endsWith("/api/projects/10")) return Response.json(project);
      if (url.endsWith("/structure/summary")) return Response.json(structure);
      if (url.includes("/quality?")) {
        const params = new URL(url, "http://localhost").searchParams;
        const offset = Number(params.get("offset") ?? "0");
        const limit = Number(params.get("limit") ?? "100");
        const page = findings.slice(offset, offset + limit);
        return Response.json({
          score: 82,
          grade: "B",
          scoring: { model: "size_normalized_v2", size_factor: 0.2, scale_units: 5, project_size: { file_count: 200, code_line_count: 80_000, symbol_count: 2_000 }, reference_size: { file_count: 50, code_line_count: 10_000, symbol_count: 500 }, base_weights: { error: 8, warning: 3, info: 1 }, effective_weights: { error: 1.6, warning: 0.6, info: 0.2 }, base_penalty: 100, adjusted_penalty: 18, rule_penalties: { LONG_FUNCTION: 18 }, explanation: "规模归一化" },
          total_findings: findings.length,
          filtered_findings: findings.length,
          limit,
          offset,
          has_more: offset + page.length < findings.length,
          severity_counts: { error: 0, warning: findings.length, info: 0 },
          rule_counts: { LONG_FUNCTION: findings.length },
          rules: [{ id: "LONG_FUNCTION", title: "超长函数", description: "函数或方法过长。", default_severity: "warning" }],
          findings: page,
          truncated: offset + page.length < findings.length,
          elapsed_ms: 4.2,
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByText("large-quality-repo"));
    await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("large-quality-repo"));
    fireEvent.click(screen.getByRole("button", { name: /质量检测/ }));
    await waitFor(() => expect(document.querySelectorAll(".quality-finding")).toHaveLength(100));
    expect(document.querySelector(".quality-toolbar")?.textContent).toContain("当前显示 100 / 150");

    fireEvent.click(screen.getByRole("button", { name: /LOAD_NEXT/ }));
    await waitFor(() => expect(document.querySelectorAll(".quality-finding")).toHaveLength(150));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/quality?limit=100&offset=100"), undefined);

    expect(screen.getAllByText("中风险").length).toBeGreaterThan(0);
    expect(screen.getByText("实际 100 / 建议 ≤ 80 · 超出 25%")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("风险等级"), { target: { value: "warning" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("severity=warning"), undefined));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("offset=0"), undefined);
  });

  it("synchronizes remote GitHub source and exposes commit comparison beside snapshots", async () => {
    const timestamp = "2026-08-28T10:00:00Z";
    const project = { id: 11, name: "git-repo", source_filename: "github.com/example/git-repo", status: "ready", primary_language: "TypeScript", file_count: 3, code_line_count: 120, created_at: timestamp, updated_at: timestamp };
    const snapshot = { id: 31, project_id: 11, label: "功能启用基线", reason: "manual", created_at: timestamp, score: 88, grade: "B", file_count: 3, symbol_count: 9, import_count: 4, finding_count: 2, cycle_count: 0, parse_issue_count: 0 };
    const unavailable = { available: false, refreshable: true, repository_url: "https://github.com/example/git-repo", default_branch: null, head_commit: null, history_available: false, recent_commits: [], fetched_at: null, message: "尚未获取 GitHub 提交元数据。" };
    const available = { ...unavailable, available: true, default_branch: "main", head_commit: "1234567890abcdef1234567890abcdef12345678", history_available: true, fetched_at: timestamp, message: "已获取 GitHub 提交元数据。", recent_commits: [{ sha: "1234567890abcdef1234567890abcdef12345678", message: "feat: add analysis snapshots", author: "Dev Atlas", authored_at: timestamp }, { sha: "abcdef1234567890abcdef1234567890abcdef12", message: "refactor: prepare snapshot model", author: "Dev Atlas", authored_at: timestamp }] };
    const gitComparison = { repository_url: unavailable.repository_url, base_commit: available.recent_commits[1].sha, head_commit: available.recent_commits[0].sha, status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, additions: 18, deletions: 4, changed_files: 2, files: [{ path: "src/snapshots.ts", status: "modified", additions: 12, deletions: 4, changes: 16 }, { path: "src/git.ts", status: "added", additions: 6, deletions: 0, changes: 6 }], truncated: false };
    let synchronized = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json([project]);
      if (url.endsWith("/api/projects/11")) return Response.json(project);
      if (url.endsWith("/structure/summary")) return Response.json({ symbol_count: 0, class_count: 0, function_count: 0, import_count: 0, resolved_import_count: 0, issue_count: 0 });
      if (url.endsWith("/snapshots")) return Response.json([snapshot]);
      if (url.endsWith("/sync-github")) {
        synchronized = true;
        return Response.json({ id: "sync-11", source_type: "github_sync", source_label: "github.com/example/git-repo", status: "completed", stage: "synchronized", progress: 100, message: "远程源码已更新，重新分析和版本快照已完成", project_id: 11, error: null, created_at: timestamp, updated_at: timestamp, completed_at: timestamp });
      }
      if (url.endsWith("/git-summary")) return Response.json(synchronized ? available : unavailable);
      if (url.includes("/git-compare?")) return Response.json(gitComparison);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByText("git-repo"));
    await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("git-repo"));
    fireEvent.click(screen.getByRole("button", { name: /版本对比/ }));
    expect(await screen.findByText(/尚未同步 GitHub 提交与源码版本/)).toBeTruthy();
    expect(screen.getByText("GitHub 版本同步与对比")).toBeTruthy();
    expect(await screen.findByText("快照记录")).toBeTruthy();
    const compareControls = document.querySelector(".snapshot-compare-controls") as HTMLElement;
    const history = document.querySelector(".snapshot-history") as HTMLElement;
    expect(compareControls.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /同步远程仓库/ }));
    expect(await screen.findByText("feat: add analysis snapshots")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getAllByText("12345678").length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/11/sync-github", expect.objectContaining({ method: "POST" }));
    expect(screen.getByText(/重新分析和版本快照已完成/)).toBeTruthy();

    const compareGitButton = screen.getByRole("button", { name: /对比提交/ });
    await waitFor(() => expect(compareGitButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(compareGitButton);
    expect(await screen.findByText("1 个提交 · 2 个变更文件")).toBeTruthy();
    expect(screen.getByText("src/snapshots.ts")).toBeTruthy();
    expect(screen.getByText(/GitHub 远端对比，不代表本地源码已更新/)).toBeTruthy();
  });

  it("searches a symbol and displays its bounded change impact", async () => {
    const timestamp = "2026-08-26T10:00:00Z";
    const project = { id: 12, name: "impact-repo", source_filename: "impact-repo/", status: "ready", primary_language: "Python", file_count: 4, code_line_count: 80, created_at: timestamp, updated_at: timestamp };
    const target = { target_type: "symbol", target_id: 7, file_id: 2, file_path: "app/auth.py", name: "authenticate_user", kind: "function", start_line: 3, end_line: 8 };
    const relation = (fileId: number, filePath: string, relationName: string, confidence: "high" | "medium" | "low" = "high") => ({
      file_id: fileId, file_path: filePath, relation: relationName, confidence, depth: 1,
      line_numbers: [2], symbol_id: null, symbol_name: null, symbol_kind: null, start_line: 2, end_line: 2,
    });
    const impact = {
      target,
      definition: { ...relation(2, "app/auth.py", "definition"), depth: 0, symbol_id: 7, symbol_name: "authenticate_user", symbol_kind: "function", start_line: 3, end_line: 8 },
      risk: {
        model: "reference_v2", base_score: 8, level: "high", score: 72, confidence: "medium",
        reasons: ["存在 2 个直接调用或引用位置", "影响范围触及接口或路由层"],
        factors: [{ key: "direct_callers", label: "直接调用或引用", actual: 2, reference: 8, unit: "个", contribution: 10, explanation: "达到参考值时计满该项风险。" }],
      },
      direct_callers: [relation(3, "app/api/login.py", "symbol_reference", "medium")],
      called_objects: [relation(4, "app/models/user.py", "target_imports_module")],
      dependencies: [relation(4, "app/models/user.py", "target_imports_module")],
      indirect_impacts: [relation(1, "app/main.py", "transitive_caller", "medium")],
      related_tests: [relation(5, "tests/test_auth.py", "symbol_reference", "medium")],
      related_apis: [relation(3, "app/api/login.py", "symbol_reference", "medium")],
      database_entities: [relation(4, "app/models/user.py", "target_imports_module")],
      cycles: [],
      recommendations: [
        { code: "run_related_tests", priority: "high", title: "优先运行已定位的相关测试", detail: "修改前后运行同一组测试。", related_paths: ["tests/test_auth.py"] },
        { code: "review_direct_callers", priority: "medium", title: "逐一检查直接调用者", detail: "确认调用契约没有被破坏。", related_paths: ["app/api/login.py"] },
      ],
      limitations: "函数关系来自有界源码引用推断。",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json([project]);
      if (url.endsWith("/api/projects/12")) return Response.json(project);
      if (url.endsWith("/structure/summary")) return Response.json({ symbol_count: 1, class_count: 0, function_count: 1, import_count: 2, resolved_import_count: 2, issue_count: 0 });
      if (url.includes("/impact-targets?")) return Response.json([target]);
      if (url.includes("/impact?")) return Response.json(impact);
      if (url.endsWith("/report-generators")) return Response.json([]);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByText("impact-repo"));
    await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("impact-repo"));
    fireEvent.click(screen.getByRole("button", { name: /耦合分析/ }));
    fireEvent.change(screen.getByLabelText(/选择要修改的文件、类或函数/), { target: { value: "authenticate" } });
    fireEvent.click(screen.getByRole("button", { name: "查找对象" }));
    fireEvent.click(await screen.findByRole("button", { name: /authenticate_user/ }));

    expect(await screen.findByText("72")).toBeTruthy();
    expect(screen.queryByText("CHANGE_RISK")).toBeNull();
    expect(screen.getByText("高风险 · 中置信")).toBeTruthy();
    expect(screen.queryByText("风险参考变量")).toBeNull();
    expect(screen.getByText("直接调用者")).toBeTruthy();
    expect(screen.queryByText("修改与验证清单")).toBeNull();
    expect(screen.queryByText("优先运行已定位的相关测试")).toBeNull();
    expect(document.querySelector(".impact-risk-reasons")?.textContent).not.toContain("[01]");
    expect(screen.getAllByText("app/api/login.py").length).toBeGreaterThan(0);
    expect(screen.getByText("函数关系来自有界源码引用推断。")).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("section")).toBe("impact");
  });

  it("generates a targeted report and saves it from the dedicated report workspace", async () => {
    const timestamp = "2026-08-26T10:00:00Z";
    const project = { id: 10, name: "report-repo", source_filename: "report-repo/", status: "ready", primary_language: "Python", file_count: 1, code_line_count: 20, created_at: timestamp, updated_at: timestamp };
    const structure = { symbol_count: 0, class_count: 0, function_count: 0, import_count: 0, resolved_import_count: 0, issue_count: 0, symbols: [], imports: [], issues: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json([project]);
      if (url.endsWith("/api/projects/10")) return Response.json({ ...project, files: [] });
      if (url.endsWith("/structure/summary")) return Response.json(structure);
      const localProvider = { id: "local", name: "本地智能分析", description: "综合结构与质量数据", endpoint: "/api/projects/{project_id}/report?generator=local", available: true, configured: true, requires_configuration: false, cost_label: "免费 · 默认", base_url: "local://rule-engine", model: "DevAtlas Rules", has_api_key: false, connection_status: "ready", connection_message: "已就绪", tested_at: null };
      const ollamaProvider = { id: "ollama", name: "Ollama 本地模型服务", description: "本地模型接口", endpoint: "/api/generate", available: false, configured: false, requires_configuration: true, cost_label: "免费 · 本地运行", base_url: "http://127.0.0.1:11434", model: "", has_api_key: false, connection_status: "untested", connection_message: "尚未测试", tested_at: null };
      if (url.endsWith("/report-generators")) return Response.json([localProvider, ollamaProvider]);
      if (url.endsWith("/report-generators/ollama/test")) return Response.json({ ok: true, message: "Ollama 连接成功", provider: { ...ollamaProvider, available: true, configured: true, model: "local-code-model", connection_status: "success" } });
      if (url.endsWith("/report-generators/ollama")) return Response.json({ ...ollamaProvider, available: true, configured: true, model: "local-code-model" });
      if (url.includes("/report?generator=local")) {
        const mode = new URL(url, "http://localhost").searchParams.get("mode") ?? "summary";
        return Response.json({ generator: "local", mode, generated_at: timestamp, filename: `report-repo-${mode}.md`, content: `# report-repo 代码仓库分析报告\n\n> 报告模式：${mode}\n\n## 2. 智能分析结论\n\n- 项目画像` });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }));
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: showSaveFilePicker });
    render(<App />);

    const sidebarNavigation = Array.from(document.querySelectorAll(".sidebar > nav"));
    expect(sidebarNavigation.map((item) => item.textContent).join(" ")).not.toContain("PROJECT_TOOLS");
    expect(sidebarNavigation.map((item) => item.textContent).join(" ")).not.toContain("MODEL_RUNTIME");

    fireEvent.click(await screen.findByText("report-repo"));
    await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("report-repo"));
    expect(screen.queryByRole("button", { name: /导出 MD/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /API 配置/ }));
    expect(await screen.findByText("统一模型与 API 配置")).toBeTruthy();
    expect(document.querySelector(".detail-metrics")).toBeNull();
    expect(screen.getByLabelText("分析报告默认模型")).toHaveProperty("value", "local");
    expect(screen.getByLabelText("智能问答默认模型")).toHaveProperty("value", "");

    const ollamaCard = Array.from(document.querySelectorAll<HTMLElement>(".report-generator-card")).find((card) => card.textContent?.includes("Ollama 本地模型服务")) as HTMLElement;
    expect(ollamaCard.classList.contains("unavailable")).toBe(true);
    fireEvent.click(ollamaCard.querySelector(".provider-card-footer button") as HTMLButtonElement);
    expect(screen.getByText("配置 Ollama 本地模型服务")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: "local-code-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/report-generators/ollama"), expect.objectContaining({ method: "PUT" })));
    expect(await screen.findByText("配置已保存到本机后端，请继续测试连接。")).toBeTruthy();
    await waitFor(() => expect(ollamaCard.classList.contains("unavailable")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("Ollama 连接成功")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("分析报告默认模型"), { target: { value: "local" } });
    fireEvent.change(screen.getByLabelText("智能问答默认模型"), { target: { value: "ollama" } });
    expect(screen.getByLabelText("智能问答默认模型")).toHaveProperty("value", "ollama");

    fireEvent.click(screen.getByRole("button", { name: /分析报告/ }));
    expect(screen.queryByText("配置 Ollama 本地模型服务")).toBeNull();
    expect(screen.queryByText("统一模型与 API 配置")).toBeNull();
    expect((await screen.findByLabelText("Markdown 报告预览")).textContent).toContain("智能分析结论");
    expect(screen.getByLabelText("报告分析模型")).toHaveProperty("value", "local");
    expect(screen.getByLabelText("报告范围")).toHaveProperty("value", "summary");
    fireEvent.click(screen.getByRole("button", { name: /重新生成/ }));
    await waitFor(() => expect(screen.getByLabelText("Markdown 报告预览").textContent).toContain("智能分析结论"));

    fireEvent.change(screen.getByLabelText("报告范围"), { target: { value: "full" } });
    expect(screen.queryByLabelText("Markdown 报告预览")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /重新生成/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("mode=full"), undefined));
    expect(screen.getByLabelText("Markdown 报告预览").textContent).toContain("报告模式：full");

    fireEvent.click(screen.getByRole("button", { name: /导出 MD/ }));
    await waitFor(() => expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "report-repo-full.md" })));
    expect(write).toHaveBeenCalledWith(expect.any(Blob));
    expect(close).toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: /导出 MD/ })).toHaveLength(1);

    fireEvent.click(document.querySelector(".project-trigger") as HTMLButtonElement);
    const pickerActions = document.querySelector(".project-picker-actions");
    expect(pickerActions?.textContent).toContain("管理项目");
    expect(pickerActions?.textContent).not.toContain("导入");
  });
});
