// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectFileTreeNode, ProjectFileTreeResponse } from "../types";
import FileTree from "./FileTree";

const file = (path: string, id = 1): ProjectFileTreeNode => ({
  kind: "file", path, name: path.split("/").at(-1)!, file_count: 1,
  id, extension: ".ts", language: "TypeScript", size_bytes: 2048, line_count: 20,
});
const directory = (path: string, fileCount = 1): ProjectFileTreeNode => ({
  ...file(path), kind: "directory", id: null, extension: null, language: null, size_bytes: null, line_count: null, file_count: fileCount,
});
const tree = (items: ProjectFileTreeNode[], path = "") => Response.json({ path, total_files: items.reduce((total, node) => total + node.file_count, 0), items });
const page = (items: ProjectFileTreeNode[], path = "", offset = 0, overrides: Partial<ProjectFileTreeResponse> = {}) => Response.json({
  path, total_files: items.reduce((total, node) => total + node.file_count, 0), items: items.slice(offset, offset + 200),
  total_items: items.length, limit: 200, offset, has_more: offset + 200 < items.length, ...overrides,
});
const manyFiles = (path = "", count = 450) => Array.from({ length: count }, (_, index) => file(`${path ? `${path}/` : ""}file-${index}.ts`, index + 1));
const more = (path = "根目录") => screen.getByRole("button", { name: `加载${path}的更多条目` });
const failure = (message: string) => Response.json({ detail: message }, { status: 500 });
const props = { projectId: 1, totalFiles: 1, onAnalyzeImpact: vi.fn() };
const toggle = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name} 目录`) }));

function pending() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((release) => { resolve = release; });
  return { promise, resolve };
}

function api(handler: (url: URL, options?: RequestInit) => Promise<Response>) {
  const fetch = vi.fn((url: string, options?: RequestInit) => handler(new URL(url, "http://localhost"), options));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(["success", "error"])("ignores a previous project's late root %s", async (outcome) => {
  const old = pending();
  let signal!: AbortSignal;
  api(async (url, options) => {
    if (url.pathname.includes("/projects/1/")) {
      signal = options!.signal!;
      return old.promise; // Intentionally ignores cancellation to exercise the response fence.
    }
    return tree([file("current.ts")]);
  });
  const view = render(<FileTree {...props} />);
  expect(screen.queryByText("当前仓库没有可展示的文件")).toBeNull();
  view.rerender(<FileTree {...props} projectId={2} />);
  await screen.findByText("current.ts");
  expect(signal.aborted).toBe(true);
  await act(async () => { old.resolve(outcome === "success" ? tree([file("obsolete.ts")]) : failure("obsolete failure")); });
  expect(screen.queryByText("obsolete.ts")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("current.ts")).toBeTruthy();
});

it("clears rendered files while switching to a pending or failing project and retries the root", async () => {
  const next = pending();
  let attempts = 0;
  api(async (url) => {
    if (url.pathname.includes("/projects/1/")) return tree([file("old.ts")]);
    attempts += 1;
    return attempts === 1 ? next.promise : tree([file("recovered.ts")]);
  });
  const view = render(<FileTree {...props} />);
  await screen.findByText("old.ts");
  view.rerender(<FileTree {...props} projectId={2} />);
  expect(screen.queryByText("old.ts")).toBeNull();
  expect(screen.getByText("正在读取仓库根目录…")).toBeTruthy();
  await act(async () => { next.resolve(failure("root unavailable")); });
  expect(screen.getByRole("alert").textContent).toContain("读取文件目录失败");
  expect(screen.queryByText("当前仓库没有可展示的文件")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "[ RETRY ]" }));
  await screen.findByText("recovered.ts");
  expect(attempts).toBe(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows an empty root only after a successful response", async () => {
  const root = pending();
  api(async () => root.promise);
  render(<FileTree {...props} />);
  expect(screen.getByRole("status").textContent).toContain("正在读取仓库根目录");
  expect(screen.queryByText("当前仓库没有可展示的文件")).toBeNull();
  await act(async () => { root.resolve(tree([])); });
  expect(screen.getByText("当前仓库没有可展示的文件")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

it("aborts root reads on StrictMode cleanup and unmount and restarts cleanly", async () => {
  const signals: AbortSignal[] = [];
  const responses: ReturnType<typeof pending>[] = [];
  api(async (_url, options) => {
    signals.push(options!.signal!);
    const response = pending();
    responses.push(response);
    return response.promise;
  });
  const view = render(<StrictMode><FileTree {...props} /></StrictMode>);
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  await act(async () => { responses[0].resolve(failure("strict-mode obsolete failure")); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("正在读取仓库根目录");
  view.unmount();
  expect(signals[1].aborted).toBe(true);
  await act(async () => { responses[1].resolve(tree([file("after-unmount.ts")])); });
  expect(view.container.childElementCount).toBe(0);
});

it.each([
  ["success", "before"], ["error", "before"], ["success", "after"], ["error", "after"],
])("ignores a collapsed directory's late %s %s its replacement completes", async (outcome, order) => {
  const old = pending();
  const latest = pending();
  const signals: AbortSignal[] = [];
  api(async (url, options) => {
    if (!url.searchParams.has("path")) return tree([directory("src")]);
    signals.push(options!.signal!);
    return signals.length === 1 ? old.promise : latest.promise;
  });
  render(<FileTree {...props} />);
  await screen.findByRole("button", { name: /^src 目录/ });
  toggle("src");
  expect(screen.getByText("正在读取目录…")).toBeTruthy();
  toggle("src");
  expect(signals[0].aborted).toBe(true);
  expect(screen.queryByText("正在读取目录…")).toBeNull();
  toggle("src");
  expect(signals).toHaveLength(2);
  const settleOld = async () => { await act(async () => { old.resolve(outcome === "success" ? tree([file("src/obsolete.ts")], "src") : failure("obsolete directory failure")); }); };
  if (order === "before") {
    await settleOld();
    expect(screen.getByText("正在读取目录…")).toBeTruthy();
    expect(screen.queryByText("空目录")).toBeNull();
  }
  await act(async () => { latest.resolve(tree([file("src/current.ts")], "src")); });
  if (order === "after") await settleOld();
  expect(screen.getByText("current.ts")).toBeTruthy();
  expect(screen.queryByText("obsolete.ts")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("正在读取目录…")).toBeNull();
  toggle("src");
  toggle("src");
  expect(signals).toHaveLength(2);
  expect(screen.getByText("current.ts")).toBeTruthy();
});

it("retries a failed directory and preserves an empty successful response across collapse", async () => {
  const retry = pending();
  let attempts = 0;
  api(async (url) => {
    if (!url.searchParams.has("path")) return tree([directory("empty", 0)]);
    attempts += 1;
    return attempts === 1 ? failure("directory unavailable") : retry.promise;
  });
  render(<FileTree {...props} />);
  await screen.findByRole("button", { name: /^empty 目录/ });
  toggle("empty");
  await screen.findByRole("alert");
  expect(screen.queryByText("空目录")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "[ RETRY ]" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("空目录")).toBeNull();
  expect(screen.getByText("正在读取目录…")).toBeTruthy();
  await act(async () => { retry.resolve(tree([], "empty")); });
  expect(screen.getByText("空目录")).toBeTruthy();
  toggle("empty");
  toggle("empty");
  expect(attempts).toBe(2);
  expect(screen.getByText("空目录")).toBeTruthy();
});

it.each(["success", "error"])("aborts a descendant when its ancestor collapses and ignores its late %s", async (outcome) => {
  const old = pending();
  const signals: AbortSignal[] = [];
  api(async (url, options) => {
    const path = url.searchParams.get("path");
    if (!path) return tree([directory("src")]);
    if (path === "src") return tree([directory("src/nested")], path);
    signals.push(options!.signal!);
    return signals.length === 1 ? old.promise : tree([file("src/nested/current.ts")], path);
  });
  render(<FileTree {...props} />);
  await screen.findByRole("button", { name: /^src 目录/ });
  toggle("src");
  await screen.findByRole("button", { name: /^nested 目录/ });
  toggle("nested");
  toggle("src");
  expect(signals[0].aborted).toBe(true);
  await act(async () => { old.resolve(outcome === "success" ? tree([file("src/nested/obsolete.ts")], "src/nested") : failure("obsolete nested failure")); });
  toggle("src");
  toggle("nested");
  await screen.findByText("current.ts");
  expect(signals).toHaveLength(2);
  expect(screen.queryByText("obsolete.ts")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps successful nested directory caches after their ancestor unmounts them", async () => {
  const fetch = api(async (url) => {
    const path = url.searchParams.get("path");
    if (!path) return tree([directory("src")]);
    if (path === "src") return tree([directory("src/nested")], path);
    return tree([file("src/nested/cached.ts")], path);
  });
  render(<FileTree {...props} />);
  await screen.findByRole("button", { name: /^src 目录/ });
  toggle("src");
  await screen.findByRole("button", { name: /^nested 目录/ });
  toggle("nested");
  await screen.findByText("cached.ts");
  toggle("src");
  expect(screen.queryByText("cached.ts")).toBeNull();
  toggle("src");
  toggle("nested");
  expect(screen.getByText("cached.ts")).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("cancels an expanded directory read when leaving the file tree", async () => {
  const child = pending();
  let signal!: AbortSignal;
  api(async (url, options) => {
    if (!url.searchParams.has("path")) return tree([directory("src")]);
    signal = options!.signal!;
    return child.promise;
  });
  const view = render(<FileTree {...props} />);
  await screen.findByRole("button", { name: /^src 目录/ });
  toggle("src");
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { child.resolve(failure("unmounted failure")); });
  expect(view.container.childElementCount).toBe(0);
});

it("discards cached paths when switching projects", async () => {
  const fetch = api(async (url) => {
    if (!url.searchParams.has("path")) return tree([directory("src")]);
    return tree([file(url.pathname.includes("/projects/1/") ? "src/old-project.ts" : "src/new-project.ts")], "src");
  });
  const view = render(<FileTree {...props} />);
  await screen.findByRole("button", { name: /^src 目录/ });
  toggle("src");
  await screen.findByText("old-project.ts");
  view.rerender(<FileTree {...props} projectId={2} />);
  expect(screen.queryByText("old-project.ts")).toBeNull();
  await screen.findByRole("button", { name: /^src 目录/ });
  toggle("src");
  await screen.findByText("new-project.ts");
  expect(screen.queryByText("old-project.ts")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(4);
});

it.each(["root", "directory"])("renders a wide %s in batches of 200 direct children without additional network requests", async (level) => {
  const items = Array.from({ length: 450 }, (_, index) => file(`src/file-${index}.ts`, index + 1));
  const fetch = api(async (url) => level === "directory" && !url.searchParams.has("path") ? tree([directory("src", 450)]) : tree(items, level === "directory" ? "src" : ""));
  const view = render(<FileTree {...props} />);
  if (level === "directory") {
    await screen.findByRole("button", { name: /^src 目录/ });
    toggle("src");
  }
  await screen.findByText("file-199.ts");
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(200);
  expect(screen.queryByText("file-200.ts")).toBeNull();
  expect(screen.getByText("已显示 200 / 450 个直接子项")).toBeTruthy();
  const more = () => screen.getByRole("button", { name: /的更多条目$/ });
  fireEvent.click(more());
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(400);
  expect(screen.queryByText("file-400.ts")).toBeNull();
  expect(screen.getByText("已显示 400 / 450 个直接子项")).toBeTruthy();
  fireEvent.click(more());
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(450);
  expect(screen.queryByRole("button", { name: /的更多条目$/ })).toBeNull();
  expect(screen.getByText("已显示全部 450 个直接子项")).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(level === "root" ? 1 : 2);
  const lastFile = screen.getByTitle("src/file-449.ts");
  fireEvent.click(within(lastFile).getByRole("button", { name: "影响" }));
  expect(props.onAnalyzeImpact).toHaveBeenCalledWith({ target_type: "file", target_id: 450, file_id: 450, file_path: "src/file-449.ts", name: "src/file-449.ts", kind: "file", start_line: 1, end_line: 20 });
});

it.each(["root", "directory"])("fetches a wide %s in separate 200, 200 and 50 item pages", async (level) => {
  const path = level === "root" ? "" : "src";
  const items = manyFiles(path);
  const second = pending();
  const offsets: number[] = [];
  api(async (url) => {
    expect(url.searchParams.get("limit")).toBe("200");
    if (level === "directory" && !url.searchParams.has("path")) return page([directory(path, 450)]);
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    return offset === 200 ? second.promise : page(items, path, offset);
  });
  const view = render(<FileTree {...props} />);
  if (path) {
    await screen.findByRole("button", { name: /^src 目录/ });
    toggle("src");
  }
  await screen.findByText("file-199.ts");
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(200);
  expect(offsets).toEqual([0]);
  const button = more(path || "根目录");
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(offsets).toEqual([0, 200]);
  expect(screen.getByText("file-199.ts")).toBeTruthy();
  expect(screen.queryByText("file-200.ts")).toBeNull();
  await act(async () => { second.resolve(page(items, path, 200)); });
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(400);
  expect(screen.getByText("已显示 400 / 450 个直接子项")).toBeTruthy();
  fireEvent.click(more(path || "根目录"));
  await screen.findByText("file-449.ts");
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(450);
  expect(offsets).toEqual([0, 200, 400]);
  expect(screen.getByText("已显示全部 450 个直接子项")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /的更多条目$/ })).toBeNull();
  fireEvent.click(within(screen.getByTitle(items[449].path)).getByRole("button", { name: "影响" }));
  expect(props.onAnalyzeImpact).toHaveBeenCalledWith(expect.objectContaining({ file_id: 450, file_path: items[449].path }));
  if (path) {
    toggle("src");
    toggle("src");
    expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(450);
    expect(offsets).toEqual([0, 200, 400]);
  }
});

it.each(["root", "directory"])("retains a %s's successful pages while retrying a failed page at the same offset", async (level) => {
  const path = level === "root" ? "" : "src";
  const items = manyFiles(path, 201);
  const offsets: number[] = [];
  api(async (url) => {
    if (level === "directory" && !url.searchParams.has("path")) return page([directory(path, 201)]);
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    return offsets.length === 2 ? failure("next page unavailable") : page(items, path, offset);
  });
  const view = render(<FileTree {...props} />);
  if (path) {
    await screen.findByRole("button", { name: /^src 目录/ });
    toggle("src");
  }
  await screen.findByText("file-199.ts");
  fireEvent.click(more(path || "根目录"));
  await screen.findByRole("alert");
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(200);
  expect(screen.queryByText("当前仓库没有可展示的文件")).toBeNull();
  if (path) {
    toggle("src");
    toggle("src");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(offsets).toEqual([0, 200]);
  }
  fireEvent.click(screen.getByRole("button", { name: "[ RETRY ]" }));
  await screen.findByText("file-200.ts");
  expect(offsets).toEqual([0, 200, 200]);
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(201);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each([
  ["self", "success", "before"], ["self", "error", "after"],
  ["ancestor", "success", "after"], ["ancestor", "error", "before"],
])("retains cached pages on %s collapse and fences a late %s %s the next read", async (scope, outcome, order) => {
  const path = "src/nested";
  const items = manyFiles(path);
  const old = pending();
  const latest = pending();
  const offsets: number[] = [];
  const signals: AbortSignal[] = [];
  api(async (url, options) => {
    const requestedPath = url.searchParams.get("path") ?? "";
    if (!requestedPath) return page([directory("src", 450)]);
    if (requestedPath === "src") return page([directory(path, 450)], "src");
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    signals.push(options!.signal!);
    if (offset !== 200) return page(items, path, offset);
    return offsets.length === 2 ? old.promise : latest.promise;
  });
  const view = render(<FileTree {...props} />);
  await screen.findByRole("button", { name: /^src 目录/ });
  toggle("src");
  await screen.findByRole("button", { name: /^nested 目录/ });
  toggle("nested");
  await screen.findByText("file-199.ts");
  fireEvent.click(more(path));
  toggle(scope === "self" ? "nested" : "src");
  expect(signals[1].aborted).toBe(true);
  const settleOld = async () => {
    await act(async () => { old.resolve(outcome === "success" ? page(items, path, 200, { items: [file(`${path}/obsolete.ts`)], has_more: true }) : failure("obsolete page failure")); });
  };
  if (order === "before") await settleOld();
  if (scope === "ancestor") toggle("src");
  toggle("nested");
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(200);
  expect(offsets).toEqual([0, 200]);
  fireEvent.click(more(path));
  await act(async () => { latest.resolve(page(items, path, 200)); });
  if (order === "after") await settleOld();
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(400);
  expect(screen.queryByText("obsolete.ts")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  toggle("src");
  toggle("src");
  toggle("nested");
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(400);
  expect(offsets).toEqual([0, 200, 200]);
  fireEvent.click(more(path));
  await screen.findByText("file-449.ts");
  expect(offsets).toEqual([0, 200, 200, 400]);
});

it.each(["project", "revision", "leave"])("aborts pagination and clears prior data on %s replacement", async (transition) => {
  const items = manyFiles("", 201);
  const old = pending();
  let firstReads = 0;
  let signal!: AbortSignal;
  api(async (url, options) => {
    if (url.searchParams.get("offset") === "200") {
      signal = options!.signal!;
      return old.promise;
    }
    firstReads += 1;
    return firstReads === 1 ? page(items) : page([file("current.ts")]);
  });
  const view = render(<FileTree key="revision-1" {...props} />);
  await screen.findByText("file-199.ts");
  fireEvent.click(more());
  if (transition === "leave") view.unmount();
  else view.rerender(<FileTree key={transition === "revision" ? "revision-2" : "revision-1"} {...props} projectId={transition === "project" ? 2 : 1} />);
  expect(signal.aborted).toBe(true);
  expect(screen.queryByText("file-199.ts")).toBeNull();
  await act(async () => { old.resolve(page(items, "", 200)); });
  expect(screen.queryByText("file-200.ts")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  if (transition !== "leave") expect(await screen.findByText("current.ts")).toBeTruthy();
});

it.each<[string, Partial<ProjectFileTreeResponse>]>([
  ["changed total", { total_items: 451 }],
  ["wrong path", { path: "other" }],
  ["wrong offset", { offset: 0 }],
  ["empty continuing page", { items: [], has_more: true }],
  ["missing pagination field", { limit: undefined }],
  ["invalid descendant count", { total_files: -1 }],
  ["descendant count smaller than direct count", { total_files: 1 }],
  ["repeated item", { items: [file("file-0.ts")], has_more: true }],
])("offers an explicit reload after %s instead of silently appending or looping", async (_label, invalid) => {
  const items = manyFiles();
  const offsets: number[] = [];
  api(async (url) => {
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    if (offset === 200) return page(items, "", offset, invalid);
    return offsets.length === 1 ? page(items) : page([file("fresh.ts")]);
  });
  const view = render(<FileTree {...props} />);
  await screen.findByText("file-199.ts");
  fireEvent.click(more());
  expect((await screen.findByRole("alert")).textContent).toContain("重新读取");
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(200);
  expect(offsets).toEqual([0, 200]);
  expect(screen.queryByRole("button", { name: /的更多条目$/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "[ 重新读取 ]" }));
  await screen.findByText("fresh.ts");
  expect(screen.queryByText("file-0.ts")).toBeNull();
  expect(offsets).toEqual([0, 200, 0]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["legacy", "paged"])("rejects a mismatched first %s directory response without caching it", async (mode) => {
  let attempts = 0;
  api(async (url) => {
    if (!url.searchParams.has("path")) return page([directory("src")]);
    attempts += 1;
    if (attempts > 1) return page([file("src/current.ts")], "src");
    return mode === "legacy" ? tree([file("other/obsolete.ts")], "other") : page([file("other/obsolete.ts")], "other");
  });
  render(<FileTree {...props} />);
  await screen.findByRole("button", { name: /^src 目录/ });
  toggle("src");
  expect((await screen.findByRole("alert")).textContent).toContain("路径不匹配");
  expect(screen.queryByText("obsolete.ts")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "[ 重新读取 ]" }));
  await screen.findByText("current.ts");
  expect(attempts).toBe(2);
});

it("keeps an expanded directory and its loaded children when a parent page is appended", async () => {
  const items = [directory("src"), ...manyFiles("", 200)];
  let childReads = 0;
  api(async (url) => {
    if (url.searchParams.get("path")) {
      childReads += 1;
      return page([file("src/child.ts")], "src");
    }
    return page(items, "", Number(url.searchParams.get("offset")));
  });
  render(<FileTree {...props} />);
  await screen.findByRole("button", { name: /^src 目录/ });
  toggle("src");
  await screen.findByText("child.ts");
  fireEvent.click(more());
  await screen.findByText("file-199.ts");
  expect(screen.getByText("child.ts")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^src 目录/ }).getAttribute("aria-expanded")).toBe("true");
  expect(childReads).toBe(1);
});

it("invalidates cached descendants and cancels their pending page when reloading an inconsistent parent", async () => {
  const root = [directory("src", 201), ...manyFiles("", 200)];
  const children = manyFiles("src", 201);
  const obsolete = pending();
  let childSignal!: AbortSignal;
  let childReads = 0;
  api(async (url, options) => {
    const offset = Number(url.searchParams.get("offset"));
    if (!url.searchParams.has("path")) return page(root, "", offset, offset === 200 ? { total_items: 202 } : {});
    childReads += 1;
    if (offset === 200) {
      childSignal = options!.signal!;
      return obsolete.promise;
    }
    return childReads === 1 ? page(children, "src") : page([file("src/fresh.ts")], "src");
  });
  render(<FileTree {...props} />);
  await screen.findByRole("button", { name: /^src 目录/ });
  toggle("src");
  await screen.findByTitle("src/file-199.ts");
  fireEvent.click(more("src"));
  fireEvent.click(more());
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "[ 重新读取 ]" }));
  expect(childSignal.aborted).toBe(true);
  await screen.findByRole("button", { name: /^src 目录/ });
  await act(async () => { obsolete.resolve(page(children, "src", 200)); });
  toggle("src");
  await screen.findByText("fresh.ts");
  expect(screen.queryByTitle("src/file-0.ts")).toBeNull();
  expect(screen.queryByTitle("src/file-200.ts")).toBeNull();
  expect(childReads).toBe(3);
});
