import random
import sys

import pytest

from app.services.dependency_graph_service import find_cycles


@pytest.mark.parametrize("close_ring", [False, True])
def test_deep_dependencies_do_not_require_a_larger_recursion_limit(close_ring):
    limit = sys.getrecursionlimit()
    nodes = set(range(5000))
    edges = {(index, index + 1) for index in range(4999)}
    if close_ring:
        edges.add((4999, 0))
    assert find_cycles(nodes, edges) == ([sorted(nodes)] if close_ring else [])
    assert sys.getrecursionlimit() == limit


def test_disconnected_cycles_self_loops_and_cross_edges_remain_separate():
    assert find_cycles(set(range(8)), {(0, 1), (1, 0), (1, 2), (2, 3), (3, 2), (4, 4), (5, 6)}) == [[0, 1], [2, 3], [4]]
    assert find_cycles(set(), set()) == []


def test_iterative_components_match_independent_reachability_oracle():
    rng = random.Random(1709)
    nodes = set(range(10))
    for _ in range(80):
        edges = {(a, b) for a in nodes for b in nodes if rng.random() < 0.15}
        reachable = {node: {node} for node in nodes}
        for a, b in edges:
            reachable[a].add(b)
        for via in nodes:
            for source in nodes:
                if via in reachable[source]:
                    reachable[source].update(reachable[via])
        components = {tuple(sorted(b for b in nodes if b in reachable[a] and a in reachable[b])) for a in nodes}
        expected = [list(group) for group in components if len(group) > 1 or (group[0], group[0]) in edges]
        assert find_cycles(nodes, edges) == sorted(expected, key=lambda group: (-len(group), group))
