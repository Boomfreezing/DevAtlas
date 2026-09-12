// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChangeImpact, ImpactRelation, ImpactTarget } from "../types";
import ImpactWorkspace from "./ImpactWorkspace";

const target = (name: string, id = 1): ImpactTarget => ({
  target_type: "symbol", target_id: id, file_id: id, file_path: `src/${name}.py`,
  name, kind: "function", start_line: 10, end_line: 100,
});
const report = (name: string, id = 1): ChangeImpact => ({
  target: target(name, id),
  definition: { file_id: id, file_path: `src/${name}.py`, relation: "definition", confidence: "high", depth: 0,
    line_numbers: [10], symbol_id: id, symbol_name: name, symbol_kind: "function", start_line: 10, end_line: 100 },
  risk: { model: "fixture", base_score: 0, level: "low", score: 10, confidence: "medium", reasons: [], factors: [] },
  direct_callers: [], called_objects: [], dependencies: [], indirect_impacts: [], related_tests: [],
  related_apis: [], database_entities: [], cycles: [], recommendations: [], limitations: "静态引用候选，不代表运行时调用链",
});
const props = { projectId: 1, initialTarget: null, onTargetChange: vi.fn(), onOpenRelation: vi.fn() };
const input = () => screen.getByRole("textbox", { name: /选择要修改的文件/ });

function api(handler: (url: URL, options?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => handler(new URL(url, "http://localhost"), options)));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each(["success", "error"])("ignores a search's late %s after editing the query", async (outcome) => {
  let release!: (response: Response) => void;
  let signal!: AbortSignal;
  api(async (url, options) => {
    if (url.searchParams.get("q") === "old") {
      signal = options!.signal!;
      return new Promise<Response>((resolve) => { release = resolve; }); // Even servers ignoring abort must be safe.
    }
    return Response.json([target("fresh")]);
  });
  render(<ImpactWorkspace {...props} />);
  fireEvent.change(input(), { target: { value: "old" } });
  fireEvent.click(screen.getByRole("button", { name: "查找对象" }));
  await screen.findByRole("status");
  fireEvent.change(input(), { target: { value: "fresh" } });
  expect(signal.aborted).toBe(true);
  expect(screen.getByRole("button", { name: "查找对象" })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "查找对象" }));
  await screen.findByText("fresh");
  await act(async () => {
    release(outcome === "success" ? Response.json([target("obsolete")]) : Response.json({ detail: "obsolete failure" }, { status: 500 }));
  });
  expect(screen.queryByText("obsolete")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("fresh")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /fresh.*ANALYZE/ }));
  expect(props.onTargetChange).toHaveBeenCalledWith(target("fresh"));
});

it.each(["success", "error"])("ignores a previous target's late %s after switching objects", async (outcome) => {
  let release!: (response: Response) => void;
  let signal!: AbortSignal;
  api(async (url, options) => {
    if (url.searchParams.get("target_id") === "1") {
      signal = options!.signal!;
      return new Promise<Response>((resolve) => { release = resolve; });
    }
    return Response.json(report("current", 2));
  });
  const view = render(<ImpactWorkspace {...props} initialTarget={target("old")} />);
  await screen.findByRole("status");
  view.rerender(<ImpactWorkspace {...props} initialTarget={target("current", 2)} />);
  await screen.findByRole("heading", { name: "current" });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    release(outcome === "success" ? Response.json(report("obsolete")) : Response.json({ detail: "obsolete failure" }, { status: 500 }));
  });
  expect(screen.queryByRole("heading", { name: "obsolete" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(input()).toHaveProperty("value", "current");
});

it("does not show the old report under a failed new target and can search again", async () => {
  api(async (url) => {
    if (url.pathname.endsWith("/impact-targets")) return Response.json([]);
    return url.searchParams.get("target_id") === "1"
      ? Response.json(report("previous"))
      : Response.json({ detail: "new target unavailable" }, { status: 404 });
  });
  const view = render(<ImpactWorkspace {...props} initialTarget={target("previous")} />);
  await screen.findByRole("heading", { name: "previous" });
  view.rerender(<ImpactWorkspace {...props} initialTarget={target("missing", 2)} />);
  await screen.findByRole("alert");
  expect(view.container.querySelector(".impact-report")).toBeNull();
  expect(screen.queryByText("从一个具体修改对象开始")).toBeNull();
  fireEvent.change(input(), { target: { value: "no-match" } });
  fireEvent.click(screen.getByRole("button", { name: "查找对象" }));
  await screen.findByText("没有匹配的文件或符号");
  expect(screen.getByText(/未找到与“no-match”匹配的对象/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("aborts target reads on StrictMode cleanup, project change and page exit", async () => {
  const signals: AbortSignal[] = [];
  api(async (_url, options) => new Promise<Response>((_resolve, reject) => {
    const signal = options!.signal!;
    signals.push(signal);
    signal.addEventListener("abort", () => reject(new DOMException("Page changed", "AbortError")), { once: true });
  }));
  const initialTarget = target("pending");
  const view = render(<StrictMode><ImpactWorkspace {...props} initialTarget={initialTarget} /></StrictMode>);
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  view.rerender(<StrictMode><ImpactWorkspace {...props} projectId={2} initialTarget={null} /></StrictMode>);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.change(input(), { target: { value: "new-project" } });
  fireEvent.click(screen.getByRole("button", { name: "查找对象" }));
  await waitFor(() => expect(signals).toHaveLength(3));
  view.unmount();
  expect(signals[2].aborted).toBe(true);
});

it("opens the definition without changing the selected target", async () => {
  const data = report("calculate");
  api(async () => Response.json(data));
  render(<ImpactWorkspace {...props} initialTarget={data.target} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看源码" }));
  expect(props.onOpenRelation).toHaveBeenCalledWith(data.definition);
  expect(props.onTargetChange).not.toHaveBeenCalled();
});

function relationGroup(title: string): HTMLElement {
  return screen.getByText(title, { exact: true }).closest(".impact-group") as HTMLElement;
}

it("distinguishes static bindings, lexical candidates and module imports without exposing scoring variables", async () => {
  const data = report("calculate");
  const makeRelation = (relation: string, id: number, confidence: ImpactRelation["confidence"]): ImpactRelation => ({
    ...data.definition, relation, file_id: id, symbol_id: id, symbol_name: `source_${id}`,
    file_path: `src/source_${id}.py`, confidence,
  });
  data.direct_callers = [makeRelation("bound_symbol_call", 2, "high"), makeRelation("symbol_reference", 3, "low")];
  data.called_objects = [makeRelation("calls_or_references_symbol", 4, "low"), makeRelation("target_imports_module", 5, "high"),
    makeRelation("candidate_symbol_call", 7, "low")];
  data.related_tests = [{ ...makeRelation("imports_target_module", 6, "high"), file_path: "tests/test_other.py" }];
  data.risk.factors = [{ key: "test_coverage", label: "内部参考变量不应展示", actual: 1, reference: 50,
    unit: "%", contribution: 0, explanation: "内部权重说明不应展示" }];
  api(async () => Response.json(data));
  const view = render(<ImpactWorkspace {...props} initialTarget={data.target} />);
  await screen.findByRole("heading", { name: "calculate" });

  expect(within(relationGroup("直接调用者")).getByText("静态绑定调用 · 高")).toBeTruthy();
  expect(within(relationGroup("直接调用者")).getByText("文本引用候选 · 低")).toBeTruthy();
  expect(within(relationGroup("被调用对象与依赖")).getByText("调用/引用候选 · 低")).toBeTruthy();
  expect(within(relationGroup("被调用对象与依赖")).getByText("目标导入该模块 · 高")).toBeTruthy();
  expect(within(relationGroup("被调用对象与依赖")).getByText("静态调用候选 · 低")).toBeTruthy();
  expect(within(relationGroup("被调用对象与依赖")).queryByText(/静态绑定调用/)).toBeNull();
  expect(within(relationGroup("相关测试候选")).getByText("直接导入目标模块 · 高")).toBeTruthy();
  expect(screen.queryByText("相关测试", { exact: true })).toBeNull();
  expect(screen.queryByText("bound_symbol_call")).toBeNull();
  expect(view.container.querySelectorAll(".impact-group")).toHaveLength(6);
  expect(view.container.querySelector(".impact-risk strong")?.textContent).toBe("10 / 100");
  expect(screen.queryByText("内部参考变量不应展示")).toBeNull();
  expect(screen.queryByText("内部权重说明不应展示")).toBeNull();
});

it("opens a statically bound caller using that caller's file and evidence lines unchanged", async () => {
  const data = report("calculate");
  const caller: ImpactRelation = { ...data.definition, relation: "bound_symbol_call", file_id: 22,
    file_path: "src/request_handler.py", symbol_id: 33, symbol_name: "handle_request", symbol_kind: "function",
    confidence: "high", depth: 1, line_numbers: [17, 23], start_line: 10, end_line: 30 };
  data.direct_callers = [caller];
  api(async () => Response.json(data));
  render(<ImpactWorkspace {...props} initialTarget={data.target} />);
  await screen.findByRole("heading", { name: "calculate" });
  fireEvent.click(within(relationGroup("直接调用者")).getByRole("button"));
  expect(props.onOpenRelation).toHaveBeenCalledWith(caller);
  expect(props.onOpenRelation).toHaveBeenLastCalledWith(expect.objectContaining({
    file_id: 22, file_path: "src/request_handler.py", line_numbers: [17, 23], start_line: 10,
  }));
  expect(props.onTargetChange).not.toHaveBeenCalled();
});

it("passes a callee's definition fallback when no call-site lines belong to its file", async () => {
  const data = report("calculate");
  const callee: ImpactRelation = { ...data.definition, relation: "bound_symbol_call", file_id: 44,
    file_path: "src/persistence.py", symbol_id: 55, symbol_name: "save_record", symbol_kind: "function",
    confidence: "high", depth: 1, line_numbers: [], start_line: 51, end_line: 64 };
  data.called_objects = [callee];
  api(async () => Response.json(data));
  render(<ImpactWorkspace {...props} initialTarget={data.target} />);
  await screen.findByRole("heading", { name: "calculate" });
  fireEvent.click(within(relationGroup("被调用对象与依赖")).getByRole("button"));
  expect(props.onOpenRelation).toHaveBeenCalledWith(callee);
  expect(props.onOpenRelation).toHaveBeenLastCalledWith(expect.objectContaining({
    file_id: 44, file_path: "src/persistence.py", line_numbers: [], start_line: 51,
  }));
  expect(props.onTargetChange).not.toHaveBeenCalled();
});
