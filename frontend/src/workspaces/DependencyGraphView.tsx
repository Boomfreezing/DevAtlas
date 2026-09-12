import { memo, useCallback, useMemo, useState } from "react";
import { getDependencyGraph } from "../api";
import { formatNumber } from "../displayFormat";
import { useReadRequests } from "../readRequests";
import type { DependencyGraph, DependencyNode } from "../types";
import { buildCycleMembership, DEPENDENCY_GRAPH_CENTER, DEPENDENCY_GRAPH_HEIGHT, DEPENDENCY_GRAPH_WIDTH, dependencyEdgeKey, isCyclicDependencyEdge, prepareDependencyGraph } from "./dependencyGraphModel";

export default function DependencyGraphView({ projectId, graph }: { projectId: number; graph: DependencyGraph }) {
  // A replacement graph may reuse file IDs but represent a different analysis.
  // Reset descendants before committing it, instead of briefly showing old focus.
  const [source, setSource] = useState({ projectId, graph, revision: 0 });
  if (source.projectId !== projectId || source.graph !== graph) {
    setSource({ projectId, graph, revision: source.revision + 1 });
  }
  return <GraphSession key={source.revision} projectId={projectId} graph={graph} />;
}

function GraphSession({ projectId, graph }: { projectId: number; graph: DependencyGraph }) {
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(graph.nodes[0]?.id ?? null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [selectedCycleIndex, setSelectedCycleIndex] = useState<number | null>(null);
  const [focusedGraph, setFocusedGraph] = useState<DependencyGraph | null>(null);
  const [cycleFocusLoading, setCycleFocusLoading] = useState(false);
  const [cycleFocusError, setCycleFocusError] = useState<string | null>(null);
  const [moduleFilter, setModuleFilter] = useState("");
  const [zoom, setZoom] = useState(1);
  const requests = useReadRequests();
  const activeGraph = selectedCycleIndex === null ? graph : focusedGraph;
  const width = DEPENDENCY_GRAPH_WIDTH;
  const height = DEPENDENCY_GRAPH_HEIGHT;
  const { x: centerX, y: centerY } = DEPENDENCY_GRAPH_CENTER;
  const cycleMembership = useMemo(() => buildCycleMembership(graph.cycles ?? []), [graph.cycles]);
  const selectedCycle = selectedCycleIndex === null ? null : graph.cycles[selectedCycleIndex] ?? null;
  const prepared = useMemo(() => prepareDependencyGraph(activeGraph, moduleFilter), [activeGraph, moduleFilter]);
  const { displayedNodes, displayedEdges } = prepared;
  const selectedNode = prepared.nodeById.get(selectedNodeId ?? -1) ?? displayedNodes[0] ?? null;
  const selectedEdges = prepared.incidentEdgesByNodeId.get(selectedNode?.id ?? -1) ?? [];
  const selectedEdge = prepared.edgeByKey.get(selectedEdgeKey ?? "") ?? null;
  const selectNode = useCallback((id: number) => { setSelectedNodeId(id); setSelectedEdgeKey(null); }, []);
  const clearSelectedEdge = useCallback(() => setSelectedEdgeKey(null), []);
  const selectRelation = useCallback((edge: DependencyGraph["edges"][number]) => setSelectedEdgeKey(dependencyEdgeKey(edge)), []);

  function changeFilter(value: string) {
    setModuleFilter(value);
    setSelectedEdgeKey(null);
    const query = value.trim().toLowerCase();
    if (selectedNode && !selectedNode.path.toLowerCase().includes(query)) {
      // Do not resurrect a hidden selection when the filter is later cleared.
      setSelectedNodeId(null);
    }
  }

  const clearCycleFocus = useCallback(() => {
    requests.cancel("cycle");
    setSelectedCycleIndex(null);
    setFocusedGraph(null);
    setCycleFocusLoading(false);
    setCycleFocusError(null);
    setModuleFilter("");
    setSelectedEdgeKey(null);
    setSelectedNodeId(graph.nodes[0]?.id ?? null);
    setZoom(1);
  }, [graph, requests]);

  const loadCycleFocus = useCallback(async (index: number) => {
    const request = requests.begin("cycle");
    setSelectedCycleIndex(index);
    setFocusedGraph(null);
    setCycleFocusLoading(true);
    setCycleFocusError(null);
    setModuleFilter("");
    setSelectedEdgeKey(null);
    setZoom(1);
    try {
      const response = await getDependencyGraph(projectId, 40, index + 1, request.signal);
      if (!request.isCurrent()) return;
      setFocusedGraph(response);
      setSelectedNodeId(response.nodes[0]?.id ?? null);
    } catch (requestError) {
      if (!request.isCurrent()) return;
      setCycleFocusError(requestError instanceof Error ? requestError.message : "无法加载所选循环依赖");
    } finally {
      if (request.isCurrent()) setCycleFocusLoading(false);
      request.finish();
    }
  }, [projectId, requests]);

  const selectCycle = useCallback((index: number) => {
    if (selectedCycleIndex === index && !cycleFocusError) {
      clearCycleFocus();
      return;
    }
    void loadCycleFocus(index);
  }, [selectedCycleIndex, cycleFocusError, clearCycleFocus, loadCycleFocus]);

  if (graph.nodes.length === 0) {
    return <div className="dependency-empty"><div className="empty-glyph">◇</div><h3>没有项目内依赖</h3><p>当前分析未发现可展示的项目内依赖关系；可能没有导入关系，或部分路径尚未解析。</p></div>;
  }

  return (
    <div className="dependency-view">
      <div className="dependency-stats">
        <div><strong>{formatNumber(graph.total_node_count)}</strong><span>关联模块</span></div>
        <div><strong>{formatNumber(graph.total_edge_count)}</strong><span>依赖边</span></div>
        <div><strong>{formatNumber(graph.internal_import_count)}</strong><span>内部导入</span></div>
        <div className={graph.cycle_count ? "warning" : ""}><strong>{formatNumber(graph.cycle_count)}</strong><span>循环依赖</span></div>
      </div>
      <div className={`graph-confidence confidence-${graph.confidence_level ?? "low"}`} role="status">
        <div><strong>依赖分类可信度 {Number(graph.classification_confidence ?? 0).toFixed(1)}%</strong><span>{dependencyConfidenceLabel(graph.confidence_level)}</span></div>
        <p>项目内 {formatNumber(graph.internal_import_count)} · 推定外部 {formatNumber(graph.external_import_count)} · 待确认 {formatNumber(graph.unresolved_import_count ?? 0)}</p>
      </div>
      {graph.truncated && selectedCycleIndex === null && <div className="graph-notice">仓库规模较大，图中优先展示循环模块和连接度最高的 {graph.nodes.length} 个文件。路径筛选仅作用于当前已加载模块。</div>}
      <div className="graph-toolbar">
        <label><span>筛选模块</span><input value={moduleFilter} onChange={(event) => changeFilter(event.target.value)} placeholder="输入文件名或路径" disabled={!activeGraph} /></label>
        <small>当前显示 {displayedNodes.length} 个模块 / {displayedEdges.length} 条边</small>
        {selectedCycle && <button type="button" className="graph-clear-focus" onClick={clearCycleFocus}>退出循环聚焦</button>}
        <div className="zoom-controls"><button aria-label="缩小依赖图" onClick={() => setZoom((value) => Math.max(1, value - .25))} disabled={!activeGraph || zoom <= 1}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大依赖图" onClick={() => setZoom((value) => Math.min(2.5, value + .25))} disabled={!activeGraph || zoom >= 2.5}>＋</button></div>
      </div>
      {selectedCycle && !cycleFocusError && (
        <div className="graph-focus-status" role="status" aria-busy={cycleFocusLoading}>
          <strong>FOCUS_CYCLE_{selectedCycleIndex! + 1}</strong>
          <span>{cycleFocusLoading ? "正在加载该循环的完整节点和依赖边…" : `图中仅保留该循环的 ${displayedNodes.length} 个节点和 ${displayedEdges.length} 条内部依赖边`}</span>
        </div>
      )}
      {cycleFocusError && (
        <div className="graph-focus-error" role="alert">
          <span>{cycleFocusError}</span>
          <button type="button" onClick={() => void loadCycleFocus(selectedCycleIndex!)}>重试</button>
          <button type="button" onClick={clearCycleFocus}>取消</button>
        </div>
      )}
      <div className="graph-legend" role="note" aria-label="依赖图图例">
        <strong>A → B 表示 A 导入并依赖 B</strong>
        <b className="legend-group-label">NODE</b>
        <span><i className="legend-node ordinary" />普通模块</span>
        <span><i className="legend-node cyclic" />循环模块</span>
        <span><i className="legend-node selected" />当前选中</span>
        <span><i className="legend-node cyclic-selected" />选中的循环模块</span>
        <b className="legend-group-label">EDGE</b>
        <span><i className="legend-edge outgoing" />当前模块依赖</span>
        <span><i className="legend-edge incoming" />依赖当前模块</span>
        <span><i className="legend-edge cyclic" />循环依赖边</span>
      </div>
      <div className="dependency-layout">
        <div className="dependency-canvas" aria-busy={cycleFocusLoading}>
          <svg viewBox={`${centerX - width / zoom / 2} ${centerY - height / zoom / 2} ${width / zoom} ${height / zoom}`} role="img" aria-label="项目模块依赖图">
            <defs>
              <marker id="dependency-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
              <marker id="dependency-arrow-outgoing" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
              <marker id="dependency-arrow-incoming" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
              <marker id="dependency-arrow-cyclic" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
            </defs>
            <GraphElements prepared={prepared} cycleMembership={cycleMembership} selectedNodeId={selectedNode?.id ?? null}
              selectedEdgeKey={selectedEdgeKey} onSelectNode={selectNode} onSelectEdge={setSelectedEdgeKey} />
            {!displayedNodes.length && <text x={centerX} y={centerY} textAnchor="middle" className="no-filter-result">
              {cycleFocusLoading ? "正在加载循环依赖…" : cycleFocusError ? "循环加载失败，请重试或退出聚焦" : selectedCycle && !moduleFilter.trim() ? "该循环暂无可展示的模块，请退出聚焦后刷新分析" : "没有匹配的模块"}
            </text>}
          </svg>
        </div>
        <aside className="node-inspector">
          {selectedEdge
            ? <EdgeInspector edge={selectedEdge} onBack={clearSelectedEdge} />
            : selectedNode && <NodeInspector node={selectedNode} edges={selectedEdges} onSelectEdge={selectRelation} />}
        </aside>
      </div>
      <CycleList cycles={graph.cycles ?? []} cycleCount={graph.cycle_count} selectedIndex={selectedCycleIndex}
        loading={cycleFocusLoading} error={!!cycleFocusError} onSelect={selectCycle} />
    </div>
  );
}

type PreparedGraph = ReturnType<typeof prepareDependencyGraph>;
type EdgeGroup = { items: PreparedGraph["renderedEdges"]; nodeIds: Set<number>; edgeKeys: Set<string> };
type NodeGroup = { items: PreparedGraph["renderedNodes"]; nodeIds: Set<number> };

// A handful of memoized batches avoids thousands of extra component instances
// on first mount, while selection updates only the batches containing its IDs.
const GraphElements = memo(function GraphElements({ prepared, cycleMembership, selectedNodeId, selectedEdgeKey, onSelectNode, onSelectEdge }: {
  prepared: PreparedGraph; cycleMembership: ReturnType<typeof buildCycleMembership>; selectedNodeId: number | null;
  selectedEdgeKey: string | null; onSelectNode: (id: number) => void; onSelectEdge: (key: string) => void;
}) {
  const groups = useMemo(() => {
    const edges: EdgeGroup[] = [], nodes: NodeGroup[] = [];
    for (let offset = 0; offset < prepared.renderedEdges.length; offset += 128) {
      const items = prepared.renderedEdges.slice(offset, offset + 128);
      edges.push({ items, nodeIds: new Set(items.flatMap(({ edge }) => [edge.source_id, edge.target_id])),
        edgeKeys: new Set(items.map((item) => item.key)) });
    }
    for (let offset = 0; offset < prepared.renderedNodes.length; offset += 64) {
      const items = prepared.renderedNodes.slice(offset, offset + 64);
      nodes.push({ items, nodeIds: new Set(items.map(({ node }) => node.id)) });
    }
    return { edges, nodes };
  }, [prepared]);
  return <>
    {groups.edges.map((group, index) => <GraphEdgeGroup key={index} group={group} cycleMembership={cycleMembership}
      selectedNodeId={selectedNodeId !== null && group.nodeIds.has(selectedNodeId) ? selectedNodeId : null}
      selectedEdgeKey={selectedEdgeKey !== null && group.edgeKeys.has(selectedEdgeKey) ? selectedEdgeKey : null} onSelect={onSelectEdge} />)}
    {groups.nodes.map((group, index) => <GraphNodeGroup key={index} group={group} cycleMembership={cycleMembership}
      selectedNodeId={selectedNodeId !== null && group.nodeIds.has(selectedNodeId) ? selectedNodeId : null} onSelect={onSelectNode} />)}
  </>;
});

const GraphEdgeGroup = memo(function GraphEdgeGroup({ group, cycleMembership, selectedNodeId, selectedEdgeKey, onSelect }: {
  group: EdgeGroup; cycleMembership: ReturnType<typeof buildCycleMembership>; selectedNodeId: number | null;
  selectedEdgeKey: string | null; onSelect: (key: string) => void;
}) {
  return <>{group.items.map(({ edge, key, geometry }) => {
    const outgoing = edge.source_id === selectedNodeId, incoming = edge.target_id === selectedNodeId;
    const cyclic = isCyclicDependencyEdge(edge, cycleMembership), selected = key === selectedEdgeKey;
    const marker = cyclic ? "dependency-arrow-cyclic" : outgoing ? "dependency-arrow-outgoing" : incoming ? "dependency-arrow-incoming" : "dependency-arrow";
    return <g key={key} className={`dependency-edge ${outgoing ? "outgoing" : ""} ${incoming ? "incoming" : ""} ${cyclic ? "cyclic" : ""} ${selected ? "selected" : ""}`}
      role="button" tabIndex={0} aria-pressed={selected}
      aria-label={`${edge.source_path} 导入并依赖 ${edge.target_path}，${edge.import_count} 条导入`}
      onClick={() => onSelect(key)} onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(key); }
      }}>
      {/* A single text child avoids separate text nodes/Fibers for each fragment on dense graphs. */}
      <title>{`${edge.source_path} → ${edge.target_path} · ${edge.import_count} 条导入 · 第 ${edge.line_numbers.join("、")} 行${cyclic ? " · 循环依赖边" : ""}`}</title>
      <path className="edge-hit-area" d={geometry.path} />
      <path className="edge-line" d={geometry.path} markerEnd={`url(#${marker})`} />
      <text className="edge-label" x={geometry.label.x} y={geometry.label.y - 5} textAnchor="middle">{`×${edge.import_count}`}</text>
    </g>;
  })}</>;
});

const GraphNodeGroup = memo(function GraphNodeGroup({ group, cycleMembership, selectedNodeId, onSelect }: {
  group: NodeGroup; cycleMembership: ReturnType<typeof buildCycleMembership>; selectedNodeId: number | null; onSelect: (id: number) => void;
}) {
  return <>{group.items.map(({ node, position, radius, label, index }) => {
    const selected = node.id === selectedNodeId;
    return <g key={node.id} className={`dependency-node ${selected ? "selected" : ""} ${cycleMembership.has(node.id) ? "cyclic" : ""}`}
      role="button" tabIndex={0} aria-pressed={selected} aria-label={`选择模块 ${node.path}`}
      onClick={() => onSelect(node.id)} onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(node.id); }
      }}>
      <title>{`${node.path} · 入度 ${node.in_degree} / 出度 ${node.out_degree}`}</title>
      <circle cx={position.x} cy={position.y} r={radius} />
      {(index < 16 || selected) && <text x={position.x} y={position.y + radius + 13} textAnchor="middle">{label}</text>}
    </g>;
  })}</>;
});

const CycleList = memo(function CycleList({ cycles, cycleCount, selectedIndex, loading, error, onSelect }: {
  cycles: DependencyGraph["cycles"]; cycleCount: number; selectedIndex: number | null; loading: boolean;
  error: boolean; onSelect: (index: number) => void;
}) {
  return <section className="cycle-list">
    <div className="cycle-heading"><strong>循环依赖</strong><span>{cycleCount ? "选择依赖环可在图中单独聚焦，再次点击取消" : "未检测到强连通依赖环"}</span></div>
    {cycles.map((cycle, index) => <button type="button" className={`cycle-row ${selectedIndex === index ? "active" : ""}`}
      aria-pressed={selectedIndex === index} aria-label={`${selectedIndex === index ? "取消聚焦" : "聚焦"}环 ${index + 1}：${cycle.paths.join(" 到 ")}`}
      key={cycle.file_ids.join("-")} onClick={() => onSelect(index)}>
      <strong>环 {index + 1}</strong><span>{`${cycle.paths.join(" → ")} → ${cycle.paths[0] ?? ""}`}</span>
      <em>{selectedIndex === index ? loading ? "[ LOADING ]" : error ? "[ RETRY ]" : "[ FOCUSED ]" : "[ SELECT ]"}</em>
    </button>)}
  </section>;
});

const NodeInspector = memo(function NodeInspector({ node, edges, onSelectEdge }: { node: DependencyNode; edges: DependencyGraph["edges"]; onSelectEdge: (edge: DependencyGraph["edges"][number]) => void }) {
  const outgoingEdges = edges.filter((edge) => edge.source_id === node.id);
  const incomingEdges = edges.filter((edge) => edge.target_id === node.id);
  return (
    <>
      <p className="eyebrow">SELECTED MODULE</p>
      <h3>{shortFileName(node.path)}</h3>
      <code>{node.path}</code>
      <div className="node-degrees"><div><strong>{node.in_degree}</strong><span>入度</span></div><div><strong>{node.out_degree}</strong><span>出度</span></div></div>
      <NeighborGroup title="当前模块依赖" tone="outgoing" edges={outgoingEdges} node={node} onSelectEdge={onSelectEdge} />
      <NeighborGroup title="依赖当前模块" tone="incoming" edges={incomingEdges} node={node} onSelectEdge={onSelectEdge} />
    </>
  );
});

function NeighborGroup({ title, tone, edges, node, onSelectEdge }: { title: string; tone: "outgoing" | "incoming"; edges: DependencyGraph["edges"]; node: DependencyNode; onSelectEdge: (edge: DependencyGraph["edges"][number]) => void }) {
  return (
    <section className={`neighbor-group ${tone}`}>
      <h4>{title}<span>{edges.length}</span></h4>
      <div className="neighbor-list">
        {edges.slice(0, 12).map((edge) => {
          const outgoing = edge.source_id === node.id;
          return <button type="button" key={dependencyEdgeKey(edge)} onClick={() => onSelectEdge(edge)}><span>{outgoing ? "→" : "←"}</span><div><strong>{shortFileName(outgoing ? edge.target_path : edge.source_path)}</strong><small>{edge.import_count} 条导入 · 第 {edge.line_numbers.slice(0, 3).join("、")} 行</small></div></button>;
        })}
        {!edges.length && <small>没有可见关系</small>}
      </div>
    </section>
  );
}

const EdgeInspector = memo(function EdgeInspector({ edge, onBack }: { edge: DependencyGraph["edges"][number]; onBack: () => void }) {
  return (
    <>
      <p className="eyebrow">SELECTED DEPENDENCY</p>
      <h3>{shortFileName(edge.source_path)} → {shortFileName(edge.target_path)}</h3>
      <div className="edge-direction-detail">
        <code>{edge.source_path}</code>
        <span>导入并依赖 ↓</span>
        <code>{edge.target_path}</code>
      </div>
      <div className="edge-metrics"><div><strong>{edge.import_count}</strong><span>导入次数</span></div><div><strong>{edge.line_numbers.length}</strong><span>代码位置</span></div></div>
      <div className="edge-lines"><strong>来源文件中的导入行</strong><span>{edge.line_numbers.map((line) => `第 ${line} 行`).join("、")}</span></div>
      <button type="button" className="edge-inspector-back" onClick={onBack}>返回模块详情</button>
    </>
  );
});

function shortFileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function dependencyConfidenceLabel(level: DependencyGraph["confidence_level"] | undefined): string {
  return { high: "HIGH", medium: "MEDIUM", low: "LOW" }[level ?? "low"];
}
