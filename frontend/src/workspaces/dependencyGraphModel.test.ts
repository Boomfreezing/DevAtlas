import { describe, expect, it } from "vitest";
import type { DependencyCycle, DependencyEdge, DependencyGraph, DependencyNode } from "../types";
import {
  buildCycleMembership,
  DEPENDENCY_GRAPH_CENTER,
  dependencyEdgeGeometry,
  dependencyNodeRadius,
  isCyclicDependencyEdge,
  prepareDependencyGraph,
} from "./dependencyGraphModel";

function node(id: number, path = `src/module-${id}.ts`, inDegree = 1, outDegree = 1): DependencyNode {
  return { id, path, language: "TypeScript", in_degree: inDegree, out_degree: outDegree };
}

function edge(source: number, target: number): DependencyEdge {
  return { source_id: source, target_id: target, source_path: `src/module-${source}.ts`, target_path: `src/module-${target}.ts`, import_count: 2, line_numbers: [3, 8] };
}

function graph(nodes: DependencyNode[], edges: DependencyEdge[] = [], cycles: DependencyCycle[] = []): DependencyGraph {
  return {
    total_node_count: nodes.length, total_edge_count: edges.length,
    internal_import_count: edges.length * 2, external_import_count: 0, unresolved_import_count: 0,
    classified_import_count: edges.length * 2, classification_confidence: 100, confidence_level: "high",
    cycle_count: cycles.length, truncated: false, nodes, edges, cycles,
  };
}

function cycle(...ids: number[]): DependencyCycle {
  return { file_ids: ids, paths: ids.map((id) => `src/module-${id}.ts`) };
}

describe("cycle membership", () => {
  it("recognizes internal cycle edges and self-loops but excludes bridges between separate cycles", () => {
    const membership = buildCycleMembership([cycle(1, 2), cycle(3, 4), cycle(5)]);
    expect(isCyclicDependencyEdge(edge(1, 2), membership)).toBe(true);
    expect(isCyclicDependencyEdge(edge(2, 1), membership)).toBe(true);
    expect(isCyclicDependencyEdge(edge(5, 5), membership)).toBe(true);
    expect(isCyclicDependencyEdge(edge(2, 3), membership)).toBe(false);
    expect(isCyclicDependencyEdge(edge(4, 5), membership)).toBe(false);
    expect(isCyclicDependencyEdge(edge(1, 6), membership)).toBe(false);
    expect(isCyclicDependencyEdge(edge(6, 1), membership)).toBe(false);
    expect(isCyclicDependencyEdge(edge(6, 6), membership)).toBe(false);
  });

  it("retains overlapping group memberships without making them transitive", () => {
    const membership = buildCycleMembership([cycle(1, 2, 2), cycle(2, 3), cycle(2, 4)]);
    expect([...membership.get(2)!]).toEqual([0, 1, 2]);
    expect(isCyclicDependencyEdge(edge(1, 2), membership)).toBe(true);
    expect(isCyclicDependencyEdge(edge(2, 3), membership)).toBe(true);
    expect(isCyclicDependencyEdge(edge(3, 2), membership)).toBe(true);
    expect(isCyclicDependencyEdge(edge(1, 3), membership)).toBe(false);
    expect(isCyclicDependencyEdge(edge(3, 4), membership)).toBe(false);
    expect(buildCycleMembership([]).size).toBe(0);
  });
});

describe("prepared dependency graph", () => {
  it("uses a trimmed case-insensitive literal path filter and keeps only edges with two visible endpoints", () => {
    const input = graph([node(1, "src/[View].TSX"), node(2, "SRC/[VIEW].test.tsx"), node(3, "src/View.tsx")], [edge(1, 2), edge(2, 3), edge(3, 1)]);
    const prepared = prepareDependencyGraph(input, " [vIeW] ");
    expect(prepared.displayedNodes.map((item) => item.id)).toEqual([1, 2]);
    expect(prepared.displayedEdges).toEqual([input.edges[0]]);
    expect(prepared.nodeById.get(1)).toBe(input.nodes[0]);
    expect(prepared.edgeByKey.get("1-2")).toBe(input.edges[0]);
    expect(prepared.incidentEdgesByNodeId.get(1)).toEqual([input.edges[0]]);
    expect(prepared.incidentEdgesByNodeId.get(2)).toEqual([input.edges[0]]);
    expect(prepared.renderedNodes[0].position).toEqual(DEPENDENCY_GRAPH_CENTER);
    expect(prepareDependencyGraph(input, " ").displayedEdges).toHaveLength(3);
  });

  it("returns an empty render model for no matches, a missing graph, and dangling edges", () => {
    for (const prepared of [prepareDependencyGraph(graph([node(1)]), "unknown"), prepareDependencyGraph(null, ""), prepareDependencyGraph(graph([]), "")]) {
      expect(prepared.displayedNodes).toEqual([]);
      expect(prepared.renderedEdges).toEqual([]);
      expect(prepared.positions.size).toBe(0);
      expect(prepared.incidentEdgesByNodeId.size).toBe(0);
    }
    expect(prepareDependencyGraph(graph([node(1)], [edge(1, 2)]), "").displayedEdges).toEqual([]);
  });

  it("preserves center, 12-node inner ring, outer ring, path labels and original degrees", () => {
    const nodes = Array.from({ length: 17 }, (_, index) => node(index + 1));
    nodes[0] = node(1, "src/very-long-dependency-module.ts", 7, 9);
    const prepared = prepareDependencyGraph(graph(nodes, [edge(1, 2)]), "");
    expect(prepared.positions.get(1)).toEqual({ x: 440, y: 245 });
    expect(prepared.positions.get(2)!.x).toBeCloseTo(440);
    expect(prepared.positions.get(2)!.y).toBeCloseTo(100);
    expect(prepared.positions.get(5)!.x).toBeCloseTo(630);
    expect(prepared.positions.get(5)!.y).toBeCloseTo(245);
    expect(prepared.positions.get(14)!.x).toBeCloseTo(440);
    expect(prepared.positions.get(14)!.y).toBeCloseTo(30);
    expect(prepared.positions.get(15)!.x).toBeCloseTo(790);
    expect(prepared.positions.get(15)!.y).toBeCloseTo(245);
    expect(prepared.renderedNodes[0].label).toBe("very-long-dependen…");
    expect(prepared.renderedNodes[0].index).toBe(0);
    expect(prepared.renderedNodes[0].radius).toBe(18);
    expect(prepared.nodeById.get(1)).toMatchObject({ in_degree: 7, out_degree: 9 });
    expect(dependencyNodeRadius(node(20, "module.ts", 0, 0))).toBe(10);
    expect(dependencyNodeRadius(node(20, "module.ts", 1, 2))).toBeCloseTo(14.2);
  });

  it("indexes incident edges in response order and counts a self-loop once", () => {
    const input = graph([node(1), node(2), node(3)], [edge(1, 1), edge(2, 1), edge(1, 2)]);
    const prepared = prepareDependencyGraph(input, "");
    expect(prepared.incidentEdgesByNodeId.get(1)).toEqual(input.edges);
    expect(prepared.incidentEdgesByNodeId.get(2)).toEqual(input.edges.slice(1));
    expect(prepared.incidentEdgesByNodeId.get(3)).toEqual([]);
    expect(prepared.renderedEdges.map((item) => item.key)).toEqual(["1-1", "2-1", "1-2"]);
  });
});

describe("dependency edge geometry", () => {
  it("places reciprocal curves on opposite sides of the center line", () => {
    const prepared = prepareDependencyGraph(graph([node(1), node(2)], [edge(1, 2), edge(2, 1)]), "");
    const forward = prepared.renderedEdges[0].geometry;
    const reverse = prepared.renderedEdges[1].geometry;
    expect(forward.label.x).toBeGreaterThan(DEPENDENCY_GRAPH_CENTER.x);
    expect(reverse.label.x).toBeLessThan(DEPENDENCY_GRAPH_CENTER.x);
    expect(forward.path).not.toEqual(reverse.path);
  });

  it("retains ordinary edge clipping and quadratic midpoint label placement", () => {
    const geometry = dependencyEdgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 18, 12);
    expect(geometry.path).toBe("M 13.00 0.00 Q 45.00 12.00 77.00 0.00");
    expect(geometry.label).toEqual({ x: 45, y: 6 });
  });

  it("renders finite, nondegenerate self-loops with endpoints outside the node and control points inside the canvas", () => {
    const nodes = Array.from({ length: 17 }, (_, index) => node(index + 1));
    const prepared = prepareDependencyGraph(graph(nodes, nodes.map((item) => edge(item.id, item.id))), "");
    for (const item of prepared.renderedEdges) {
      expect(item.geometry.path).toContain(" C ");
      const coordinates = item.geometry.path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      expect(coordinates).toHaveLength(8);
      expect(coordinates.every(Number.isFinite)).toBe(true);
      const [startX, startY, , , , , endX, endY] = coordinates;
      const position = prepared.positions.get(item.edge.source_id)!;
      const radius = dependencyNodeRadius(prepared.nodeById.get(item.edge.source_id)!);
      expect(Math.hypot(startX - position.x, startY - position.y)).toBeCloseTo(radius + 3, 1);
      expect(Math.hypot(endX - position.x, endY - position.y)).toBeCloseTo(radius + 5, 1);
      expect(Math.hypot(endX - startX, endY - startY)).toBeGreaterThan(radius);
      expect(Number.isFinite(item.geometry.label.x) && Number.isFinite(item.geometry.label.y)).toBe(true);
      for (let index = 0; index < coordinates.length; index += 2) {
        expect(coordinates[index]).toBeGreaterThanOrEqual(-10);
        expect(coordinates[index]).toBeLessThanOrEqual(890);
        expect(coordinates[index + 1]).toBeGreaterThanOrEqual(-5);
        expect(coordinates[index + 1]).toBeLessThanOrEqual(495);
      }
    }
  });
});
