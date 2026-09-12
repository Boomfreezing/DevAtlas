import { useCallback, useEffect, useRef, useState } from "react";
import { compareAnalysisSnapshots, compareProjectGitCommits, createAnalysisSnapshot, deleteAnalysisSnapshot, getProjectGitSummary, listAnalysisSnapshots } from "../api";
import type { AnalysisSnapshotComparison, AnalysisSnapshotSummary, GitComparison, ProjectGitSummary, SnapshotComparisonGroup } from "../types";
import { formatDate, formatNumber, stageLabel } from "../displayFormat";
import { useReadRequests } from "../readRequests";
import type { ProjectSynchronizationState } from "./useProjectSynchronization";

export default function SnapshotWorkspace({ projectId, synchronization, onSynchronize }: { projectId: number; synchronization: ProjectSynchronizationState; onSynchronize: () => void }) {
  const [snapshots, setSnapshots] = useState<AnalysisSnapshotSummary[]>([]);
  const [gitSummary, setGitSummary] = useState<ProjectGitSummary | null>(null);
  const [label, setLabel] = useState("");
  const [baseId, setBaseId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [comparison, setComparison] = useState<AnalysisSnapshotComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [gitLoading, setGitLoading] = useState(true);
  const [gitError, setGitError] = useState<string | null>(null);
  const { busy: syncing, job: syncJob, message: syncMessage, error: syncError } = synchronization;
  const lastCompletionRef = useRef(synchronization.completion);
  const [baseCommit, setBaseCommit] = useState("");
  const [headCommit, setHeadCommit] = useState("");
  const [gitComparison, setGitComparison] = useState<GitComparison | null>(null);
  const [gitComparing, setGitComparing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reads = useReadRequests();
  const activeRef = useRef(true);
  const comparisonKeyRef = useRef("");
  const gitComparisonKeyRef = useRef("");
  comparisonKeyRef.current = `${projectId}/${baseId}/${targetId}`;
  gitComparisonKeyRef.current = `${projectId}/${baseCommit}/${headCommit}`;

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  useEffect(() => {
    if (reads.cancel("comparison")) setWorking(false);
    setComparison(null);
  }, [baseId, targetId, reads]);
  useEffect(() => {
    if (reads.cancel("git-comparison")) setGitComparing(false);
    setGitComparison(null);
  }, [baseCommit, headCommit, reads]);

  const applySnapshots = useCallback((items: AnalysisSnapshotSummary[]) => {
    setSnapshots(items);
    setTargetId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null);
    setBaseId((current) => current && items.some((item) => item.id === current) ? current : items[1]?.id ?? null);
  }, []);

  const loadSnapshots = useCallback(async () => {
    const request = reads.begin("snapshots");
    setLoading(true);
    setError(null);
    try {
      const items = await listAnalysisSnapshots(projectId, request.signal);
      if (request.isCurrent()) applySnapshots(items);
    } catch (requestError) {
      if (request.isCurrent()) setError(requestError instanceof Error ? requestError.message : "无法加载分析快照");
    } finally {
      if (request.isCurrent()) { setLoading(false); request.finish(); }
    }
  }, [projectId, applySnapshots, reads]);

  const loadGitSummary = useCallback(async () => {
    const request = reads.begin("git-summary");
    setGitLoading(true);
    setGitError(null);
    try {
      const summary = await getProjectGitSummary(projectId, request.signal);
      if (request.isCurrent()) setGitSummary(summary);
    } catch (requestError) {
      if (request.isCurrent()) setGitError(requestError instanceof Error ? requestError.message : "无法加载 Git 提交信息");
    } finally {
      if (request.isCurrent()) { setGitLoading(false); request.finish(); }
    }
  }, [projectId, reads]);

  useEffect(() => {
    void loadSnapshots();
    return () => { reads.cancel("snapshots"); };
  }, [loadSnapshots, reads]);

  useEffect(() => {
    void loadGitSummary();
    return () => { reads.cancel("git-summary"); };
  }, [loadGitSummary, reads]);

  useEffect(() => {
    const commits = gitSummary?.recent_commits ?? [];
    if (commits.length < 2) {
      setBaseCommit("");
      setHeadCommit(commits[0]?.sha ?? "");
      setGitComparison(null);
      return;
    }
    setHeadCommit((current) => commits.some((item) => item.sha === current) ? current : commits[0].sha);
    setBaseCommit((current) => commits.some((item) => item.sha === current) ? current : commits[1].sha);
    setGitComparison(null);
  }, [gitSummary]);

  useEffect(() => {
    if (lastCompletionRef.current === synchronization.completion) return;
    lastCompletionRef.current = synchronization.completion;
    reads.cancel("comparison");
    reads.cancel("git-comparison");
    setWorking(false);
    setGitComparing(false);
    setComparison(null);
    setGitComparison(null);
    void loadGitSummary();
    void loadSnapshots();
  }, [synchronization.completion, loadGitSummary, loadSnapshots, reads]);

  async function handleCompareGit() {
    if (!baseCommit || !headCommit || baseCommit === headCommit || gitComparing) return;
    setGitComparing(true);
    setGitError(null);
    setGitComparison(null);
    const requestKey = gitComparisonKeyRef.current;
    const request = reads.begin("git-comparison");
    try {
      const result = await compareProjectGitCommits(projectId, baseCommit, headCommit, request.signal);
      if (request.isCurrent() && gitComparisonKeyRef.current === requestKey) setGitComparison(result);
    } catch (requestError) {
      if (request.isCurrent() && gitComparisonKeyRef.current === requestKey) setGitError(requestError instanceof Error ? requestError.message : "无法对比 Git 提交");
    } finally {
      if (request.isCurrent()) { setGitComparing(false); request.finish(); }
    }
  }

  async function handleCreate() {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await createAnalysisSnapshot(projectId, label);
      if (!activeRef.current) return;
      await loadSnapshots();
      if (!activeRef.current) return;
      setLabel("");
      setComparison(null);
    } catch (requestError) {
      if (activeRef.current) setError(requestError instanceof Error ? requestError.message : "无法保存分析快照");
    } finally {
      if (activeRef.current) setWorking(false);
    }
  }

  async function handleCompare() {
    if (!baseId || !targetId || baseId === targetId || working) return;
    setWorking(true);
    setError(null);
    setComparison(null);
    const requestKey = comparisonKeyRef.current;
    const request = reads.begin("comparison");
    try {
      const result = await compareAnalysisSnapshots(projectId, baseId, targetId, request.signal);
      if (request.isCurrent() && comparisonKeyRef.current === requestKey) setComparison(result);
    } catch (requestError) {
      if (request.isCurrent() && comparisonKeyRef.current === requestKey) setError(requestError instanceof Error ? requestError.message : "无法对比分析快照");
    } finally {
      if (request.isCurrent()) { setWorking(false); request.finish(); }
    }
  }

  async function handleDelete(snapshot: AnalysisSnapshotSummary) {
    if (!window.confirm(`删除快照“${snapshot.label}”？此操作不会删除项目源码。`)) return;
    setWorking(true);
    setError(null);
    try {
      await deleteAnalysisSnapshot(projectId, snapshot.id);
      if (!activeRef.current) return;
      applySnapshots(snapshots.filter((item) => item.id !== snapshot.id));
      setComparison(null);
    } catch (requestError) {
      if (activeRef.current) setError(requestError instanceof Error ? requestError.message : "无法删除分析快照");
    } finally {
      if (activeRef.current) setWorking(false);
    }
  }

  return (
    <div className="snapshot-workspace">
      <section className="snapshot-git-context" aria-label="GitHub 版本同步与对比">
        <header>
          <div><span>GITHUB_SYNC</span><strong>GitHub 版本同步与对比</strong><small>检查远端最新提交；有更新时安全更新本地源码、重新分析并保存快照。</small></div>
          {gitSummary?.refreshable && <button type="button" onClick={onSynchronize} disabled={syncing}>{syncing ? "正在同步…" : synchronization.retry === "poll" ? "重试读取进度" : synchronization.retry === "refresh" ? "重试刷新" : "同步远程仓库"}</button>}
        </header>
        {gitError && <div className="snapshot-git-message error">[ERR] {gitError}</div>}
        {syncError && <div className="snapshot-git-message error" role="alert">[ERR] {syncError}</div>}
        {syncing && syncJob && <div className="snapshot-sync-progress"><div><strong>{stageLabel(syncJob.stage)}</strong><span>{syncJob.message}</span></div><small>{syncJob.progress}%</small><div className="progress-track"><i style={{ width: `${syncJob.progress}%` }} /></div></div>}
        {!syncing && syncMessage && <div className="snapshot-git-message success">[OK] {syncMessage}</div>}
        {gitLoading && <div className="snapshot-git-message"><div className="spinner" />正在读取 Git 提交信息…</div>}
        {!gitLoading && !gitError && !syncError && !syncing && gitSummary && !gitSummary.available && <div className="snapshot-git-message">{gitSummary.refreshable ? "尚未同步 GitHub 提交与源码版本，点击右上角“同步远程仓库”开始检查。" : gitSummary.message}</div>}
        {!gitLoading && gitSummary?.available && (<>
          <div className="snapshot-git-body">
            <dl>
              <div><dt>仓库</dt><dd>{gitSummary.repository_url ? <a href={gitSummary.repository_url} target="_blank" rel="noreferrer">{gitSummary.repository_url.replace(/^https?:\/\//, "")}</a> : "—"}</dd></div>
              <div><dt>默认分支</dt><dd>{gitSummary.default_branch ?? "—"}</dd></div>
              <div><dt>HEAD</dt><dd><code title={gitSummary.head_commit ?? undefined}>{gitSummary.head_commit?.slice(0, 8) ?? "—"}</code></dd></div>
              <div><dt>更新时间</dt><dd>{gitSummary.fetched_at ? formatDate(gitSummary.fetched_at) : "—"}</dd></div>
            </dl>
            <div className="snapshot-git-commits">
              <span>RECENT_COMMITS</span>
              {gitSummary.recent_commits.length === 0 ? <p>GitHub 未返回最近提交记录。</p> : gitSummary.recent_commits.slice(0, 5).map((commit) => <article key={commit.sha}><code>{commit.sha.slice(0, 8)}</code><div><strong>{commit.message}</strong><small>{commit.author || "未知作者"} · {formatDate(commit.authored_at)}</small></div></article>)}
            </div>
          </div>
          {gitSummary.recent_commits.length >= 2 && <div className="snapshot-git-compare">
            <div className="snapshot-git-compare-controls">
              <label><span>BASE</span><select aria-label="Git 对比基准提交" value={baseCommit} onChange={(event) => setBaseCommit(event.target.value)}>{gitSummary.recent_commits.map((commit) => <option key={commit.sha} value={commit.sha}>{commit.sha.slice(0, 8)} · {commit.message}</option>)}</select></label>
              <i>→</i>
              <label><span>TARGET</span><select aria-label="Git 对比目标提交" value={headCommit} onChange={(event) => setHeadCommit(event.target.value)}>{gitSummary.recent_commits.map((commit) => <option key={commit.sha} value={commit.sha}>{commit.sha.slice(0, 8)} · {commit.message}</option>)}</select></label>
              <button type="button" onClick={() => void handleCompareGit()} disabled={!baseCommit || !headCommit || baseCommit === headCommit || gitComparing}>{gitComparing ? "正在对比…" : "对比提交"}</button>
            </div>
            {baseCommit === headCommit && <p className="snapshot-git-compare-hint">请选择两个不同提交。</p>}
            {gitComparison && <div className="snapshot-git-diff">
              <header><span>REMOTE_DIFF</span><strong>{gitComparison.total_commits} 个提交 · {gitComparison.changed_files} 个变更文件</strong><small>+{formatNumber(gitComparison.additions)} / −{formatNumber(gitComparison.deletions)} 行 · GitHub 远端对比，不代表本地源码已更新</small></header>
              <div>{gitComparison.files.map((file) => <article key={file.path}><span className={`git-file-status ${file.status}`}>{gitFileStatusLabel(file.status)}</span><code title={file.path}>{file.path}</code><b>+{formatNumber(file.additions)}</b><em>−{formatNumber(file.deletions)}</em></article>)}</div>
              {gitComparison.truncated && <footer>文件较多，当前仅显示变化量最高的前 100 个文件。</footer>}
            </div>}
          </div>}
        </>)}
      </section>
      <section className="snapshot-toolbar">
        <div><span>CAPTURE</span><strong>保存当前分析状态</strong><small>仅保存指标与问题定位，不复制仓库源码 · 每个项目最多保留 30 个</small></div>
        <div><input value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder="快照名称（可选）" aria-label="快照名称" /><button type="button" onClick={() => void handleCreate()} disabled={working}>{working ? "处理中…" : "＋ 保存当前快照"}</button></div>
      </section>
      {error && <div className="impact-error" role="alert">[ERR] {error}</div>}
      {loading && <div className="mini-empty"><div className="spinner" />正在读取分析快照…</div>}
      {!loading && snapshots.length === 0 && <div className="impact-empty"><span>◫</span><h3>还没有分析快照</h3><p>保存当前状态后，再次分析仓库即可对比质量问题、解析结果和依赖变化。</p></div>}
      {!loading && snapshots.length > 0 && (
        <>
          <section className="snapshot-compare-controls">
            <label><span>BASE</span><select value={baseId ?? ""} onChange={(event) => setBaseId(Number(event.target.value) || null)}><option value="">选择较早快照</option>{snapshots.map((item) => <option key={item.id} value={item.id}>{item.label} · {formatDate(item.created_at)}</option>)}</select></label>
            <span>→</span>
            <label><span>TARGET</span><select value={targetId ?? ""} onChange={(event) => setTargetId(Number(event.target.value) || null)}><option value="">选择较新快照</option>{snapshots.map((item) => <option key={item.id} value={item.id}>{item.label} · {formatDate(item.created_at)}</option>)}</select></label>
            <button type="button" onClick={() => void handleCompare()} disabled={!baseId || !targetId || baseId === targetId || working}>{working ? "COMPARING..." : "开始对比"}</button>
          </section>
          <section className="snapshot-history">
            <header><div><span>SNAPSHOT_HISTORY</span><strong>快照记录</strong></div><em>{snapshots.length} 条</em></header>
            <div className="snapshot-list">
              {snapshots.map((snapshot) => <article key={snapshot.id}>
                <div><span>{snapshotReasonLabel(snapshot.reason)}</span><strong>{snapshot.label}</strong><small>{formatDate(snapshot.created_at)}</small></div>
                <dl><div><dt>质量</dt><dd title={snapshot.score_available === false ? "检测覆盖不足，暂不评级" : snapshot.score_available == null ? "历史记录的解析覆盖口径未知" : undefined}>{snapshot.score_available === false ? "N/A" : `${snapshot.score} / ${snapshot.grade}`}</dd></div><div><dt>文件</dt><dd>{formatNumber(snapshot.file_count)}</dd></div><div><dt>符号</dt><dd>{formatNumber(snapshot.symbol_count)}</dd></div><div><dt>问题</dt><dd>{formatNumber(snapshot.finding_count)}</dd></div></dl>
                <button type="button" onClick={() => void handleDelete(snapshot)} disabled={working} aria-label={`删除快照 ${snapshot.label}`}>×</button>
              </article>)}
            </div>
          </section>
        </>
      )}
      {comparison && <SnapshotComparisonView comparison={comparison} />}
    </div>
  );
}

function SnapshotComparisonView({ comparison }: { comparison: AnalysisSnapshotComparison }) {
  const comparable = comparison.comparable === true;
  const warnings = comparison.comparison_warnings?.length ? comparison.comparison_warnings : comparable ? [] : ["分析口径未知，仅展示观测差异，不判断质量提升或问题已修复。"];
  return <div className="snapshot-comparison">
    <header><div><span>DIFF_RESULT</span><strong>{comparison.base.label}</strong></div><i>→</i><div><span>TARGET</span><strong>{comparison.target.label}</strong></div></header>
    {warnings.length > 0 && <div className="snapshot-comparison-warning" role="status" aria-label="版本对比口径提示">{warnings.map((warning) => <p key={warning}>[NOTE] {warning}</p>)}</div>}
    <div className="snapshot-metrics">{comparison.metric_changes.map((metric) => {
      const baseUnavailable = metric.key === "score" && comparison.base.score_available === false;
      const targetUnavailable = metric.key === "score" && comparison.target.score_available === false;
      const delta = !baseUnavailable && !targetUnavailable && (comparable || metric.key === "files") ? metric.delta : null;
      const baseValue = baseUnavailable ? "N/A" : formatNumber(metric.base);
      const targetValue = targetUnavailable ? "N/A" : formatNumber(metric.target);
      return <article key={metric.key}><span>{metric.label}</span><strong>{targetValue}</strong><em className={`${snapshotMetricTone(metric.key, delta)}${delta === null ? " not-comparable" : ""}`} title={delta === null ? "评分依据不足或口径不同，不计算差值" : undefined}>{delta === null ? "不计差值" : `${delta > 0 ? "+" : ""}${formatNumber(delta)}`}</em><small>{baseValue} → {targetValue}</small></article>;
    })}</div>
    <SnapshotGroup title="质量问题" code="QUALITY" group={comparison.quality} comparable={comparable} />
    <SnapshotGroup title="解析问题" code="PARSER" group={comparison.parse_issues} comparable={comparable} />
    <SnapshotGroup title="循环依赖" code="CYCLES" group={comparison.cycles} comparable={comparable} />
  </div>;
}

function SnapshotGroup({ title, code, group, comparable }: { title: string; code: string; group: SnapshotComparisonGroup; comparable: boolean }) {
  const sections = [
    { label: comparable ? "新增" : "新增检出", tone: "new", count: group.new_count, items: group.new_items },
    { label: comparable ? "已修复" : "不再检出", tone: "fixed", count: group.fixed_count, items: group.fixed_items },
    { label: comparable ? "持续存在" : "两次检出", tone: "persistent", count: group.persistent_count, items: group.persistent_items },
  ];
  return <section className="snapshot-group"><header><span>{code}</span><strong>{title}</strong>{group.truncated && <em>仅显示前 100 条</em>}</header><div>{sections.map((section) => <article className={`snapshot-change-${comparable ? section.tone : "neutral"}`} key={section.tone}><h4>{section.label}<b>{formatNumber(section.count)}</b></h4>{section.items.length === 0 ? <p>无</p> : section.items.map((item, index) => <p key={String(item.key ?? index)}>{snapshotItemLabel(item)}</p>)}</article>)}</div></section>;
}

function snapshotItemLabel(item: Record<string, unknown>): string {
  if (Array.isArray(item.paths)) return item.paths.join(" → ");
  const location = item.start_line ? `${String(item.file_path)}:${String(item.start_line)}` : String(item.file_path ?? "未知位置");
  return `${location} · ${String(item.title ?? item.message ?? item.rule_id ?? "分析项")}`;
}

function snapshotMetricTone(key: string, delta: number | null): "good" | "bad" | "neutral" {
  if (delta === null || delta === 0 || ["files", "symbols", "imports"].includes(key)) return "neutral";
  if (key === "score") return delta > 0 ? "good" : "bad";
  return delta < 0 ? "good" : "bad";
}

function snapshotReasonLabel(reason: AnalysisSnapshotSummary["reason"]): string {
  return ({ manual: "MANUAL", import: "IMPORT", full: "FULL", incremental: "INCREMENTAL", sync: "REMOTE_SYNC" } as const)[reason] ?? reason.toUpperCase();
}

function gitFileStatusLabel(status: string): string {
  return ({ added: "新增", modified: "修改", removed: "删除", renamed: "重命名", copied: "复制", changed: "变更", unchanged: "未变化" } as Record<string, string>)[status] ?? "修改";
}
