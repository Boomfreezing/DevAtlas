// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SnapshotWorkspace from "./SnapshotWorkspace";
import { EMPTY_SYNCHRONIZATION } from "./useProjectSynchronization";

const snapshots = [3, 2, 1].map((id) => ({ id, project_id: 1, label: `snapshot-${id}`, reason: "manual", created_at: "2026-09-12T00:00:00Z", score: 80, grade: "B", file_count: 1, symbol_count: 2, import_count: 0, finding_count: 1, cycle_count: 0, parse_issue_count: 0 }));
const group = { new_count: 0, fixed_count: 0, persistent_count: 0, new_items: [], fixed_items: [], persistent_items: [], truncated: false };
const result = (label: string) => ({ base: { ...snapshots[1], label }, target: snapshots[0], comparable: true, comparison_warnings: [], metric_changes: [], quality: group, parse_issues: group, cycles: group });

function api(handler: (url: URL, options?: RequestInit) => Promise<Response | undefined>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const response = await handler(url, options);
    if (response) return response;
    return Response.json(url.pathname.endsWith("/git-summary") ? { available: false, refreshable: false, recent_commits: [], message: "local fixture" } : snapshots);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("aborts reads on strict-mode cleanup and page exit without a network-error banner", async () => {
  const signals: AbortSignal[] = [];
  api(async (_url, options) => new Promise((_resolve, reject) => {
    const signal = options!.signal!;
    signals.push(signal);
    signal.addEventListener("abort", () => reject(new DOMException("left page", "AbortError")), { once: true });
  }));
  const view = render(<StrictMode><SnapshotWorkspace projectId={1} synchronization={EMPTY_SYNCHRONIZATION} onSynchronize={() => {}} /></StrictMode>);
  await waitFor(() => expect(signals).toHaveLength(4));
  expect(signals.filter((signal) => signal.aborted)).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

it("cancels an old comparison and permits a new one without waiting for the old server", async () => {
  let release!: (response: Response) => void;
  let oldSignal: AbortSignal | undefined;
  api(async (url, options) => {
    if (!url.pathname.endsWith("/compare")) return;
    if (url.searchParams.get("base_id") === "2") {
      oldSignal = options?.signal ?? undefined;
      return new Promise<Response>((resolve) => { release = resolve; }); // Deliberately ignores abort.
    }
    return Response.json(result("fresh-comparison"));
  });
  const view = render(<SnapshotWorkspace projectId={1} synchronization={EMPTY_SYNCHRONIZATION} onSynchronize={() => {}} />);
  await screen.findByRole("button", { name: "开始对比" });
  fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
  await waitFor(() => expect(oldSignal).toBeDefined());
  fireEvent.change(view.container.querySelector(".snapshot-compare-controls select")!, { target: { value: "1" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "开始对比" })).toHaveProperty("disabled", false));
  expect(oldSignal!.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
  await screen.findByText("fresh-comparison");
  await act(async () => { release(Response.json(result("stale-comparison"))); });
  expect(screen.queryByText("stale-comparison")).toBeNull();
  expect(screen.getByText("fresh-comparison")).toBeTruthy();
});

it("does not cancel submitted writes or refresh an unmounted page afterwards", async () => {
  let release!: (response: Response) => void;
  const fetchMock = api(async (_url, options) => {
    if (options?.method !== "POST") return;
    expect(options.signal).toBeUndefined();
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const view = render(<SnapshotWorkspace projectId={1} synchronization={EMPTY_SYNCHRONIZATION} onSynchronize={() => {}} />);
  await screen.findByRole("button", { name: "开始对比" });
  fireEvent.click(screen.getByRole("button", { name: /保存当前快照/ }));
  await waitFor(() => expect(release).toBeDefined());
  const calls = fetchMock.mock.calls.length;
  view.unmount();
  await act(async () => { release(Response.json(snapshots[0])); });
  expect(fetchMock).toHaveBeenCalledTimes(calls);
});

it("shows N/A for a snapshot without scoring evidence and never displays a placeholder score delta", async () => {
  const unscored = { ...snapshots[0], score: 0, grade: "E", score_available: false };
  api(async (url) => {
    if (url.pathname.endsWith("/compare")) return Response.json({ ...result("supported-base"),
      base: { ...snapshots[1], score_available: true }, target: unscored,
      metric_changes: [{ key: "score", label: "综合质量分", base: 80, target: 0, delta: -80 }] });
    if (!url.pathname.endsWith("/git-summary")) return Response.json([unscored, snapshots[1]]);
    return undefined;
  });
  render(<SnapshotWorkspace projectId={1} synchronization={EMPTY_SYNCHRONIZATION} onSynchronize={() => {}} />);
  await screen.findByRole("button", { name: "开始对比" });
  expect(screen.getByTitle("检测覆盖不足，暂不评级").textContent).toBe("N/A");
  expect(screen.getByTitle("历史记录的解析覆盖口径未知").textContent).toBe("80 / B");
  fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
  await screen.findByText("综合质量分");
  const metric = document.querySelector(".snapshot-metrics article")!;
  expect(metric.textContent).toContain("N/A");
  expect(metric.textContent).toContain("不计差值");
  expect(metric.textContent).not.toContain("-80");
  expect(metric.querySelector("small")?.textContent).toBe("80 → N/A");
});

it("reloads snapshot and git reads after an application-owned sync completion", async () => {
  const fetchMock = api(async () => undefined);
  const view = render(<SnapshotWorkspace projectId={1} synchronization={EMPTY_SYNCHRONIZATION} onSynchronize={() => {}} />);
  await screen.findByRole("button", { name: "开始对比" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  view.rerender(<SnapshotWorkspace projectId={1} synchronization={{ ...EMPTY_SYNCHRONIZATION, completion: 1, message: "已同步" }} onSynchronize={() => {}} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  expect(screen.getByText("[OK] 已同步")).toBeTruthy();
});
