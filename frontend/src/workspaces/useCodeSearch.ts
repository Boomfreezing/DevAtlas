import { useEffect, useRef, useState } from "react";
import { searchProject } from "../api";
import { useReadRequests } from "../readRequests";
import type { CodeSearchResponse, CodeSearchResult } from "../types";

interface SearchState {
  key: string;
  query: string;
  response: CodeSearchResponse | null;
  nextOffset: number;
  pending: "search" | "more" | null;
  error: { message: string; retry: "search" | "more" } | null;
}

const emptyState = (key: string, query = ""): SearchState => ({
  key, query, response: null, nextOffset: 0, pending: null, error: null,
});
const uniqueResults = (results: CodeSearchResult[]) =>
  [...new Map(results.map((result) => [result.chunk_id, result])).values()];

/** Keep completed searches across menu switches, never across changed source indexes. */
export function useCodeSearch(projectId: number | null, active: boolean, revision: number) {
  const key = `${projectId ?? "none"}:${revision}`;
  const previousProject = useRef(projectId);
  const [state, setState] = useState<SearchState>(() => emptyState(key));
  const current = state.key === key ? state : emptyState(key, previousProject.current === projectId ? state.query : "");
  const stateRef = useRef(current);
  const contextRef = useRef({ key, active });
  stateRef.current = current;
  contextRef.current = { key, active };
  const reads = useReadRequests();

  function publish(next: SearchState) {
    stateRef.current = next;
    setState(next);
  }

  useEffect(() => {
    reads.cancelAll();
    const sameProject = previousProject.current === projectId;
    previousProject.current = projectId;
    setState((previous) => emptyState(key, sameProject ? previous.query : ""));
    return () => reads.cancelAll();
  }, [key, projectId, reads]);

  useEffect(() => {
    if (!active) {
      reads.cancelAll();
      setState((previous) => ({ ...previous, pending: null }));
    }
  }, [active, reads]);

  function changeQuery(query: string) {
    if (query === stateRef.current.query) return;
    reads.cancelAll();
    publish(emptyState(key, query));
  }

  async function run(more: boolean) {
    const previous = stateRef.current;
    const query = previous.query.trim();
    if (projectId === null || !contextRef.current.active || !query || previous.pending) return;
    if (more && (!previous.response?.has_more || previous.response.query !== query)) return;
    const request = reads.begin("search");
    const offset = more ? previous.nextOffset : 0;
    const isCurrent = () => request.isCurrent() && contextRef.current.key === key && contextRef.current.active;
    publish({ ...previous, response: more ? previous.response : null, pending: more ? "more" : "search", error: null });
    try {
      const page = await searchProject(projectId, query, 10, offset, request.signal);
      if (!isCurrent()) return;
      const previousPage = more ? previous.response : null;
      if (page.query !== query || page.offset !== offset ||
          (previousPage && (page.total_matches !== previousPage.total_matches || page.indexed_chunks !== previousPage.indexed_chunks))) {
        publish({ ...emptyState(key, previous.query), error: { message: "搜索索引或分页结果已变化，请重新搜索后继续。", retry: "search" } });
        return;
      }
      const results = uniqueResults([...(previousPage?.results ?? []), ...page.results]);
      const noProgress = page.has_more && (page.results.length === 0 || results.length === (previousPage?.results.length ?? 0));
      const incomplete = !page.has_more && results.length < page.total_matches;
      publish({
        key, query: previous.query,
        response: { ...page, results, offset: 0, limit: results.length, has_more: page.has_more && !noProgress },
        // The server cursor is independent of the number of unique cards displayed.
        nextOffset: page.offset + page.results.length,
        pending: null,
        error: noProgress || incomplete ? { message: "本次分页未能取得完整的新结果，可能发生了索引更新，请重新搜索。", retry: "search" } : null,
      });
    } catch (error) {
      if (isCurrent()) {
        publish({ ...stateRef.current, pending: null, error: {
          message: error instanceof Error ? error.message : more ? "加载更多搜索结果失败" : "代码搜索失败",
          retry: more ? "more" : "search",
        } });
      }
    } finally {
      request.finish();
    }
  }

  return {
    query: current.query, changeQuery, response: current.response,
    loading: current.pending === "search", loadingMore: current.pending === "more",
    error: current.error,
    search: () => run(false), loadMore: () => run(true),
    retry: () => run(current.error?.retry === "more"),
  };
}
