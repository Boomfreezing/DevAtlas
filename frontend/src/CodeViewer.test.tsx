// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CodeViewer from "./CodeViewer";
import { getProjectFileContent } from "./api";


vi.mock("./api", () => ({ getProjectFileContent: vi.fn() }));

const result = {
  chunk_id: 1,
  file_id: 7,
  file_path: "src/main.py",
  symbol_name: "main",
  kind: "function",
  start_line: 1,
  end_line: 2,
  snippet_start_line: 1,
  snippet_end_line: 2,
  snippet: "def main():\n    return True",
  score: 1,
};

describe("CodeViewer errors", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows a clear error and retries loading the source file", async () => {
    vi.mocked(getProjectFileContent)
      .mockRejectedValueOnce(new Error("打开源码失败：文件暂时不可用。建议：刷新索引。"))
      .mockResolvedValueOnce({
        file_id: 7,
        file_path: "src/main.py",
        language: "Python",
        size_bytes: 27,
        total_lines: 2,
        lines: ["def main():", "    return True"],
      });

    render(<CodeViewer projectId={1} result={result} query="main" onClose={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toContain("无法打开源码");
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));

    await waitFor(() => expect(getProjectFileContent).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("region", { name: "src/main.py 源代码" })).toBeTruthy();
  });
});
