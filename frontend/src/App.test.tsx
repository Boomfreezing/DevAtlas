// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";


describe("App", () => {
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
    expect(screen.getByRole("tree", { name: "仓库文件树" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /src 目录/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /core 目录/ }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /core 目录/ }));
    expect(screen.getByText("main.py")).toBeTruthy();
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json([project]);
      if (url.endsWith("/api/projects/5")) return Response.json({ ...project, files: [] });
      if (url.endsWith("/structure/summary")) return Response.json({ symbol_count: 0, class_count: 0, function_count: 0, import_count: 0, resolved_import_count: 0, issue_count: 0 });
      if (url.endsWith("/files/1/content")) return Response.json({ file_id: 1, file_path: "src/result-1.ts", language: "TypeScript", size_bytes: 72, total_lines: 3, lines: ["export function result1() {", "  return \"needle\";", "}"] });
      if (url.includes("/search?")) {
        const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") ?? "0");
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
      total_node_count: 2,
      total_edge_count: 2,
      internal_import_count: 3,
      external_import_count: 0,
      cycle_count: 1,
      truncated: false,
      nodes: [
        { id: 1, path: "src/a.py", language: "Python", in_degree: 1, out_degree: 1 },
        { id: 2, path: "src/b.py", language: "Python", in_degree: 1, out_degree: 1 },
      ],
      edges: [
        { source_id: 1, target_id: 2, source_path: "src/a.py", target_path: "src/b.py", import_count: 2, line_numbers: [2, 5] },
        { source_id: 2, target_id: 1, source_path: "src/b.py", target_path: "src/a.py", import_count: 1, line_numbers: [3] },
      ],
      cycles: [{ file_ids: [1, 2], paths: ["src/a.py", "src/b.py"] }],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/projects")) return Response.json([project]);
      if (url.endsWith("/api/projects/8")) return Response.json({ ...project, files: [] });
      if (url.endsWith("/structure/summary")) return Response.json({ symbol_count: 0, class_count: 0, function_count: 0, import_count: 3, resolved_import_count: 3, issue_count: 0 });
      if (url.includes("/dependency-graph")) return Response.json(graph);
      return new Response(null, { status: 404 });
    }));
    render(<App />);

    fireEvent.click(await screen.findByText("dependency-demo"));
    await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("dependency-demo"));
    fireEvent.click(screen.getByRole("button", { name: /依赖图谱/ }));

    expect(await screen.findByText("A → B 表示 A 导入并依赖 B")).toBeTruthy();
    const inspector = document.querySelector(".node-inspector");
    expect(inspector?.textContent).toContain("当前模块依赖");
    expect(inspector?.textContent).toContain("依赖当前模块");
    expect(document.querySelectorAll(".dependency-edge")).toHaveLength(2);
    expect(document.querySelector(".dependency-edge .edge-line")?.getAttribute("d")).toContain(" Q ");
    expect(screen.getByText("×2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "src/a.py 导入并依赖 src/b.py，2 条导入" }));
    expect(await screen.findByText("a.py → b.py")).toBeTruthy();
    expect(screen.getByText("第 2 行、第 5 行")).toBeTruthy();
    expect(screen.getByRole("button", { name: "返回模块详情" })).toBeTruthy();
  });

  it("keeps full analysis in the overview and reloads quality when reopened", async () => {
    const timestamp = "2026-08-26T10:00:00Z";
    const project = { id: 9, name: "quality-repo", source_filename: "quality-repo/", status: "ready", primary_language: "Python", file_count: 1, code_line_count: 20, created_at: timestamp, updated_at: timestamp };
    const structure = { symbol_count: 1, class_count: 0, function_count: 1, import_count: 0, resolved_import_count: 0, issue_count: 0, symbols: [], imports: [], issues: [] };
    const qualityReport = {
      score: 100,
      grade: "A",
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
    expect(screen.getByRole("meter", { name: "质量评分 100 分，评级 A" }).classList.contains("grade-a")).toBe(true);
    expect(screen.getByRole("region", { name: "质量评分依据" }).textContent).toContain("规模系数×1.000");
    expect(screen.getByRole("region", { name: "质量评分依据" }).textContent).toContain("ERR 8.00");
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
      if (url.endsWith("/report?generator=local")) return Response.json({ generator: "local", generated_at: timestamp, filename: "report-repo.md", content: "# report-repo 代码仓库分析报告\n\n## 2. 智能分析结论\n\n- 项目画像" });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }));
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: showSaveFilePicker });
    render(<App />);

    fireEvent.click(await screen.findByText("report-repo"));
    await waitFor(() => expect(document.querySelector(".topbar h1")?.textContent).toBe("report-repo"));
    expect(screen.queryByRole("button", { name: /导出 MD/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /分析报告/ }));
    expect(await screen.findByText("选择分析接口")).toBeTruthy();
    expect(document.querySelector(".detail-metrics")).toBeNull();
    expect(screen.getByText("本地智能分析")).toBeTruthy();
    expect(screen.getByText("Ollama 本地模型服务")).toBeTruthy();
    expect(screen.getByLabelText("Markdown 报告预览").textContent).toContain("智能分析结论");

    const ollamaCard = screen.getByText("Ollama 本地模型服务").closest("article") as HTMLElement;
    expect(ollamaCard.querySelector(".provider-select-button")).toHaveProperty("disabled", true);
    fireEvent.click(ollamaCard.querySelector(".provider-card-footer button") as HTMLButtonElement);
    expect(screen.getByText("配置 Ollama 本地模型服务")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: "local-code-model" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/report-generators/ollama"), expect.objectContaining({ method: "PUT" })));
    expect(await screen.findByText("配置已保存到本机后端，请继续测试连接。")).toBeTruthy();
    await waitFor(() => expect(ollamaCard.querySelector(".provider-select-button")).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("Ollama 连接成功")).toBeTruthy();

    fireEvent.click(screen.getByText("本地智能分析").closest("button") as HTMLButtonElement);
    expect(screen.queryByText("配置 Ollama 本地模型服务")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /重新生成/ }));
    await waitFor(() => expect(screen.getByLabelText("Markdown 报告预览").textContent).toContain("智能分析结论"));

    fireEvent.click(screen.getByRole("button", { name: /导出 MD/ }));
    await waitFor(() => expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "report-repo.md" })));
    expect(write).toHaveBeenCalledWith(expect.any(Blob));
    expect(close).toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: /导出 MD/ })).toHaveLength(1);

    fireEvent.click(document.querySelector(".project-trigger") as HTMLButtonElement);
    const pickerActions = document.querySelector(".project-picker-actions");
    expect(pickerActions?.textContent).toContain("管理项目");
    expect(pickerActions?.textContent).not.toContain("导入");
  });
});
