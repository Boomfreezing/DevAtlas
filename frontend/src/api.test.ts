import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError, getDependencyGraph, getProjectFileContent, listProjects } from "./api";


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
});
