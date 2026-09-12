// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCodeSearch } from "./useCodeSearch";

const result = (id: number) => ({ chunk_id: id, file_id: id, file_path: `src/${id}.py`, symbol_name: `function_${id}`, kind: "function",
  start_line: 1, end_line: 2, snippet_start_line: 1, snippet_end_line: 2, snippet: "return needle", score: 1 });
const page = (query = "needle", ids = [1, 2], offset = 0, total = 4, more = true) => ({
  query, results: ids.map(result), offset, limit: 10, total_matches: total, has_more: more, indexed_chunks: 20, elapsed_ms: 1,
});
const setup = () => renderHook(
  ({ projectId, active, revision }) => useCodeSearch(projectId, active, revision),
  { initialProps: { projectId: 1, active: true, revision: 0 } },
);
function api(handler: (url: URL, options?: RequestInit) => Promise<Response>) {
  const fetch = vi.fn((input: string, options?: RequestInit) => handler(new URL(input, "http://localhost"), options));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["success", "error"])("cancels an edited query and ignores its late %s", async (outcome) => {
  let release!: (response: Response) => void;
  let oldSignal!: AbortSignal;
  api(async (url, options) => {
    if (url.searchParams.get("q") === "old") {
      oldSignal = options!.signal!;
      return new Promise<Response>((resolve) => { release = resolve; });
    }
    return Response.json(page("fresh", [3], 0, 1, false));
  });
  const hook = setup();
  act(() => hook.result.current.changeQuery("old"));
  act(() => { void hook.result.current.search(); });
  expect(hook.result.current.loading).toBe(true);
  act(() => hook.result.current.changeQuery("fresh"));
  expect(oldSignal.aborted).toBe(true);
  expect(hook.result.current.loading).toBe(false);
  await act(() => hook.result.current.search());
  await act(async () => { release(outcome === "success" ? Response.json(page("old")) : Response.json({ detail: "stale failure" }, { status: 500 })); });
  expect(hook.result.current.response?.query).toBe("fresh");
  expect(hook.result.current.error).toBeNull();
});

it("retains existing results when pagination fails and retries the same server offset", async () => {
  const offsets: number[] = [];
  api(async (url) => {
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    if (offset && offsets.length === 2) return Response.json({ detail: "temporary failure" }, { status: 500 });
    return Response.json(page("needle", offset ? [3, 4] : [1, 2], offset, 4, !offset));
  });
  const hook = setup();
  act(() => hook.result.current.changeQuery("needle"));
  await act(() => hook.result.current.search());
  await act(() => hook.result.current.loadMore());
  expect(hook.result.current.error?.retry).toBe("more");
  expect(hook.result.current.response?.results.map((item) => item.chunk_id)).toEqual([1, 2]);
  await act(() => hook.result.current.retry());
  expect(offsets).toEqual([0, 2, 2]);
  expect(hook.result.current.response?.results.map((item) => item.chunk_id)).toEqual([1, 2, 3, 4]);
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.response?.has_more).toBe(false);
});

it("advances by server rows rather than deduplicated cards and explains incomplete pagination", async () => {
  const offsets: number[] = [];
  api(async (url) => {
    const offset = Number(url.searchParams.get("offset"));
    offsets.push(offset);
    return Response.json(page("needle", offset === 0 ? [1, 2] : offset === 2 ? [2, 3] : [4], offset, 5, offset < 4));
  });
  const hook = setup();
  act(() => hook.result.current.changeQuery("needle"));
  await act(() => hook.result.current.search());
  await act(() => hook.result.current.loadMore());
  expect(hook.result.current.response?.results.map((item) => item.chunk_id)).toEqual([1, 2, 3]);
  await act(() => hook.result.current.loadMore());
  expect(offsets).toEqual([0, 2, 4]);
  expect(hook.result.current.response?.has_more).toBe(false);
  expect(hook.result.current.error?.retry).toBe("search");
});

it.each([{ name: "empty", ids: [] }, { name: "duplicates", ids: [1, 2] }])("stops pagination with $name instead of silently looping", async ({ ids }) => {
  api(async (url) => {
    const offset = Number(url.searchParams.get("offset"));
    return Response.json(page("needle", offset ? ids : [1, 2], offset));
  });
  const hook = setup();
  act(() => hook.result.current.changeQuery("needle"));
  await act(() => hook.result.current.search());
  await act(() => hook.result.current.loadMore());
  expect(hook.result.current.loadingMore).toBe(false);
  expect(hook.result.current.response?.has_more).toBe(false);
  expect(hook.result.current.error?.message).toContain("重新搜索");
});

it("does not merge pages from a changed index", async () => {
  api(async (url) => {
    const offset = Number(url.searchParams.get("offset"));
    return Response.json(page("needle", [1, 2], offset, offset ? 10 : 4, true));
  });
  const hook = setup();
  act(() => hook.result.current.changeQuery("needle"));
  await act(() => hook.result.current.search());
  await act(() => hook.result.current.loadMore());
  expect(hook.result.current.response).toBeNull();
  expect(hook.result.current.error?.retry).toBe("search");
});

it("distinguishes a failed first page from a valid empty result", async () => {
  let fail = true;
  api(async () => fail ? Response.json({ detail: "try again" }, { status: 500 }) : Response.json(page("needle", [], 0, 0, false)));
  const hook = setup();
  act(() => hook.result.current.changeQuery("needle"));
  await act(() => hook.result.current.search());
  expect(hook.result.current.error?.retry).toBe("search");
  expect(hook.result.current.response).toBeNull();
  fail = false;
  await act(() => hook.result.current.retry());
  expect(hook.result.current.response?.results).toEqual([]);
  expect(hook.result.current.error).toBeNull();
});

it("aborts pending pagination on menu exit while retaining completed results for return", async () => {
  let signal!: AbortSignal;
  let release!: (response: Response) => void;
  api(async (url, options) => {
    if (url.searchParams.get("offset") !== "0") {
      signal = options!.signal!;
      return new Promise<Response>((resolve) => { release = resolve; });
    }
    return Response.json(page());
  });
  const hook = setup();
  act(() => hook.result.current.changeQuery("needle"));
  await act(() => hook.result.current.search());
  act(() => { void hook.result.current.loadMore(); });
  hook.rerender({ projectId: 1, active: false, revision: 0 });
  expect(signal.aborted).toBe(true);
  hook.rerender({ projectId: 1, active: true, revision: 0 });
  await act(async () => { release(Response.json(page("needle", [3, 4], 2, 4, false))); });
  expect(hook.result.current.loadingMore).toBe(false);
  expect(hook.result.current.response?.results.map((item) => item.chunk_id)).toEqual([1, 2]);
  expect(hook.result.current.query).toBe("needle");
});

it("invalidates reads on source revision and clears the query on project changes", async () => {
  let signal!: AbortSignal;
  let release!: (response: Response) => void;
  api(async (_url, options) => {
    signal = options!.signal!;
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const hook = setup();
  act(() => hook.result.current.changeQuery("needle"));
  act(() => { void hook.result.current.search(); });
  hook.rerender({ projectId: 1, active: true, revision: 1 });
  expect(signal.aborted).toBe(true);
  await act(async () => { release(Response.json(page())); });
  expect(hook.result.current.response).toBeNull();
  expect(hook.result.current.query).toBe("needle");
  hook.rerender({ projectId: 2, active: true, revision: 1 });
  expect(hook.result.current.query).toBe("");
  expect(hook.result.current.loading).toBe(false);
});

it("does not submit a duplicate request in the same turn and aborts on unmount", async () => {
  let signal!: AbortSignal;
  const fetch = api(async (_url, options) => {
    signal = options!.signal!;
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("closed", "AbortError"))));
  });
  const hook = setup();
  act(() => hook.result.current.changeQuery("needle"));
  act(() => { void hook.result.current.search(); void hook.result.current.search(); });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  hook.unmount();
  expect(signal.aborted).toBe(true);
});
