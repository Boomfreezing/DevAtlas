from collections import defaultdict
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.analysis import ImportRelation
from app.models.project import ProjectFile
from app.services.analysis_cache import get_or_create_project_analysis


DEPENDENCY_CACHE_NAMESPACE = "dependency_graph_v1"


@dataclass(frozen=True)
class DependencyFile:
    id: int
    path: str
    language: str | None


@dataclass(frozen=True)
class DependencyGraphSnapshot:
    files: dict[int, DependencyFile]
    edge_lines: dict[tuple[int, int], tuple[int, ...]]
    participating_ids: frozenset[int]
    in_degree: dict[int, int]
    out_degree: dict[int, int]
    cycles: tuple[tuple[int, ...], ...]
    ranked_ids: tuple[int, ...]
    external_import_count: int


def load_dependency_graph(
    database: Session,
    project_id: int,
    limit: int = 40,
    cycle_index: int | None = None,
) -> dict[str, object]:
    snapshot = get_or_create_project_analysis(
        database,
        project_id,
        DEPENDENCY_CACHE_NAMESPACE,
        lambda: _build_dependency_graph_snapshot(database, project_id),
    )
    file_by_id = snapshot.files
    edge_lines = snapshot.edge_lines
    participating_ids = snapshot.participating_ids
    in_degree = snapshot.in_degree
    out_degree = snapshot.out_degree
    cycles = snapshot.cycles
    if cycle_index is not None:
        if cycle_index < 0 or cycle_index >= len(cycles):
            raise IndexError("Dependency cycle not found.")
        visible_ids = set(cycles[cycle_index])
    else:
        visible_ids = set(snapshot.ranked_ids[:limit])
    visible_files = sorted(
        (file_by_id[file_id] for file_id in visible_ids),
        key=lambda item: (-(in_degree[item.id] + out_degree[item.id]), item.path),
    )

    edges = []
    for (source_id, target_id), line_numbers in sorted(
        edge_lines.items(),
        key=lambda item: (
            file_by_id[item[0][0]].path,
            file_by_id[item[0][1]].path,
        ),
    ):
        if source_id not in visible_ids or target_id not in visible_ids:
            continue
        edges.append(
            {
                "source_id": source_id,
                "target_id": target_id,
                "source_path": file_by_id[source_id].path,
                "target_path": file_by_id[target_id].path,
                "import_count": len(line_numbers),
                "line_numbers": list(line_numbers),
            }
        )

    cycle_responses = [
        {
            "file_ids": list(cycle),
            "paths": [file_by_id[file_id].path for file_id in cycle],
        }
        for cycle in cycles[:20]
    ]
    return {
        "total_node_count": len(participating_ids),
        "total_edge_count": len(edge_lines),
        "internal_import_count": sum(map(len, edge_lines.values())),
        "external_import_count": snapshot.external_import_count,
        "cycle_count": len(cycles),
        "truncated": cycle_index is None and len(participating_ids) > len(visible_ids),
        "nodes": [
            {
                "id": item.id,
                "path": item.path,
                "language": item.language,
                "in_degree": in_degree[item.id],
                "out_degree": out_degree[item.id],
            }
            for item in visible_files
        ],
        "edges": edges,
        "cycles": cycle_responses,
    }


def _build_dependency_graph_snapshot(
    database: Session, project_id: int
) -> DependencyGraphSnapshot:
    files = list(
        database.scalars(
            select(ProjectFile)
            .where(ProjectFile.project_id == project_id)
            .order_by(ProjectFile.relative_path)
        )
    )
    file_by_id = {
        item.id: DependencyFile(item.id, item.relative_path, item.language)
        for item in files
    }
    imports = list(
        database.scalars(
            select(ImportRelation)
            .where(ImportRelation.project_id == project_id)
            .order_by(ImportRelation.file_id, ImportRelation.line_number)
        )
    )

    edge_lines: dict[tuple[int, int], list[int]] = defaultdict(list)
    external_import_count = 0
    for relation in imports:
        if relation.resolved_file_id is None or relation.resolved_file_id not in file_by_id:
            external_import_count += 1
            continue
        edge_lines[(relation.file_id, relation.resolved_file_id)].append(relation.line_number)

    participating_ids = {file_id for edge in edge_lines for file_id in edge}
    in_degree: dict[int, int] = defaultdict(int)
    out_degree: dict[int, int] = defaultdict(int)
    for source_id, target_id in edge_lines:
        out_degree[source_id] += 1
        in_degree[target_id] += 1

    cycles = find_cycles(participating_ids, set(edge_lines))
    cycle_ids = {file_id for cycle in cycles for file_id in cycle}
    ranked_ids = sorted(
        participating_ids,
        key=lambda file_id: (
            file_id not in cycle_ids,
            -(in_degree[file_id] + out_degree[file_id]),
            file_by_id[file_id].path,
        ),
    )
    return DependencyGraphSnapshot(
        files=file_by_id,
        edge_lines={edge: tuple(lines) for edge, lines in edge_lines.items()},
        participating_ids=frozenset(participating_ids),
        in_degree=dict(in_degree),
        out_degree=dict(out_degree),
        cycles=tuple(tuple(cycle) for cycle in cycles),
        ranked_ids=tuple(ranked_ids),
        external_import_count=external_import_count,
    )


def find_cycles(
    node_ids: set[int], edges: set[tuple[int, int]]
) -> list[list[int]]:
    adjacency: dict[int, list[int]] = defaultdict(list)
    for source_id, target_id in edges:
        adjacency[source_id].append(target_id)

    next_index = 0
    indexes: dict[int, int] = {}
    low_links: dict[int, int] = {}
    stack: list[int] = []
    on_stack: set[int] = set()
    components: list[list[int]] = []

    def visit(node_id: int) -> None:
        nonlocal next_index
        indexes[node_id] = next_index
        low_links[node_id] = next_index
        next_index += 1
        stack.append(node_id)
        on_stack.add(node_id)

        for target_id in adjacency[node_id]:
            if target_id not in indexes:
                visit(target_id)
                low_links[node_id] = min(low_links[node_id], low_links[target_id])
            elif target_id in on_stack:
                low_links[node_id] = min(low_links[node_id], indexes[target_id])

        if low_links[node_id] != indexes[node_id]:
            return
        component: list[int] = []
        while stack:
            member = stack.pop()
            on_stack.remove(member)
            component.append(member)
            if member == node_id:
                break
        if len(component) > 1 or (node_id, node_id) in edges:
            components.append(sorted(component))

    for node_id in sorted(node_ids):
        if node_id not in indexes:
            visit(node_id)
    return sorted(components, key=lambda component: (-len(component), component))
