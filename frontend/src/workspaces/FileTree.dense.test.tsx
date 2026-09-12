// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectFileTreeNode, ProjectFileTreeResponse } from "../types";
import FileTree from "./FileTree";

const file = (path: string, id = 1): ProjectFileTreeNode => ({
  kind: "file", path, name: path.split("/").at(-1)!, file_count: 1,
  id, extension: ".ts", language: "TypeScript", size_bytes: 128, line_count: 5,
});
const directory = (path: string, fileCount = 1): ProjectFileTreeNode => ({
  ...file(path), kind: "directory", id: null, extension: null, language: null,
  size_bytes: null, line_count: null, file_count: fileCount,
});
const page = (items: ProjectFileTreeNode[], path = "", offset = 0, overrides: Partial<ProjectFileTreeResponse> = {}) => Response.json({
  path, total_files: items.reduce((total, node) => total + node.file_count, 0),
  items: items.slice(offset, offset + 200), total_items: items.length,
  limit: 200, offset, has_more: offset + 200 < items.length, ...overrides,
});
const failure = () => Response.json({ detail: "obsolete read failed" }, { status: 500 });
const props = { projectId: 1, totalFiles: 8, onAnalyzeImpact: vi.fn() };
const toggle = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name} 目录`) }));
const directories = Array.from({ length: 8 }, (_, index) => directory(`dir-${index}`));

function pending() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((release) => { resolve = release; });
  return { promise, resolve };
}

function api(handler: (url: URL, options?: RequestInit) => Promise<Response>) {
  const fetch = vi.fn((input: string, options?: RequestInit) => handler(new URL(input, "http://localhost"), options));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("limits eight expanded directories to four actual reads and requeues a collapsed pending directory at the FIFO tail", async () => {
  const responses = new Map<string, ReturnType<typeof pending>>();
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  api(async (url) => {
    const path = url.searchParams.get("path") ?? "";
    if (!path) return page(directories);
    started.push(path);
    const response = pending();
    responses.set(path, response);
    active += 1;
    peak = Math.max(peak, active);
    try { return await response.promise; }
    finally { active -= 1; }
  });
  render(<FileTree {...props} />);
  await screen.findByRole("button", { name: /^dir-0 目录/ });
  for (const node of directories) toggle(node.name);
  expect(started).toEqual(["dir-0", "dir-1", "dir-2", "dir-3"]);
  expect(peak).toBe(4);

  toggle("dir-5"); // Its task is queued, so collapsing must prevent any fetch.
  toggle("dir-5"); // Reopening appends a new read behind directories 4, 6 and 7.
  expect(started).toHaveLength(4);
  for (const [finished, next] of [[0, 4], [1, 6], [2, 7], [3, 5]]) {
    const path = `dir-${finished}`;
    await act(async () => { responses.get(path)!.resolve(page([file(`${path}/file-${finished}.ts`)], path)); });
    expect(started.at(-1)).toBe(`dir-${next}`);
    expect(peak).toBe(4);
  }
  expect(started).toEqual(["dir-0", "dir-1", "dir-2", "dir-3", "dir-4", "dir-6", "dir-7", "dir-5"]);
  await act(async () => {
    for (const index of [4, 5, 6, 7]) {
      const path = `dir-${index}`;
      responses.get(path)!.resolve(page([file(`${path}/file-${index}.ts`)], path));
    }
  });
  for (let index = 0; index < 8; index += 1) expect(screen.getByText(`file-${index}.ts`)).toBeTruthy();
  expect(active).toBe(0);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["success", "error"])("fences A1's late %s through A1 → B → A2 and removes A1's queued reads", async (outcome) => {
  const oldReads: { path: string; signal: AbortSignal; response: ReturnType<typeof pending> }[] = [];
  const freshPaths: string[] = [];
  let firstProjectRootReads = 0;
  api(async (url, options) => {
    const path = url.searchParams.get("path") ?? "";
    if (url.pathname.includes("/projects/2/")) return page([file("project-b.ts")]);
    if (!path) {
      firstProjectRootReads += 1;
      return page(directories);
    }
    if (firstProjectRootReads === 1) {
      const response = pending();
      oldReads.push({ path, signal: options!.signal!, response });
      return response.promise; // Deliberately ignores abort to exercise the response fence.
    }
    freshPaths.push(path);
    return page([file(`${path}/current-a2.ts`)], path);
  });
  const view = render(<FileTree {...props} />);
  await screen.findByRole("button", { name: /^dir-0 目录/ });
  for (const node of directories) toggle(node.name);
  expect(oldReads.map((read) => read.path)).toEqual(["dir-0", "dir-1", "dir-2", "dir-3"]);

  view.rerender(<FileTree {...props} projectId={2} />);
  await screen.findByText("project-b.ts");
  expect(oldReads.every((read) => read.signal.aborted)).toBe(true);
  view.rerender(<FileTree {...props} projectId={1} />);
  await screen.findByRole("button", { name: /^dir-0 目录/ });
  toggle("dir-0");
  // Old A1 requests are still unsettled; they must not consume A2's own queue.
  await screen.findByText("current-a2.ts");
  expect(freshPaths).toEqual(["dir-0"]);
  await act(async () => {
    for (const read of oldReads) {
      read.response.resolve(outcome === "success" ? page([file(`${read.path}/obsolete-a1.ts`)], read.path) : failure());
    }
  });
  expect(oldReads).toHaveLength(4);
  expect(freshPaths).toEqual(["dir-0"]); // No abandoned A1 queued task was started.
  expect(screen.queryByText("obsolete-a1.ts")).toBeNull();
  expect(screen.queryByText("project-b.ts")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  toggle("dir-0");
  toggle("dir-0");
  expect(screen.getByText("current-a2.ts")).toBeTruthy();
  expect(freshPaths).toEqual(["dir-0"]);
});

it("cancels queued grandchildren before reloading a parent with inconsistent pagination", async () => {
  const children = [
    ...directories.map((node) => directory(`src/${node.name}`)),
    ...Array.from({ length: 193 }, (_, index) => file(`src/parent-${index}.ts`, index + 100)),
  ];
  const oldReads: { path: string; signal: AbortSignal; response: ReturnType<typeof pending> }[] = [];
  let parentFirstPageReads = 0;
  api(async (url, options) => {
    const path = url.searchParams.get("path") ?? "";
    const offset = Number(url.searchParams.get("offset"));
    if (!path) return page([directory("src", 201)]);
    if (path === "src") {
      if (offset === 200) return page(children, path, offset, { total_items: 202 });
      parentFirstPageReads += 1;
      return parentFirstPageReads === 1 ? page(children, path) : page([file("src/fresh-parent.ts")], path);
    }
    const response = pending();
    oldReads.push({ path, signal: options!.signal!, response });
    return response.promise;
  });
  render(<FileTree {...props} totalFiles={201} />);
  await screen.findByRole("button", { name: /^src 目录/ });
  toggle("src");
  await screen.findByRole("button", { name: /^dir-0 目录/ });
  fireEvent.click(screen.getByRole("button", { name: "加载src的更多条目" }));
  await screen.findByRole("alert");
  for (const node of directories) toggle(node.name);
  expect(oldReads).toHaveLength(4);
  fireEvent.click(screen.getByRole("button", { name: "[ 重新读取 ]" }));
  expect(oldReads.every((read) => read.signal.aborted)).toBe(true);
  expect(screen.queryByRole("button", { name: /^dir-0 目录/ })).toBeNull();
  expect(parentFirstPageReads).toBe(1); // Active reads still occupy their slots until settled.
  await act(async () => {
    const first = oldReads[0];
    first.response.resolve(page([file(`${first.path}/obsolete.ts`)], first.path));
  });
  await screen.findByText("fresh-parent.ts");
  expect(parentFirstPageReads).toBe(2);
  await act(async () => {
    for (const read of oldReads.slice(1)) read.response.resolve(failure());
  });
  expect(oldReads.map((read) => read.path)).toEqual(["src/dir-0", "src/dir-1", "src/dir-2", "src/dir-3"]);
  expect(screen.queryByText("obsolete.ts")).toBeNull();
  expect(screen.queryByText("parent-0.ts")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("fresh-parent.ts")).toBeTruthy();
});

it("continues expanding and reusing directories after StrictMode cleans up and restarts read effects", async () => {
  const signals: AbortSignal[] = [];
  const fetchedPaths: string[] = [];
  api(async (url, options) => {
    const path = url.searchParams.get("path") ?? "";
    signals.push(options!.signal!);
    fetchedPaths.push(path);
    return path ? page([file(`${path}/${path}.ts`)], path) : page(directories);
  });
  render(<StrictMode><FileTree {...props} /></StrictMode>);
  await screen.findByRole("button", { name: /^dir-0 目录/ });
  expect(signals.some((signal) => signal.aborted)).toBe(true);
  for (let index = 0; index < 8; index += 1) {
    toggle(`dir-${index}`);
    await screen.findByText(`dir-${index}.ts`);
    toggle(`dir-${index}`);
  }
  const completedReads = fetchedPaths.length;
  for (let index = 0; index < 8; index += 1) {
    toggle(`dir-${index}`);
    expect(screen.getByText(`dir-${index}.ts`)).toBeTruthy();
  }
  expect(fetchedPaths.length).toBe(completedReads);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("windows many small directories when their combined metadata exceeds 600 and restores remaining rows after collapse", async () => {
  const intersections: { deliver: (visible: boolean) => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    private callback: (entries: object[]) => void;
    disconnect = vi.fn();
    constructor(callback: (entries: object[]) => void) { this.callback = callback; }
    observe() {
      intersections.push({ disconnect: this.disconnect, deliver: (visible) => this.callback([{ isIntersecting: visible }]) });
    }
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  const branches = directories.slice(0, 7).map((node) => directory(node.path, 100));
  const fetch = api(async (url) => {
    const path = url.searchParams.get("path") ?? "";
    return path ? page(Array.from({ length: 100 }, (_, index) => file(`${path}/${path}-file-${index}.ts`, index + 1)), path) : page(branches);
  });
  const view = render(<FileTree {...props} totalFiles={700} />);
  await screen.findByRole("button", { name: /^dir-0 目录/ });
  for (let index = 0; index < 5; index += 1) {
    toggle(`dir-${index}`);
    await screen.findByText(`dir-${index}-file-99.ts`);
  }
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(500);
  expect(intersections).toHaveLength(0); // 7 root directories + 500 files stay below the budget.
  toggle("dir-5");
  await screen.findByText("dir-5-file-99.ts");
  // Metadata registration and observer setup run in effects after the file rows commit.
  await waitFor(() => expect(intersections).toHaveLength(6)); // 7 + 600 rows cross the shared threshold.
  toggle("dir-6");
  await screen.findByText("dir-6-file-99.ts");
  await waitFor(() => expect(intersections).toHaveLength(7));
  expect(view.container.querySelectorAll('[data-windowed="true"]')).toHaveLength(7);
  const readsAfterExpansion = fetch.mock.calls.length;
  act(() => intersections.slice(1).forEach((observer) => observer.deliver(false)));
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(100);
  expect(view.container.querySelectorAll('[data-materialized="false"]')).toHaveLength(6);
  expect(screen.getByRole("button", { name: /^dir-4 目录/ }).getAttribute("aria-expanded")).toBe("true");

  toggle("dir-6");
  expect(view.container.querySelectorAll('[data-windowed="true"]')).toHaveLength(6);
  toggle("dir-5");
  // Only 507 metadata rows remain: previously offscreen pages must materialize again.
  expect(view.container.querySelectorAll('[data-windowed="true"]')).toHaveLength(0);
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(500);
  expect(screen.getByText("dir-4-file-99.ts")).toBeTruthy();
  expect(intersections.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
  act(() => intersections.forEach((observer) => observer.deliver(false)));
  expect(view.container.querySelectorAll(".file-tree-file")).toHaveLength(500);
  expect(fetch).toHaveBeenCalledTimes(readsAfterExpansion);
});
