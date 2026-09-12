// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CodeViewer from "./CodeViewer";
import { getProjectFileContent } from "./api";
import type { ProjectFileContent } from "./types";


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

const source: ProjectFileContent = {
  file_id: 7,
  file_path: "src/main.py",
  language: "Python",
  size_bytes: 27,
  total_lines: 2,
  lines: ["def main():", "    return True"],
};
const nextResult = { ...result, file_id: 8, file_path: "src/next.py" };
const nextSource = { ...source, file_id: 8, file_path: "src/next.py", lines: ["next source"] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("CodeViewer", () => {
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows a clear error and retries loading the source file", async () => {
    vi.mocked(getProjectFileContent)
      .mockRejectedValueOnce(new Error("打开源码失败：文件暂时不可用。建议：刷新索引。"))
      .mockResolvedValueOnce(source);

    render(<CodeViewer projectId={1} result={result} query="main" onClose={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toContain("无法打开源码");
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));

    await waitFor(() => expect(getProjectFileContent).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("region", { name: "src/main.py 源代码" })).toBeTruthy();
  });

  it("clears the previous source and copy feedback while the next file loads and after failure", async () => {
    const next = deferred<ProjectFileContent>();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.mocked(getProjectFileContent).mockResolvedValueOnce(source).mockReturnValueOnce(next.promise);
    const { rerender } = render(<CodeViewer projectId={1} result={result} query="" onClose={vi.fn()} />);

    await screen.findByRole("region");
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await screen.findByRole("button", { name: "已复制代码" });
    expect(writeText).toHaveBeenCalledWith(source.lines.join("\n"));

    rerender(<CodeViewer projectId={1} result={nextResult} query="" onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: nextResult.file_path })).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByText("正在读取源文件…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "复制代码" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    expect(writeText).toHaveBeenCalledTimes(1);

    await act(async () => next.reject(new Error("新文件读取失败")));
    expect(screen.getByRole("alert").textContent).toContain("新文件读取失败");
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByText("正在读取源文件…")).toBeNull();
    expect((screen.getByRole("button", { name: "复制代码" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["resolve", "before"], ["reject", "before"],
    ["resolve", "after"], ["reject", "after"],
  ] as const)("ignores an obsolete read that %ss %s the current read", async (outcome, order) => {
    const previous = deferred<ProjectFileContent>();
    const next = deferred<ProjectFileContent>();
    vi.mocked(getProjectFileContent).mockReturnValueOnce(previous.promise).mockReturnValueOnce(next.promise);
    const { rerender } = render(<CodeViewer projectId={1} result={result} query="" onClose={vi.fn()} />);
    const previousSignal = vi.mocked(getProjectFileContent).mock.calls[0][2];

    rerender(<CodeViewer projectId={1} result={nextResult} query="" onClose={vi.fn()} />);
    expect(previousSignal?.aborted).toBe(true);
    const currentSignal = vi.mocked(getProjectFileContent).mock.calls[1][2];
    expect(currentSignal?.aborted).toBe(false);
    if (order === "after") await act(async () => next.resolve(nextSource));

    await act(async () => {
      if (outcome === "resolve") previous.resolve(source);
      else previous.reject(new Error("过期请求失败"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("region", { name: "src/main.py 源代码" })).toBeNull();
    if (order === "before") {
      expect(screen.getByText("正在读取源文件…")).toBeTruthy();
      expect((screen.getByRole("button", { name: "复制代码" }) as HTMLButtonElement).disabled).toBe(true);
      expect(currentSignal?.aborted).toBe(false);
      await act(async () => next.resolve(nextSource));
    }
    expect(screen.getByRole("region", { name: "src/next.py 源代码" }).textContent).toContain("next source");
    expect(screen.queryByText("正在读取源文件…")).toBeNull();
  });

  it("reloads the same file id when the project changes", async () => {
    const next = deferred<ProjectFileContent>();
    vi.mocked(getProjectFileContent).mockResolvedValueOnce(source).mockReturnValueOnce(next.promise);
    const { rerender } = render(<CodeViewer projectId={1} result={result} query="" onClose={vi.fn()} />);
    await screen.findByRole("region");

    rerender(<CodeViewer projectId={2} result={result} query="" onClose={vi.fn()} />);
    expect(screen.queryByRole("region")).toBeNull();
    expect(getProjectFileContent).toHaveBeenLastCalledWith(2, 7, expect.any(AbortSignal));
    await act(async () => next.resolve({ ...source, lines: ["project two"] }));
    expect(screen.getByRole("region").textContent).toContain("project two");
  });

  it("scrolls to a different match in the same file without reading it again", async () => {
    vi.mocked(getProjectFileContent).mockResolvedValueOnce(source);
    const { rerender } = render(<CodeViewer projectId={1} result={result} query="" onClose={vi.fn()} />);
    const region = await screen.findByRole("region");
    const secondLine = region.querySelectorAll(".code-viewer-line")[1];
    const scrollIntoView = vi.fn();
    Object.defineProperty(secondLine, "scrollIntoView", { configurable: true, value: scrollIntoView });

    rerender(<CodeViewer projectId={1} result={{ ...result, snippet_start_line: 2, snippet_end_line: 2 }} query="" onClose={vi.fn()} />);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(secondLine.classList.contains("highlighted")).toBe(true);
    expect(region.querySelectorAll(".highlighted")).toHaveLength(1);
    expect(getProjectFileContent).toHaveBeenCalledTimes(1);
  });

  it.each(["button", "escape", "backdrop"])("cancels a pending read when closed through %s", async (method) => {
    const pending = deferred<ProjectFileContent>();
    const onClose = vi.fn();
    vi.mocked(getProjectFileContent).mockReturnValueOnce(pending.promise);
    render(<CodeViewer projectId={1} result={result} query="" onClose={onClose} />);
    const signal = vi.mocked(getProjectFileContent).mock.calls[0][2];

    if (method === "button") fireEvent.click(screen.getByRole("button", { name: "关闭代码查看器" }));
    else if (method === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);

    expect(signal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(source));
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("cancels an unfinished read and removes its keyboard listener on unmount", async () => {
    const pending = deferred<ProjectFileContent>();
    const onClose = vi.fn();
    vi.mocked(getProjectFileContent).mockReturnValueOnce(pending.promise);
    const { unmount } = render(<CodeViewer projectId={1} result={result} query="" onClose={onClose} />);
    const signal = vi.mocked(getProjectFileContent).mock.calls[0][2];

    unmount();
    expect(signal?.aborted).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => pending.reject(new DOMException("Read aborted", "AbortError")));
  });

  it.each(["resolve", "reject"])("ignores clipboard feedback that %ss after switching files", async (outcome) => {
    const copied = deferred<void>();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockReturnValue(copied.promise) } });
    vi.mocked(getProjectFileContent).mockResolvedValueOnce(source).mockResolvedValueOnce(nextSource);
    const { rerender } = render(<CodeViewer projectId={1} result={result} query="" onClose={vi.fn()} />);
    await screen.findByRole("region");
    fireEvent.click(screen.getByRole("button", { name: "复制路径" }));

    rerender(<CodeViewer projectId={1} result={nextResult} query="" onClose={vi.fn()} />);
    await screen.findByRole("region", { name: "src/next.py 源代码" });
    await act(async () => {
      if (outcome === "resolve") copied.resolve(undefined);
      else copied.reject(new Error("Clipboard denied"));
    });
    expect(screen.getByRole("button", { name: "复制路径" })).toBeTruthy();
    expect(screen.queryByText("浏览器未授予剪贴板权限，请手动选择并复制。")).toBeNull();
  });

  it.each([true, false])("cleans up clipboard timers on unmount (copy completed: %s)", async (completed) => {
    const copied = deferred<void>();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockReturnValue(copied.promise) } });
    vi.mocked(getProjectFileContent).mockResolvedValueOnce(source);
    const { unmount } = render(<CodeViewer projectId={1} result={result} query="" onClose={vi.fn()} />);
    await screen.findByRole("region");
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    if (completed) {
      await act(async () => copied.resolve(undefined));
      expect(vi.getTimerCount()).toBe(1);
    }

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    if (!completed) await act(async () => copied.resolve(undefined));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { file_id: 8, file_path: "src/main.py" },
    { file_id: 7, file_path: "src/reused-id.py" },
    { file_id: 7, file_path: "src/MAIN.py" },
  ])("rejects source with a different identity (%s) without showing or copying its body", async (identity) => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.mocked(getProjectFileContent).mockResolvedValue({ ...source, ...identity, lines: ["WRONG SOURCE MUST STAY HIDDEN"] });
    render(<CodeViewer projectId={1} result={result} query="" onClose={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("引用文件与当前索引不一致");
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByText("WRONG SOURCE MUST STAY HIDDEN")).toBeNull();
    expect(screen.getByRole("button", { name: "复制代码" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "src/main.py" })).toBeTruthy();
  });

  it("permits a fresh read after rejecting a reused file id", async () => {
    vi.mocked(getProjectFileContent)
      .mockResolvedValueOnce({ ...source, file_path: "other.py", lines: ["WRONG SOURCE"] })
      .mockResolvedValueOnce(source);
    render(<CodeViewer projectId={1} result={result} query="" onClose={vi.fn()} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await screen.findByRole("region", { name: "src/main.py 源代码" });
    expect(screen.getByRole("button", { name: "复制代码" })).toHaveProperty("disabled", false);
    expect(screen.queryByText("WRONG SOURCE")).toBeNull();
  });

  it("reloads and hides old content when the same numeric file id now refers to a different path", async () => {
    const pending = deferred<ProjectFileContent>();
    vi.mocked(getProjectFileContent).mockResolvedValueOnce(source).mockReturnValueOnce(pending.promise);
    const { rerender } = render(<CodeViewer projectId={1} result={result} query="" onClose={vi.fn()} />);
    await screen.findByRole("region");
    rerender(<CodeViewer projectId={1} result={{ ...result, file_path: "new/path.py" }} query="" onClose={vi.fn()} />);
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByText("正在读取源文件…")).toBeTruthy();
    expect(getProjectFileContent).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve({ ...source, file_path: "new/path.py", lines: ["new path source"] }));
    expect(screen.getByRole("region", { name: "new/path.py 源代码" }).textContent).toContain("new path source");
  });

  it("validates QA evidence only at its exact lines, retaining indentation and empty lines", async () => {
    const lines = ["unrelated heading", "\tdef main():", "", "    return True", "unrelated footer"];
    vi.mocked(getProjectFileContent).mockResolvedValue({ ...source, lines, total_lines: lines.length });
    render(<CodeViewer projectId={1} result={{ ...result, expected_evidence: {
      start_line: 2, end_line: 4, snippet: "\tdef main():\n\n    return True",
    } }} query="" onClose={vi.fn()} />);
    expect((await screen.findByRole("region")).textContent).toContain("return True");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    { name: "modified body", lines: ["def main():", "    return False"], snippet: source.lines.join("\n") },
    { name: "shifted location", lines: ["inserted heading", ...source.lines], snippet: source.lines.join("\n") },
    { name: "changed indentation", lines: ["def main():", "  return True"], snippet: source.lines.join("\n") },
    { name: "shortened prefix", lines: source.lines, snippet: "def main" },
    { name: "preview ellipsis", lines: source.lines, snippet: "def main()..." },
  ])("rejects $name rather than searching for or loosely matching old QA evidence", async ({ lines, snippet }) => {
    vi.mocked(getProjectFileContent).mockResolvedValue({ ...source, lines, total_lines: lines.length });
    render(<CodeViewer projectId={1} result={{ ...result, expected_evidence: { start_line: 1, end_line: 2, snippet } }} query="" onClose={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("问答引用与当前源码不一致");
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByRole("button", { name: "复制代码" })).toHaveProperty("disabled", true);
  });

  it.each([
    { start_line: 0, end_line: 2 },
    { start_line: 1.5, end_line: 2 },
    { start_line: 2, end_line: 1 },
    { start_line: 1, end_line: 3 },
    { start_line: 1, end_line: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid or out-of-file evidence bounds (%s)", async (bounds) => {
    vi.mocked(getProjectFileContent).mockResolvedValue(source);
    render(<CodeViewer projectId={1} result={{ ...result, expected_evidence: { ...bounds, snippet: result.snippet } }} query="" onClose={vi.fn()} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it.each([
    { name: "ASCII mid-line truncation", lines: ["x".repeat(1_700)], snippet: "x".repeat(1_600) },
    { name: "Unicode code points", lines: ["🧪".repeat(1_700)], snippet: "🧪".repeat(1_600) },
    { name: "newline at the truncation boundary", lines: ["🧪".repeat(1_599), "tail"], snippet: "🧪".repeat(1_599) + "\n" },
  ])("mirrors Python's 1600-code-point public evidence limit: $name", async ({ lines, snippet }) => {
    vi.mocked(getProjectFileContent).mockResolvedValue({ ...source, lines, total_lines: lines.length });
    render(<CodeViewer projectId={1} result={{ ...result, expected_evidence: {
      start_line: 1, end_line: lines.length, snippet,
    } }} query="" onClose={vi.fn()} />);
    await screen.findByRole("region");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reloads the same file when expected evidence changes but reuses equal evidence values", async () => {
    const pending = deferred<ProjectFileContent>();
    const expected = { start_line: 1, end_line: 2, snippet: result.snippet };
    const changed = { ...expected, snippet: "def main():\n    return False" };
    vi.mocked(getProjectFileContent).mockResolvedValueOnce(source).mockReturnValueOnce(pending.promise);
    const { rerender } = render(<CodeViewer projectId={1} result={{ ...result, expected_evidence: expected }} query="" onClose={vi.fn()} />);
    await screen.findByRole("region");
    rerender(<CodeViewer projectId={1} result={{ ...result, expected_evidence: { ...expected } }} query="main" onClose={vi.fn()} />);
    expect(getProjectFileContent).toHaveBeenCalledTimes(1);
    rerender(<CodeViewer projectId={1} result={{ ...result, expected_evidence: changed }} query="" onClose={vi.fn()} />);
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByRole("button", { name: "复制代码" })).toHaveProperty("disabled", true);
    expect(getProjectFileContent).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve({ ...source, lines: changed.snippet.split("\n") }));
    expect(screen.getByRole("region").textContent).toContain("return False");
  });

  it("cancels an old citation read and ignores its delayed body after selecting new evidence in the same file", async () => {
    const previous = deferred<ProjectFileContent>();
    const next = deferred<ProjectFileContent>();
    const expected = { start_line: 1, end_line: 2, snippet: result.snippet };
    const changed = { ...expected, snippet: "def main():\n    return False" };
    vi.mocked(getProjectFileContent).mockReturnValueOnce(previous.promise).mockReturnValueOnce(next.promise);
    const { rerender } = render(<CodeViewer projectId={1} result={{ ...result, expected_evidence: expected }} query="" onClose={vi.fn()} />);
    const oldSignal = vi.mocked(getProjectFileContent).mock.calls[0][2];
    rerender(<CodeViewer projectId={1} result={{ ...result, expected_evidence: changed }} query="" onClose={vi.fn()} />);
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => next.resolve({ ...source, lines: changed.snippet.split("\n") }));
    await act(async () => previous.resolve(source));
    expect(screen.getByRole("region").textContent).toContain("return False");
    expect(screen.getByRole("region").textContent).not.toContain("return True");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
