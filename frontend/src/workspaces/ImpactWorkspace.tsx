import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { getChangeImpact, searchImpactTargets } from "../api";
import { useReadRequests } from "../readRequests";
import type { ChangeImpact, ImpactRelation, ImpactTarget } from "../types";

const IMPACT_RELATION_LABELS: Record<string, string> = {
  definition: "定义位置",
  imports_target_module: "直接导入目标模块",
  target_imports_module: "目标导入该模块",
  transitive_caller: "二级影响模块",
  bound_symbol_call: "静态绑定调用",
  candidate_symbol_call: "静态调用候选",
  symbol_reference: "文本引用候选",
  calls_or_references_symbol: "调用/引用候选",
};

export default function ImpactWorkspace({
  projectId,
  initialTarget,
  onOpenRelation,
  onTargetChange,
}: {
  projectId: number;
  initialTarget: ImpactTarget | null;
  onTargetChange: (target: ImpactTarget) => void;
  onOpenRelation: (relation: ImpactRelation) => void;
}) {
  const [query, setQuery] = useState(initialTarget?.name ?? "");
  const [targets, setTargets] = useState<ImpactTarget[]>([]);
  const [report, setReport] = useState<ChangeImpact | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchedQuery, setSearchedQuery] = useState<string | null>(null);
  const requests = useReadRequests();

  useEffect(() => {
    requests.cancelAll();
    setTargets([]);
    setReport(null);
    setError(null);
    setSearchedQuery(null);
    setSearching(false);
    setLoading(!!initialTarget);
    if (!initialTarget) return;

    setQuery(initialTarget.name);
    const request = requests.begin("impact");
    void getChangeImpact(projectId, initialTarget.target_type, initialTarget.target_id, request.signal)
      .then((result) => { if (request.isCurrent()) setReport(result); })
      .catch((requestError: unknown) => {
        if (request.isCurrent()) setError(requestError instanceof Error ? requestError.message : "耦合分析失败");
      })
      .finally(() => {
        if (request.isCurrent()) setLoading(false);
        request.finish();
      });
    return () => requests.cancelAll();
  }, [initialTarget, projectId, requests]);

  function changeQuery(value: string) {
    requests.cancelAll();
    setQuery(value);
    setTargets([]);
    setReport(null);
    setError(null);
    setSearchedQuery(null);
    setSearching(false);
    setLoading(false);
  }

  async function handleTargetSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = query.trim();
    if (!text || searching || loading) return;
    requests.cancelAll();
    const request = requests.begin("search");
    setSearching(true);
    setError(null);
    setReport(null);
    setTargets([]);
    setSearchedQuery(null);
    try {
      const result = await searchImpactTargets(projectId, text, 20, request.signal);
      if (!request.isCurrent()) return;
      setTargets(result);
      setSearchedQuery(text);
    } catch (requestError) {
      if (request.isCurrent()) setError(requestError instanceof Error ? requestError.message : "无法搜索分析对象");
    } finally {
      if (request.isCurrent()) setSearching(false);
      request.finish();
    }
  }

  return (
    <div className="impact-workspace">
      <form className="impact-search" onSubmit={(event) => void handleTargetSearch(event)}>
        <label htmlFor="impact-target-query"><span>TARGET</span>选择要修改的文件、类或函数</label>
        <div>
          <input id="impact-target-query" value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="输入文件路径、类名或函数名" />
          <button disabled={!query.trim() || searching || loading}>{searching ? "SEARCHING..." : "查找对象"}</button>
        </div>
      </form>
      {error && <div className="impact-error" role="alert">[ERR] {error}</div>}
      {searching && <div className="mini-empty" role="status"><div className="spinner" />正在查找文件和符号…</div>}
      {!searching && targets.length > 0 && (
        <div className="impact-target-list" aria-label="影响分析对象">
          {targets.map((target) => (
            <button type="button" key={`${target.target_type}:${target.target_id}`} onClick={() => onTargetChange(target)}>
              <span className={`kind-badge kind-${target.kind}`}>{target.target_type === "file" ? "FI" : target.kind.slice(0, 2).toUpperCase()}</span>
              <div><strong>{target.name}</strong><small>{target.file_path} · 第 {target.start_line}–{target.end_line} 行</small></div>
              <em>ANALYZE →</em>
            </button>
          ))}
        </div>
      )}
      {!searching && !loading && !report && !error && targets.length === 0 && (
        <div className="impact-empty">
          <span>◎</span>
          <h3>{searchedQuery ? "没有匹配的文件或符号" : "从一个具体修改对象开始"}</h3>
          <p>{searchedQuery ? `未找到与“${searchedQuery}”匹配的对象，请尝试更短的名称或文件路径。` : "搜索文件、类、接口、函数或方法，或者在“仓库概览”的文件和符号列表中点击“影响”。"}</p>
        </div>
      )}
      {loading && <div className="mini-empty" role="status"><div className="spinner" />正在追踪调用者、依赖和相关测试…</div>}
      {report && !loading && (
        <div className="impact-report">
          <header className="impact-report-header">
            <div>
              <span>IMPACT_TARGET::{report.target.target_type.toUpperCase()}</span>
              <h3>{report.target.name}</h3>
              <p>{report.target.file_path} · 第 {report.target.start_line}–{report.target.end_line} 行</p>
            </div>
            <div className={`impact-risk impact-risk-${report.risk.level}`}>
              <strong>{report.risk.score}<i> / 100</i></strong>
              <span>{impactRiskLabel(report.risk.level)} · {impactConfidenceLabel(report.risk.confidence)}置信</span>
            </div>
          </header>
          <section className="impact-definition">
            <div><span>DEFINITION</span><strong>{report.definition.symbol_name ?? report.definition.file_path}</strong><small>{report.definition.file_path}</small></div>
            <button type="button" onClick={() => onOpenRelation(report.definition)}>查看源码</button>
          </section>
          <div className="impact-risk-reasons">
            {report.risk.reasons.map((reason) => <span key={reason}><b>{reason}</b></span>)}
          </div>
          <div className="impact-grid">
            <ImpactRelationGroup title="直接调用者" code="CALLERS" items={report.direct_callers} onOpen={onOpenRelation} />
            <ImpactRelationGroup title="被调用对象与依赖" code="CALLEES" items={report.called_objects} onOpen={onOpenRelation} />
            <ImpactRelationGroup title="间接影响模块" code="TRANSITIVE" items={report.indirect_impacts} onOpen={onOpenRelation} />
            <ImpactRelationGroup title="相关测试候选" code="TESTS" items={report.related_tests} onOpen={onOpenRelation} />
            <ImpactRelationGroup title="相关接口" code="APIS" items={report.related_apis} onOpen={onOpenRelation} />
            <ImpactRelationGroup title="数据库实体" code="DATABASE" items={report.database_entities} onOpen={onOpenRelation} />
          </div>
          <section className="impact-cycles">
            <header><span>CYCLES</span><strong>循环依赖</strong><em>{report.cycles.length}</em></header>
            {report.cycles.length === 0
              ? <p>目标不在已识别的循环依赖中。</p>
              : report.cycles.map((cycle, index) => <p key={`${index}:${cycle.paths.join(":")}`}>{cycle.paths.join(" → ")} → {cycle.paths[0]}</p>)}
          </section>
          <p className="impact-limit">{report.limitations}</p>
        </div>
      )}
    </div>
  );
}

function ImpactRelationGroup({ title, code, items, onOpen }: { title: string; code: string; items: ImpactRelation[]; onOpen: (relation: ImpactRelation) => void }) {
  return (
    <section className="impact-group">
      <header><span>{code}</span><strong>{title}</strong><em>{items.length}</em></header>
      {items.length === 0 ? <p>未发现</p> : items.map((item) => (
        <button type="button" key={`${item.relation}:${item.file_id}:${item.symbol_id ?? 0}`} onClick={() => onOpen(item)}>
          <div><strong>{item.symbol_name ?? item.file_path}</strong><small>{item.file_path}</small></div>
          <span>{IMPACT_RELATION_LABELS[item.relation] ?? item.relation} · {impactConfidenceLabel(item.confidence)}</span>
        </button>
      ))}
    </section>
  );
}

function impactRiskLabel(level: ChangeImpact["risk"]["level"]): string {
  return level === "high" ? "高风险" : level === "medium" ? "中风险" : "低风险";
}

function impactConfidenceLabel(confidence: ImpactRelation["confidence"]): string {
  return confidence === "high" ? "高" : confidence === "medium" ? "中" : "低";
}
