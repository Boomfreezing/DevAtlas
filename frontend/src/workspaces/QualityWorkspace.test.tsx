// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { QualityFinding, QualityReport } from "../types";
import QualityWorkspace from "./QualityWorkspace";
import { qualityMetricSummary } from "./qualityReportModel";
import type { QualityWorkspaceState } from "./useQualityReport";

vi.mock("./qualityReportModel", async (original) => {
  const actual = await original<typeof import("./qualityReportModel")>();
  return { ...actual, qualityMetricSummary: vi.fn(actual.qualityMetricSummary) };
});

const finding = (id: number): QualityFinding => ({
  id: `risk-${id}`, rule_id: "LONG_FUNCTION", severity: "warning", scope: "production", title: `Risk ${id}`,
  description: "Function has 100 lines", suggestion: "Extract helpers", file_id: id, file_path: `src/file-${id}.ts`,
  start_line: 1, end_line: 100, metric: 100, threshold: 80,
});
const firstPage = [finding(1), finding(2)];
const size = { file_count: 4, code_line_count: 400, symbol_count: 4 };
const weights = { production: .7, test: .2, generated: .1 };
const severity = { error: 0, warning: 4, info: 0 };
const scopeScore = (scope: QualityFinding["scope"]) => ({
  scope, label: scope, score: scope === "production" ? 82 : null, grade: scope === "production" ? "B" : null,
  available: scope === "production", configured_weight: weights[scope], effective_weight: scope === "production" ? 1 : 0,
  exclusion_reason: null, finding_count: scope === "production" ? 4 : 0, severity_counts: severity, project_size: size,
});
const report: QualityReport = {
  score: 82, grade: "B", score_scope: "composite",
  scoring: { model: "composite_v3", size_factor: 1, scale_units: 1, project_size: size, reference_size: size,
    base_weights: severity, effective_weights: severity, base_penalty: 18, adjusted_penalty: 18, rule_penalties: { LONG_FUNCTION: 18 },
    scope_weights: weights, effective_scope_weights: { production: 1, test: 0, generated: 0 }, excluded_scopes: ["test", "generated"],
    source_file_count: 4, parser_supported_file_count: 4, parser_coverage: 100, coverage_message: "", explanation: "",
    coverage_level: "high", applicable_rule_count: 6, total_rule_count: 6 },
  scope_scores: { production: scopeScore("production"), test: scopeScore("test"), generated: scopeScore("generated") },
  total_findings: 4, filtered_findings: 4, limit: 100, offset: 0, has_more: true, truncated: true, elapsed_ms: 2,
  rules: [{ id: "LONG_FUNCTION", title: "Long function", description: "Hidden description", default_severity: "warning" }],
  severity_counts: { error: 0, warning: 4, info: 0 }, rule_counts: { LONG_FUNCTION: 4 }, findings: firstPage,
};
const initial = (): QualityWorkspaceState => ({
  summary: report, response: report, pages: [firstPage], count: 2,
  filters: { severity: "all", rule: "all", scope: "all" }, loading: false, loadingMore: false, error: null,
  retry: vi.fn(), changeFilters: vi.fn(), loadMore: vi.fn(), invalidate: vi.fn(),
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("reuses existing finding pages during loading and appends without rendering earlier cards again", () => {
  const state = initial();
  const view = render(<QualityWorkspace state={state} paused={false} />);
  const firstCard = document.querySelector(".quality-finding");
  expect(qualityMetricSummary).toHaveBeenCalledTimes(2);
  view.rerender(<QualityWorkspace state={{ ...state, loadingMore: true }} paused={false} />);
  expect(qualityMetricSummary).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status").textContent).toContain("正在读取质量问题");
  const more = [finding(3), finding(4)];
  view.rerender(<QualityWorkspace state={{ ...state, count: 4, pages: [...state.pages, more], response: { ...report, findings: more, offset: 2, has_more: false } }} paused={false} />);
  expect(qualityMetricSummary).toHaveBeenCalledTimes(4);
  expect(document.querySelector(".quality-finding")).toBe(firstCard);
  expect(document.querySelectorAll(".quality-finding")).toHaveLength(4);
  expect(screen.queryByRole("button", { name: /LOAD_NEXT/ })).toBeNull();
  expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("82");
});

it("does not display old rows or a false empty-state message after a failed filter", () => {
  const state: QualityWorkspaceState = { ...initial(), response: null, pages: [], count: 0,
    filters: { severity: "error", scope: "all", rule: "all" }, error: { message: "筛选暂时失败", retry: "first" } };
  render(<QualityWorkspace state={state} paused={false} />);
  expect(screen.getByLabelText("风险等级")).toHaveProperty("value", "error");
  expect(screen.queryByText("Risk 1")).toBeNull();
  expect(screen.queryByText("当前筛选条件下没有质量问题")).toBeNull();
  expect(document.querySelector(".quality-toolbar")?.textContent).toContain("当前显示 0 / —");
  expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("82");
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  expect(state.retry).toHaveBeenCalledOnce();
});

it("keeps valid rows during a failed append and exposes only the matching retry", () => {
  const state: QualityWorkspaceState = { ...initial(), error: { message: "读取下一页失败", retry: "more" } };
  render(<QualityWorkspace state={state} paused={false} />);
  expect(document.querySelectorAll(".quality-finding")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /LOAD_NEXT/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  expect(state.retry).toHaveBeenCalledOnce();
});

it("preserves unavailable scores and hidden explanations while allowing new filters during reads", () => {
  const unavailable = { ...report, scoring: { ...report.scoring, coverage_level: "limited" as const, coverage_message: "检测覆盖不足" } };
  const state = { ...initial(), summary: unavailable, loading: true };
  const view = render(<QualityWorkspace state={state} paused={false} />);
  expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.getAllByText("N/A")).toHaveLength(4);
  expect(screen.queryByText("Hidden description")).toBeNull();
  expect(screen.getByLabelText("代码范围")).toHaveProperty("disabled", false);
  fireEvent.change(screen.getByLabelText("代码范围"), { target: { value: "test" } });
  expect(state.changeFilters).toHaveBeenCalledWith({ severity: "all", rule: "all", scope: "test" });
  view.rerender(<QualityWorkspace state={state} paused />);
  expect(screen.getByLabelText("代码范围")).toHaveProperty("disabled", true);
  expect(screen.getByRole("status").textContent).toContain("等待仓库分析完成");
});

it("does not show a score for a wholly unparsed scope even when the overall coverage is partial", () => {
  const partial: QualityReport = { ...report,
    scoring: { ...report.scoring, coverage_model: "recorded_parse_outcomes_v2", parser_analyzed_file_count: 1,
      parser_issue_file_count: 3, parser_coverage: .25, coverage_level: "partial", coverage_message: "只有部分源码有可用解析依据" },
    scope_scores: { ...report.scope_scores,
      production: { ...report.scope_scores.production, coverage_level: "partial", coverage_message: "生产代码存在解析失败" },
      test: { ...report.scope_scores.test, label: "测试代码", score: null, grade: null, available: false,
        coverage_level: "limited", exclusion_reason: "没有可用的结构解析依据，暂不评级且不参与综合评分。" } },
  };
  render(<QualityWorkspace state={{ ...initial(), summary: partial }} paused={false} />);
  expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("82");
  expect(screen.getByText("只有部分源码有可用解析依据")).toBeTruthy();
  expect(screen.getByText("测试代码", { selector: "span" }).closest("article")?.textContent).toContain("--N/A");
  expect(screen.getByText("测试代码", { selector: "span" }).closest("article")?.textContent).not.toContain("100");
  expect(screen.getByTitle("生产代码存在解析失败")).toBeTruthy();
  expect(screen.queryByText(/权重/)).toBeNull();
});
