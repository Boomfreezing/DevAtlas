import { memo } from "react";
import { formatNumber } from "../displayFormat";
import type { QualityFinding, QualityReport } from "../types";
import type { QualityWorkspaceState } from "./useQualityReport";
import { QUALITY_PAGE_SIZE, qualityMetricSummary } from "./qualityReportModel";

const severityLabels = { error: "高风险", warning: "中风险", info: "低风险" } as const;
const scopeLabels = { production: "生产代码", test: "测试代码", generated: "生成/外部代码" } as const;

export default function QualityWorkspace({ state, paused }: { state: QualityWorkspaceState; paused: boolean }) {
  const { summary: report, response, pages, filters, count, loading, loadingMore, error, changeFilters } = state;
  if (!report) return <QualityFeedback state={state} paused={paused} />;
  const filteredTotal = response?.filtered_findings;
  return <div className="quality-view">
    <QualitySummary report={report} />
    <div className="quality-toolbar">
      <strong>问题明细</strong>
      <span>当前显示 {count} / {filteredTotal ?? "—"}{filteredTotal !== undefined && filteredTotal !== report.total_findings ? `（全部 ${report.total_findings}）` : ""}</span>
      <label>代码范围<select value={filters.scope} disabled={paused} onChange={(event) => changeFilters({ ...filters, scope: event.target.value })}><option value="all">全部范围</option><option value="production">生产代码</option><option value="test">测试代码</option><option value="generated">生成/外部代码</option></select></label>
      <label>风险等级<select value={filters.severity} disabled={paused} onChange={(event) => changeFilters({ ...filters, severity: event.target.value })}><option value="all">全部</option><option value="error">高风险</option><option value="warning">中风险</option><option value="info">低风险</option></select></label>
      <label>检测规则<select value={filters.rule} disabled={paused} onChange={(event) => changeFilters({ ...filters, rule: event.target.value })}><option value="all">全部规则</option>{report.rules.map((rule) => <option value={rule.id} key={rule.id}>{rule.title}</option>)}</select></label>
    </div>
    <section className="quality-findings" aria-busy={loading || loadingMore || paused}>
      {pages.map((findings, index) => <QualityFindingPage key={index} findings={findings} />)}
      <QualityFeedback state={state} paused={paused} />
      {response && count === 0 && !loading && !loadingMore && !error && !paused && <div className="mini-empty">当前筛选条件下没有质量问题</div>}
      {response?.has_more && !error && <div className="structure-load-more quality-load-more">
        <button type="button" disabled={paused || loading || loadingMore} onClick={() => void state.loadMore()}>
          {loadingMore ? "LOADING..." : "LOAD_NEXT"} <span>＋{Math.min(QUALITY_PAGE_SIZE, (filteredTotal ?? 0) - count)} ROWS</span>
        </button>
      </div>}
    </section>
  </div>;
}

function QualityFeedback({ state, paused }: { state: QualityWorkspaceState; paused: boolean }) {
  if (paused) return <div className="mini-empty" role="status"><div className="spinner" />等待仓库分析完成…</div>;
  if (state.loading || state.loadingMore) return <div className="mini-empty" role="status"><div className="spinner" />正在读取质量问题…</div>;
  if (state.error) return <div className="graph-focus-error" role="alert">
    <span>[ERR] {state.error.message}</span>
    <button type="button" onClick={state.retry}>{state.error.retry === "more" ? "重试加载" : "重新读取"}</button>
  </div>;
  return null;
}

// Appended pages retain their original arrays. Existing cards and the score
// header need not render again for loading indicators or later pages.
const QualityFindingPage = memo(function QualityFindingPage({ findings }: { findings: QualityFinding[] }) {
  return <>
        {findings.map((finding) => (
          <article className={`quality-finding severity-${finding.severity}`} key={finding.id}>
            <div className="finding-level"><span>{severityLabels[finding.severity]}</span><code>{finding.rule_id}</code><small>{scopeLabels[finding.scope] ?? "未分类"}</small></div>
            <div className="finding-main">
              <header><div><strong>{finding.title}</strong><span>{finding.file_path}{finding.start_line ? ` · 第 ${finding.start_line}${finding.end_line && finding.end_line !== finding.start_line ? `–${finding.end_line}` : ""} 行` : ""}</span></div><small>{qualityMetricSummary(finding)}</small></header>
              <p>{finding.description}</p>
              <div className="finding-suggestion"><b>建议</b><span>{finding.suggestion}</span></div>
            </div>
          </article>
        ))}
  </>;
});

const QualitySummary = memo(function QualitySummary({ report }: { report: QualityReport }) {
  const qualityCoverageLevel = report.scoring.coverage_level ?? "high";
  const qualityCoverageLimited = qualityCoverageLevel !== "high";
  const qualityScoreAvailable = qualityCoverageLevel !== "none" && qualityCoverageLevel !== "limited";

  return <>
      <section className="quality-hero">
        {qualityScoreAvailable ? <div
            className={`quality-score grade-${report.grade.toLowerCase()}`}
            role="meter"
            aria-label={`综合质量评分 ${report.score} 分，评级 ${report.grade}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={report.score}
          >
            <strong>{report.score}</strong><span>综合质量分</span><em>{report.grade}</em>
          </div> : <div className="quality-score quality-score-unavailable" aria-label="综合质量评分不可用，检测覆盖不足"><strong>--</strong><span>覆盖不足</span><em>N/A</em></div>}
        <div className="quality-overview"><p className="eyebrow">STATIC QUALITY REPORT</p><h3>{report.total_findings ? `发现 ${formatNumber(report.total_findings)} 项可改进问题` : qualityCoverageLimited ? "当前可执行规则未发现问题，但检测覆盖有限" : "未发现规则命中的质量问题"}</h3><span>可执行规则 {report.scoring.applicable_rule_count ?? report.rules.length} / {report.scoring.total_rule_count ?? report.rules.length} · {report.elapsed_ms.toFixed(1)} ms</span>{qualityCoverageLimited && report.scoring.coverage_message && <small className="quality-coverage-note">{report.scoring.coverage_message}</small>}</div>
        <div className="severity-summary"><div className="error"><strong>{report.severity_counts.error}</strong><span>高风险</span></div><div className="warning"><strong>{report.severity_counts.warning}</strong><span>中风险</span></div><div><strong>{report.severity_counts.info}</strong><span>低风险</span></div></div>
      </section>
      {report.scope_scores && <section className="quality-scope-scores" aria-label="分范围质量评分">
        {(["production", "test", "generated"] as const).map((scope) => {
          const summary = report.scope_scores[scope];
          const scopeScoreAvailable = qualityScoreAvailable && summary.available && summary.grade;
          const unavailableReason = !qualityScoreAvailable && summary.available ? "检测覆盖不足，暂不评级。" : summary.exclusion_reason;
          const coverageNote = summary.coverage_level === "partial" ? summary.coverage_message : undefined;
          return <article key={scope} className={scopeScoreAvailable ? `grade-${summary.grade!.toLowerCase()}` : "scope-unavailable"} title={unavailableReason ?? coverageNote ?? `${summary.label}参与综合评分`}><div><strong>{scopeScoreAvailable ? summary.score : "--"}</strong><em>{scopeScoreAvailable ? summary.grade : "N/A"}</em></div><span>{summary.label}</span>{unavailableReason && <small>{unavailableReason}</small>}</article>;
        })}
      </section>}
      <section className="quality-rules">
        {report.rules.map((rule) => <article key={rule.id}><div><strong>{rule.title}</strong><code>{rule.id}</code></div><span>{report.rule_counts[rule.id] ?? 0}</span></article>)}
      </section>
  </>;
});
