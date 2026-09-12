// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAnalysisJob, synchronizeGitHubProject } from "../api";
import type { AnalysisJob } from "../types";
import { useProjectSynchronization } from "./useProjectSynchronization";

vi.mock("../api", () => ({ getAnalysisJob: vi.fn(), synchronizeGitHubProject: vi.fn(), formatOperationError: (_op: string, _code: number, detail: string) => detail }));
const job = (projectId = 1, overrides: Partial<AnalysisJob> = {}): AnalysisJob => ({
  id: `sync-${projectId}`, source_type: "github_sync", source_label: "synthetic",
  status: "running", stage: "staging_analysis", progress: 30, message: "syncing",
  project_id: projectId, error: null, created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z", completed_at: null, ...overrides,
});
const done = (projectId = 1, stage = "synchronized") => job(projectId, { status: "completed", stage, progress: 100, message: "updated" });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(500); });
beforeEach(() => { vi.useFakeTimers(); vi.mocked(synchronizeGitHubProject).mockReset(); vi.mocked(getAnalysisJob).mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("locks synchronously, keeps tracking across rerenders, and calls the latest completion handler once", async () => {
  const post = deferred<AnalysisJob>();
  vi.mocked(synchronizeGitHubProject).mockReturnValue(post.promise);
  vi.mocked(getAnalysisJob).mockResolvedValue(done());
  const old = vi.fn(async () => {}), latest = vi.fn(async () => {});
  const view = renderHook(({ callback }) => useProjectSynchronization(callback), { initialProps: { callback: old } });
  act(() => { void view.result.current.start(1); void view.result.current.start(1); });
  expect(synchronizeGitHubProject).toHaveBeenCalledTimes(1);
  expect(view.result.current.stateFor(1).busy).toBe(true);
  view.rerender({ callback: latest });
  await act(async () => post.resolve(job()));
  await tick();
  expect(old).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledExactlyOnceWith(1, done());
  expect(view.result.current.stateFor(1)).toMatchObject({ busy: false, completion: 1, error: null, message: "updated" });
  expect(vi.getTimerCount()).toBe(0);
});

it("tracks independent projects without crossing progress or callbacks", async () => {
  vi.mocked(synchronizeGitHubProject).mockImplementation(async (id) => job(id));
  vi.mocked(getAnalysisJob).mockImplementation(async (id) => done(Number(id.split("-")[1])));
  const callback = vi.fn(async () => {});
  const view = renderHook(() => useProjectSynchronization(callback));
  await act(async () => { void view.result.current.start(1); void view.result.current.start(2); });
  expect(view.result.current.stateFor(2).job?.project_id).toBe(2);
  await tick();
  expect(callback).toHaveBeenCalledWith(1, done(1));
  expect(callback).toHaveBeenCalledWith(2, done(2));
  expect(view.result.current.stateFor(1).completion).toBe(1);
  expect(view.result.current.stateFor(2).completion).toBe(1);
});

it("retains a known job after poll failure and retries its GET without submitting again", async () => {
  vi.mocked(synchronizeGitHubProject).mockResolvedValue(job());
  vi.mocked(getAnalysisJob).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(done());
  const callback = vi.fn(async () => {});
  const view = renderHook(() => useProjectSynchronization(callback));
  await act(async () => { void view.result.current.start(1); }); await tick();
  expect(view.result.current.stateFor(1)).toMatchObject({ busy: false, retry: "poll", error: "offline" });
  expect(callback).not.toHaveBeenCalled();
  await act(async () => { void view.result.current.start(1); }); await tick();
  expect(synchronizeGitHubProject).toHaveBeenCalledTimes(1);
  expect(getAnalysisJob).toHaveBeenCalledTimes(2);
  expect(callback).toHaveBeenCalledTimes(1);
});

it("distinguishes completed sync with refresh failure and retries refresh only", async () => {
  vi.mocked(synchronizeGitHubProject).mockResolvedValue(done());
  const callback = vi.fn<(_: number, result: AnalysisJob) => Promise<void>>().mockRejectedValueOnce(new Error("summary unavailable")).mockResolvedValueOnce(undefined);
  const view = renderHook(() => useProjectSynchronization(callback));
  await act(async () => { await view.result.current.start(1); });
  expect(view.result.current.stateFor(1).error).toContain("同步已完成");
  expect(view.result.current.stateFor(1).retry).toBe("refresh");
  await act(async () => { await view.result.current.start(1); });
  expect(callback).toHaveBeenCalledTimes(2);
  expect(synchronizeGitHubProject).toHaveBeenCalledTimes(1);
  expect(getAnalysisJob).not.toHaveBeenCalled();
  expect(view.result.current.stateFor(1).completion).toBe(1);
});

it("allows a new explicit sync after a terminal backend failure, but never publishes success", async () => {
  vi.mocked(synchronizeGitHubProject).mockResolvedValueOnce(job(1, { status: "failed", error: "download failed" })).mockResolvedValueOnce(done());
  const callback = vi.fn(async () => {});
  const view = renderHook(() => useProjectSynchronization(callback));
  await act(async () => { await view.result.current.start(1); });
  expect(callback).not.toHaveBeenCalled();
  expect(view.result.current.stateFor(1)).toMatchObject({ retry: "submit", completion: 0, error: "download failed" });
  await act(async () => { await view.result.current.start(1); });
  expect(synchronizeGitHubProject).toHaveBeenCalledTimes(2);
  expect(view.result.current.stateFor(1).completion).toBe(1);
});

it("reports up-to-date completion for metadata refresh without changing the job stage", async () => {
  vi.mocked(synchronizeGitHubProject).mockResolvedValue(done(1, "up_to_date"));
  const callback = vi.fn(async () => {});
  const view = renderHook(() => useProjectSynchronization(callback), { reactStrictMode: true });
  await act(async () => { await view.result.current.start(1); });
  expect(callback).toHaveBeenCalledExactlyOnceWith(1, done(1, "up_to_date"));
  expect(view.result.current.stateFor(1).completion).toBe(1);
});

it("stops timers on app unmount without cancelling submitted POSTs or following their late response", async () => {
  const post = deferred<AnalysisJob>();
  vi.mocked(synchronizeGitHubProject).mockReturnValue(post.promise);
  const callback = vi.fn(async () => {});
  const view = renderHook(() => useProjectSynchronization(callback));
  act(() => { void view.result.current.start(1); });
  view.unmount();
  await act(async () => post.resolve(done()));
  expect(synchronizeGitHubProject).toHaveBeenCalledWith(1);
  expect(callback).not.toHaveBeenCalled();
  expect(getAnalysisJob).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a pending progress GET on app unmount and ignores late success", async () => {
  const progress = deferred<AnalysisJob>();
  vi.mocked(synchronizeGitHubProject).mockResolvedValue(job());
  vi.mocked(getAnalysisJob).mockReturnValue(progress.promise);
  const callback = vi.fn(async () => {});
  const view = renderHook(() => useProjectSynchronization(callback));
  await act(async () => { void view.result.current.start(1); }); await tick();
  const signal = vi.mocked(getAnalysisJob).mock.calls[0][1]!;
  expect(signal.aborted).toBe(false);
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => progress.resolve(done()));
  expect(callback).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("clears a waiting poll timer on app unmount", async () => {
  vi.mocked(synchronizeGitHubProject).mockResolvedValue(job());
  const view = renderHook(() => useProjectSynchronization(async () => {}));
  await act(async () => { void view.result.current.start(1); });
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  await act(async () => {});
  expect(vi.getTimerCount()).toBe(0);
  expect(getAnalysisJob).not.toHaveBeenCalled();
});

it("rejects a different project's poll result and retains the correct job for retry", async () => {
  vi.mocked(synchronizeGitHubProject).mockResolvedValue(job());
  vi.mocked(getAnalysisJob).mockResolvedValueOnce(done(2)).mockResolvedValueOnce(done(1));
  const callback = vi.fn(async () => {});
  const view = renderHook(() => useProjectSynchronization(callback));
  await act(async () => { void view.result.current.start(1); }); await tick();
  expect(callback).not.toHaveBeenCalled();
  expect(view.result.current.stateFor(1).job?.id).toBe("sync-1");
  await act(async () => { void view.result.current.start(1); }); await tick();
  expect(callback).toHaveBeenCalledExactlyOnceWith(1, done());
  expect(synchronizeGitHubProject).toHaveBeenCalledTimes(1);
});
