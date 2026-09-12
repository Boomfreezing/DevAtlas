import { useCallback, useEffect, useRef, useState } from "react";
import { formatOperationError, getAnalysisJob, synchronizeGitHubProject } from "../api";
import type { AnalysisJob } from "../types";

export interface ProjectSynchronizationState {
  busy: boolean;
  job: AnalysisJob | null;
  error: string | null;
  message: string | null;
  completion: number;
  retry: "submit" | "poll" | "refresh" | null;
}
export const EMPTY_SYNCHRONIZATION: ProjectSynchronizationState = {
  busy: false, job: null, error: null, message: null, completion: 0, retry: null,
};
interface PendingSync { controller: AbortController; wake?: () => void }

/** Submitted tasks belong to the application, not the currently visible menu. */
export function useProjectSynchronization(onCompleted: (projectId: number, job: AnalysisJob) => Promise<void>) {
  const [states, setStates] = useState<Record<number, ProjectSynchronizationState>>({});
  const stateRef = useRef(states);
  const pending = useRef(new Map<number, PendingSync>());
  const mounted = useRef(true);
  const completedRef = useRef(onCompleted);
  completedRef.current = onCompleted;
  const publish = useCallback((projectId: number, state: ProjectSynchronizationState) => {
    stateRef.current = { ...stateRef.current, [projectId]: state };
    setStates(stateRef.current);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const operation of pending.current.values()) {
        operation.controller.abort();
        operation.wake?.();
      }
      pending.current.clear();
    };
  }, []);

  const start = useCallback(async (projectId: number) => {
    if (!mounted.current || pending.current.has(projectId)) return;
    const previous = stateRef.current[projectId] ?? EMPTY_SYNCHRONIZATION;
    const operation: PendingSync = { controller: new AbortController() };
    pending.current.set(projectId, operation);
    const current = () => mounted.current && pending.current.get(projectId) === operation;
    // A failed poll/refresh resumes the known job. It must not submit a second mutation.
    let job = previous.retry && previous.retry !== "submit" ? previous.job : null;
    let phase: "submit" | "poll" | "refresh" = job ? "poll" : "submit";
    publish(projectId, { ...previous, busy: true, job, error: null, message: null, retry: null });
    try {
      if (!job) job = await synchronizeGitHubProject(projectId); // Never abort a submitted POST.
      if (!current()) return;
      const jobId = job.id;
      for (let attempt = 0; attempt < 1_200; attempt += 1) {
        if (!current()) return;
        phase = "poll";
        if (job.id !== jobId || job.project_id !== projectId) throw new Error("同步任务与当前仓库不匹配，已停止读取。");
        publish(projectId, { ...previous, busy: true, job, error: null, message: null, retry: null });
        if (job.status === "completed") {
          phase = "refresh";
          await completedRef.current(projectId, job);
          if (!current()) return;
          publish(projectId, { busy: false, job, error: null, message: job.message,
            completion: previous.completion + 1, retry: null });
          return;
        }
        if (job.status === "failed") {
          phase = "submit"; // The backend explicitly ended this task; a manual retry may create a new one.
          throw new Error(formatOperationError("同步远程仓库", 500, job.error || job.message || null));
        }
        if (job.status !== "queued" && job.status !== "running") throw new Error("同步任务返回了未知状态，请重试读取进度。");
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(() => { operation.wake = undefined; resolve(); }, 500);
          operation.wake = () => { window.clearTimeout(timer); resolve(); };
        });
        if (!current()) return;
        const next = await getAnalysisJob(jobId, operation.controller.signal);
        if (next.id !== jobId || next.project_id !== projectId) throw new Error("同步任务与当前仓库不匹配，已停止读取。");
        job = next;
      }
      throw new Error("同步进度等待超时，后端任务可能仍在运行；请重试读取进度，不必重新提交同步。");
    } catch (cause) {
      if (!current()) return;
      const detail = cause instanceof Error ? cause.message : "无法读取同步进度";
      publish(projectId, { ...previous, busy: false, job, message: null, retry: phase,
        error: phase === "refresh" ? `同步已完成，但刷新分析数据失败：${detail}。请重试刷新。` : detail });
    } finally {
      if (pending.current.get(projectId) === operation) pending.current.delete(projectId);
    }
  }, [publish]);

  return { stateFor: (projectId: number | null) => projectId === null ? EMPTY_SYNCHRONIZATION : states[projectId] ?? EMPTY_SYNCHRONIZATION, start };
}
