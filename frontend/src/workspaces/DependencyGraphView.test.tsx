// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DependencyEdge, DependencyGraph, DependencyNode } from "../types";
import DependencyGraphView from "./DependencyGraphView";

const node = (id: number, path: string): DependencyNode => ({ id, path, language: "Python", in_degree: 1, out_degree: 1 });
const nodes = [node(1, "src/global.py"), node(2, "src/a.py"), node(3, "src/b.py"), node(4, "src/offscreen.py"), node(5, "src/c.py"), node(6, "src/d.py")];
const edge = (source: DependencyNode, target: DependencyNode): DependencyEdge => ({
  source_id: source.id, target_id: target.id, source_path: source.path, target_path: target.path,
  import_count: 2, line_numbers: [3, 8],
});
const globalGraph: DependencyGraph = {
  total_node_count: 6, total_edge_count: 5, internal_import_count: 10,
  external_import_count: 2, unresolved_import_count: 1, classified_import_count: 12,
  classification_confidence: 92.3, confidence_level: "high", cycle_count: 2, truncated: true,
  nodes: nodes.slice(0, 3), edges: [edge(nodes[1], nodes[2]), edge(nodes[2], nodes[1])],
  cycles: [{ file_ids: [2, 3, 4], paths: nodes.slice(1, 4).map((item) => item.path) },
    { file_ids: [5, 6], paths: nodes.slice(4).map((item) => item.path) }],
};
const cycleGraph = (cycle: number): DependencyGraph => ({
  ...globalGraph, truncated: false,
  nodes: cycle === 1 ? nodes.slice(1, 4) : nodes.slice(4),
  edges: cycle === 1
    ? [edge(nodes[1], nodes[2]), edge(nodes[2], nodes[3]), edge(nodes[3], nodes[1])]
    : [edge(nodes[4], nodes[5]), edge(nodes[5], nodes[4])],
});
const focus = (index: number) => screen.getByRole("button", { name: new RegExp(`^(?:取消)?聚焦环 ${index}：`) });
const filter = () => screen.getByRole("textbox", { name: "筛选模块" });
const canvasNodes = () => document.querySelectorAll(".dependency-node");
const inspector = () => document.querySelector(".node-inspector");

function api(handler: (url: URL, options?: RequestInit) => Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => handler(new URL(String(input), "http://localhost"), options));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("loads the complete selected cycle with an abortable request and no unrelated pending graph", async () => {
  let release!: (response: Response) => void;
  let signal!: AbortSignal;
  const request = api(async (url, options) => {
    expect(url.pathname).toBe("/api/projects/7/dependency-graph");
    expect(url.searchParams.get("limit")).toBe("40");
    expect(url.searchParams.get("cycle")).toBe("1");
    signal = options!.signal!;
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  render(<DependencyGraphView projectId={7} graph={globalGraph} />);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(focus(1));
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal.aborted).toBe(false);
  expect(document.querySelector(".dependency-canvas")?.getAttribute("aria-busy")).toBe("true");
  expect(canvasNodes()).toHaveLength(0);
  expect(inspector()?.textContent).toBe("");
  expect(screen.queryByText("没有匹配的模块")).toBeNull();
  await act(async () => { release(Response.json(cycleGraph(1))); });
  expect(canvasNodes()).toHaveLength(3);
  expect(screen.getByRole("button", { name: "选择模块 src/offscreen.py" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "选择模块 src/global.py" })).toBeNull();
  expect(document.querySelector(".graph-focus-status")?.textContent).toContain("3 个节点和 3 条内部依赖边");
  expect(document.querySelector(".dependency-canvas")?.getAttribute("aria-busy")).toBe("false");
});

it.each(["success", "error"])("cancels the previous cycle and ignores its late %s after selecting another", async (outcome) => {
  let release!: (response: Response) => void;
  let signal!: AbortSignal;
  api(async (url, options) => {
    if (url.searchParams.get("cycle") === "1") {
      signal = options!.signal!;
      return new Promise<Response>((resolve) => { release = resolve; }); // A server may still finish after abort.
    }
    return Response.json(cycleGraph(2));
  });
  render(<DependencyGraphView projectId={1} graph={globalGraph} />);
  fireEvent.click(focus(1));
  fireEvent.click(focus(2));
  expect(signal.aborted).toBe(true);
  await screen.findByRole("button", { name: "选择模块 src/c.py" });
  await act(async () => {
    release(outcome === "success" ? Response.json(cycleGraph(1)) : Response.json({ detail: "过期循环读取失败" }, { status: 500 }));
  });
  expect(focus(2).getAttribute("aria-pressed")).toBe("true");
  expect(canvasNodes()).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "选择模块 src/offscreen.py" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["exit", "same-cycle"])("cancels pending focus via %s and permits a fresh read immediately", async (action) => {
  let release!: (response: Response) => void;
  let signal!: AbortSignal;
  let calls = 0;
  api(async (_url, options) => {
    calls += 1;
    if (calls > 1) return Response.json(cycleGraph(1));
    signal = options!.signal!;
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  render(<DependencyGraphView projectId={1} graph={globalGraph} />);
  fireEvent.click(focus(1));
  expect(filter()).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "放大依赖图" })).toHaveProperty("disabled", true);
  fireEvent.click(action === "exit" ? screen.getByRole("button", { name: "退出循环聚焦" }) : focus(1));
  expect(signal.aborted).toBe(true);
  expect(filter()).toHaveProperty("value", "");
  expect(screen.getByText("100%")).toBeTruthy();
  expect(canvasNodes()).toHaveLength(3);
  expect(focus(1).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(focus(1));
  await screen.findByRole("button", { name: "选择模块 src/offscreen.py" });
  await act(async () => { release(Response.json({ detail: "已取消的读取失败" }, { status: 503 })); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(focus(1).getAttribute("aria-pressed")).toBe("true");
});

it.each(["retry-button", "same-cycle"])("keeps failed focus empty and retries the same cycle through %s", async (action) => {
  const cycles: string[] = [];
  api(async (url) => {
    cycles.push(url.searchParams.get("cycle")!);
    return cycles.length === 1 ? Response.json({ detail: "循环暂时不可用" }, { status: 503 }) : Response.json(cycleGraph(1));
  });
  render(<DependencyGraphView projectId={1} graph={globalGraph} />);
  fireEvent.click(focus(1));
  await screen.findByRole("alert");
  expect(canvasNodes()).toHaveLength(0);
  expect(inspector()?.textContent).toBe("");
  expect(screen.queryByText("没有匹配的模块")).toBeNull();
  fireEvent.click(action === "retry-button" ? screen.getByRole("button", { name: "重试" }) : focus(1));
  await screen.findByRole("button", { name: "选择模块 src/offscreen.py" });
  expect(cycles).toEqual(["1", "1"]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["project", "graph", "unmount"])("aborts focus on %s replacement under StrictMode and ignores late errors", async (replacement) => {
  let release!: (response: Response) => void;
  let signal!: AbortSignal;
  api(async (_url, options) => {
    signal = options!.signal!;
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  const view = render(<StrictMode><DependencyGraphView projectId={1} graph={globalGraph} /></StrictMode>);
  fireEvent.click(focus(1));
  expect(signal.aborted).toBe(false); // The StrictMode cleanup must not poison later requests.
  if (replacement === "unmount") view.unmount();
  else view.rerender(<StrictMode><DependencyGraphView projectId={replacement === "project" ? 2 : 1} graph={replacement === "graph" ? { ...globalGraph } : globalGraph} /></StrictMode>);
  expect(signal.aborted).toBe(true);
  await act(async () => { release(Response.json({ detail: "过期项目循环失败" }, { status: 500 })); });
  expect(screen.queryByRole("alert")).toBeNull();
  if (replacement !== "unmount") {
    expect(filter()).toHaveProperty("value", "");
    expect(screen.getByText("100%")).toBeTruthy();
    expect(focus(1).getAttribute("aria-pressed")).toBe("false");
    expect(inspector()?.textContent).toContain("src/global.py");
    expect(canvasNodes()).toHaveLength(3);
  }
});

it.each(["project", "graph"])("resets a completed cycle, selection, filter and zoom when the %s changes", async (replacement) => {
  api(async () => Response.json(cycleGraph(1)));
  const view = render(<DependencyGraphView projectId={1} graph={globalGraph} />);
  fireEvent.click(focus(1));
  fireEvent.click(await screen.findByRole("button", { name: "选择模块 src/offscreen.py" }));
  fireEvent.change(filter(), { target: { value: "offscreen" } });
  fireEvent.click(screen.getByRole("button", { name: "放大依赖图" }));
  expect(inspector()?.querySelector("code")?.textContent).toBe("src/offscreen.py");
  expect(screen.getByText("125%")).toBeTruthy();
  view.rerender(<DependencyGraphView projectId={replacement === "project" ? 2 : 1} graph={replacement === "graph" ? { ...globalGraph } : globalGraph} />);
  expect(focus(1).getAttribute("aria-pressed")).toBe("false");
  expect(filter()).toHaveProperty("value", "");
  expect(screen.getByText("100%")).toBeTruthy();
  expect(inspector()?.querySelector("code")?.textContent).toBe("src/global.py");
  expect(canvasNodes()).toHaveLength(3);
});

it("separates an empty graph, isolated modules and an empty path filter", () => {
  const empty: DependencyGraph = { ...globalGraph, nodes: [], edges: [], cycles: [], total_node_count: 0, total_edge_count: 0, internal_import_count: 0, external_import_count: 0, cycle_count: 0, truncated: false };
  const view = render(<DependencyGraphView projectId={1} graph={empty} />);
  expect(screen.getByRole("heading", { name: "没有项目内依赖" })).toBeTruthy();
  expect(screen.queryByText("没有匹配的模块")).toBeNull();
  const isolated = { ...empty, nodes: [nodes[0]], total_node_count: 1 };
  view.rerender(<DependencyGraphView projectId={1} graph={isolated} />);
  expect(screen.getByRole("button", { name: "选择模块 src/global.py" })).toBeTruthy();
  expect(screen.getByText("当前显示 1 个模块 / 0 条边")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "没有项目内依赖" })).toBeNull();
  fireEvent.change(filter(), { target: { value: "no-match" } });
  expect(screen.getByText("没有匹配的模块")).toBeTruthy();
  expect(inspector()?.textContent).toBe("");
  fireEvent.change(filter(), { target: { value: "  SRC/GLOBAL  " } });
  expect(canvasNodes()).toHaveLength(1);
  expect(screen.queryByText("没有匹配的模块")).toBeNull();
});

it.each(["Enter", " "])("selects nodes and dependency details using %s and removes filtered relationships", async (key) => {
  render(<DependencyGraphView projectId={1} graph={globalGraph} />);
  const selectedNode = screen.getByRole("button", { name: "选择模块 src/b.py" });
  expect(selectedNode.getAttribute("tabindex")).toBe("0");
  fireEvent.keyDown(selectedNode, { key });
  expect(inspector()?.querySelector("code")?.textContent).toBe("src/b.py");
  const selectedEdge = screen.getByRole("button", { name: "src/a.py 导入并依赖 src/b.py，2 条导入" });
  fireEvent.keyDown(selectedEdge, { key });
  expect(inspector()?.textContent).toContain("SELECTED DEPENDENCY");
  expect(inspector()?.textContent).toContain("第 3 行、第 8 行");
  fireEvent.keyDown(selectedNode, { key });
  expect(inspector()?.textContent).toContain("SELECTED MODULE");
  fireEvent.change(filter(), { target: { value: "src/a" } });
  await waitFor(() => expect(document.querySelectorAll(".dependency-edge")).toHaveLength(0));
  expect(inspector()?.querySelector("code")?.textContent).toBe("src/a.py");
  expect(canvasNodes()).toHaveLength(1);
  fireEvent.change(filter(), { target: { value: "" } });
  expect(inspector()?.querySelector("code")?.textContent).toBe("src/global.py");
});

it("updates highlights and details across node and edge memo batch boundaries", () => {
  const manyNodes = Array.from({ length: 130 }, (_, index) => ({ id: index + 100, path: `src/module-${index}.py`, language: "Python", in_degree: 2, out_degree: 2 }));
  const manyEdges = manyNodes.flatMap((source, index) => [source, manyNodes[(index + 1) % manyNodes.length]].map((target) => ({
    source_id: source.id, target_id: target.id, source_path: source.path, target_path: target.path, import_count: 1, line_numbers: [3],
  })));
  const graph = { ...globalGraph, nodes: manyNodes, edges: manyEdges, total_node_count: 130, total_edge_count: 260,
    cycles: [{ file_ids: manyNodes.map((node) => node.id), paths: manyNodes.map((node) => node.path) }], cycle_count: 1, truncated: false };
  render(<DependencyGraphView projectId={1} graph={graph} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "选择模块 src/module-129.py" }), { key: "Enter" });
  expect(inspector()?.querySelector("code")?.textContent).toBe("src/module-129.py");
  expect(document.querySelectorAll(".dependency-node.selected")).toHaveLength(1);
  expect(document.querySelectorAll(".dependency-edge.outgoing")).toHaveLength(2);
  expect(document.querySelectorAll(".dependency-edge.incoming")).toHaveLength(2);
  expect(document.querySelector(".dependency-node.selected")?.getAttribute("aria-label")).toContain("module-129.py");
  for (const index of [66, 0]) {
    fireEvent.keyDown(screen.getByRole("button", { name: `src/module-${index}.py 导入并依赖 src/module-${index}.py，1 条导入` }), { key: "Enter" });
    expect(document.querySelectorAll(".dependency-edge.selected")).toHaveLength(1);
    expect(inspector()?.querySelector("code")?.textContent).toBe(`src/module-${index}.py`);
  }
  fireEvent.change(filter(), { target: { value: "src/module-1.py" } });
  expect(canvasNodes()).toHaveLength(1);
  expect(document.querySelectorAll(".dependency-edge.selected")).toHaveLength(0);
  fireEvent.change(filter(), { target: { value: "" } });
  expect(canvasNodes()).toHaveLength(130);
  expect(document.querySelectorAll(".dependency-edge")).toHaveLength(260);
  expect(inspector()?.querySelector("code")?.textContent).toBe("src/module-0.py");
  expect(document.querySelectorAll(".dependency-edge.outgoing")).toHaveLength(2);
});

function expectSingleTextNode(element: Element | null, text: string) {
  expect(element).not.toBeNull();
  expect(element?.textContent).toBe(text);
  expect(element?.childNodes).toHaveLength(1);
  expect(element?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
}

it("keeps SVG titles and import labels as single safe text nodes after clearing a filter", () => {
  const source = { ...node(71, "src/<img src=x onerror=alert(1)>.py"), in_degree: 12, out_degree: 34 };
  const target = node(72, 'src/<script>alert("x")</script>.py');
  const relation = { ...edge(source, target), import_count: 5, line_numbers: [1, 3, 8, 99, 1200] };
  const graph = { ...globalGraph, nodes: [source, target], edges: [relation], cycles: [], cycle_count: 0, truncated: false };
  render(<DependencyGraphView projectId={1} graph={graph} />);

  const verifyText = () => {
    const sourceNode = screen.getByRole("button", { name: `选择模块 ${source.path}` });
    const targetNode = screen.getByRole("button", { name: `选择模块 ${target.path}` });
    const edgeNode = screen.getByRole("button", { name: `${source.path} 导入并依赖 ${target.path}，5 条导入` });
    expectSingleTextNode(sourceNode.querySelector("title"), `${source.path} · 入度 12 / 出度 34`);
    expectSingleTextNode(targetNode.querySelector("title"), `${target.path} · 入度 1 / 出度 1`);
    expectSingleTextNode(edgeNode.querySelector("title"), `${source.path} → ${target.path} · 5 条导入 · 第 1、3、8、99、1200 行`);
    expectSingleTextNode(edgeNode.querySelector(".edge-label"), "×5");
    expect(document.querySelector(".dependency-canvas")?.querySelector("img, script, [onerror]")).toBeNull();
    return edgeNode;
  };

  fireEvent.keyDown(verifyText(), { key: "Enter" });
  expect(inspector()?.querySelector(".edge-lines span")?.textContent).toBe("第 1 行、第 3 行、第 8 行、第 99 行、第 1200 行");
  fireEvent.change(filter(), { target: { value: "does-not-exist" } });
  expect(screen.getByText("没有匹配的模块")).toBeTruthy();
  fireEvent.change(filter(), { target: { value: "" } });
  verifyText();
  expect(inspector()?.querySelector("code")?.textContent).toBe(source.path);
});

it("preserves cyclic edge text and an empty line list without adding text fragments", () => {
  const relation = { ...globalGraph.edges[0], import_count: 1, line_numbers: [] };
  render(<DependencyGraphView projectId={1} graph={{ ...globalGraph, edges: [relation] }} />);
  const edgeNode = screen.getByRole("button", { name: "src/a.py 导入并依赖 src/b.py，1 条导入" });
  expectSingleTextNode(edgeNode.querySelector("title"), "src/a.py → src/b.py · 1 条导入 · 第  行 · 循环依赖边");
  expectSingleTextNode(edgeNode.querySelector(".edge-label"), "×1");
  fireEvent.keyDown(edgeNode, { key: "Enter" });
  expect(inspector()?.querySelector(".edge-lines span")?.textContent).toBe("");
  expect(inspector()?.textContent).not.toContain("undefined");
});

it("keeps a complete cycle path in one safe text node through loading, retry, focus and exit", async () => {
  const cycleNodes = Array.from({ length: 32 }, (_, index) => node(index + 100, index === 0
    ? "src/<img src=x onerror=alert(1)>.py" : `src/long-module-path-${index}.py`));
  const longCycle = { file_ids: cycleNodes.map((item) => item.id), paths: cycleNodes.map((item) => item.path) };
  const focused = { ...globalGraph, nodes: cycleNodes, edges: cycleNodes.map((source, index) => edge(source, cycleNodes[(index + 1) % cycleNodes.length])), cycles: [longCycle], cycle_count: 1, truncated: false };
  const releases: Array<(response: Response) => void> = [];
  api(async () => new Promise<Response>((resolve) => { releases.push(resolve); }));
  render(<DependencyGraphView projectId={1} graph={{ ...focused, nodes: cycleNodes.slice(0, 3), edges: focused.edges.slice(0, 2), truncated: true }} />);

  const verifyCycle = (status: string, selected: boolean) => {
    const button = focus(1);
    expectSingleTextNode(button.querySelector("span"), `${longCycle.paths.join(" → ")} → ${longCycle.paths[0]}`);
    expect(button.querySelector("em")?.textContent).toBe(status);
    expect(button.getAttribute("aria-pressed")).toBe(String(selected));
    expect(button.getAttribute("aria-label")).toBe(`${selected ? "取消聚焦" : "聚焦"}环 1：${longCycle.paths.join(" 到 ")}`);
    expect(button.querySelector("img, [onerror]")).toBeNull();
  };

  verifyCycle("[ SELECT ]", false);
  fireEvent.click(focus(1));
  verifyCycle("[ LOADING ]", true);
  await act(async () => { releases[0](Response.json({ detail: "循环暂时不可用" }, { status: 503 })); });
  verifyCycle("[ RETRY ]", true);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  verifyCycle("[ LOADING ]", true);
  await act(async () => { releases[1](Response.json(focused)); });
  verifyCycle("[ FOCUSED ]", true);
  fireEvent.click(screen.getByRole("button", { name: "退出循环聚焦" }));
  verifyCycle("[ SELECT ]", false);
});
