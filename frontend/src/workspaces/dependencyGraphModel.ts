import type { DependencyCycle, DependencyEdge, DependencyGraph, DependencyNode } from "../types";

export const DEPENDENCY_GRAPH_WIDTH = 900;
export const DEPENDENCY_GRAPH_HEIGHT = 500;
export const DEPENDENCY_GRAPH_CENTER = { x: 440, y: 245 };

export interface GraphPoint {
  x: number;
  y: number;
}

export interface DependencyEdgeGeometry {
  path: string;
  label: GraphPoint;
}

export interface RenderedDependencyNode {
  node: DependencyNode;
  position: GraphPoint;
  radius: number;
  label: string;
  index: number;
}

export interface RenderedDependencyEdge {
  edge: DependencyEdge;
  key: string;
  geometry: DependencyEdgeGeometry;
}

export interface PreparedDependencyGraph {
  displayedNodes: DependencyNode[];
  displayedEdges: DependencyEdge[];
  nodeById: Map<number, DependencyNode>;
  edgeByKey: Map<string, DependencyEdge>;
  positions: Map<number, GraphPoint>;
  renderedNodes: RenderedDependencyNode[];
  renderedEdges: RenderedDependencyEdge[];
  incidentEdgesByNodeId: Map<number, DependencyEdge[]>;
}

export type CycleMembership = ReadonlyMap<number, ReadonlySet<number>>;

export function buildCycleMembership(cycles: readonly DependencyCycle[]): Map<number, Set<number>> {
  const membership = new Map<number, Set<number>>();
  cycles.forEach((cycle, index) => {
    for (const id of cycle.file_ids) {
      let groups = membership.get(id);
      if (!groups) {
        groups = new Set<number>();
        membership.set(id, groups);
      }
      groups.add(index);
    }
  });
  return membership;
}

export function isCyclicDependencyEdge(edge: DependencyEdge, membership: CycleMembership): boolean {
  const sourceGroups = membership.get(edge.source_id);
  const targetGroups = membership.get(edge.target_id);
  if (!sourceGroups || !targetGroups) return false;
  const smaller = sourceGroups.size <= targetGroups.size ? sourceGroups : targetGroups;
  const larger = smaller === sourceGroups ? targetGroups : sourceGroups;
  for (const group of smaller) {
    if (larger.has(group)) return true;
  }
  return false;
}

export function dependencyEdgeKey(edge: DependencyEdge): string {
  return `${edge.source_id}-${edge.target_id}`;
}

export function dependencyNodeRadius(node: DependencyNode): number {
  return 10 + Math.min(8, (node.in_degree + node.out_degree) * 1.4);
}

/** Layout and geometry depend only on the loaded graph and literal path filter. */
export function prepareDependencyGraph(graph: DependencyGraph | null, filter: string): PreparedDependencyGraph {
  const query = filter.trim().toLowerCase();
  const displayedNodes = graph?.nodes.filter((node) => !query || node.path.toLowerCase().includes(query)) ?? [];
  const nodeById = new Map(displayedNodes.map((node) => [node.id, node]));
  const displayedEdges = graph?.edges.filter((edge) => nodeById.has(edge.source_id) && nodeById.has(edge.target_id)) ?? [];
  const edgeByKey = new Map(displayedEdges.map((edge) => [dependencyEdgeKey(edge), edge]));
  const positions = new Map<number, GraphPoint>();
  const incidentEdgesByNodeId = new Map<number, DependencyEdge[]>();
  const innerCount = Math.min(12, Math.max(0, displayedNodes.length - 1));
  const renderedNodes = displayedNodes.map((node, index): RenderedDependencyNode => {
    let position: GraphPoint;
    if (index === 0) {
      position = { ...DEPENDENCY_GRAPH_CENTER };
    } else {
      const inner = index <= innerCount;
      const ringIndex = inner ? index - 1 : index - innerCount - 1;
      const ringCount = inner ? innerCount : displayedNodes.length - innerCount - 1;
      const angle = (Math.PI * 2 * ringIndex) / Math.max(1, ringCount) - Math.PI / 2;
      position = {
        x: DEPENDENCY_GRAPH_CENTER.x + Math.cos(angle) * (inner ? 190 : 350),
        y: DEPENDENCY_GRAPH_CENTER.y + Math.sin(angle) * (inner ? 145 : 215),
      };
    }
    positions.set(node.id, position);
    incidentEdgesByNodeId.set(node.id, []);
    const fileName = node.path.split("/").at(-1) ?? node.path;
    return {
      node,
      position,
      radius: dependencyNodeRadius(node),
      label: fileName.length > 20 ? `${fileName.slice(0, 18)}…` : fileName,
      index,
    };
  });
  const renderedEdges = displayedEdges.map((edge): RenderedDependencyEdge => {
    incidentEdgesByNodeId.get(edge.source_id)!.push(edge);
    if (edge.target_id !== edge.source_id) incidentEdgesByNodeId.get(edge.target_id)!.push(edge);
    const reverseExists = edgeByKey.has(`${edge.target_id}-${edge.source_id}`);
    // Reversing the endpoints also reverses the perpendicular unit vector.
    // Equal curvature signs put reciprocal dependencies on opposite sides.
    const curvature = reverseExists ? 30 : edge.source_id < edge.target_id ? 12 : -12;
    return {
      edge,
      key: dependencyEdgeKey(edge),
      geometry: dependencyEdgeGeometry(
        positions.get(edge.source_id)!,
        positions.get(edge.target_id)!,
        dependencyNodeRadius(nodeById.get(edge.source_id)!),
        dependencyNodeRadius(nodeById.get(edge.target_id)!),
        curvature,
      ),
    };
  });
  return { displayedNodes, displayedEdges, nodeById, edgeByKey, positions, renderedNodes, renderedEdges, incidentEdgesByNodeId };
}

export function dependencyEdgeGeometry(
  source: GraphPoint,
  target: GraphPoint,
  sourceRadius: number,
  targetRadius: number,
  curvature: number,
): DependencyEdgeGeometry {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return selfLoopGeometry(source, sourceRadius, targetRadius);
  const unitX = dx / Math.max(1, distance);
  const unitY = dy / Math.max(1, distance);
  const start = { x: source.x + unitX * (sourceRadius + 3), y: source.y + unitY * (sourceRadius + 3) };
  const end = { x: target.x - unitX * (targetRadius + 5), y: target.y - unitY * (targetRadius + 5) };
  const control = {
    x: (start.x + end.x) / 2 - unitY * curvature,
    y: (start.y + end.y) / 2 + unitX * curvature,
  };
  return {
    path: `M ${pointCoordinates(start)} Q ${pointCoordinates(control)} ${pointCoordinates(end)}`,
    label: {
      x: start.x * .25 + control.x * .5 + end.x * .25,
      y: start.y * .25 + control.y * .5 + end.y * .25,
    },
  };
}

function selfLoopGeometry(position: GraphPoint, sourceRadius: number, targetRadius: number): DependencyEdgeGeometry {
  const dx = DEPENDENCY_GRAPH_CENTER.x - position.x;
  const dy = DEPENDENCY_GRAPH_CENTER.y - position.y;
  const distance = Math.hypot(dx, dy);
  // Point peripheral loops inward so they remain inside the initial viewport.
  const axis = distance ? { x: dx / distance, y: dy / distance } : { x: 0, y: -1 };
  const perpendicular = { x: -axis.y, y: axis.x };
  const offset = (along: number, across: number): GraphPoint => ({
    x: position.x + axis.x * along + perpendicular.x * across,
    y: position.y + axis.y * along + perpendicular.y * across,
  });
  const startDistance = (sourceRadius + 3) / Math.SQRT2;
  const endDistance = (targetRadius + 5) / Math.SQRT2;
  const reach = Math.max(sourceRadius, targetRadius) + 38;
  const width = Math.max(sourceRadius, targetRadius) + 22;
  const start = offset(startDistance, -startDistance);
  const end = offset(endDistance, endDistance);
  const firstControl = offset(reach, -width);
  const secondControl = offset(reach, width);
  return {
    path: `M ${pointCoordinates(start)} C ${pointCoordinates(firstControl)} ${pointCoordinates(secondControl)} ${pointCoordinates(end)}`,
    label: {
      x: (start.x + 3 * firstControl.x + 3 * secondControl.x + end.x) / 8,
      y: (start.y + 3 * firstControl.y + 3 * secondControl.y + end.y) / 8,
    },
  };
}

function pointCoordinates(point: GraphPoint): string {
  return `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
}
