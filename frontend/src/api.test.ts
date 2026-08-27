import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError, formatOperationError, getDependencyGraph, getProjectFileContent, getProjectImports, getProjectIssues, getProjectStructureSummary, getProjectSymbols, listProjects, prepareFolderUpload, uploadFolder } from "./api";


describe("API error guidance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("translates a missing source file into a clear recovery action", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ detail: "Project file is no longer available on disk." }, { status: 404 }),
    ));

    await expect(getProjectFileContent(3, 104)).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 404,
      detail: "Project file is no longer available on disk.",
      message: expect.stringContaining("执行一次增量分析"),
    });
  });

  it("keeps a Chinese service detail and adds status-specific advice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ detail: "图谱服务暂时不可用" }, { status: 503 }),
    ));

    await expect(getDependencyGraph(3)).rejects.toThrow(
      "加载依赖图谱失败：图谱服务暂时不可用。建议：确认后端、GitHub 或模型服务正常后重试。",
    );
  });

  it("explains how to recover when the local backend is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(listProjects()).rejects.toThrow("确认后端服务已启动，并检查 8000 端口是否可访问");
  });

  it("preserves technical error metadata for diagnostics", () => {
    const error = new ApiRequestError("提示", "测试操作", 502, "upstream failed");
    expect(error).toMatchObject({ name: "ApiRequestError", operation: "测试操作", status: 502, detail: "upstream failed" });
  });

  it("translates a background archive safety failure instead of hiding it behind HTTP 500", () => {
    expect(formatOperationError(
      "分析仓库",
      500,
      "GitHub returned an invalid repository archive: The archive contains a symbolic link.",
    )).toContain("仓库压缩包包含符号链接");
  });

  it("skips generated directories before uploading a local folder", () => {
    const source = new File(["export const value = 1;"], "value.ts");
    const dependency = new File(["generated"], "index.js");
    Object.defineProperty(source, "webkitRelativePath", { value: "demo/src/value.ts" });
    Object.defineProperty(dependency, "webkitRelativePath", { value: "demo/node_modules/pkg/index.js" });

    const prepared = prepareFolderUpload([source, dependency]);

    expect(prepared.acceptedFiles).toEqual([source]);
    expect(prepared.ignoredCount).toBe(1);
    expect(prepared.totalBytes).toBe(source.size);
  });

  it("reports an oversized folder before starting the request", async () => {
    const oversized = new File([], "dataset.txt");
    Object.defineProperty(oversized, "webkitRelativePath", { value: "demo/data/dataset.txt" });
    Object.defineProperty(oversized, "size", { value: 201 * 1024 * 1024 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => uploadFolder([oversized], { max_upload_mb: 200, max_folder_files: 20_000, max_source_file_mb: 300 })).toThrow("超过 200 MB 上限");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses upload-specific guidance when a folder transfer is interrupted", async () => {
    const source = new File(["print('ok')"], "main.py");
    Object.defineProperty(source, "webkitRelativePath", { value: "demo/main.py" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(uploadFolder([source])).rejects.toThrow("上传连接在传输过程中中断");
  });

  it("requests structure summaries and rows through bounded pagination endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ total: 0, limit: 150, offset: 0, has_more: false, items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getProjectStructureSummary(6);
    await getProjectSymbols(6, 150, 0);
    await getProjectImports(6, 150, 150);
    await getProjectIssues(6, 50, 0);

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/projects/6/structure/summary",
      "/api/projects/6/symbols?limit=150&offset=0",
      "/api/projects/6/imports?limit=150&offset=150",
      "/api/projects/6/issues?limit=50&offset=0",
    ]);
  });
});
