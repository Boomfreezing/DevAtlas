import { useCallback, useEffect, useRef, useState } from "react";
import { getQualityReport } from "../api";
import { useReadRequests } from "../readRequests";
import type { QualityFinding, QualityReport } from "../types";
import { DEFAULT_QUALITY_FILTERS, QUALITY_PAGE_SIZE, QualityPageMismatch, validateQualityPage, type QualityFilters } from "./qualityReportModel";

interface QualityState {
  key: string;
  filters: QualityFilters;
  summary: QualityReport | null;
  response: QualityReport | null;
  pages: QualityFinding[][];
  ids: ReadonlySet<string>;
  nextOffset: number;
  pending: "first" | "more" | null;
  error: { message: string; retry: "first" | "more" } | null;
}
const emptyState = (key: string, filters = DEFAULT_QUALITY_FILTERS): QualityState => ({
  key, filters, summary: null, response: null, pages: [], ids: new Set(), nextOffset: 0, pending: null, error: null,
});

/** A single owner for filters, completed pages and cancellable reads. */
export function useQualityReport(projectId: number | null, active: boolean, revision: number, paused = false) {
  const key = `${projectId ?? "none"}:${revision}`;
  const [state, setState] = useState<QualityState>(() => emptyState(key));
  const current = state.key === key ? state : emptyState(key);
  const stateRef = useRef(current);
  stateRef.current = current;
  const contextRef = useRef({ key, enabled: active && !paused });
  contextRef.current = { key, enabled: active && !paused };
  const reads = useReadRequests();
  const publish = useCallback((next: QualityState) => { stateRef.current = next; setState(next); }, []);

  const run = useCallback(async (more: boolean) => {
    const previous = stateRef.current;
    if (projectId === null || !contextRef.current.enabled || contextRef.current.key !== key || previous.pending) return;
    if (more && (!previous.response?.has_more || previous.error?.retry === "first")) return;
    const request = reads.begin("quality");
    const isCurrent = () => request.isCurrent() && contextRef.current.key === key && contextRef.current.enabled;
    const offset = more ? previous.nextOffset : 0;
    const { severity, rule, scope } = previous.filters;
    publish({ ...previous, pending: more ? "more" : "first", error: null });
    try {
      const input = await getQualityReport(projectId, QUALITY_PAGE_SIZE, offset, severity, rule, scope, request.signal);
      if (!isCurrent()) return;
      const page = validateQualityPage(input, offset, previous.filters, more ? previous.response : null, more ? previous.ids : new Set());
      const ids = new Set(more ? previous.ids : []);
      for (const finding of page.findings) ids.add(finding.id);
      publish({ ...previous, summary: more ? previous.summary : page, response: page,
        pages: more ? [...previous.pages, page.findings] : [page.findings], ids,
        nextOffset: page.offset + page.findings.length, pending: null, error: null });
    } catch (cause) {
      if (!isCurrent()) return;
      const mismatch = cause instanceof QualityPageMismatch;
      publish({ ...stateRef.current, pending: null, error: {
        message: cause instanceof Error ? cause.message : "无法读取质量问题",
        retry: mismatch || !more ? "first" : "more",
      } });
    } finally { request.finish(); }
  }, [key, projectId, reads, publish]);

  useEffect(() => {
    reads.cancelAll();
    const next = { ...stateRef.current, pending: null };
    publish(next);
    if (active && !paused && !next.response && !next.error) void run(false);
    return () => reads.cancelAll();
  }, [key, active, paused, reads, run, publish]);

  const changeFilters = useCallback((filters: QualityFilters) => {
    const previous = stateRef.current;
    if (Object.keys(filters).every((name) => filters[name as keyof QualityFilters] === previous.filters[name as keyof QualityFilters])) return;
    reads.cancelAll();
    publish({ ...emptyState(key, filters), summary: previous.summary });
    void run(false);
  }, [key, reads, publish, run]);

  const retry = useCallback(() => {
    if (stateRef.current.pending) return;
    if (stateRef.current.error?.retry === "more") { void run(true); return; }
    reads.cancelAll();
    const previous = stateRef.current;
    publish({ ...emptyState(key, previous.filters), summary: previous.summary });
    void run(false);
  }, [key, reads, publish, run]);

  return {
    summary: current.summary, response: current.response, pages: current.pages, filters: current.filters,
    count: current.nextOffset, loading: current.pending === "first", loadingMore: current.pending === "more",
    error: current.error, changeFilters, retry, loadMore: () => run(true),
    // Used immediately before a full reanalysis; pause/resume owns the next GET.
    invalidate: () => { reads.cancelAll(); publish(emptyState(key)); },
  };
}

export type QualityWorkspaceState = ReturnType<typeof useQualityReport>;
