from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.analysis import ImportRelation
from app.models.project import ProjectFile


def load_dependency_graph(
    database: Session, project_id: int, limit: int = 40
) -> dict[str, object]:
    files = list(
        database.scalars(
            select(ProjectFile)
            .where(ProjectFile.project_id == project_id)
            .order_by(ProjectFile.relative_path)
        )
    )
    file_by_id = {item.id: item for item in files}
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
            file_by_id[file_id].relative_path,
        ),
    )
    visible_ids = set(ranked_ids[:limit])
    visible_files = sorted(
        (file_by_id[file_id] for file_id in visible_ids),
        key=lambda item: (-(in_degree[item.id] + out_degree[item.id]), item.relative_path),
    )

    edges = []
    for (source_id, target_id), line_numbers in sorted(
        edge_lines.items(),
        key=lambda item: (
            file_by_id[item[0][0]].relative_path,
            file_by_id[item[0][1]].relative_path,
        ),
    ):
        if source_id not in visible_ids or target_id not in visible_ids:
            continue
        edges.append(
            {
                "source_id": source_id,
                "target_id": target_id,
                "source_path": file_by_id[source_id].relative_path,
                "target_path": file_by_id[target_id].relative_path,
                "import_count": len(line_numbers),
                "line_numbers": line_numbers,
            }
        )

    cycle_responses = [
        {
            "file_ids": cycle,
            "paths": [file_by_id[file_id].relative_path for file_id in cycle],
        }
        for cycle in cycles[:20]
    ]
    return {
        "total_node_count": len(participating_ids),
        "total_edge_count": len(edge_lines),
        "internal_import_count": sum(map(len, edge_lines.values())),
        "external_import_count": external_import_count,
        "cycle_count": len(cycles),
        "truncated": len(participating_ids) > len(visible_ids),
        "nodes": [
            {
                "id": item.id,
                "path": item.relative_path,
                "language": item.language,
                "in_degree": in_degree[item.id],
                "out_degree": out_degree[item.id],
            }
            for item in visible_files
        ],
        "edges": edges,
        "cycles": cycle_responses,
    }


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
