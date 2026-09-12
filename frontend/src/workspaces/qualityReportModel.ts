import type { QualityFinding, QualityReport } from "../types";

export const QUALITY_PAGE_SIZE = 100;
export interface QualityFilters { severity: string; rule: string; scope: string }
export const DEFAULT_QUALITY_FILTERS: QualityFilters = { severity: "all", rule: "all", scope: "all" };

export class QualityPageMismatch extends Error {
  constructor() { super("质量结果或分页信息已变化，请重新读取当前筛选，避免混合不同分析结果。"); }
}

// Compare stable report metadata, never request elapsed time or the row slice.
function reportIdentity(report: QualityReport): string {
  return JSON.stringify([report.total_findings, report.score, report.grade,
    report.scoring, report.scope_scores, report.severity_counts, report.rule_counts, report.rules]);
}

export function validateQualityPage(
  input: QualityReport, offset: number, filters: QualityFilters, previous: QualityReport | null, existingIds: ReadonlySet<string>,
): QualityReport {
  if (!input || !Array.isArray(input.findings)) throw new QualityPageMismatch();
  let page = input;
  const fields = [input.filtered_findings, input.limit, input.offset, input.has_more];
  // Older backends may return a complete unpaginated report. Accept only a
  // provably complete first page; never guess a cursor for a truncated result.
  if (fields.every((value) => value === undefined) && offset === 0 && !input.truncated
      && input.findings.length === input.total_findings && input.findings.length <= QUALITY_PAGE_SIZE) {
    page = { ...input, filtered_findings: input.total_findings, limit: QUALITY_PAGE_SIZE, offset: 0, has_more: false };
  }
  const end = offset + page.findings.length;
  if (![page.offset, page.limit, page.filtered_findings, page.total_findings].every(Number.isSafeInteger)
      || page.offset !== offset || page.limit !== QUALITY_PAGE_SIZE || page.filtered_findings < 0
      || page.total_findings < page.filtered_findings || page.findings.length > page.limit
      || end > page.filtered_findings || typeof page.has_more !== "boolean"
      || page.has_more !== (end < page.filtered_findings)
      || (page.has_more && page.findings.length === 0)
      || (previous && (previous.filtered_findings !== page.filtered_findings || reportIdentity(previous) !== reportIdentity(page)))) {
    throw new QualityPageMismatch();
  }
  const ids = new Set<string>();
  for (const finding of page.findings) {
    if (!finding || typeof finding.id !== "string" || !finding.id || ids.has(finding.id) || existingIds.has(finding.id)
        || (filters.severity !== "all" && finding.severity !== filters.severity)
        || (filters.rule !== "all" && finding.rule_id !== filters.rule)
        || (filters.scope !== "all" && finding.scope !== filters.scope)) throw new QualityPageMismatch();
    ids.add(finding.id);
  }
  return page;
}

export function qualityMetricSummary(finding: QualityFinding): string {
  if (finding.rule_id === "CIRCULAR_DEPENDENCY") {
    return `结构性风险 · 涉及 ${finding.metric} 个模块`;
  }
  if (finding.threshold <= 0) return `实际值 ${finding.metric}`;
  const exceededPercent = Math.round(((finding.metric - finding.threshold) / finding.threshold) * 100);
  return `实际 ${finding.metric} / 建议 ≤ ${finding.threshold} · 超出 ${Math.max(0, exceededPercent)}%`;
}
