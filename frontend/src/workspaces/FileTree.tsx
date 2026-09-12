import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getProjectFileTree } from "../api";
import { formatNumber } from "../displayFormat";
import { useReadRequests } from "../readRequests";
import type { ImpactTarget, ProjectFileTreeNode, ProjectFileTreeResponse } from "../types";
import FileTreeFilePages from "./FileTreeFilePages";
import { BoundedDirectoryCache } from "./fileTreeCache";
import { createDirectoryReadQueue, type DirectoryReadQueue } from "./directoryReadQueue";
import { TreeRenderBudget, TreeRenderBudgetContext, useTreeMetadataBudget } from "./treeRenderBudget";

const PAGE_SIZE = 200;
const DirectoryReadQueueContext = createContext<DirectoryReadQueue | null>(null);

type FileTreeProps = {
  projectId: number;
  totalFiles: number;
  onAnalyzeImpact: (target: ImpactTarget) => void;
};

type DirectoryData = {
  items: ProjectFileTreeNode[];
  totalItems: number;
  totalFiles: number;
  nextOffset: number;
  hasMore: boolean;
  legacy: boolean;
  visibleCount: number;
};
type PageError = { message: string; reload: boolean };
type CacheEntry = { data?: DirectoryData; error?: PageError };
type DirectoryCache = BoundedDirectoryCache<CacheEntry>;
type NodeProps = Pick<FileTreeProps, "projectId" | "onAnalyzeImpact"> & {
  node: ProjectFileTreeNode;
  cache: DirectoryCache;
};

class InvalidDirectoryPage extends Error {}

function mergePage(response: ProjectFileTreeResponse, path: string, offset: number, previous?: DirectoryData): DirectoryData {
  if (!Array.isArray(response.items)) throw new InvalidDirectoryPage("目录条目响应无效，请重新读取该目录。");
  if (response.path !== path) throw new InvalidDirectoryPage("目录响应路径不匹配，请重新读取该目录。");
  if (!Number.isSafeInteger(response.total_files) || response.total_files < 0) {
    throw new InvalidDirectoryPage("目录文件统计无效，请重新读取该目录。");
  }
  const pagination = [response.total_items, response.limit, response.offset, response.has_more];
  if (pagination.every((value) => value === undefined)) {
    // Older servers return every direct child; retain bounded rendering for them.
    if (offset !== 0) throw new InvalidDirectoryPage("目录分页信息发生变化，请重新读取该目录。");
    return { items: response.items, totalItems: response.items.length, totalFiles: response.total_files, nextOffset: response.items.length, hasMore: false, legacy: true, visibleCount: PAGE_SIZE };
  }
  const total = response.total_items;
  if (pagination.some((value) => value === undefined) || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0
    || response.offset !== offset || response.limit !== PAGE_SIZE || typeof response.has_more !== "boolean") {
    throw new InvalidDirectoryPage("目录分页信息或路径不匹配，请重新读取该目录。");
  }
  if (previous && (previous.totalItems !== total || previous.totalFiles !== response.total_files)) {
    throw new InvalidDirectoryPage("目录条目总数已变化，请重新读取该目录。");
  }
  if (response.total_files < total) throw new InvalidDirectoryPage("目录文件统计与条目数量不一致，请重新读取该目录。");
  const nextOffset = offset + response.items.length;
  if (response.items.length > PAGE_SIZE || nextOffset > total || response.has_more !== (nextOffset < total)
    || (response.has_more && response.items.length === 0)) {
    throw new InvalidDirectoryPage("目录分页为空或范围不一致，请重新读取该目录。");
  }
  const items = [...(previous?.items ?? []), ...response.items];
  if (new Set(items.map((item) => item.path)).size !== items.length) {
    throw new InvalidDirectoryPage("目录分页包含重复条目，请重新读取该目录。");
  }
  return { items, totalItems: total, totalFiles: response.total_files, nextOffset, hasMore: response.has_more, legacy: false, visibleCount: items.length };
}

function useDirectoryPages(projectId: number, path: string, cache: DirectoryCache) {
  const requests = useReadRequests();
  const queue = useContext(DirectoryReadQueueContext)!;
  const active = useRef<AbortSignal | null>(null);
  const [data, setData] = useState(() => cache.get(path)?.data);
  const [error, setError] = useState(() => cache.get(path)?.error);
  const [loading, setLoading] = useState(!data);
  const [generation, setGeneration] = useState(0);
  useTreeMetadataBudget(data ? Math.min(data.visibleCount, data.items.length) : 0);

  const readPage = useCallback(async (offset: number) => {
    if (active.current && !active.current.aborted) return;
    const request = requests.begin("page");
    active.current = request.signal;
    const entry = cache.get(path) ?? {};
    cache.set(path, entry);
    const previous = offset === 0 ? undefined : entry.data;
    const isCurrent = () => request.isCurrent() && cache.get(path) === entry;
    entry.error = undefined;
    setError(undefined);
    setLoading(true);
    try {
      const response = await queue.run(request.signal, () => getProjectFileTree(projectId, path, request.signal, { limit: PAGE_SIZE, offset }));
      if (!isCurrent()) return;
      const next = mergePage(response, path, offset, previous);
      entry.data = next;
      cache.refresh(path);
      setData(next);
    } catch (cause) {
      if (isCurrent()) {
        const problem = { message: cause instanceof Error ? cause.message : "无法读取该目录", reload: cause instanceof InvalidDirectoryPage };
        entry.error = problem;
        setError(problem);
      }
    } finally {
      if (isCurrent()) setLoading(false);
      if (active.current === request.signal) active.current = null;
      request.finish();
    }
  }, [cache, path, projectId, requests, queue]);

  useEffect(() => {
    const release = cache.pin(path);
    if (!cache.get(path)?.data) void readPage(0);
    return () => {
      requests.cancel("page");
      active.current = null;
      release();
    };
  }, [cache, path, readPage, requests]);

  function loadMore() {
    if (!data || loading || error) return;
    if (data.legacy) {
      const next = { ...data, visibleCount: Math.min(data.visibleCount + PAGE_SIZE, data.items.length) };
      cache.get(path)!.data = next;
      cache.refresh(path);
      setData(next);
    } else if (data.hasMore) {
      void readPage(data.nextOffset);
    }
  }

  function retry() {
    if (loading) return;
    if (error?.reload) {
      // Invalidating entry identity also fences late descendant cache writes.
      cache.deleteSubtree(path);
      setGeneration((value) => value + 1);
      setData(undefined);
      void readPage(0);
    } else {
      void readPage(data?.nextOffset ?? 0);
    }
  }

  return { data, error, loading, generation, loadMore, retry };
}

type DirectoryPages = ReturnType<typeof useDirectoryPages>;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

export default function FileTree(props: FileTreeProps) {
  // Project changes discard rendered nodes, metadata, and pending read scopes.
  return <TreeRuntime key={props.projectId} {...props} />;
}

function TreeRuntime(props: FileTreeProps) {
  const [queue] = useState(createDirectoryReadQueue);
  const [budget] = useState(() => new TreeRenderBudget());
  // Each reader cancels its signal on cleanup. Do not permanently dispose the
  // queue here: StrictMode repeats effect setup on the same runtime instance.
  return <DirectoryReadQueueContext.Provider value={queue}>
    <TreeRenderBudgetContext.Provider value={budget}>
      <ProjectFileTree {...props} />
    </TreeRenderBudgetContext.Provider>
  </DirectoryReadQueueContext.Provider>;
}

function ProjectFileTree({ projectId, totalFiles, onAnalyzeImpact }: FileTreeProps) {
  const [cache] = useState<DirectoryCache>(() => new BoundedDirectoryCache());
  const pages = useDirectoryPages(projectId, "", cache);
  useEffect(() => () => cache.clear(), [cache]);
  if (!pages.data) {
    if (pages.error) return <div className="mini-empty"><PageFailure pages={pages} /></div>;
    return <div className="mini-empty" role="status"><div className="spinner" />正在读取仓库根目录…</div>;
  }
  if (!pages.data.items.length) return <div className="mini-empty">当前仓库没有可展示的文件</div>;

  return (
    <>
      <div className="structure-list-summary file-tree-summary">
        <span className="structure-summary-prompt">&gt; tree --lazy</span>
        <span>indexed</span>
        <strong>{formatNumber(pages.data.totalFiles ?? totalFiles)}</strong>
        <span>files · 展开目录时按需读取</span>
      </div>
      <div className="file-tree" role="tree" aria-label="仓库文件树">
        <FileTreeItems key={pages.generation} projectId={projectId} pages={pages} path="" cache={cache} onAnalyzeImpact={onAnalyzeImpact} />
      </div>
    </>
  );
}

function PageFailure({ pages }: { pages: DirectoryPages }) {
  if (!pages.error) return null;
  return <div className="file-tree-loading" role="alert"><span>{pages.error.message}</span><button type="button" className="file-tree-retry" disabled={pages.loading} onClick={pages.retry}>{pages.error.reload ? "[ 重新读取 ]" : "[ RETRY ]"}</button></div>;
}

function FileTreeItems({ projectId, pages, path, cache, onAnalyzeImpact }: Pick<NodeProps, "projectId" | "cache" | "onAnalyzeImpact"> & { pages: DirectoryPages; path: string }) {
  const data = pages.data!;
  const shown = Math.min(data.visibleCount, data.items.length);
  const hasMore = data.hasMore || shown < data.items.length;
  const { directories, files } = useMemo(() => {
    const visible = data.items.slice(0, shown);
    return { directories: visible.filter((node) => node.kind === "directory"), files: visible.filter((node) => node.kind !== "directory") };
  }, [data.items, shown]);
  const renderFile = useCallback((node: ProjectFileTreeNode, index: number) => (
    <FileTreeNodeView key={`${node.kind}:${node.path}`} projectId={projectId} node={node} cache={cache}
      onAnalyzeImpact={onAnalyzeImpact} position={directories.length + index + 1} total={data.totalItems} />
  ), [projectId, cache, onAnalyzeImpact, directories.length, data.totalItems]);
  return (
    <>
      {directories.map((node) => <FileTreeNodeView key={`${node.kind}:${node.path}`} projectId={projectId} node={node} cache={cache} onAnalyzeImpact={onAnalyzeImpact} />)}
      <FileTreeFilePages items={files} renderFile={renderFile} />
      {hasMore && !pages.error && (
        <div className="structure-load-more">
          <button type="button" disabled={pages.loading} aria-label={`加载${path || "根目录"}的更多条目`} onClick={pages.loadMore}>
            {pages.loading ? "正在读取更多条目…" : "加载更多条目"} <span>已显示 {formatNumber(shown)} / {formatNumber(data.totalItems)} 个直接子项</span>
          </button>
        </div>
      )}
      <PageFailure pages={pages} />
      {data.totalItems > PAGE_SIZE && !hasMore && <div className="file-tree-loading" role="status">已显示全部 {formatNumber(shown)} 个直接子项</div>}
    </>
  );
}

const FileTreeNodeView = memo(function FileTreeNodeView({ projectId, node, cache, onAnalyzeImpact, position, total }: NodeProps & { position?: number; total?: number }) {
  if (node.kind === "directory") return <FileTreeDirectoryView projectId={projectId} node={node} cache={cache} onAnalyzeImpact={onAnalyzeImpact} />;
  return (
    <div className="file-tree-file" role="treeitem" title={node.path} aria-posinset={position} aria-setsize={total}>
      <span className="file-tree-branch">├</span>
      <span className="file-symbol">⌑</span>
      <strong>{node.name}</strong>
      <span>{node.language ?? "Text"}</span>
      <small>{formatNumber(node.line_count ?? 0)} 行</small>
      <small>{formatBytes(node.size_bytes ?? 0)}</small>
      <button type="button" className="file-tree-impact-button" onClick={() => onAnalyzeImpact({ target_type: "file", target_id: node.id!, file_id: node.id!, file_path: node.path, name: node.path, kind: "file", start_line: 1, end_line: Math.max(1, node.line_count ?? 1) })}>影响</button>
    </div>
  );
});

function FileTreeDirectoryView({ projectId, node, cache, onAnalyzeImpact }: NodeProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="file-tree-directory" role="treeitem" aria-expanded={expanded}>
      <button
        type="button"
        className="file-tree-directory-button"
        aria-expanded={expanded}
        aria-label={`${node.name} 目录，${node.file_count} 个文件，${expanded ? "点击折叠" : "点击展开"}`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="file-tree-toggle">{expanded ? "▾" : "▸"}</span>
        <span className="file-tree-folder">{expanded ? "▱" : "□"}</span>
        <strong>{node.name}</strong>
        <small title="包括子目录中的文件">{formatNumber(node.file_count)} 个文件</small>
      </button>
      {expanded && <FileTreeDirectoryContents projectId={projectId} node={node} cache={cache} onAnalyzeImpact={onAnalyzeImpact} />}
    </div>
  );
}

function FileTreeDirectoryContents({ projectId, node, cache, onAnalyzeImpact }: NodeProps) {
  const pages = useDirectoryPages(projectId, node.path, cache);
  return (
    <div className="file-tree-children" role="group">
      {!pages.data && !pages.error && <div className="file-tree-loading" role="status"><div className="spinner" />正在读取目录…</div>}
      {!pages.data && <PageFailure pages={pages} />}
      {pages.data && <FileTreeItems key={pages.generation} projectId={projectId} pages={pages} path={node.path} cache={cache} onAnalyzeImpact={onAnalyzeImpact} />}
      {pages.data && pages.data.items.length === 0 && <div className="file-tree-loading">空目录</div>}
    </div>
  );
}
