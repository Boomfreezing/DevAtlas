import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import CodeViewer from "./CodeViewer";
import {
  DEFAULT_IMPORT_LIMITS,
  askRepository,
  compareAnalysisSnapshots,
  compareProjectGitCommits,
  configureReportGenerator,
  createAnalysisSnapshot,
  deleteAnalysisSnapshot,
  deleteProject,
  formatOperationError,
  formatUploadSize,
  generateProjectReport,
  getChangeImpact,
  getAnalysisJob,
  getDependencyGraph,
  getImportLimits,
  getQualityReport,
  getProject,
  getProjectFileTree,
  getProjectImports,
  getProjectIssues,
  getProjectGitSummary,
  getProjectStructureSummary,
  getProjectSymbols,
  getReportGenerators,
  importGitHubProject,
  incrementalReanalyzeProject,
  listProjects,
  listAnalysisSnapshots,
  prepareFolderUpload,
  reanalyzeProject,
  searchProject,
  searchImpactTargets,
  synchronizeGitHubProject,
  testReportGenerator,
  uploadFolder,
  uploadProject,
} from "./api";
import type { FolderUploadPreparation } from "./api";
import { formatFolderScanProgress, pickFolderSafely, scanDroppedFolderSafely, supportsSafeFolderDrop, supportsSafeFolderPicker } from "./safeFolderPicker";
import type { FolderScanProgress } from "./safeFolderPicker";
import type { AnalysisJob, AnalysisSnapshotComparison, AnalysisSnapshotSummary, ChangeImpact, CodeSearchResponse, CodeSearchResult, CodeSymbol, DependencyGraph, DependencyNode, GeneratedReport, GitComparison, ImpactRelation, ImpactTarget, ImportLimits, ImportRelation, IncrementalAnalysisResult, ParseIssue, ProjectFileTreeNode, ProjectFileTreeResponse, ProjectGitSummary, ProjectStructureSummary, ProjectSummary, QualityFinding, QualityReport, ReportGenerator, ReportGeneratorConfiguration, ReportGeneratorTestResult, RepositoryAnswer, RepositoryCitation, SnapshotComparisonGroup, StructurePage } from "./types";

type ActiveSection = "projects" | "search" | "graph" | "impact" | "snapshots" | "quality" | "report" | "providers";
type ProjectTab = "files" | "symbols" | "imports" | "issues";
type DisplayScale = 90 | 100 | 110 | 120;
type LoadedStructurePage<T> = StructurePage<T> & { projectId: number };

interface NavigationState {
  section: ActiveSection;
  tab: ProjectTab;
  projectId: number | null;
}

const SECTION_LABELS: Record<ActiveSection, string> = {
  projects: "仓库概览",
  search: "代码搜索",
  graph: "依赖图谱",
  impact: "耦合分析",
  snapshots: "版本对比",
  quality: "质量检测",
  report: "分析报告",
  providers: "API 配置",
};

const PROJECT_TAB_LABELS: Record<ProjectTab, string> = {
  files: "文件",
  symbols: "符号",
  imports: "依赖",
  issues: "问题",
};

const ACTIVE_SECTIONS: ActiveSection[] = ["projects", "search", "graph", "impact", "snapshots", "quality", "report", "providers"];
const PROJECT_TABS: ProjectTab[] = ["files", "symbols", "imports", "issues"];
const DISPLAY_SCALES: DisplayScale[] = [90, 100, 110, 120];
const STRUCTURE_ROWS_INCREMENT = 150;
function readDisplayScale(): DisplayScale {
  try {
    const stored = Number(window.localStorage.getItem("devatlas-display-scale"));
    return DISPLAY_SCALES.includes(stored as DisplayScale) ? stored as DisplayScale : 100;
  } catch {
    return 100;
  }
}

function readProviderPreference(key: "report" | "qa"): string {
  try {
    return window.localStorage.getItem(`devatlas-${key}-provider`) || (key === "report" ? "local" : "");
  } catch {
    return key === "report" ? "local" : "";
  }
}

function readNavigationState(): NavigationState {
  const params = new URLSearchParams(window.location.search);
  const sectionParam = params.get("section");
  const tabParam = params.get("tab");
  const projectParam = Number(params.get("project"));
  return {
    section: ACTIVE_SECTIONS.includes(sectionParam as ActiveSection) ? sectionParam as ActiveSection : "projects",
    tab: PROJECT_TABS.includes(tabParam as ProjectTab) ? tabParam as ProjectTab : "files",
    projectId: Number.isInteger(projectParam) && projectParam > 0 ? projectParam : null,
  };
}

function writeNavigationState(state: NavigationState, mode: "push" | "replace" = "push") {
  const url = new URL(window.location.href);
  url.searchParams.set("section", state.section);
  url.searchParams.set("tab", state.tab);
  if (state.projectId === null) url.searchParams.delete("project");
  else url.searchParams.set("project", String(state.projectId));
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl === currentUrl) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"]({}, "", nextUrl);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatAnalysisValue(value: number | undefined, loading: boolean): string {
  if (loading) return "…";
  return value === undefined ? "—" : formatNumber(value);
}

interface MarkdownFileHandle {
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
  }>;
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<MarkdownFileHandle>;
};

async function saveMarkdownFile(report: GeneratedReport): Promise<void> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (picker) {
    const handle = await picker.call(window, {
      suggestedName: report.filename,
      types: [{ description: "Markdown 文档", accept: { "text/markdown": [".md"] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([report.content], { type: "text/markdown;charset=utf-8" }));
    await writable.close();
    return;
  }

  const blobUrl = window.URL.createObjectURL(new Blob([report.content], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = report.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(blobUrl);
}

function App() {
  const initialNavigation = useRef(readNavigationState());
  const [displayScale, setDisplayScale] = useState<DisplayScale>(readDisplayScale);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selected, setSelected] = useState<ProjectSummary | null>(null);
  const [structure, setStructure] = useState<ProjectStructureSummary | null>(null);
  const [structureLoading, setStructureLoading] = useState(false);
  const [symbolPage, setSymbolPage] = useState<LoadedStructurePage<CodeSymbol> | null>(null);
  const [importPage, setImportPage] = useState<LoadedStructurePage<ImportRelation> | null>(null);
  const [issuePage, setIssuePage] = useState<LoadedStructurePage<ParseIssue> | null>(null);
  const [structureRowsLoading, setStructureRowsLoading] = useState(false);
  const [activeSection, setActiveSection] = useState<ActiveSection>(initialNavigation.current.section);
  const [projectTab, setProjectTab] = useState<ProjectTab>(initialNavigation.current.tab);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResponse, setSearchResponse] = useState<CodeSearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [codeViewerResult, setCodeViewerResult] = useState<CodeSearchResult | null>(null);
  const [codeViewerQuery, setCodeViewerQuery] = useState("");
  const [qaPanelOpen, setQaPanelOpen] = useState(false);
  const [dependencyGraph, setDependencyGraph] = useState<DependencyGraph | null>(null);
  const [impactSeed, setImpactSeed] = useState<ImpactTarget | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [qualityReport, setQualityReport] = useState<QualityReport | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [qualityPageLoading, setQualityPageLoading] = useState(false);
  const [reportGenerators, setReportGenerators] = useState<ReportGenerator[]>([]);
  const [selectedReportGenerator, setSelectedReportGenerator] = useState(() => readProviderPreference("report"));
  const [selectedQaProvider, setSelectedQaProvider] = useState(() => readProviderPreference("qa"));
  const [selectedReportMode, setSelectedReportMode] = useState<"summary" | "full">("summary");
  const [generatedReport, setGeneratedReport] = useState<GeneratedReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [activeJob, setActiveJob] = useState<AnalysisJob | null>(null);
  const [incrementalResult, setIncrementalResult] = useState<IncrementalAnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectingProjectId, setSelectingProjectId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<"incremental" | "full" | null>(null);
  const [exportingReport, setExportingReport] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [importMode, setImportMode] = useState<"zip" | "folder" | "github">("zip");
  const [importLimits, setImportLimits] = useState<ImportLimits>(DEFAULT_IMPORT_LIMITS);
  const [folderSelection, setFolderSelection] = useState<{ files: File[]; preview: FolderUploadPreparation } | null>(null);
  const [folderScanning, setFolderScanning] = useState(false);
  const [folderScanProgress, setFolderScanProgress] = useState<FolderScanProgress | null>(null);
  const [folderDropActive, setFolderDropActive] = useState(false);
  const [githubUrl, setGithubUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const folderScanAbortRef = useRef<AbortController | null>(null);
  const selectionRequestRef = useRef(0);
  const structurePageRequestRef = useRef(0);
  const qualityPageRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const initialProjectRestoredRef = useRef(false);
  const structureCacheRef = useRef(new Map<number, ProjectStructureSummary>());

  const refreshProjects = useCallback(async () => {
    try {
      setError(null);
      setProjects(await listProjects());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法加载项目列表");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    void getImportLimits().then(setImportLimits).catch(() => setImportLimits(DEFAULT_IMPORT_LIMITS));
  }, []);

  useEffect(() => {
    void getReportGenerators().then(setReportGenerators).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!reportGenerators.length) return;
    const reportProvider = reportGenerators.find((item) => item.id === selectedReportGenerator);
    const qaProvider = reportGenerators.find((item) => item.id === selectedQaProvider);
    if (!reportProvider?.available) setSelectedReportGenerator("local");
    if (!qaProvider?.available || qaProvider.id === "local") {
      setSelectedQaProvider(
        reportGenerators.find((item) => item.id !== "local" && item.available)?.id ?? "",
      );
    }
  }, [reportGenerators, selectedReportGenerator, selectedQaProvider]);

  useEffect(() => {
    try {
      window.localStorage.setItem("devatlas-report-provider", selectedReportGenerator);
      window.localStorage.setItem("devatlas-qa-provider", selectedQaProvider);
    } catch {
      // Provider selection still works for the current session when storage is disabled.
    }
  }, [selectedReportGenerator, selectedQaProvider]);

  useEffect(() => {
    document.documentElement.dataset.displayScale = String(displayScale);
    try {
      window.localStorage.setItem("devatlas-display-scale", String(displayScale));
    } catch {
      // The visual setting still works when storage is disabled.
    }
  }, [displayScale]);

  const adjustDisplayScale = (direction: -1 | 1) => {
    const currentIndex = DISPLAY_SCALES.indexOf(displayScale);
    const nextIndex = Math.min(DISPLAY_SCALES.length - 1, Math.max(0, currentIndex + direction));
    setDisplayScale(DISPLAY_SCALES[nextIndex]);
  };

  useEffect(() => {
    setCodeViewerResult(null);
  }, [selected?.id]);

  useEffect(() => {
    const handleQaShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "j" || !selected) return;
      event.preventDefault();
      setQaPanelOpen((current) => !current);
    };
    window.addEventListener("keydown", handleQaShortcut);
    return () => window.removeEventListener("keydown", handleQaShortcut);
  }, [selected?.id]);

  function openQaCitation(citation: RepositoryCitation, citationIndex: number) {
    setCodeViewerQuery(citation.symbol_name ?? "");
    setCodeViewerResult({
      chunk_id: -(citationIndex + 1),
      file_id: citation.file_id,
      file_path: citation.file_path,
      symbol_name: citation.symbol_name,
      kind: "repository-evidence",
      start_line: citation.start_line,
      end_line: citation.end_line,
      snippet_start_line: citation.start_line,
      snippet_end_line: citation.end_line,
      snippet: citation.snippet,
      score: 1,
    });
  }

  function openImpactRelation(relation: ImpactRelation) {
    const startLine = relation.start_line ?? relation.line_numbers[0] ?? 1;
    const endLine = relation.end_line ?? startLine;
    setCodeViewerQuery(relation.symbol_name ?? "");
    setCodeViewerResult({
      chunk_id: -(relation.file_id * 10_000 + startLine),
      file_id: relation.file_id,
      file_path: relation.file_path,
      symbol_name: relation.symbol_name,
      kind: relation.symbol_kind ?? relation.relation,
      start_line: startLine,
      end_line: endLine,
      snippet_start_line: startLine,
      snippet_end_line: endLine,
      snippet: "",
      score: 1,
    });
  }

  function openImpactTarget(target: ImpactTarget) {
    if (!selected) return;
    setImpactSeed(target);
    setActiveSection("impact");
    setWorkspaceError(null);
    writeNavigationState({ section: "impact", tab: projectTab, projectId: selected.id });
  }

  function clearStructurePages() {
    structurePageRequestRef.current += 1;
    setSymbolPage(null);
    setImportPage(null);
    setIssuePage(null);
    setStructureRowsLoading(false);
  }

  async function loadStructurePage(tab: ProjectTab, reset: boolean, projectId = selected?.id) {
    if (!projectId || tab === "files") return;
    const currentPage = tab === "symbols" ? symbolPage : tab === "imports" ? importPage : issuePage;
    const offset = reset || currentPage?.projectId !== projectId ? 0 : currentPage.items.length;
    const requestId = ++structurePageRequestRef.current;
    const selectionId = selectionRequestRef.current;
    setStructureRowsLoading(true);
    setWorkspaceError(null);
    try {
      const nextPage = tab === "symbols"
        ? await getProjectSymbols(projectId, STRUCTURE_ROWS_INCREMENT, offset)
        : tab === "imports"
          ? await getProjectImports(projectId, STRUCTURE_ROWS_INCREMENT, offset)
          : await getProjectIssues(projectId, STRUCTURE_ROWS_INCREMENT, offset);
      if (structurePageRequestRef.current !== requestId || selectionRequestRef.current !== selectionId) return;
      const loadedPage = {
        ...nextPage,
        offset: 0,
        items: reset || currentPage?.projectId !== projectId
          ? nextPage.items
          : [...currentPage.items, ...nextPage.items],
        projectId,
      };
      loadedPage.has_more = loadedPage.items.length < loadedPage.total;
      loadedPage.limit = loadedPage.items.length;
      if (tab === "symbols") setSymbolPage(loadedPage as LoadedStructurePage<CodeSymbol>);
      else if (tab === "imports") setImportPage(loadedPage as LoadedStructurePage<ImportRelation>);
      else setIssuePage(loadedPage as LoadedStructurePage<ParseIssue>);
    } catch (requestError) {
      if (structurePageRequestRef.current === requestId && selectionRequestRef.current === selectionId) {
        setWorkspaceError(requestError instanceof Error ? requestError.message : "无法加载结构列表");
      }
    } finally {
      if (structurePageRequestRef.current === requestId) setStructureRowsLoading(false);
    }
  }

  const activeStructurePageProjectId = projectTab === "symbols"
    ? symbolPage?.projectId
    : projectTab === "imports"
      ? importPage?.projectId
      : projectTab === "issues"
        ? issuePage?.projectId
        : undefined;

  useEffect(() => {
    if (!selected || activeSection !== "projects" || projectTab === "files") return;
    if (activeStructurePageProjectId === selected.id) return;
    void loadStructurePage(projectTab, true, selected.id);
  }, [selected?.id, activeSection, projectTab, activeStructurePageProjectId]);

  const stats = useMemo(
    () => ({
      projects: projects.length,
      files: projects.reduce((total, project) => total + project.file_count, 0),
      lines: projects.reduce((total, project) => total + project.code_line_count, 0),
      languages: new Set(projects.map((project) => project.primary_language).filter(Boolean)).size,
    }),
    [projects],
  );

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("请选择 ZIP 格式的代码仓库。");
      return;
    }

    setUploading(true);
    setError(null);
    try {
      const job = await uploadProject(file, importLimits);
      await monitorJob(job);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "上传失败");
    } finally {
      setUploading(false);
      setActiveJob(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleFolderSelection(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    setError(null);
    try {
      setFolderSelection({ files, preview: prepareFolderUpload(files, importLimits) });
    } catch (requestError) {
      setFolderSelection(null);
      setError(requestError instanceof Error ? requestError.message : "文件夹预检失败");
    } finally {
      if (folderInputRef.current) folderInputRef.current.value = "";
    }
  }

  async function runFolderScan(
    scan: (options: { signal: AbortSignal; onProgress: (progress: FolderScanProgress) => void }) => Promise<{ files: File[]; preview: FolderUploadPreparation }>,
  ) {
    const controller = new AbortController();
    folderScanAbortRef.current = controller;
    setFolderScanning(true);
    setFolderScanProgress(null);
    setFolderSelection(null);
    setError(null);
    try {
      setFolderSelection(await scan({
        signal: controller.signal,
        onProgress: setFolderScanProgress,
      }));
    } catch (requestError) {
      if (!(requestError instanceof DOMException && requestError.name === "AbortError")) {
        setError(requestError instanceof Error ? requestError.message : "安全扫描文件夹失败");
      }
    } finally {
      if (folderScanAbortRef.current === controller) folderScanAbortRef.current = null;
      setFolderScanning(false);
    }
  }

  async function chooseFolderSafely() {
    if (!supportsSafeFolderPicker()) {
      setError("当前内置浏览器不支持点击式安全目录选择。请从系统文件管理器把项目文件夹拖入虚线区域，或改用 ZIP 导入。");
      return;
    }
    await runFolderScan((options) => pickFolderSafely(importLimits, options));
  }

  async function handleFolderDrop(dataTransfer: DataTransfer) {
    setFolderDropActive(false);
    await runFolderScan((options) => scanDroppedFolderSafely(dataTransfer, importLimits, options));
  }

  function cancelFolderScan() {
    folderScanAbortRef.current?.abort();
    folderScanAbortRef.current = null;
    setFolderScanning(false);
    setFolderScanProgress(null);
    setFolderDropActive(false);
  }

  async function confirmFolderUpload() {
    if (!folderSelection) return;
    setUploading(true);
    setError(null);
    try {
      const job = await uploadFolder(folderSelection.files, importLimits);
      await monitorJob(job);
      setFolderSelection(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "文件夹导入失败");
    } finally {
      setUploading(false);
      setActiveJob(null);
    }
  }

  async function handleGitHubImport() {
    if (!githubUrl.trim()) {
      setError("请输入公开 GitHub 仓库地址。");
      return;
    }

    setUploading(true);
    setError(null);
    try {
      const job = await importGitHubProject(githubUrl.trim());
      await monitorJob(job);
      setGithubUrl("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "GitHub 仓库导入失败");
    } finally {
      setUploading(false);
      setActiveJob(null);
    }
  }

  async function finishImport(created: ProjectSummary) {
    selectionRequestRef.current += 1;
    await refreshProjects();
    setSelected(created);
    setActiveSection("projects");
    setProjectTab("symbols");
    setWorkspaceError(null);
    writeNavigationState({ section: "projects", tab: "symbols", projectId: created.id });
    setStructure(null);
    setSearchQuery("");
    setSearchResponse(null);
    setDependencyGraph(null);
    setImpactSeed(null);
    setQualityReport(null);
    setGeneratedReport(null);
    setIncrementalResult(null);
    clearStructurePages();
    setStructureLoading(true);
    try {
      const nextStructure = await getProjectStructureSummary(created.id);
      structureCacheRef.current.set(created.id, nextStructure);
      setStructure(nextStructure);
    } catch (structureError) {
      setWorkspaceError(structureError instanceof Error ? structureError.message : "无法加载结构分析");
    } finally {
      setStructureLoading(false);
    }
    setImportOpen(false);
  }

  async function monitorJob(initialJob: AnalysisJob) {
    let job = initialJob;
    setActiveJob(job);
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      if (job.status === "completed") {
        if (job.project_id === null) throw new Error("任务完成但没有返回项目 ID。");
        await finishImport(await getProject(job.project_id));
        setActiveJob(null);
        return;
      }
      if (job.status === "failed") {
        throw new Error(formatOperationError("分析仓库", 500, job.error || job.message || null));
      }
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      job = await getAnalysisJob(job.id);
      setActiveJob(job);
    }
    throw new Error("后台分析等待超时，请稍后重新打开项目列表。");
  }

  async function handleProjectSynchronized(projectId: number) {
    const requestId = selectionRequestRef.current;
    const [updated, nextStructure] = await Promise.all([
      getProject(projectId),
      getProjectStructureSummary(projectId),
    ]);
    await refreshProjects();
    if (selectionRequestRef.current !== requestId || selected?.id !== projectId) return;
    setSelected(updated);
    structureCacheRef.current.set(projectId, nextStructure);
    setStructure(nextStructure);
    clearStructurePages();
    setSearchResponse(null);
    setDependencyGraph(null);
    setImpactSeed(null);
    setQualityReport(null);
    setGeneratedReport(null);
    setIncrementalResult(null);
  }

  async function handleReanalyze() {
    if (!selected) return;
    const projectId = selected.id;
    const requestId = selectionRequestRef.current;
    const sectionAtAnalysis = activeSection;
    setUploading(true);
    setAnalysisMode("full");
    setStructureLoading(true);
    setGraphLoading(sectionAtAnalysis === "graph");
    setQualityLoading(sectionAtAnalysis === "quality");
    setReportLoading(sectionAtAnalysis === "report");
    setWorkspaceError(null);
    setDependencyGraph(null);
    setQualityReport(null);
    setGeneratedReport(null);
    try {
      const nextStructure = await reanalyzeProject(projectId);
      if (selectionRequestRef.current !== requestId) return;
      structureCacheRef.current.set(projectId, nextStructure);
      setStructure(nextStructure);
      clearStructurePages();
      setSearchResponse(null);
      setIncrementalResult(null);
      if (sectionAtAnalysis === "graph") {
        const graph = await getDependencyGraph(projectId);
        if (selectionRequestRef.current !== requestId) return;
        setDependencyGraph(graph);
      }
      if (sectionAtAnalysis === "quality") {
        const report = await getQualityReport(projectId);
        if (selectionRequestRef.current !== requestId) return;
        setQualityReport(report);
      }
      if (sectionAtAnalysis === "report") {
        const report = await generateProjectReport(projectId, selectedReportGenerator, selectedReportMode);
        if (selectionRequestRef.current !== requestId) return;
        setGeneratedReport(report);
      }
      const detail = await getProject(projectId);
      if (selectionRequestRef.current !== requestId) return;
      setSelected(detail);
      await refreshProjects();
    } catch (requestError) {
      if (selectionRequestRef.current === requestId) {
        setWorkspaceError(requestError instanceof Error ? requestError.message : "重新分析失败");
      }
    } finally {
      setUploading(false);
      setAnalysisMode(null);
      if (selectionRequestRef.current === requestId) {
        setStructureLoading(false);
        setGraphLoading(false);
        setQualityLoading(false);
        setReportLoading(false);
      }
    }
  }

  async function handleIncrementalReanalyze() {
    if (!selected) return;
    const projectId = selected.id;
    const requestId = selectionRequestRef.current;
    const sectionAtAnalysis = activeSection;
    setUploading(true);
    setAnalysisMode("incremental");
    setWorkspaceError(null);
    try {
      const result = await incrementalReanalyzeProject(projectId);
      if (selectionRequestRef.current !== requestId) return;
      setIncrementalResult(result);
      const hasChanges = Boolean(result.added_file_count || result.changed_file_count || result.deleted_file_count);
      if (hasChanges) {
        setStructureLoading(true);
        setGraphLoading(sectionAtAnalysis === "graph");
        setQualityLoading(sectionAtAnalysis === "quality");
        setReportLoading(sectionAtAnalysis === "report");
        setDependencyGraph(null);
        setQualityReport(null);
        setGeneratedReport(null);
        const nextStructure = await getProjectStructureSummary(projectId);
        if (selectionRequestRef.current !== requestId) return;
        structureCacheRef.current.set(projectId, nextStructure);
        setStructure(nextStructure);
        clearStructurePages();
        setSearchResponse(null);
        if (sectionAtAnalysis === "graph") {
          const graph = await getDependencyGraph(projectId);
          if (selectionRequestRef.current !== requestId) return;
          setDependencyGraph(graph);
        }
        if (sectionAtAnalysis === "quality") {
          const report = await getQualityReport(projectId);
          if (selectionRequestRef.current !== requestId) return;
          setQualityReport(report);
        }
        if (sectionAtAnalysis === "report") {
          const report = await generateProjectReport(projectId, selectedReportGenerator, selectedReportMode);
          if (selectionRequestRef.current !== requestId) return;
          setGeneratedReport(report);
        }
      }
      const detail = await getProject(projectId);
      if (selectionRequestRef.current !== requestId) return;
      setSelected(detail);
      await refreshProjects();
    } catch (requestError) {
      if (selectionRequestRef.current === requestId) {
        setWorkspaceError(requestError instanceof Error ? requestError.message : "增量分析失败");
      }
    } finally {
      setUploading(false);
      setAnalysisMode(null);
      if (selectionRequestRef.current === requestId) {
        setStructureLoading(false);
        setGraphLoading(false);
        setQualityLoading(false);
        setReportLoading(false);
      }
    }
  }

  function openImporter(mode: "zip" | "folder" | "github" = "zip") {
    cancelFolderScan();
    setImportMode(mode);
    setFolderSelection(null);
    setError(null);
    setProjectPickerOpen(false);
    setImportOpen(true);
  }

  async function handleSelect(
    project: ProjectSummary,
    options: { section?: ActiveSection; tab?: ProjectTab; syncUrl?: boolean } = {},
  ) {
    const sectionAtSelection = options.section ?? activeSection;
    const tabAtSelection = options.tab ?? projectTab;
    if (selected?.id === project.id && sectionAtSelection === activeSection && tabAtSelection === projectTab) {
      setProjectPickerOpen(false);
      return;
    }
    const requestId = ++selectionRequestRef.current;
    qualityPageRequestRef.current += 1;
    const cachedStructure = structureCacheRef.current.get(project.id) ?? null;
    setActiveSection(sectionAtSelection);
    setProjectTab(tabAtSelection);
    setProjectPickerOpen(false);
    setSelectingProjectId(project.id);
    setSelected(project);
    if (options.syncUrl !== false) {
      writeNavigationState({ section: sectionAtSelection, tab: tabAtSelection, projectId: project.id });
    }
    try {
      setWorkspaceError(null);
      setSearchQuery("");
      setSearchResponse(null);
      setDependencyGraph(null);
      setImpactSeed(null);
      setQualityReport(null);
      setQualityPageLoading(false);
      setGeneratedReport(null);
      setIncrementalResult(null);
      clearStructurePages();
      setStructureLoading(cachedStructure === null);
      setGraphLoading(sectionAtSelection === "graph");
      setQualityLoading(sectionAtSelection === "quality");
      setReportLoading(sectionAtSelection === "report");
      setStructure(cachedStructure);
      const structurePromise = cachedStructure === null ? getProjectStructureSummary(project.id) : null;
      const graphPromise = sectionAtSelection === "graph" ? getDependencyGraph(project.id) : null;
      const qualityPromise = sectionAtSelection === "quality" ? getQualityReport(project.id) : null;
      const reportPromise = sectionAtSelection === "report"
        ? Promise.all([getReportGenerators(), generateProjectReport(project.id, "local")])
        : null;
      // Mark eagerly-started feature requests as handled until their dedicated
      // error boundary below awaits them.
      void graphPromise?.catch(() => undefined);
      void qualityPromise?.catch(() => undefined);
      void reportPromise?.catch(() => undefined);
      if (structurePromise !== null) {
        try {
          const projectStructure = await structurePromise;
          if (selectionRequestRef.current !== requestId) return;
          structureCacheRef.current.set(project.id, projectStructure);
          setStructure(projectStructure);
        } catch (structureError) {
          setWorkspaceError(structureError instanceof Error ? structureError.message : "无法加载结构分析");
        }
      }
      if (sectionAtSelection === "graph") {
        try {
          const graph = await graphPromise!;
          if (selectionRequestRef.current !== requestId) return;
          setDependencyGraph(graph);
        } catch (graphError) {
          setWorkspaceError(graphError instanceof Error ? graphError.message : "无法加载依赖图谱");
        }
      }
      if (sectionAtSelection === "quality") {
        try {
          const report = await qualityPromise!;
          if (selectionRequestRef.current !== requestId) return;
          setQualityReport(report);
        } catch (qualityError) {
          setWorkspaceError(qualityError instanceof Error ? qualityError.message : "无法生成质量报告");
        }
      }
      if (sectionAtSelection === "report") {
        try {
          const [generators, report] = await reportPromise!;
          if (selectionRequestRef.current !== requestId) return;
          setReportGenerators(generators);
          setSelectedReportGenerator("local");
          setSelectedReportMode("summary");
          setGeneratedReport(report);
        } catch (reportError) {
          setWorkspaceError(reportError instanceof Error ? reportError.message : "无法生成分析报告");
        }
      }
    } catch (requestError) {
      setWorkspaceError(requestError instanceof Error ? requestError.message : "无法加载项目详情");
    } finally {
      if (selectionRequestRef.current === requestId) {
        setStructureLoading(false);
        setGraphLoading(false);
        setQualityLoading(false);
        setReportLoading(false);
        setSelectingProjectId(null);
      }
    }
  }

  async function handleDelete(project: ProjectSummary) {
    if (!window.confirm(`确定删除“${project.name}”及其本地分析数据吗？`)) return;
    try {
      await deleteProject(project.id);
      structureCacheRef.current.delete(project.id);
      if (selected?.id === project.id) {
        selectionRequestRef.current += 1;
        setSelected(null);
        setStructure(null);
        clearStructurePages();
        setSearchResponse(null);
        setDependencyGraph(null);
        setImpactSeed(null);
        setQualityReport(null);
        setGeneratedReport(null);
        setIncrementalResult(null);
        setWorkspaceError(null);
        writeNavigationState({ section: activeSection, tab: projectTab, projectId: null }, "replace");
      }
      await refreshProjects();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "删除失败");
    }
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !searchQuery.trim() || searchLoading || searchLoadingMore) return;
    const query = searchQuery.trim();
    const projectId = selected.id;
    const selectionId = selectionRequestRef.current;
    const requestId = ++searchRequestRef.current;
    setSearchLoading(true);
    setWorkspaceError(null);
    setSearchResponse(null);
    setCodeViewerResult(null);
    try {
      const response = await searchProject(projectId, query);
      if (searchRequestRef.current === requestId && selectionRequestRef.current === selectionId) {
        setSearchResponse(response);
      }
    } catch (requestError) {
      if (searchRequestRef.current === requestId && selectionRequestRef.current === selectionId) {
        setWorkspaceError(requestError instanceof Error ? requestError.message : "代码搜索失败");
      }
    } finally {
      if (searchRequestRef.current === requestId) setSearchLoading(false);
    }
  }

  async function handleLoadMoreSearchResults() {
    if (!selected || !searchResponse || searchLoading || searchLoadingMore) return;
    if (!searchResponse.has_more) return;
    const query = searchResponse.query;
    const offset = searchResponse.results.length;
    const selectionId = selectionRequestRef.current;
    const requestId = ++searchRequestRef.current;
    setSearchLoadingMore(true);
    setWorkspaceError(null);
    try {
      const nextPage = await searchProject(selected.id, query, 10, offset);
      if (searchRequestRef.current !== requestId || selectionRequestRef.current !== selectionId) return;
      setSearchResponse((current) => {
        if (!current || current.query !== query) return current;
        const loadedChunkIds = new Set(current.results.map((result) => result.chunk_id));
        const results = [...current.results, ...nextPage.results.filter((result) => !loadedChunkIds.has(result.chunk_id))];
        return {
          ...nextPage,
          limit: results.length,
          offset: 0,
          has_more: results.length < nextPage.total_matches,
          results,
        };
      });
    } catch (requestError) {
      if (searchRequestRef.current === requestId && selectionRequestRef.current === selectionId) {
        setWorkspaceError(requestError instanceof Error ? requestError.message : "加载更多搜索结果失败");
      }
    } finally {
      if (searchRequestRef.current === requestId) setSearchLoadingMore(false);
    }
  }

  async function handleGenerateReport(generator = selectedReportGenerator): Promise<GeneratedReport | null> {
    if (!selected) return null;
    setReportLoading(true);
    setWorkspaceError(null);
    try {
      const report = await generateProjectReport(selected.id, generator, selectedReportMode);
      setGeneratedReport(report);
      return report;
    } catch (requestError) {
      setWorkspaceError(requestError instanceof Error ? requestError.message : "无法生成分析报告");
      return null;
    } finally {
      setReportLoading(false);
    }
  }

  function handleSelectReportGenerator(generator: string) {
    setSelectedReportGenerator(generator);
    if (generatedReport?.generator !== generator) setGeneratedReport(null);
  }

  function handleSelectReportMode(mode: "summary" | "full") {
    setSelectedReportMode(mode);
    if (generatedReport?.mode !== mode) setGeneratedReport(null);
  }

  async function handleConfigureReportGenerator(
    generator: string,
    configuration: ReportGeneratorConfiguration,
  ): Promise<ReportGenerator> {
    const provider = await configureReportGenerator(generator, configuration);
    setReportGenerators((current) => current.map((item) => item.id === provider.id ? provider : item));
    return provider;
  }

  async function handleTestReportGenerator(generator: string): Promise<ReportGeneratorTestResult> {
    const result = await testReportGenerator(generator);
    setReportGenerators((current) => current.map((item) => item.id === result.provider.id ? result.provider : item));
    return result;
  }

  async function handleExportReport() {
    if (!selected || activeSection !== "report") return;
    setExportingReport(true);
    setWorkspaceError(null);
    try {
      const report = generatedReport ?? await handleGenerateReport();
      if (report) await saveMarkdownFile(report);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") return;
      setWorkspaceError(requestError instanceof Error ? requestError.message : "无法生成 Markdown 报告");
    } finally {
      setExportingReport(false);
    }
  }

  async function handleOpenGraph(options: { syncUrl?: boolean } = {}) {
    const requestId = selectionRequestRef.current;
    setActiveSection("graph");
    setWorkspaceError(null);
    if (options.syncUrl !== false) {
      writeNavigationState({ section: "graph", tab: projectTab, projectId: selected?.id ?? null });
    }
    if (!selected) {
      return;
    }
    if (dependencyGraph) return;
    setGraphLoading(true);
    setWorkspaceError(null);
    try {
      const graph = await getDependencyGraph(selected.id);
      if (selectionRequestRef.current === requestId) setDependencyGraph(graph);
    } catch (requestError) {
      setWorkspaceError(requestError instanceof Error ? requestError.message : "无法加载依赖图谱");
    } finally {
      if (selectionRequestRef.current === requestId) setGraphLoading(false);
    }
  }

  async function handleOpenQuality(options: { syncUrl?: boolean } = {}) {
    const requestId = selectionRequestRef.current;
    setActiveSection("quality");
    setWorkspaceError(null);
    if (options.syncUrl !== false) {
      writeNavigationState({ section: "quality", tab: projectTab, projectId: selected?.id ?? null });
    }
    if (!selected) {
      return;
    }
    if (qualityReport) return;
    setQualityLoading(true);
    setWorkspaceError(null);
    try {
      const report = await getQualityReport(selected.id);
      if (selectionRequestRef.current === requestId) setQualityReport(report);
    } catch (requestError) {
      setWorkspaceError(requestError instanceof Error ? requestError.message : "无法生成质量报告");
    } finally {
      if (selectionRequestRef.current === requestId) setQualityLoading(false);
    }
  }

  async function handleQualityPageRequest(severity: string, rule: string, scope: string, offset: number, append: boolean) {
    if (!selected) return;
    const projectId = selected.id;
    const requestId = selectionRequestRef.current;
    const pageRequestId = ++qualityPageRequestRef.current;
    setQualityPageLoading(true);
    setWorkspaceError(null);
    try {
      const nextPage = await getQualityReport(projectId, 100, offset, severity, rule, scope);
      if (selectionRequestRef.current !== requestId || qualityPageRequestRef.current !== pageRequestId || selected.id !== projectId) return;
      setQualityReport((current) => {
        if (!append || !current) return nextPage;
        const findings = [...current.findings, ...nextPage.findings];
        return {
          ...nextPage,
          findings,
          offset: 0,
          limit: findings.length,
          has_more: findings.length < nextPage.filtered_findings,
          truncated: findings.length < nextPage.filtered_findings,
        };
      });
    } catch (requestError) {
      if (selectionRequestRef.current === requestId && qualityPageRequestRef.current === pageRequestId) {
        setWorkspaceError(requestError instanceof Error ? requestError.message : "无法加载质量问题");
      }
    } finally {
      if (selectionRequestRef.current === requestId && qualityPageRequestRef.current === pageRequestId) setQualityPageLoading(false);
    }
  }

  async function handleOpenReport(options: { syncUrl?: boolean } = {}) {
    const requestId = selectionRequestRef.current;
    setActiveSection("report");
    setWorkspaceError(null);
    if (options.syncUrl !== false) {
      writeNavigationState({ section: "report", tab: projectTab, projectId: selected?.id ?? null });
    }
    if (!selected || (generatedReport && reportGenerators.length)) return;
    setReportLoading(true);
    try {
      const [generators, report] = await Promise.all([
        reportGenerators.length ? Promise.resolve(reportGenerators) : getReportGenerators(),
        generatedReport ? Promise.resolve(generatedReport) : generateProjectReport(selected.id, selectedReportGenerator, selectedReportMode),
      ]);
      if (selectionRequestRef.current !== requestId) return;
      setReportGenerators(generators);
      setGeneratedReport(report);
    } catch (requestError) {
      setWorkspaceError(requestError instanceof Error ? requestError.message : "无法生成分析报告");
    } finally {
      if (selectionRequestRef.current === requestId) setReportLoading(false);
    }
  }

  async function handleOpenProviders(options: { syncUrl?: boolean } = {}) {
    setActiveSection("providers");
    setWorkspaceError(null);
    if (options.syncUrl !== false) {
      writeNavigationState({ section: "providers", tab: projectTab, projectId: selected?.id ?? null });
    }
    if (reportGenerators.length) return;
    setReportLoading(true);
    try {
      setReportGenerators(await getReportGenerators());
    } catch (requestError) {
      setWorkspaceError(requestError instanceof Error ? requestError.message : "无法读取 API 配置");
    } finally {
      setReportLoading(false);
    }
  }

  function clearSelectedProject() {
    selectionRequestRef.current += 1;
    qualityPageRequestRef.current += 1;
    setSelected(null);
    setStructure(null);
    clearStructurePages();
    setSearchQuery("");
    setSearchResponse(null);
    setDependencyGraph(null);
    setImpactSeed(null);
    setQualityReport(null);
    setGeneratedReport(null);
    setIncrementalResult(null);
    setSelectingProjectId(null);
    setStructureLoading(false);
    setGraphLoading(false);
    setQualityLoading(false);
    setQualityPageLoading(false);
    setReportLoading(false);
  }

  function navigateToSection(section: "projects" | "search" | "impact" | "snapshots") {
    if (!selected) return;
    setActiveSection(section);
    setWorkspaceError(null);
    writeNavigationState({ section, tab: projectTab, projectId: selected?.id ?? null });
  }

  function navigateToProjectTab(tab: ProjectTab) {
    setProjectTab(tab);
    setWorkspaceError(null);
    writeNavigationState({ section: "projects", tab, projectId: selected?.id ?? null });
  }

  function openProjectManager() {
    clearSelectedProject();
    setProjectPickerOpen(false);
    setActiveSection("projects");
    setProjectTab("files");
    setWorkspaceError(null);
    writeNavigationState({ section: "projects", tab: "files", projectId: null });
  }

  useEffect(() => {
    if (loading || initialProjectRestoredRef.current) return;
    initialProjectRestoredRef.current = true;
    const navigation = initialNavigation.current;
    if (navigation.projectId === null) return;
    const project = projects.find((item) => item.id === navigation.projectId);
    if (project) {
      void handleSelect(project, { section: navigation.section, tab: navigation.tab, syncUrl: false });
    } else {
      writeNavigationState({ ...navigation, projectId: null }, "replace");
      setWorkspaceError("URL 中的项目不存在或已被删除。");
    }
  }, [loading, projects]);

  useEffect(() => {
    const handlePopState = () => {
      const navigation = readNavigationState();
      setActiveSection(navigation.section);
      setProjectTab(navigation.tab);
      setWorkspaceError(null);

      if (navigation.projectId === null) {
        clearSelectedProject();
        return;
      }

      const project = projects.find((item) => item.id === navigation.projectId);
      if (!project) {
        clearSelectedProject();
        setWorkspaceError("历史记录中的项目不存在或已被删除。");
        return;
      }

      if (selected?.id !== project.id) {
        void handleSelect(project, { section: navigation.section, tab: navigation.tab, syncUrl: false });
        return;
      }

      if (navigation.section === "graph" && !dependencyGraph) void handleOpenGraph({ syncUrl: false });
      if (navigation.section === "quality" && !qualityReport) void handleOpenQuality({ syncUrl: false });
      if (navigation.section === "report" && !generatedReport) void handleOpenReport({ syncUrl: false });
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [projects, selected?.id, dependencyGraph, qualityReport, generatedReport]);

  const visibleSymbolPage = symbolPage?.projectId === selected?.id ? symbolPage : null;
  const visibleImportPage = importPage?.projectId === selected?.id ? importPage : null;
  const visibleIssuePage = issuePage?.projectId === selected?.id ? issuePage : null;
  const activeStructurePage = projectTab === "symbols"
    ? visibleSymbolPage
    : projectTab === "imports"
      ? visibleImportPage
      : projectTab === "issues"
        ? visibleIssuePage
        : null;

  return (
    <div className={`app-shell ${selected && qaPanelOpen ? "qa-side-open" : ""}`}>
      <aside className={`sidebar ${projectPickerOpen ? "project-picker-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><span>&gt;_</span></div>
          <div><strong>DEVATLAS</strong><small>repo_intelligence.sys</small></div>
        </div>

        <section className="project-context" aria-label="当前项目">
          <p className="sidebar-label">CURRENT_PROJECT</p>
          <button
            className={`project-trigger ${projectPickerOpen ? "open" : ""}`}
            aria-expanded={projectPickerOpen}
            onClick={() => setProjectPickerOpen((open) => !open)}
          >
            <span className="project-trigger-mark">{selected ? selected.name.slice(0, 2).toUpperCase() : "{}"}</span>
            <span className="project-trigger-copy">
              <strong>{selected?.name ?? "选择一个项目"}</strong>
              <small>{selected ? `${selected.primary_language ?? "未识别"} · ${formatNumber(selected.file_count)} 文件` : projects.length ? `${projects.length} 个项目可用` : "尚未导入仓库"}</small>
            </span>
            <span className="project-trigger-arrow">{projectPickerOpen ? "▲" : "▼"}</span>
          </button>
          {projectPickerOpen && (
            <div className="project-picker">
              <div className="project-picker-heading"><strong>切换项目</strong><span>{projects.length}</span></div>
              <div className="project-picker-list">
                {loading && <div className="project-picker-empty">正在读取项目…</div>}
                {!loading && projects.map((project) => (
                  <button
                    key={project.id}
                    className={`project-option ${selected?.id === project.id ? "active" : ""}`}
                    onClick={() => void handleSelect(project)}
                  >
                    <span>{project.name.slice(0, 2).toUpperCase()}</span>
                    <div><strong>{project.name}</strong><small>{project.primary_language ?? "未识别"} · {formatNumber(project.file_count)} 文件</small></div>
                    {selected?.id === project.id && <em>●</em>}
                  </button>
                ))}
                {!loading && projects.length === 0 && <div className="project-picker-empty">还没有可选择的项目</div>}
              </div>
              <div className="project-picker-actions">
                <button onClick={openProjectManager}>管理项目</button>
              </div>
            </div>
          )}
        </section>

        <nav aria-label="主导航">
          <button disabled={!selected} className={`nav-item ${selected && activeSection === "projects" ? "active" : ""}`} onClick={() => navigateToSection("projects")}><span className="nav-icon">⌘</span>仓库概览</button>
          <button
            disabled={!selected}
            className={`nav-item ${selected && activeSection === "search" ? "active" : ""}`}
            onClick={() => navigateToSection("search")}
          ><span className="nav-icon">⌕</span>代码搜索<em>BM25</em></button>
          <button disabled={!selected} className={`nav-item ${selected && activeSection === "graph" ? "active" : ""}`} onClick={() => void handleOpenGraph()}><span className="nav-icon">◇</span>依赖图谱<em>LOCAL</em></button>
          <button disabled={!selected} className={`nav-item ${selected && activeSection === "impact" ? "active" : ""}`} onClick={() => navigateToSection("impact")}><span className="nav-icon">◎</span>耦合分析<em>TRACE</em></button>
          <button disabled={!selected} className={`nav-item ${selected && activeSection === "snapshots" ? "active" : ""}`} onClick={() => navigateToSection("snapshots")}><span className="nav-icon">◫</span>版本对比<em>DIFF</em></button>
          <button disabled={!selected} className={`nav-item ${selected && activeSection === "quality" ? "active" : ""}`} onClick={() => void handleOpenQuality()}><span className="nav-icon">✓</span>质量检测<em>6 RULES</em></button>
          <button disabled={!selected} className={`nav-item ${selected && activeSection === "report" ? "active" : ""}`} onClick={() => void handleOpenReport()}><span className="nav-icon">▤</span>分析报告<em>SMART</em></button>
          <button className={`nav-item ${activeSection === "providers" ? "active" : ""}`} onClick={() => void handleOpenProviders()}><span className="nav-icon">⚙</span>API 配置<em>GLOBAL</em></button>
        </nav>

        <div className="sidebar-note">
          <span className="status-dot" />
          <div><strong>[LOCAL_MODE]</strong><small>code_stays_on_device</small></div>
        </div>
        <div className="version">$ devatlas --version<br />v0.9.0</div>
      </aside>

      <main className={`main-content ${selected || selectingProjectId !== null || activeSection === "providers" ? "workspace-mode" : ""}`}>
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {activeSection === "providers"
                ? "root@devatlas:~/runtime/providers"
                : selected
                ? `CURRENT_PROJECT · ${selected.primary_language ?? "未识别语言"} · ${formatNumber(selected.file_count)} 文件`
                : "root@devatlas:~/workspace/projects"}
            </p>
            <h1>{activeSection === "providers" ? "API 配置" : selected?.name ?? "项目管理"}</h1>
          </div>
          <div className="topbar-actions">
            <div className="display-scale-control" aria-label="页面显示比例">
              <button
                type="button"
                aria-label="缩小页面字号"
                disabled={displayScale === DISPLAY_SCALES[0]}
                onClick={() => adjustDisplayScale(-1)}
              ><span aria-hidden="true">−</span></button>
              <output aria-live="polite" title="仅调整 DevAtlas 页面，不受浏览器独立缩放设置影响">
                <strong>{displayScale}%</strong>
              </output>
              <button
                type="button"
                aria-label="放大页面字号"
                disabled={displayScale === DISPLAY_SCALES[DISPLAY_SCALES.length - 1]}
                onClick={() => adjustDisplayScale(1)}
              ><span aria-hidden="true">＋</span></button>
            </div>
            <div className="topbar-primary-actions">
              {selected && (
                <button
                  type="button"
                  className={`qa-terminal-toggle ${qaPanelOpen ? "active" : ""}`}
                  aria-expanded={qaPanelOpen}
                  aria-controls="repository-qa-terminal"
                  onClick={() => setQaPanelOpen((current) => !current)}
                ><span>&gt;_</span> 智能问答</button>
              )}
              <button className="primary-button" onClick={() => openImporter()} disabled={uploading}>
                <span>＋</span>{uploading ? "正在分析…" : "导入仓库"}
              </button>
            </div>
          </div>
        </header>

        {error && <div className="error-banner"><strong>[ERR] 操作未完成</strong><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}

        {activeJob && <JobProgress job={activeJob} />}

        {!selected && selectingProjectId === null && activeSection !== "providers" && <>
        <section className="stats-grid" aria-label="项目统计">
          <StatCard label="仓库总数" value={formatNumber(stats.projects)} meta="已完成本地扫描" tone="indigo" />
          <StatCard label="已索引文件" value={formatNumber(stats.files)} meta="文本与源代码文件" tone="cyan" />
          <StatCard label="代码行数" value={formatNumber(stats.lines)} meta="按编程语言统计" tone="amber" />
          <StatCard label="主要语言" value={formatNumber(stats.languages)} meta="跨全部仓库" tone="green" />
        </section>

        <section
          className={`upload-zone ${isDragging ? "dragging" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            void handleUpload(event.dataTransfer.files[0]);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => void handleUpload(event.target.files?.[0])}
          />
          <div className="upload-icon">&gt;&gt;</div>
          <div>
            <strong>{uploading ? "$ import --scan --wait" : "$ import repository --source"}</strong>
            <p>支持 ZIP、本地文件夹和公开 GitHub 仓库 · 最大 {importLimits.max_upload_mb} MB</p>
          </div>
          <span className="local-badge">[LOCAL_ONLY]</span>
        </section>
        </>}

        <div className={`content-grid ${selected || selectingProjectId !== null || activeSection === "providers" ? "workspace-single" : "project-manager-grid"}`}>
          {!selected && selectingProjectId === null && activeSection !== "providers" && (
          <section className="panel project-panel">
            <div className="panel-heading">
              <div><p className="eyebrow">~/repositories</p><h2>项目管理</h2></div>
              <span>{projects.length} 个仓库</span>
            </div>

            {loading ? (
              <div className="empty-state"><div className="spinner" /><p>正在读取本地项目…</p></div>
            ) : projects.length === 0 ? (
              <div className="empty-state"><div className="empty-glyph">{"{}"}</div><h3>还没有导入仓库</h3><p>从 ZIP、本地文件夹或 GitHub 开始第一次扫描。</p></div>
            ) : (
              <div className="project-list">
                {projects.map((project) => (
                  <article
                    key={project.id}
                    className={`project-row ${selectingProjectId === project.id ? "loading" : ""}`}
                    aria-busy={selectingProjectId === project.id}
                    onClick={() => void handleSelect(project)}
                  >
                    <div className="repo-mark">{project.name.slice(0, 2).toUpperCase()}</div>
                    <div className="repo-main"><strong>{project.name}</strong><span>{selectingProjectId === project.id ? "[LOADING] 正在读取项目" : project.source_filename}</span></div>
                    <LanguageBadge language={project.primary_language} />
                    <div className="repo-number file-count"><strong>{formatNumber(project.file_count)}</strong><span>文件</span></div>
                    <div className="repo-number line-count"><strong>{formatNumber(project.code_line_count)}</strong><span>代码行</span></div>
                    <time>{formatDate(project.created_at)}</time>
                    <button
                      className="icon-button danger"
                      title="删除项目"
                      onClick={(event) => { event.stopPropagation(); void handleDelete(project); }}
                    >
                      ×
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
          )}

          {(selected || selectingProjectId !== null || activeSection === "providers") && (
          <section className="panel detail-panel" aria-busy={selectingProjectId !== null}>
            <div className="panel-heading">
              <div><p className="eyebrow">{activeSection === "providers" ? "MODEL_RUNTIME" : activeSection === "projects" ? "REPOSITORY_OVERVIEW" : "PROJECT_TOOL"}</p><h2>{SECTION_LABELS[activeSection]}</h2></div>
              <div className="workspace-breadcrumb" aria-label="当前位置">
                <strong>{activeSection === "providers" ? "global" : selected?.name ?? "no-project"}</strong><i>/</i><em>{activeSection === "projects" ? PROJECT_TAB_LABELS[projectTab] : SECTION_LABELS[activeSection]}</em>
              </div>
            </div>
            {workspaceError && <div className="workspace-error" role="alert"><strong>操作未完成</strong><span>{workspaceError}</span><button aria-label="关闭工作区错误" onClick={() => setWorkspaceError(null)}>×</button></div>}
            {activeSection === "providers" ? (
              <div className="detail-content">
                <div className="file-list structure-list feature-content">
                  <ProviderWorkspace
                    generators={reportGenerators}
                    selectedReportProvider={selectedReportGenerator}
                    selectedQaProvider={selectedQaProvider}
                    loading={reportLoading}
                    onSelectReportProvider={handleSelectReportGenerator}
                    onSelectQaProvider={setSelectedQaProvider}
                    onConfigureGenerator={handleConfigureReportGenerator}
                    onTestGenerator={handleTestReportGenerator}
                  />
                </div>
              </div>
            ) : !selected ? (
              selectingProjectId !== null
                ? <div className="empty-state compact"><div className="spinner" /><h3>正在切换项目</h3><p>读取项目详情与结构分析…</p></div>
                : <div className="empty-state compact"><div className="empty-glyph">&gt;_</div><h3>选择一个仓库</h3><p>查看语言、文件和扫描信息。</p></div>
            ) : (
              <div className="detail-content">
                {selectingProjectId !== null && <div className="context-loading" role="status"><span>[LOAD]</span> 正在切换项目上下文，当前内容将在数据就绪后更新</div>}
                {activeSection === "projects" && <>
                <div className="detail-title"><div className="repo-mark large">{selected.name.slice(0, 2).toUpperCase()}</div><div><h3>仓库扫描已完成</h3><span>最后更新 · {formatDate(selected.updated_at)}</span></div></div>
                <div className="detail-metrics">
                  <div><span>主要语言</span><strong>{selected.primary_language ?? "未识别"}</strong></div>
                  <div><span>已索引文件</span><strong>{formatNumber(selected.file_count)}</strong></div>
                  <div><span>代码行数</span><strong>{formatNumber(selected.code_line_count)}</strong></div>
                </div>
                <div className="analysis-strip">
                  <div><strong>{formatAnalysisValue(structure?.class_count, structureLoading)}</strong><span>类 / 接口</span></div>
                  <div><strong>{formatAnalysisValue(structure?.function_count, structureLoading)}</strong><span>函数 / 方法</span></div>
                  <div><strong>{formatAnalysisValue(structure?.import_count, structureLoading)}</strong><span>导入关系</span></div>
                  <div className="analysis-actions"><button onClick={() => void handleIncrementalReanalyze()} disabled={uploading}>{analysisMode === "incremental" ? "分析中" : "增量分析"}</button><button onClick={() => void handleReanalyze()} disabled={uploading}>{analysisMode === "full" ? "分析中" : "全量"}</button></div>
                </div>
                {incrementalResult && <IncrementalSummary result={incrementalResult} />}
                <div className="inspector-tabs">
                  <button className={projectTab === "files" ? "active" : ""} onClick={() => navigateToProjectTab("files")}>文件 <span title="文件总数">{selected.file_count}</span></button>
                  <button className={projectTab === "symbols" ? "active" : ""} onClick={() => navigateToProjectTab("symbols")}>符号 <span title="符号总数">{formatAnalysisValue(structure?.symbol_count, structureLoading)}</span></button>
                  <button className={projectTab === "imports" ? "active" : ""} onClick={() => navigateToProjectTab("imports")}>依赖 <span title="导入关系总数">{formatAnalysisValue(structure?.import_count, structureLoading)}</span></button>
                  <button className={projectTab === "issues" ? "active" : ""} onClick={() => navigateToProjectTab("issues")}>问题 <span title="解析问题总数">{formatAnalysisValue(structure?.issue_count, structureLoading)}</span></button>
                </div>
                </>}
                <div className={`file-list structure-list ${activeSection !== "projects" ? "feature-content" : ""}`}>
                  {activeSection === "quality" && qualityLoading && <div className="mini-empty"><div className="spinner" />正在执行质量规则…</div>}
                  {activeSection === "quality" && qualityReport && <QualityReportView key={selected.id} report={qualityReport} loading={qualityPageLoading} onRequestPage={handleQualityPageRequest} />}
                  {activeSection === "graph" && graphLoading && <div className="mini-empty"><div className="spinner" />正在聚合项目内依赖…</div>}
                  {activeSection === "graph" && dependencyGraph && <DependencyGraphView key={selected.id} projectId={selected.id} graph={dependencyGraph} />}
                  {activeSection === "impact" && (
                    <ImpactWorkspace
                      key={`${selected.id}:${impactSeed?.target_type ?? "none"}:${impactSeed?.target_id ?? 0}`}
                      projectId={selected.id}
                      initialTarget={impactSeed}
                      onOpenRelation={openImpactRelation}
                    />
                  )}
                  {activeSection === "snapshots" && <SnapshotWorkspace key={selected.id} projectId={selected.id} onSynchronized={handleProjectSynchronized} />}
                  {activeSection === "report" && (
                    <ReportWorkspace
                      generators={reportGenerators}
                      selectedGenerator={selectedReportGenerator}
                      selectedMode={selectedReportMode}
                      report={generatedReport}
                      loading={reportLoading}
                      exporting={exportingReport}
                      onSelectGenerator={handleSelectReportGenerator}
                      onSelectMode={handleSelectReportMode}
                      onGenerate={() => void handleGenerateReport()}
                      onExport={() => void handleExportReport()}
                    />
                  )}
                  {activeSection === "search" && (
                    <div className="search-pane" aria-busy={searchLoading || searchLoadingMore}>
                      <form className="search-form" onSubmit={(event) => void handleSearch(event)}>
                        <input
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                          placeholder="搜索函数、类名或代码，例如 authentication"
                          aria-label="代码搜索关键词"
                        />
                        <button disabled={searchLoading || searchLoadingMore || !searchQuery.trim()}>{searchLoading ? "检索中…" : "搜索"}</button>
                      </form>
                      {searchLoading && (
                        <div className="search-progress" role="status" aria-live="polite" aria-label="代码搜索进行中">
                          <div className="spinner" />
                          <div><strong>SEARCHING_INDEX</strong><span>正在当前仓库中检索“{searchQuery.trim()}”</span></div>
                          <code>BM25 · PLEASE_WAIT</code>
                        </div>
                      )}
                      {searchResponse && (
                        <div className="search-summary">
                          <span>显示 {formatNumber(searchResponse.results.length)} / {formatNumber(searchResponse.total_matches)} 条匹配</span>
                          <small>{formatNumber(searchResponse.indexed_chunks)} 个代码片段 · {searchResponse.elapsed_ms.toFixed(1)} ms</small>
                        </div>
                      )}
                      {searchResponse?.results.map((result) => (
                        <article className="search-result" key={result.chunk_id}>
                          <header>
                            <div><strong>{result.symbol_name ?? result.file_path}</strong><span>{result.file_path} · 第 {result.snippet_start_line}–{result.snippet_end_line} 行</span></div>
                            <div className="search-result-actions"><small>{result.kind} · {result.score.toFixed(2)}</small><button type="button" onClick={() => openImpactTarget({ target_type: "file", target_id: result.file_id, file_id: result.file_id, file_path: result.file_path, name: result.file_path, kind: "file", start_line: 1, end_line: result.end_line })}>分析影响</button><button type="button" onClick={() => { setCodeViewerQuery(searchResponse.query); setCodeViewerResult(result); }}>查看代码</button></div>
                          </header>
                          <pre>{result.snippet}</pre>
                        </article>
                      ))}
                      {!searchResponse && !searchLoading && <div className="mini-empty">输入关键词，在当前仓库的函数、类和模块代码中检索</div>}
                      {searchResponse && searchResponse.results.length === 0 && <div className="mini-empty">没有找到匹配代码，请尝试函数名或更短的关键词</div>}
                      {searchResponse?.has_more && (
                        <div className="search-load-more">
                          <button type="button" onClick={() => void handleLoadMoreSearchResults()} disabled={searchLoading || searchLoadingMore}>
                            {searchLoadingMore ? "加载中…" : `加载更多（剩余 ${formatNumber(searchResponse.total_matches - searchResponse.results.length)} 条）`}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  {activeSection === "projects" && projectTab === "files" && <FileTree key={selected.id} projectId={selected.id} totalFiles={selected.file_count} onAnalyzeImpact={openImpactTarget} />}
                  {activeSection === "projects" && projectTab !== "files" && activeStructurePage && (
                    <div className="structure-list-summary">
                      <span className="structure-summary-prompt">&gt; list --buffer</span>
                      <span>shown</span>
                      <strong>{activeStructurePage.items.length}</strong>
                      <span>/ total {formatNumber(activeStructurePage.total)} rows</span>
                    </div>
                  )}
                  {activeSection === "projects" && projectTab === "symbols" && visibleSymbolPage?.items.map((symbol) => (
                    <div className="symbol-row" key={symbol.id}>
                      <span className={`kind-badge kind-${symbol.kind}`}>{symbol.kind.slice(0, 2).toUpperCase()}</span>
                      <div><strong>{symbol.qualified_name}</strong><span>{symbol.file_path}</span></div>
                      <small>第 {symbol.start_line}–{symbol.end_line} 行</small>
                      <button type="button" className="row-action" onClick={() => openImpactTarget({ target_type: "symbol", target_id: symbol.id, file_id: symbol.file_id, file_path: symbol.file_path, name: symbol.qualified_name, kind: symbol.kind, start_line: symbol.start_line, end_line: symbol.end_line })}>影响</button>
                    </div>
                  ))}
                  {activeSection === "projects" && projectTab === "imports" && visibleImportPage?.items.map((relation) => (
                    <div className="import-row" key={relation.id}>
                      <span className={`resolve-dot ${relation.resolved_file_id ? "resolved" : "external"}`} />
                      <div><strong>{relation.target_module}</strong><span>{relation.source_path} · 第 {relation.line_number} 行</span></div>
                      <small>{relation.resolved_file_id ? "项目内" : "外部"}</small>
                    </div>
                  ))}
                  {activeSection === "projects" && projectTab === "issues" && visibleIssuePage?.items.map((issue) => (
                    <ParseIssueRow issue={issue} key={issue.id} />
                  ))}
                  {activeSection === "projects" && activeStructurePage?.has_more && (
                    <div className="structure-load-more">
                      <button type="button" onClick={() => void loadStructurePage(projectTab, false)} disabled={structureRowsLoading}>
                        {structureRowsLoading ? "LOADING..." : "LOAD_NEXT"} <span>＋{Math.min(STRUCTURE_ROWS_INCREMENT, activeStructurePage.total - activeStructurePage.items.length)} ROWS</span>
                      </button>
                    </div>
                  )}
                  {(structureLoading || structureRowsLoading) && activeSection === "projects" && projectTab !== "files" && !activeStructurePage && <div className="mini-empty">正在读取结构分析…</div>}
                  {!structureLoading && !structureRowsLoading && activeSection === "projects" && projectTab !== "files" && activeStructurePage?.items.length === 0 && <div className="mini-empty">当前分类没有结果</div>}
                </div>
              </div>
            )}
          </section>
          )}
        </div>
      </main>

      {selected && qaPanelOpen && (
        <aside className="qa-side-panel" aria-label="智能问答面板">
          <RepositoryQaTerminal
            key={selected.id}
            projectId={selected.id}
            projectName={selected.name}
            providers={reportGenerators}
            selectedProvider={selectedQaProvider}
            onSelectProvider={setSelectedQaProvider}
            onOpenProviders={() => {
              setQaPanelOpen(false);
              void handleOpenProviders();
            }}
            onClose={() => setQaPanelOpen(false)}
            onOpenCitation={openQaCitation}
          />
        </aside>
      )}

      {importOpen && (
        <div className="modal-backdrop" onMouseDown={() => { if (!uploading) { cancelFolderScan(); setImportOpen(false); setFolderSelection(null); } }}>
          <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><p className="eyebrow">IMPORT_SOURCE::SELECT</p><h2 id="import-title">导入代码仓库</h2></div>
              <button className="modal-close" onClick={() => { cancelFolderScan(); setImportOpen(false); setFolderSelection(null); }} disabled={uploading}>×</button>
            </div>

            <div className="import-tabs" role="tablist">
              <button className={importMode === "zip" ? "active" : ""} onClick={() => { cancelFolderScan(); setImportMode("zip"); setFolderSelection(null); }}><span>ZIP</span>压缩包</button>
              <button className={importMode === "folder" ? "active" : ""} onClick={() => setImportMode("folder")}><span>DIR</span>本地文件夹</button>
              <button className={importMode === "github" ? "active" : ""} onClick={() => { cancelFolderScan(); setImportMode("github"); setFolderSelection(null); }}><span>GIT</span>GitHub</button>
            </div>

            <div className="import-body">
              {importMode === "zip" && (
                <div className="source-pane">
                  <div className="source-icon">.zip</div>
                  <h3>上传 ZIP 压缩包</h3>
                  <p>适合已经下载到本机的项目。系统会进行路径安全检查，再提取源代码。</p>
                  <button className="source-button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>{uploading ? "正在分析…" : "选择 ZIP 文件"}</button>
                </div>
              )}

              {importMode === "folder" && (
                <div className="source-pane folder-pane">
                  <input
                    className="hidden-input"
                    ref={(element) => {
                      folderInputRef.current = element;
                      if (element) element.setAttribute("webkitdirectory", "");
                    }}
                    type="file"
                    multiple
                    onChange={(event) => handleFolderSelection(event.target.files)}
                  />
                  {folderScanning ? (
                    <div className="folder-scanning" aria-live="polite">
                      <div className="spinner" />
                      <h3>正在安全扫描目录</h3>
                      <p>逐层读取并在进入前跳过依赖、缓存和构建目录，页面会定期让出执行时间以保持响应。</p>
                      <strong>{folderScanProgress ? formatFolderScanProgress(folderScanProgress) : "等待目录授权或正在读取第一批文件…"}</strong>
                      <button className="secondary-button" onClick={cancelFolderScan}>取消扫描</button>
                    </div>
                  ) : folderSelection ? (
                    <div className="folder-preview">
                      <div className="folder-preview-heading"><span>✓</span><div><h3>安全扫描完成</h3><p>已在遍历过程中跳过高风险目录，请确认源码范围后再上传。</p></div></div>
                      <div className="folder-preview-stats">
                        <div><span>{folderSelection.preview.selectionMode === "safe" ? "已扫描文件" : "原始文件夹"}</span><strong>{formatUploadSize(folderSelection.preview.originalBytes)}</strong><small>{formatNumber(folderSelection.preview.originalCount)} 个文件</small></div>
                        <div className="ignored"><span>自动排除</span><strong>-{formatUploadSize(folderSelection.preview.ignoredBytes)}</strong><small>{formatNumber(folderSelection.preview.ignoredCount)} 个文件</small></div>
                        <div className="accepted"><span>待分析源码</span><strong>{formatUploadSize(folderSelection.preview.totalBytes)}</strong><small>{formatNumber(folderSelection.preview.acceptedFiles.length)} 个文件</small></div>
                      </div>
                      <div className="folder-preview-breakdown">
                        <span>跳过目录 {folderSelection.preview.skippedDirectoryCount || folderSelection.preview.directoryIgnoredCount}</span>
                        <span>非源码/二进制 {folderSelection.preview.unsupportedCount}</span>
                        <span>单文件超限 {folderSelection.preview.oversizedCount}</span>
                      </div>
                      {!!folderSelection.preview.skippedDirectoryNames.length && <div className="folder-skipped-names">未进入：{folderSelection.preview.skippedDirectoryNames.join("、")}</div>}
                      <div className="folder-preview-actions">
                        <button className="secondary-button" onClick={() => setFolderSelection(null)} disabled={uploading}>重新选择</button>
                        <button className="source-button" onClick={() => void confirmFolderUpload()} disabled={uploading}>{uploading ? "正在上传…" : "确认并开始分析"}</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="source-icon">DIR</div>
                      <h3>安全选择本地项目文件夹</h3>
                      <p>逐层遍历并在进入前跳过依赖、缓存和构建目录；最多 {formatNumber(importLimits.max_folder_files)} 个源码文件 / {importLimits.max_upload_mb} MB，单文件不超过 {importLimits.max_source_file_mb} MB。</p>
                      <div
                        className={`folder-drop-zone ${folderDropActive ? "active" : ""}`}
                        onDragEnter={(event) => { event.preventDefault(); setFolderDropActive(true); }}
                        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setFolderDropActive(true); }}
                        onDragLeave={() => setFolderDropActive(false)}
                        onDrop={(event) => { event.preventDefault(); void handleFolderDrop(event.dataTransfer); }}
                      >
                        <span>⇩</span>
                        <strong>从文件管理器拖入项目文件夹</strong>
                        <small>{supportsSafeFolderDrop() ? "兼容内置浏览器 · 惰性遍历，不会预先枚举整个目录" : "若拖放不可用，请改用 ZIP 导入"}</small>
                      </div>
                      {supportsSafeFolderPicker() && <><div className="folder-choice-divider"><span>或</span></div><button className="source-button" onClick={() => void chooseFolderSafely()} disabled={uploading || folderScanning}>点击选择并安全扫描</button></>}
                      {!supportsSafeFolderPicker() && <small className="folder-picker-warning">当前内置浏览器不支持点击式目录授权，请使用上方拖放入口；高风险的整目录枚举仍保持禁用。</small>}
                    </>
                  )}
                </div>
              )}

              {importMode === "github" && (
                <div className="source-pane github-pane">
                  <div className="source-icon">GIT</div>
                  <h3>导入公开 GitHub 仓库</h3>
                  <p>仅下载公开仓库默认分支，不执行代码；下载后会按本地文件夹相同的规则过滤依赖、构建产物和超限文件。</p>
                  <label htmlFor="github-url">GitHub 仓库地址</label>
                  <div className="github-input-row">
                    <input id="github-url" value={githubUrl} onChange={(event) => setGithubUrl(event.target.value)} placeholder="https://github.com/owner/repository" disabled={uploading} />
                    <button onClick={() => void handleGitHubImport()} disabled={uploading}>{uploading ? "下载中…" : "开始分析"}</button>
                  </div>
                  <small>仅支持 https://github.com/owner/repository 格式 · 全程校验下载域名、压缩包与解压路径</small>
                </div>
              )}
            </div>

            <div className="modal-footer">
              {activeJob ? <><div className="modal-progress"><div><strong>{stageLabel(activeJob.stage)}</strong><span>{activeJob.message}</span></div><small>{activeJob.progress}%</small></div><div className="progress-track"><i style={{ width: `${activeJob.progress}%` }} /></div></> : <><span className="status-dot" /><strong>全部分析均在本机完成</strong><small>源码导入上限 {importLimits.max_upload_mb} MB</small></>}
            </div>
          </section>
        </div>
      )}
      {selected && codeViewerResult && (
        <CodeViewer
          projectId={selected.id}
          result={codeViewerResult}
          query={codeViewerQuery || searchResponse?.query || searchQuery}
          onClose={() => setCodeViewerResult(null)}
        />
      )}
    </div>
  );
}

function SnapshotWorkspace({ projectId, onSynchronized }: { projectId: number; onSynchronized: (projectId: number) => Promise<void> }) {
  const [snapshots, setSnapshots] = useState<AnalysisSnapshotSummary[]>([]);
  const [gitSummary, setGitSummary] = useState<ProjectGitSummary | null>(null);
  const [label, setLabel] = useState("");
  const [baseId, setBaseId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [comparison, setComparison] = useState<AnalysisSnapshotComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [gitLoading, setGitLoading] = useState(true);
  const [gitError, setGitError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncJob, setSyncJob] = useState<AnalysisJob | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [baseCommit, setBaseCommit] = useState("");
  const [headCommit, setHeadCommit] = useState("");
  const [gitComparison, setGitComparison] = useState<GitComparison | null>(null);
  const [gitComparing, setGitComparing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applySnapshots = useCallback((items: AnalysisSnapshotSummary[]) => {
    setSnapshots(items);
    setTargetId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null);
    setBaseId((current) => current && items.some((item) => item.id === current) ? current : items[1]?.id ?? null);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    listAnalysisSnapshots(projectId)
      .then((items) => { if (active) applySnapshots(items); })
      .catch((requestError) => { if (active) setError(requestError instanceof Error ? requestError.message : "无法加载分析快照"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, applySnapshots]);

  useEffect(() => {
    let active = true;
    setGitLoading(true);
    setGitError(null);
    getProjectGitSummary(projectId)
      .then((summary) => { if (active) setGitSummary(summary); })
      .catch((requestError) => { if (active) setGitError(requestError instanceof Error ? requestError.message : "无法加载 Git 提交信息"); })
      .finally(() => { if (active) setGitLoading(false); });
    return () => { active = false; };
  }, [projectId]);

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

  async function handleSynchronizeRemote() {
    if (syncing) return;
    setSyncing(true);
    setGitError(null);
    setSyncMessage(null);
    try {
      let job = await synchronizeGitHubProject(projectId);
      setSyncJob(job);
      for (let attempt = 0; attempt < 1_200; attempt += 1) {
        if (job.status === "completed") {
          setSyncMessage(job.message);
          await onSynchronized(projectId);
          const [summary, items] = await Promise.all([
            getProjectGitSummary(projectId),
            listAnalysisSnapshots(projectId),
          ]);
          setGitSummary(summary);
          applySnapshots(items);
          setComparison(null);
          return;
        }
        if (job.status === "failed") {
          throw new Error(formatOperationError("同步远程仓库", 500, job.error || job.message || null));
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        job = await getAnalysisJob(job.id);
        setSyncJob(job);
      }
      throw new Error("远程同步等待超时，请稍后重新打开版本对比页面查看结果。");
    } catch (requestError) {
      setGitError(requestError instanceof Error ? requestError.message : "无法同步远程仓库");
    } finally {
      setSyncing(false);
    }
  }

  async function handleCompareGit() {
    if (!baseCommit || !headCommit || baseCommit === headCommit || gitComparing) return;
    setGitComparing(true);
    setGitError(null);
    try {
      setGitComparison(await compareProjectGitCommits(projectId, baseCommit, headCommit));
    } catch (requestError) {
      setGitError(requestError instanceof Error ? requestError.message : "无法对比 Git 提交");
    } finally {
      setGitComparing(false);
    }
  }

  async function handleCreate() {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await createAnalysisSnapshot(projectId, label);
      const items = await listAnalysisSnapshots(projectId);
      applySnapshots(items);
      setLabel("");
      setComparison(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法保存分析快照");
    } finally {
      setWorking(false);
    }
  }

  async function handleCompare() {
    if (!baseId || !targetId || baseId === targetId || working) return;
    setWorking(true);
    setError(null);
    try {
      setComparison(await compareAnalysisSnapshots(projectId, baseId, targetId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法对比分析快照");
    } finally {
      setWorking(false);
    }
  }

  async function handleDelete(snapshot: AnalysisSnapshotSummary) {
    if (!window.confirm(`删除快照“${snapshot.label}”？此操作不会删除项目源码。`)) return;
    setWorking(true);
    setError(null);
    try {
      await deleteAnalysisSnapshot(projectId, snapshot.id);
      applySnapshots(snapshots.filter((item) => item.id !== snapshot.id));
      setComparison(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法删除分析快照");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="snapshot-workspace">
      <section className="snapshot-git-context" aria-label="GitHub 版本同步与对比">
        <header>
          <div><span>GITHUB_SYNC</span><strong>GitHub 版本同步与对比</strong><small>检查远端最新提交；有更新时安全更新本地源码、重新分析并保存快照。</small></div>
          {gitSummary?.refreshable && <button type="button" onClick={() => void handleSynchronizeRemote()} disabled={syncing}>{syncing ? "正在同步…" : "同步远程仓库"}</button>}
        </header>
        {gitError && <div className="snapshot-git-message error">[ERR] {gitError}</div>}
        {syncing && syncJob && <div className="snapshot-sync-progress"><div><strong>{stageLabel(syncJob.stage)}</strong><span>{syncJob.message}</span></div><small>{syncJob.progress}%</small><div className="progress-track"><i style={{ width: `${syncJob.progress}%` }} /></div></div>}
        {!syncing && syncMessage && <div className="snapshot-git-message success">[OK] {syncMessage}</div>}
        {gitLoading && <div className="snapshot-git-message"><div className="spinner" />正在读取 Git 提交信息…</div>}
        {!gitLoading && !gitError && !syncing && gitSummary && !gitSummary.available && <div className="snapshot-git-message">{gitSummary.refreshable ? "尚未同步 GitHub 提交与源码版本，点击右上角“同步远程仓库”开始检查。" : gitSummary.message}</div>}
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
                <dl><div><dt>质量</dt><dd>{snapshot.score} / {snapshot.grade}</dd></div><div><dt>文件</dt><dd>{formatNumber(snapshot.file_count)}</dd></div><div><dt>符号</dt><dd>{formatNumber(snapshot.symbol_count)}</dd></div><div><dt>问题</dt><dd>{formatNumber(snapshot.finding_count)}</dd></div></dl>
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
  return <div className="snapshot-comparison">
    <header><div><span>DIFF_RESULT</span><strong>{comparison.base.label}</strong></div><i>→</i><div><span>TARGET</span><strong>{comparison.target.label}</strong></div></header>
    <div className="snapshot-metrics">{comparison.metric_changes.map((metric) => <article key={metric.key}><span>{metric.label}</span><strong>{formatNumber(metric.target)}</strong><em className={snapshotMetricTone(metric.key, metric.delta)}>{metric.delta > 0 ? "+" : ""}{formatNumber(metric.delta)}</em><small>{formatNumber(metric.base)} → {formatNumber(metric.target)}</small></article>)}</div>
    <SnapshotGroup title="质量问题" code="QUALITY" group={comparison.quality} />
    <SnapshotGroup title="解析问题" code="PARSER" group={comparison.parse_issues} />
    <SnapshotGroup title="循环依赖" code="CYCLES" group={comparison.cycles} />
  </div>;
}

function SnapshotGroup({ title, code, group }: { title: string; code: string; group: SnapshotComparisonGroup }) {
  const sections = [
    { label: "新增", tone: "new", count: group.new_count, items: group.new_items },
    { label: "已修复", tone: "fixed", count: group.fixed_count, items: group.fixed_items },
    { label: "持续存在", tone: "persistent", count: group.persistent_count, items: group.persistent_items },
  ];
  return <section className="snapshot-group"><header><span>{code}</span><strong>{title}</strong>{group.truncated && <em>仅显示前 100 条</em>}</header><div>{sections.map((section) => <article className={`snapshot-change-${section.tone}`} key={section.tone}><h4>{section.label}<b>{formatNumber(section.count)}</b></h4>{section.items.length === 0 ? <p>无</p> : section.items.map((item, index) => <p key={String(item.key ?? index)}>{snapshotItemLabel(item)}</p>)}</article>)}</div></section>;
}

function snapshotItemLabel(item: Record<string, unknown>): string {
  if (Array.isArray(item.paths)) return item.paths.join(" → ");
  const location = item.start_line ? `${String(item.file_path)}:${String(item.start_line)}` : String(item.file_path ?? "未知位置");
  return `${location} · ${String(item.title ?? item.message ?? item.rule_id ?? "分析项")}`;
}

function snapshotMetricTone(key: string, delta: number): "good" | "bad" | "neutral" {
  if (delta === 0 || ["files", "symbols", "imports"].includes(key)) return "neutral";
  if (key === "score") return delta > 0 ? "good" : "bad";
  return delta < 0 ? "good" : "bad";
}

function snapshotReasonLabel(reason: AnalysisSnapshotSummary["reason"]): string {
  return ({ manual: "MANUAL", import: "IMPORT", full: "FULL", incremental: "INCREMENTAL", sync: "REMOTE_SYNC" } as const)[reason] ?? reason.toUpperCase();
}

function gitFileStatusLabel(status: string): string {
  return ({ added: "新增", modified: "修改", removed: "删除", renamed: "重命名", copied: "复制", changed: "变更", unchanged: "未变化" } as Record<string, string>)[status] ?? "修改";
}

const IMPACT_RELATION_LABELS: Record<string, string> = {
  definition: "定义位置",
  imports_target_module: "直接导入目标模块",
  target_imports_module: "目标导入该模块",
  transitive_caller: "二级影响模块",
  symbol_reference: "源码引用目标符号",
  calls_or_references_symbol: "目标可能调用或引用",
};

function ImpactWorkspace({
  projectId,
  initialTarget,
  onOpenRelation,
}: {
  projectId: number;
  initialTarget: ImpactTarget | null;
  onOpenRelation: (relation: ImpactRelation) => void;
}) {
  const [query, setQuery] = useState(initialTarget?.name ?? "");
  const [targets, setTargets] = useState<ImpactTarget[]>([]);
  const [report, setReport] = useState<ChangeImpact | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadImpact = useCallback(async (target: ImpactTarget) => {
    setLoading(true);
    setError(null);
    setTargets([]);
    try {
      setReport(await getChangeImpact(projectId, target.target_type, target.target_id));
      setQuery(target.name);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "修改影响分析失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (initialTarget) void loadImpact(initialTarget);
  }, [initialTarget, loadImpact]);

  async function handleTargetSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim() || searching) return;
    setSearching(true);
    setError(null);
    setReport(null);
    try {
      setTargets(await searchImpactTargets(projectId, query.trim()));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法搜索分析对象");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="impact-workspace">
      <form className="impact-search" onSubmit={(event) => void handleTargetSearch(event)}>
        <label htmlFor="impact-target-query"><span>TARGET</span>选择要修改的文件、类或函数</label>
        <div>
          <input id="impact-target-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入文件路径、类名或函数名" />
          <button disabled={!query.trim() || searching || loading}>{searching ? "SEARCHING..." : "查找对象"}</button>
        </div>
      </form>
      {error && <div className="impact-error" role="alert">[ERR] {error}</div>}
      {searching && <div className="mini-empty"><div className="spinner" />正在查找文件和符号…</div>}
      {!searching && targets.length > 0 && (
        <div className="impact-target-list" aria-label="影响分析对象">
          {targets.map((target) => (
            <button type="button" key={`${target.target_type}:${target.target_id}`} onClick={() => void loadImpact(target)}>
              <span className={`kind-badge kind-${target.kind}`}>{target.target_type === "file" ? "FI" : target.kind.slice(0, 2).toUpperCase()}</span>
              <div><strong>{target.name}</strong><small>{target.file_path} · 第 {target.start_line}–{target.end_line} 行</small></div>
              <em>ANALYZE →</em>
            </button>
          ))}
        </div>
      )}
      {!searching && !loading && !report && targets.length === 0 && (
        <div className="impact-empty">
          <span>◎</span>
          <h3>从一个具体修改对象开始</h3>
          <p>搜索文件、类、接口、函数或方法，或者在“仓库概览”的文件和符号列表中点击“影响”。</p>
        </div>
      )}
      {loading && <div className="mini-empty"><div className="spinner" />正在追踪调用者、依赖和相关测试…</div>}
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
            <ImpactRelationGroup title="相关测试" code="TESTS" items={report.related_tests} onOpen={onOpenRelation} />
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

function FileTree({ projectId, totalFiles, onAnalyzeImpact }: { projectId: number; totalFiles: number; onAnalyzeImpact: (target: ImpactTarget) => void }) {
  const [root, setRoot] = useState<ProjectFileTreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRoot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRoot(await getProjectFileTree(projectId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法读取仓库文件目录");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  if (loading && !root) return <div className="mini-empty"><div className="spinner" />正在读取仓库根目录…</div>;
  if (error && !root) {
    return <div className="mini-empty"><span>{error}</span><button type="button" className="file-tree-retry" onClick={() => void loadRoot()}>[ RETRY ]</button></div>;
  }
  if (!root?.items.length) return <div className="mini-empty">当前仓库没有可展示的文件</div>;

  return (
    <>
      <div className="structure-list-summary file-tree-summary">
        <span className="structure-summary-prompt">&gt; tree --lazy</span>
        <span>indexed</span>
        <strong>{formatNumber(root.total_files || totalFiles)}</strong>
        <span>files · 展开目录时按需读取</span>
      </div>
      <div className="file-tree" role="tree" aria-label="仓库文件树">
        {root.items.map((node) => <FileTreeNodeView key={`${node.kind}:${node.path}`} projectId={projectId} node={node} onAnalyzeImpact={onAnalyzeImpact} />)}
      </div>
    </>
  );
}

function FileTreeNodeView({ projectId, node, onAnalyzeImpact }: { projectId: number; node: ProjectFileTreeNode; onAnalyzeImpact: (target: ImpactTarget) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<ProjectFileTreeNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (node.kind === "file") {
    return (
      <div className="file-tree-file" role="treeitem" title={node.path}>
        <span className="file-tree-branch">├</span>
        <span className="file-symbol">⌑</span>
        <strong>{node.name}</strong>
        <span>{node.language ?? "Text"}</span>
        <small>{formatNumber(node.line_count ?? 0)} 行</small>
        <small>{formatBytes(node.size_bytes ?? 0)}</small>
        <button type="button" className="file-tree-impact-button" onClick={() => onAnalyzeImpact({ target_type: "file", target_id: node.id!, file_id: node.id!, file_path: node.path, name: node.path, kind: "file", start_line: 1, end_line: Math.max(1, node.line_count ?? 1) })}>影响</button>
      </div>
    );
  }

  async function loadChildren() {
    setLoading(true);
    setError(null);
    try {
      const response = await getProjectFileTree(projectId, node.path);
      setChildren(response.items);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法读取该目录");
    } finally {
      setLoading(false);
    }
  }

  async function toggleDirectory() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (children === null) await loadChildren();
  }

  return (
    <div className="file-tree-directory" role="treeitem" aria-expanded={expanded}>
      <button
        type="button"
        className="file-tree-directory-button"
        aria-expanded={expanded}
        aria-label={`${node.name} 目录，${node.file_count} 个文件，${expanded ? "点击折叠" : "点击展开"}`}
        onClick={() => void toggleDirectory()}
      >
        <span className="file-tree-toggle">{expanded ? "▾" : "▸"}</span>
        <span className="file-tree-folder">{expanded ? "▱" : "□"}</span>
        <strong>{node.name}</strong>
        <small>{formatNumber(node.file_count)} 个文件</small>
      </button>
      {expanded && (
        <div className="file-tree-children" role="group">
          {loading && <div className="file-tree-loading"><div className="spinner" />正在读取目录…</div>}
          {error && <div className="file-tree-loading"><span>{error}</span><button type="button" className="file-tree-retry" onClick={() => void loadChildren()}>[ RETRY ]</button></div>}
          {!loading && !error && children?.map((child) => <FileTreeNodeView key={`${child.kind}:${child.path}`} projectId={projectId} node={child} onAnalyzeImpact={onAnalyzeImpact} />)}
          {!loading && !error && children?.length === 0 && <div className="file-tree-loading">空目录</div>}
        </div>
      )}
    </div>
  );
}

function describeParseIssueInChinese(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("syntax error")) {
    return "代码解析器检测到语法错误，该文件的符号和依赖统计可能不完整。";
  }
  if (normalized.includes("2 mb") || normalized.includes("parser limit")) {
    return "该文件超过 2 MB 解析上限，系统已跳过其代码结构分析。";
  }
  if (normalized.includes("outside the managed repository")) {
    return "文件路径超出当前仓库的受管目录，系统已因安全限制停止读取。";
  }
  if (normalized.includes("parser failed")) {
    return "读取文件或调用语法解析器时发生异常，未能提取完整的代码结构。";
  }
  return "分析器处理该文件时出现异常，相关结构统计结果可能不完整。";
}

function ParseIssueRow({ issue }: { issue: ParseIssue }) {
  return (
    <div className="issue-row">
      <span>!</span>
      <div>
        <strong>{issue.file_path}</strong>
        <small>{issue.message}</small>
        <p className="issue-chinese-note"><b>中文说明：</b>{describeParseIssueInChinese(issue.message)}</p>
      </div>
    </div>
  );
}

function ProviderWorkspace({
  generators,
  selectedReportProvider,
  selectedQaProvider,
  loading,
  onSelectReportProvider,
  onSelectQaProvider,
  onConfigureGenerator,
  onTestGenerator,
}: {
  generators: ReportGenerator[];
  selectedReportProvider: string;
  selectedQaProvider: string;
  loading: boolean;
  onSelectReportProvider: (generator: string) => void;
  onSelectQaProvider: (generator: string) => void;
  onConfigureGenerator: (generator: string, configuration: ReportGeneratorConfiguration) => Promise<ReportGenerator>;
  onTestGenerator: (generator: string) => Promise<ReportGeneratorTestResult>;
}) {
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState({ base_url: "", model: "", api_key: "" });
  const [configurationBusy, setConfigurationBusy] = useState<"save" | "test" | null>(null);
  const [configurationMessage, setConfigurationMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const configuringProvider = generators.find((generator) => generator.id === configuringId);
  const qaGenerators = generators.filter((generator) => generator.id !== "local");
  const selectedQaModel = qaGenerators.some((generator) => generator.id === selectedQaProvider && generator.available)
    ? selectedQaProvider
    : "";

  function openConfiguration(generator: ReportGenerator) {
    setConfiguringId(generator.id);
    setConfigDraft({ base_url: generator.base_url, model: generator.model, api_key: "" });
    setConfigurationMessage(null);
  }

  async function saveConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configuringProvider) return;
    setConfigurationBusy("save");
    setConfigurationMessage(null);
    try {
      const provider = await onConfigureGenerator(configuringProvider.id, {
        base_url: configDraft.base_url,
        model: configDraft.model,
        api_key: configDraft.api_key || undefined,
      });
      setConfigDraft({ base_url: provider.base_url, model: provider.model, api_key: "" });
      setConfigurationMessage({ tone: "success", text: "配置已保存到本机后端，请继续测试连接。" });
    } catch (requestError) {
      setConfigurationMessage({ tone: "error", text: requestError instanceof Error ? requestError.message : "配置保存失败" });
    } finally {
      setConfigurationBusy(null);
    }
  }

  async function testConfiguration() {
    if (!configuringProvider) return;
    setConfigurationBusy("test");
    setConfigurationMessage(null);
    try {
      const result = await onTestGenerator(configuringProvider.id);
      setConfigurationMessage({ tone: result.ok ? "success" : "error", text: result.message });
    } catch (requestError) {
      setConfigurationMessage({ tone: "error", text: requestError instanceof Error ? requestError.message : "连接测试失败" });
    } finally {
      setConfigurationBusy(null);
    }
  }

  return (
    <div className="report-workspace provider-workspace">
      <section className="report-generator-section" aria-labelledby="report-generator-title">
        <div className="report-section-heading">
          <div><span>MODEL_PROVIDER_REGISTRY</span><h3 id="report-generator-title">统一模型与 API 配置</h3></div>
          <small>一次配置，同时供分析报告与智能问答使用</small>
        </div>
        <div className="provider-usage-grid">
          <label>
            <span>REPORT_DEFAULT</span>
            <strong>分析报告默认模型</strong>
            <select aria-label="分析报告默认模型" value={selectedReportProvider} onChange={(event) => onSelectReportProvider(event.target.value)}>
              {generators.map((generator) => <option key={generator.id} value={generator.id} disabled={!generator.available}>{generator.name}{generator.available ? "" : "（未配置）"}</option>)}
            </select>
          </label>
          <label>
            <span>QA_DEFAULT</span>
            <strong>智能问答默认模型</strong>
            <select aria-label="智能问答默认模型" value={selectedQaModel} disabled={!qaGenerators.some((generator) => generator.available)} onChange={(event) => onSelectQaProvider(event.target.value)}>
              {!selectedQaModel && <option value="">请先配置生成模型</option>}
              {qaGenerators.map((generator) => <option key={generator.id} value={generator.id} disabled={!generator.available}>{generator.name}{generator.available ? "" : "（未配置）"}</option>)}
            </select>
            <small>智能问答不支持本地规则引擎，必须使用 Ollama 或在线模型。</small>
          </label>
        </div>
        <div className="report-generator-grid">
          {generators.map((generator) => (
            <article
              key={generator.id}
              className={`report-generator-card ${selectedReportProvider === generator.id || selectedQaProvider === generator.id ? "active" : ""} ${!generator.available ? "unavailable" : ""}`}
            >
              <div className="provider-select-button">
                <span className={`generator-status status-${generator.connection_status}`}>{providerStatusLabel(generator)}</span>
                <strong>{generator.name}</strong>
                <p>{generator.description}</p>
                <code>{generator.base_url}{generator.endpoint}</code>
                <em>{generator.cost_label}</em>
                <div className="provider-usage-tags">
                  {selectedReportProvider === generator.id && <span>REPORT</span>}
                  {generator.id !== "local" && selectedQaProvider === generator.id && <span>Q&amp;A</span>}
                </div>
              </div>
              <div className="provider-card-footer">
                {generator.requires_configuration
                  ? <button onClick={() => openConfiguration(generator)}>{generator.configured ? "修改 API 配置" : "配置 API"}</button>
                  : <span>无需配置</span>}
                {generator.model && <small>{generator.model}</small>}
              </div>
            </article>
          ))}
          {loading && generators.length === 0 && <div className="report-provider-loading"><div className="spinner" />正在读取接口配置…</div>}
        </div>
        {configuringProvider && (
          <form className="provider-config-panel" onSubmit={(event) => void saveConfiguration(event)}>
            <div className="provider-config-heading">
              <div><span>PROVIDER_CONFIG</span><h3>配置 {configuringProvider.name}</h3></div>
              <button type="button" aria-label="关闭 API 配置" onClick={() => setConfiguringId(null)}>×</button>
            </div>
            <div className="provider-config-fields">
              <label>
                <span>API 服务地址</span>
                <input value={configDraft.base_url} onChange={(event) => setConfigDraft((current) => ({ ...current, base_url: event.target.value }))} placeholder={providerBaseUrlPlaceholder(configuringProvider.id)} disabled={configurationBusy !== null} />
              </label>
              <label>
                <span>模型名称</span>
                <input value={configDraft.model} onChange={(event) => setConfigDraft((current) => ({ ...current, model: event.target.value }))} placeholder={configuringProvider.id === "ollama" ? "填写 ollama list 中的模型名称" : "填写账号可用的模型 ID"} disabled={configurationBusy !== null} />
              </label>
              {configuringProvider.id !== "ollama" && (
                <label className="provider-key-field">
                  <span>API Key</span>
                  <input type="password" autoComplete="new-password" value={configDraft.api_key} onChange={(event) => setConfigDraft((current) => ({ ...current, api_key: event.target.value }))} placeholder={configuringProvider.has_api_key ? "已安全保存；留空表示不修改" : "输入 API Key（不会回显）"} disabled={configurationBusy !== null} />
                </label>
              )}
            </div>
            <div className="provider-config-security"><strong>SECURITY</strong> 密钥仅发送到本机后端，并保存在 Git 忽略的数据目录中；接口永远不会向浏览器回传密钥内容。</div>
            {configurationMessage && <div className={`provider-config-message ${configurationMessage.tone}`} role="status">{configurationMessage.text}</div>}
            <div className="provider-config-actions">
              <button type="button" className="secondary-button" onClick={() => void testConfiguration()} disabled={configurationBusy !== null || !configuringProvider.configured}>{configurationBusy === "test" ? "测试中…" : "测试连接"}</button>
              <button
                type="submit"
                className="primary-button"
                disabled={
                  configurationBusy !== null
                  || !configDraft.base_url.trim()
                  || !configDraft.model.trim()
                  || (configuringProvider.id !== "ollama" && !configuringProvider.has_api_key && !configDraft.api_key.trim())
                }
              >{configurationBusy === "save" ? "保存中…" : "保存配置"}</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function ReportWorkspace({
  generators,
  selectedGenerator,
  selectedMode,
  report,
  loading,
  exporting,
  onSelectGenerator,
  onSelectMode,
  onGenerate,
  onExport,
}: {
  generators: ReportGenerator[];
  selectedGenerator: string;
  selectedMode: "summary" | "full";
  report: GeneratedReport | null;
  loading: boolean;
  exporting: boolean;
  onSelectGenerator: (generator: string) => void;
  onSelectMode: (mode: "summary" | "full") => void;
  onGenerate: () => void;
  onExport: () => void;
}) {
  const selectedProvider = generators.find((generator) => generator.id === selectedGenerator);
  return (
    <div className="report-workspace">

      <section className="report-preview-section" aria-labelledby="report-preview-title">
        <div className="report-toolbar">
          <div>
            <span>MARKDOWN_OUTPUT</span>
            <h3 id="report-preview-title">报告预览</h3>
            {report && <small>{report.filename} · {formatDate(report.generated_at)}</small>}
          </div>
          <div className="report-actions">
            <label className="report-mode-select">
              <span>分析模型</span>
              <select aria-label="报告分析模型" value={selectedGenerator} disabled={loading || exporting} onChange={(event) => onSelectGenerator(event.target.value)}>
                {generators.map((generator) => <option key={generator.id} value={generator.id} disabled={!generator.available}>{generator.name}{generator.available ? "" : "（未配置）"}</option>)}
              </select>
            </label>
            <label className="report-mode-select">
              <span>报告范围</span>
              <select
                aria-label="报告范围"
                value={selectedMode}
                disabled={loading || exporting}
                onChange={(event) => onSelectMode(event.target.value as "summary" | "full")}
              >
                <option value="summary">摘要报告（推荐）</option>
                <option value="full">完整报告</option>
              </select>
            </label>
            <button className="secondary-button" onClick={onGenerate} disabled={loading || exporting || !selectedProvider?.available}>
              <span>↻</span>{loading ? "分析中…" : selectedProvider?.id === "local" ? "重新生成" : "使用当前 API 生成"}
            </button>
            <button className="primary-button report-export-button" title="打开系统保存窗口并选择导出路径" onClick={onExport} disabled={!report || loading || exporting}>
              <span>↓</span>{exporting ? "正在保存…" : "导出 MD"}
            </button>
          </div>
        </div>
        {loading && !report && <div className="report-preview-empty"><div className="spinner" /><strong>正在进行针对性智能分析</strong><span>综合项目结构、依赖热点、质量评分与测试信号…</span></div>}
        {!loading && !report && <div className="report-preview-empty"><strong>{selectedProvider?.available ? "尚未生成报告" : "当前接口尚未配置"}</strong><span>{selectedProvider?.available ? "点击生成按钮，使用当前模型分析项目。" : "请前往“API 配置”菜单完成配置和连接测试。"}</span></div>}
        {report && <pre className="report-preview" aria-label="Markdown 报告预览">{report.content}</pre>}
        <div className="report-save-note"><span>PATH</span> 导出时会打开系统保存窗口，可选择目录和文件名；不支持该能力的浏览器将保存到默认下载目录。</div>
      </section>
    </div>
  );
}

function providerBaseUrlPlaceholder(providerId: string): string {
  return {
    ollama: "http://127.0.0.1:11434",
    "openai-compatible": "https://api.openai.com/v1",
    "openai-chat-compatible": "https://api.deepseek.com",
    anthropic: "https://api.anthropic.com/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta",
  }[providerId] ?? "https://api.example.com/v1";
}

function providerStatusLabel(generator: ReportGenerator): string {
  if (generator.id === "local") return "● READY";
  if (!generator.configured) return "○ NEED_CONFIG";
  if (generator.connection_status === "success") return "● CONNECTED";
  if (generator.connection_status === "failed") return "× CONNECTION_FAILED";
  return "◐ CONFIGURED";
}

function StatCard({ label, value, meta, tone }: { label: string; value: string; meta: string; tone: string }) {
  return <article className={`stat-card ${tone}`}><div className="stat-accent" /><span>{label}</span><strong>{value}</strong><small>{meta}</small></article>;
}

function JobProgress({ job }: { job: AnalysisJob }) {
  return <section className="job-progress"><div className="job-progress-icon">↻</div><div className="job-progress-main"><div><strong>{stageLabel(job.stage)}</strong><span>{job.message}</span><small>{job.source_label}</small></div><div className="progress-track"><i style={{ width: `${job.progress}%` }} /></div></div><em>{job.progress}%</em></section>;
}

function IncrementalSummary({ result }: { result: IncrementalAnalysisResult }) {
  const noChanges = result.added_file_count + result.changed_file_count + result.deleted_file_count === 0;
  return <div className={`incremental-summary ${noChanges ? "no-changes" : ""}`}><div><strong>{noChanges ? "仓库没有文件变化" : "增量分析完成"}</strong><span>{noChanges ? `已校验并跳过 ${result.unchanged_file_count} 个未变化文件` : `实际重新解析 ${result.parsed_file_count} 个文件`}</span></div><div className="incremental-counts"><span><b>＋{result.added_file_count}</b>新增</span><span><b>△{result.changed_file_count}</b>修改</span><span><b>－{result.deleted_file_count}</b>删除</span><span><b>{result.unchanged_file_count}</b>跳过</span></div><em>{result.elapsed_ms.toFixed(1)} ms</em></div>;
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    queued: "任务排队中",
    checking_remote: "正在检查远端版本",
    downloading_update: "正在下载远端更新",
    staging_analysis: "正在验证新版本",
    sync_scanning: "正在扫描新版本",
    sync_parsing: "正在解析新版本",
    sync_indexing: "正在建立新版本索引",
    sync_finalizing: "正在切换新版本",
    up_to_date: "已是最新版本",
    synchronized: "远程同步完成",
    downloading: "正在下载仓库",
    preparing: "正在准备文件",
    scanning: "正在扫描仓库",
    parsing: "正在解析代码结构",
    indexing: "正在建立搜索索引",
    finalizing: "正在整理结果",
    completed: "分析完成",
    failed: "分析失败",
  };
  return labels[stage] ?? "后台分析中";
}

function LanguageBadge({ language }: { language: string | null }) {
  const key = (language ?? "text").toLowerCase().replaceAll("#", "sharp").replaceAll("+", "p");
  return <span className={`language-badge lang-${key}`}><i />{language ?? "Text"}</span>;
}

type QaTerminalMessage = {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  response?: RepositoryAnswer;
  retryQuestion?: string;
};

function qaGroundingLabel(status: RepositoryAnswer["grounding_status"]): string {
  if (status === "project_context") return "项目上下文";
  if (status === "insufficient") return "证据不足";
  if (status === "reference_failed") return "引用校验失败";
  return "证据已校验";
}

function qaConfidenceLabel(confidence: RepositoryAnswer["confidence"]): string {
  return confidence === "high" ? "高置信" : confidence === "medium" ? "中置信" : "低置信";
}

function RepositoryQaTerminal({
  projectId,
  projectName,
  providers,
  selectedProvider,
  onSelectProvider,
  onOpenProviders,
  onClose,
  onOpenCitation,
}: {
  projectId: number;
  projectName: string;
  providers: ReportGenerator[];
  selectedProvider: string;
  onSelectProvider: (provider: string) => void;
  onOpenProviders: () => void;
  onClose: () => void;
  onOpenCitation: (citation: RepositoryCitation, citationIndex: number) => void;
}) {
  const [messages, setMessages] = useState<QaTerminalMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const messageIdRef = useRef(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const qaProviders = providers.filter((item) => item.id !== "local");
  const provider = qaProviders.find((item) => item.id === selectedProvider && item.available);
  const modelReady = Boolean(provider);

  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [messages, loading]);

  async function submitQuestion(value = question) {
    const normalized = value.trim();
    if (!normalized || loading || !modelReady) return;
    if (normalized === "/clear") {
      setMessages([]);
      setQuestion("");
      return;
    }
    const userMessage: QaTerminalMessage = { id: ++messageIdRef.current, role: "user", content: normalized };
    const history = messages
      .filter((item): item is QaTerminalMessage & { role: "user" | "assistant" } => item.role !== "system")
      .map((item) => ({ role: item.role, content: item.content }));
    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setLoading(true);
    try {
      const response = await askRepository(projectId, normalized, selectedProvider, history);
      setMessages((current) => [...current, {
        id: ++messageIdRef.current,
        role: "assistant",
        content: response.answer,
        response,
      }]);
    } catch (requestError) {
      setMessages((current) => [...current, {
        id: ++messageIdRef.current,
        role: "system",
        content: requestError instanceof Error ? requestError.message : "智能问答请求失败",
        retryQuestion: normalized,
      }]);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitQuestion();
  }

  return (
    <section className="qa-terminal" id="repository-qa-terminal" aria-label="智能问答终端">
      <header className="qa-terminal-bar">
        <div className="qa-terminal-title"><strong>DevAtlas 智能问答</strong><span>{projectName}</span></div>
        <label className="qa-provider-select">
          <span>MODEL</span>
          <select aria-label="智能问答模型" value={modelReady ? selectedProvider : ""} disabled={loading || qaProviders.length === 0} onChange={(event) => onSelectProvider(event.target.value)}>
            {!modelReady && <option value="">未配置生成模型</option>}
            {qaProviders.map((item) => <option key={item.id} value={item.id} disabled={!item.available}>{item.name}{item.available ? "" : "（未配置）"}</option>)}
          </select>
        </label>
        <button type="button" className="qa-panel-close" onClick={onClose} aria-label="关闭智能问答面板">×</button>
      </header>
      <div className="qa-transcript" ref={transcriptRef} aria-live="polite">
        {!messages.length && (
          <div className="qa-welcome">
            <p>DevAtlas Repository Shell</p>
            <p>当前仓库：{projectName}</p>
            {modelReady
              ? <p>当前模型：{provider?.name} · 输入问题并按 Enter，/clear 清空会话。</p>
              : (
                <div className="qa-model-required" role="alert">
                  <strong>[MODEL_REQUIRED] 智能问答必须连接生成模型。</strong>
                  <span>请先配置 Ollama 或在线模型 API。</span>
                  <button type="button" onClick={onOpenProviders}>[ 配置生成模型 ]</button>
                </div>
              )}
          </div>
        )}
        {messages.map((message) => (
          <article className={`qa-message qa-${message.role}`} key={message.id}>
            <div className="qa-message-prompt">
              <span>{message.role === "user" ? `${projectName} $` : message.role === "assistant" ? "devatlas >" : "system !"}</span>
              {message.role === "user" && <strong>{message.content}</strong>}
            </div>
            {message.role !== "user" && <div className="qa-answer-text">{message.content}</div>}
            {message.response && (
              <div className={`qa-answer-meta qa-grounding-${message.response.grounding_status}`}>
                <span>[{qaGroundingLabel(message.response.grounding_status)}]</span>
                <b>{qaConfidenceLabel(message.response.confidence)}</b>
                <small>{message.response.evidence_count} 条证据 · {message.response.reference_count} 个有效引用 · {message.response.elapsed_ms.toFixed(1)} ms</small>
              </div>
            )}
            {message.retryQuestion && (
              <button
                type="button"
                className="qa-retry-button"
                disabled={loading || !modelReady}
                onClick={() => void submitQuestion(message.retryQuestion)}
              >[ 使用当前模型重试 ]</button>
            )}
            {message.response && (
              <div className="qa-citations">
                {message.response.citations.map((citation, index) => (
                  <button type="button" key={`${citation.file_id}-${citation.start_line}-${index}`} onClick={() => onOpenCitation(citation, index)}>
                    <b>[{index + 1}]</b> {citation.file_path}:{citation.start_line}-{citation.end_line}
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}
        {loading && <div className="qa-thinking"><span>devatlas &gt;</span><i /><i /><i /><small>{`正在检索仓库证据并调用 ${provider?.name ?? "生成模型"}`}</small></div>}
      </div>
      <form className="qa-command-line" onSubmit={handleSubmit}>
        <span>PS {projectName}&gt;</span>
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={2000}
          aria-label="输入仓库问题"
          autoFocus
          disabled={loading || !modelReady}
        />
      </form>
    </section>
  );
}

function DependencyGraphView({ projectId, graph }: { projectId: number; graph: DependencyGraph }) {
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(graph.nodes[0]?.id ?? null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [selectedCycleIndex, setSelectedCycleIndex] = useState<number | null>(null);
  const [focusedGraph, setFocusedGraph] = useState<DependencyGraph | null>(null);
  const [cycleFocusLoading, setCycleFocusLoading] = useState(false);
  const [cycleFocusError, setCycleFocusError] = useState<string | null>(null);
  const [moduleFilter, setModuleFilter] = useState("");
  const [zoom, setZoom] = useState(1);
  const cycleFocusRequestRef = useRef(0);
  const activeGraph = focusedGraph ?? graph;
  const width = 900;
  const height = 500;
  const centerX = 440;
  const centerY = 245;
  const cycleNodeIds = useMemo(
    () => new Set(graph.cycles.flatMap((cycle) => cycle.file_ids)),
    [graph.cycles],
  );
  const cyclicEdgeKeys = useMemo(() => {
    const keys = new Set<string>();
    graph.cycles.forEach((cycle) => {
      const members = new Set(cycle.file_ids);
      activeGraph.edges.forEach((edge) => {
        if (members.has(edge.source_id) && members.has(edge.target_id)) keys.add(dependencyEdgeKey(edge));
      });
    });
    return keys;
  }, [activeGraph.edges, graph.cycles]);
  const selectedCycle = selectedCycleIndex === null ? null : graph.cycles[selectedCycleIndex] ?? null;
  const displayedNodes = useMemo(() => {
    const query = moduleFilter.trim().toLowerCase();
    return activeGraph.nodes.filter((node) => !query || node.path.toLowerCase().includes(query));
  }, [activeGraph.nodes, moduleFilter]);
  const displayedNodeIds = useMemo(() => new Set(displayedNodes.map((node) => node.id)), [displayedNodes]);
  const displayedEdges = useMemo(
    () => activeGraph.edges.filter((edge) => displayedNodeIds.has(edge.source_id) && displayedNodeIds.has(edge.target_id)),
    [activeGraph.edges, displayedNodeIds],
  );
  const displayedEdgeKeys = useMemo(() => new Set(displayedEdges.map(dependencyEdgeKey)), [displayedEdges]);
  const positions = useMemo(() => {
    const result = new Map<number, { x: number; y: number }>();
    displayedNodes.forEach((node, index) => {
      if (index === 0) {
        result.set(node.id, { x: centerX, y: centerY });
        return;
      }
      const innerCount = Math.min(12, Math.max(0, displayedNodes.length - 1));
      const inner = index <= innerCount;
      const ringIndex = inner ? index - 1 : index - innerCount - 1;
      const ringCount = inner ? innerCount : displayedNodes.length - innerCount - 1;
      const angle = (Math.PI * 2 * ringIndex) / Math.max(1, ringCount) - Math.PI / 2;
      const radiusX = inner ? 190 : 350;
      const radiusY = inner ? 145 : 215;
      result.set(node.id, {
        x: centerX + Math.cos(angle) * radiusX,
        y: centerY + Math.sin(angle) * radiusY,
      });
    });
    return result;
  }, [displayedNodes]);
  const selectedNode = displayedNodes.find((node) => node.id === selectedNodeId) ?? displayedNodes[0] ?? null;
  const selectedEdges = displayedEdges.filter(
    (edge) => edge.source_id === selectedNode?.id || edge.target_id === selectedNode?.id,
  );
  const selectedEdge = displayedEdges.find((edge) => dependencyEdgeKey(edge) === selectedEdgeKey) ?? null;
  const nodeById = useMemo(() => new Map(displayedNodes.map((node) => [node.id, node])), [displayedNodes]);

  function clearCycleFocus() {
    cycleFocusRequestRef.current += 1;
    setSelectedCycleIndex(null);
    setFocusedGraph(null);
    setCycleFocusLoading(false);
    setCycleFocusError(null);
    setModuleFilter("");
    setSelectedEdgeKey(null);
    setSelectedNodeId(graph.nodes[0]?.id ?? null);
    setZoom(1);
  }

  async function loadCycleFocus(index: number) {
    const requestId = ++cycleFocusRequestRef.current;
    setSelectedCycleIndex(index);
    setFocusedGraph(null);
    setCycleFocusLoading(true);
    setCycleFocusError(null);
    setModuleFilter("");
    setSelectedEdgeKey(null);
    setZoom(1);
    try {
      const response = await getDependencyGraph(projectId, 40, index + 1);
      if (cycleFocusRequestRef.current !== requestId) return;
      setFocusedGraph(response);
      setSelectedNodeId(response.nodes[0]?.id ?? null);
    } catch (requestError) {
      if (cycleFocusRequestRef.current !== requestId) return;
      setCycleFocusError(requestError instanceof Error ? requestError.message : "无法加载所选循环依赖");
    } finally {
      if (cycleFocusRequestRef.current === requestId) setCycleFocusLoading(false);
    }
  }

  function selectCycle(index: number) {
    if (selectedCycleIndex === index && !cycleFocusError) {
      clearCycleFocus();
      return;
    }
    void loadCycleFocus(index);
  }

  if (graph.nodes.length === 0) {
    return <div className="dependency-empty"><div className="empty-glyph">◇</div><h3>没有项目内依赖</h3><p>当前仓库只有外部依赖，或导入路径暂时无法解析到项目文件。</p></div>;
  }

  return (
    <div className="dependency-view">
      <div className="dependency-stats">
        <div><strong>{formatNumber(graph.total_node_count)}</strong><span>关联模块</span></div>
        <div><strong>{formatNumber(graph.total_edge_count)}</strong><span>依赖边</span></div>
        <div><strong>{formatNumber(graph.internal_import_count)}</strong><span>内部导入</span></div>
        <div className={graph.cycle_count ? "warning" : ""}><strong>{formatNumber(graph.cycle_count)}</strong><span>循环依赖</span></div>
      </div>
      <div className={`graph-confidence confidence-${graph.confidence_level ?? "low"}`} role="status">
        <div><strong>依赖分类可信度 {Number(graph.classification_confidence ?? 0).toFixed(1)}%</strong><span>{dependencyConfidenceLabel(graph.confidence_level)}</span></div>
        <p>项目内 {formatNumber(graph.internal_import_count)} · 推定外部 {formatNumber(graph.external_import_count)} · 待确认 {formatNumber(graph.unresolved_import_count ?? 0)}</p>
      </div>
      {graph.truncated && <div className="graph-notice">仓库规模较大，图中优先展示循环模块和连接度最高的 {graph.nodes.length} 个文件。</div>}
      <div className="graph-toolbar">
        <label><span>筛选模块</span><input value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)} placeholder="输入文件名或路径" /></label>
        <small>当前显示 {displayedNodes.length} 个模块 / {displayedEdges.length} 条边</small>
        {selectedCycle && <button type="button" className="graph-clear-focus" onClick={clearCycleFocus}>退出循环聚焦</button>}
        <div className="zoom-controls"><button onClick={() => setZoom((value) => Math.max(1, value - .25))} disabled={zoom <= 1}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((value) => Math.min(2.5, value + .25))} disabled={zoom >= 2.5}>＋</button></div>
      </div>
      {selectedCycle && !cycleFocusError && (
        <div className="graph-focus-status" role="status" aria-busy={cycleFocusLoading}>
          <strong>FOCUS_CYCLE_{selectedCycleIndex! + 1}</strong>
          <span>{cycleFocusLoading ? "正在加载该循环的完整节点和依赖边…" : `图中仅保留该循环的 ${displayedNodes.length} 个节点和 ${displayedEdges.length} 条内部依赖边`}</span>
        </div>
      )}
      {cycleFocusError && (
        <div className="graph-focus-error" role="alert">
          <span>{cycleFocusError}</span>
          <button type="button" onClick={() => void loadCycleFocus(selectedCycleIndex!)}>重试</button>
          <button type="button" onClick={clearCycleFocus}>取消</button>
        </div>
      )}
      <div className="graph-legend" role="note" aria-label="依赖图图例">
        <strong>A → B 表示 A 导入并依赖 B</strong>
        <b className="legend-group-label">NODE</b>
        <span><i className="legend-node ordinary" />普通模块</span>
        <span><i className="legend-node cyclic" />循环模块</span>
        <span><i className="legend-node selected" />当前选中</span>
        <span><i className="legend-node cyclic-selected" />选中的循环模块</span>
        <b className="legend-group-label">EDGE</b>
        <span><i className="legend-edge outgoing" />当前模块依赖</span>
        <span><i className="legend-edge incoming" />依赖当前模块</span>
        <span><i className="legend-edge cyclic" />循环依赖边</span>
      </div>
      <div className="dependency-layout">
        <div className="dependency-canvas" aria-busy={cycleFocusLoading}>
          <svg viewBox={`${centerX - width / zoom / 2} ${centerY - height / zoom / 2} ${width / zoom} ${height / zoom}`} role="img" aria-label="项目模块依赖图">
            <defs>
              <marker id="dependency-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
              <marker id="dependency-arrow-outgoing" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
              <marker id="dependency-arrow-incoming" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
              <marker id="dependency-arrow-cyclic" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
            </defs>
            {displayedEdges.map((edge) => {
              const source = positions.get(edge.source_id);
              const target = positions.get(edge.target_id);
              const sourceNode = nodeById.get(edge.source_id);
              const targetNode = nodeById.get(edge.target_id);
              if (!source || !target || !sourceNode || !targetNode) return null;
              const outgoing = edge.source_id === selectedNode?.id;
              const incoming = edge.target_id === selectedNode?.id;
              const edgeKey = dependencyEdgeKey(edge);
              const cyclic = cyclicEdgeKeys.has(edgeKey);
              const reverseExists = displayedEdgeKeys.has(`${edge.target_id}-${edge.source_id}`);
              const geometry = dependencyEdgeGeometry(
                source,
                target,
                dependencyNodeRadius(sourceNode),
                dependencyNodeRadius(targetNode),
                reverseExists ? (edge.source_id < edge.target_id ? 30 : -30) : (edge.source_id < edge.target_id ? 12 : -12),
              );
              const isSelected = edgeKey === selectedEdgeKey;
              const marker = cyclic ? "dependency-arrow-cyclic" : outgoing ? "dependency-arrow-outgoing" : incoming ? "dependency-arrow-incoming" : "dependency-arrow";
              return (
                <g
                  key={edgeKey}
                  className={`dependency-edge ${outgoing ? "outgoing" : ""} ${incoming ? "incoming" : ""} ${cyclic ? "cyclic" : ""} ${isSelected ? "selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${edge.source_path} 导入并依赖 ${edge.target_path}，${edge.import_count} 条导入`}
                  onClick={() => setSelectedEdgeKey(edgeKey)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedEdgeKey(edgeKey);
                    }
                  }}
                >
                  <title>{edge.source_path} → {edge.target_path} · {edge.import_count} 条导入 · 第 {edge.line_numbers.join("、")} 行{cyclic ? " · 循环依赖边" : ""}</title>
                  <path className="edge-hit-area" d={geometry.path} />
                  <path className="edge-line" d={geometry.path} markerEnd={`url(#${marker})`} />
                  <text className="edge-label" x={geometry.label.x} y={geometry.label.y - 5} textAnchor="middle">×{edge.import_count}</text>
                </g>
              );
            })}
            {displayedNodes.map((node, index) => {
              const position = positions.get(node.id)!;
              const radius = dependencyNodeRadius(node);
              const isSelected = node.id === selectedNode?.id;
              const label = shortFileName(node.path);
              return (
                <g key={node.id} className={`dependency-node ${isSelected ? "selected" : ""} ${cycleNodeIds.has(node.id) ? "cyclic" : ""}`} onClick={() => { setSelectedNodeId(node.id); setSelectedEdgeKey(null); }}>
                  <title>{node.path} · 入度 {node.in_degree} / 出度 {node.out_degree}</title>
                  <circle cx={position.x} cy={position.y} r={radius} />
                  {(index < 16 || isSelected) && <text x={position.x} y={position.y + radius + 13} textAnchor="middle">{label.length > 20 ? `${label.slice(0, 18)}…` : label}</text>}
                </g>
              );
            })}
            {!displayedNodes.length && <text x={centerX} y={centerY} textAnchor="middle" className="no-filter-result">没有匹配的模块</text>}
          </svg>
        </div>
        <aside className="node-inspector">
          {selectedEdge
            ? <EdgeInspector edge={selectedEdge} onBack={() => setSelectedEdgeKey(null)} />
            : selectedNode && <NodeInspector node={selectedNode} edges={selectedEdges} onSelectEdge={(edge) => setSelectedEdgeKey(dependencyEdgeKey(edge))} />}
        </aside>
      </div>
      <section className="cycle-list">
        <div className="cycle-heading"><strong>循环依赖</strong><span>{graph.cycle_count ? "选择依赖环可在图中单独聚焦，再次点击取消" : "未检测到强连通依赖环"}</span></div>
        {graph.cycles.map((cycle, index) => (
          <button
            type="button"
            className={`cycle-row ${selectedCycleIndex === index ? "active" : ""}`}
            aria-pressed={selectedCycleIndex === index}
            aria-label={`${selectedCycleIndex === index ? "取消聚焦" : "聚焦"}环 ${index + 1}：${cycle.paths.join(" 到 ")}`}
            key={cycle.file_ids.join("-")}
            onClick={() => selectCycle(index)}
          >
            <strong>环 {index + 1}</strong>
            <span>{cycle.paths.join(" → ")} → {cycle.paths[0]}</span>
            <em>{selectedCycleIndex === index && cycleFocusLoading ? "[ LOADING ]" : selectedCycleIndex === index ? "[ FOCUSED ]" : "[ SELECT ]"}</em>
          </button>
        ))}
      </section>
    </div>
  );
}

function dependencyNodeRadius(node: DependencyNode): number {
  return 10 + Math.min(8, (node.in_degree + node.out_degree) * 1.4);
}

export function qualityMetricSummary(finding: QualityFinding): string {
  if (finding.rule_id === "CIRCULAR_DEPENDENCY") {
    return `结构性风险 · 涉及 ${finding.metric} 个模块`;
  }
  if (finding.threshold <= 0) return `实际值 ${finding.metric}`;
  const exceededPercent = Math.round(((finding.metric - finding.threshold) / finding.threshold) * 100);
  return `实际 ${finding.metric} / 建议 ≤ ${finding.threshold} · 超出 ${Math.max(0, exceededPercent)}%`;
}

function dependencyEdgeKey(edge: DependencyGraph["edges"][number]): string {
  return `${edge.source_id}-${edge.target_id}`;
}

function dependencyEdgeGeometry(
  source: { x: number; y: number },
  target: { x: number; y: number },
  sourceRadius: number,
  targetRadius: number,
  curvature: number,
): { path: string; label: { x: number; y: number } } {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const unitX = dx / distance;
  const unitY = dy / distance;
  const start = { x: source.x + unitX * (sourceRadius + 3), y: source.y + unitY * (sourceRadius + 3) };
  const end = { x: target.x - unitX * (targetRadius + 5), y: target.y - unitY * (targetRadius + 5) };
  const control = {
    x: (start.x + end.x) / 2 - unitY * curvature,
    y: (start.y + end.y) / 2 + unitX * curvature,
  };
  return {
    path: `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} Q ${control.x.toFixed(2)} ${control.y.toFixed(2)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
    label: {
      x: start.x * .25 + control.x * .5 + end.x * .25,
      y: start.y * .25 + control.y * .5 + end.y * .25,
    },
  };
}

function NodeInspector({ node, edges, onSelectEdge }: { node: DependencyNode; edges: DependencyGraph["edges"]; onSelectEdge: (edge: DependencyGraph["edges"][number]) => void }) {
  const outgoingEdges = edges.filter((edge) => edge.source_id === node.id);
  const incomingEdges = edges.filter((edge) => edge.target_id === node.id);
  return (
    <>
      <p className="eyebrow">SELECTED MODULE</p>
      <h3>{shortFileName(node.path)}</h3>
      <code>{node.path}</code>
      <div className="node-degrees"><div><strong>{node.in_degree}</strong><span>入度</span></div><div><strong>{node.out_degree}</strong><span>出度</span></div></div>
      <NeighborGroup title="当前模块依赖" tone="outgoing" edges={outgoingEdges} node={node} onSelectEdge={onSelectEdge} />
      <NeighborGroup title="依赖当前模块" tone="incoming" edges={incomingEdges} node={node} onSelectEdge={onSelectEdge} />
    </>
  );
}

function NeighborGroup({ title, tone, edges, node, onSelectEdge }: { title: string; tone: "outgoing" | "incoming"; edges: DependencyGraph["edges"]; node: DependencyNode; onSelectEdge: (edge: DependencyGraph["edges"][number]) => void }) {
  return (
    <section className={`neighbor-group ${tone}`}>
      <h4>{title}<span>{edges.length}</span></h4>
      <div className="neighbor-list">
        {edges.slice(0, 12).map((edge) => {
          const outgoing = edge.source_id === node.id;
          return <button type="button" key={dependencyEdgeKey(edge)} onClick={() => onSelectEdge(edge)}><span>{outgoing ? "→" : "←"}</span><div><strong>{shortFileName(outgoing ? edge.target_path : edge.source_path)}</strong><small>{edge.import_count} 条导入 · 第 {edge.line_numbers.slice(0, 3).join("、")} 行</small></div></button>;
        })}
        {!edges.length && <small>没有可见关系</small>}
      </div>
    </section>
  );
}

function EdgeInspector({ edge, onBack }: { edge: DependencyGraph["edges"][number]; onBack: () => void }) {
  return (
    <>
      <p className="eyebrow">SELECTED DEPENDENCY</p>
      <h3>{shortFileName(edge.source_path)} → {shortFileName(edge.target_path)}</h3>
      <div className="edge-direction-detail">
        <code>{edge.source_path}</code>
        <span>导入并依赖 ↓</span>
        <code>{edge.target_path}</code>
      </div>
      <div className="edge-metrics"><div><strong>{edge.import_count}</strong><span>导入次数</span></div><div><strong>{edge.line_numbers.length}</strong><span>代码位置</span></div></div>
      <div className="edge-lines"><strong>来源文件中的导入行</strong><span>{edge.line_numbers.map((line) => `第 ${line} 行`).join("、")}</span></div>
      <button type="button" className="edge-inspector-back" onClick={onBack}>返回模块详情</button>
    </>
  );
}

function shortFileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function dependencyConfidenceLabel(level: DependencyGraph["confidence_level"] | undefined): string {
  return { high: "HIGH", medium: "MEDIUM", low: "LOW" }[level ?? "low"];
}

function QualityReportView({
  report,
  loading,
  onRequestPage,
}: {
  report: QualityReport;
  loading: boolean;
  onRequestPage: (severity: string, rule: string, scope: string, offset: number, append: boolean) => Promise<void>;
}) {
  const [severityFilter, setSeverityFilter] = useState("all");
  const [ruleFilter, setRuleFilter] = useState("all");
  const [scopeFilter, setScopeFilter] = useState("all");
  const severityLabels = { error: "高风险", warning: "中风险", info: "低风险" } as const;
  const scopeLabels = { production: "生产代码", test: "测试代码", generated: "生成/外部代码" } as const;
  const filteredTotal = report.filtered_findings ?? report.total_findings;
  const qualityCoverageLevel = report.scoring.coverage_level ?? "high";
  const qualityCoverageLimited = qualityCoverageLevel !== "high";
  const qualityScoreAvailable = qualityCoverageLevel !== "none" && qualityCoverageLevel !== "limited";

  function changeSeverity(nextSeverity: string) {
    setSeverityFilter(nextSeverity);
    void onRequestPage(nextSeverity, ruleFilter, scopeFilter, 0, false);
  }

  function changeRule(nextRule: string) {
    setRuleFilter(nextRule);
    void onRequestPage(severityFilter, nextRule, scopeFilter, 0, false);
  }

  function changeScope(nextScope: string) {
    setScopeFilter(nextScope);
    void onRequestPage(severityFilter, ruleFilter, nextScope, 0, false);
  }

  return (
    <div className="quality-view">
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
          return <article key={scope} className={scopeScoreAvailable ? `grade-${summary.grade!.toLowerCase()}` : "scope-unavailable"} title={unavailableReason ?? `${summary.label}参与综合评分`}><div><strong>{scopeScoreAvailable ? summary.score : "--"}</strong><em>{scopeScoreAvailable ? summary.grade : "N/A"}</em></div><span>{summary.label}</span>{unavailableReason && <small>{unavailableReason}</small>}</article>;
        })}
      </section>}
      <section className="quality-rules">
        {report.rules.map((rule) => <article key={rule.id}><div><strong>{rule.title}</strong><code>{rule.id}</code></div><span>{report.rule_counts[rule.id] ?? 0}</span></article>)}
      </section>
      <div className="quality-toolbar">
        <strong>问题明细</strong>
        <span>当前显示 {report.findings.length} / {filteredTotal}{filteredTotal !== report.total_findings ? `（全部 ${report.total_findings}）` : ""}</span>
        <label>代码范围<select value={scopeFilter} disabled={loading} onChange={(event) => changeScope(event.target.value)}><option value="all">全部范围</option><option value="production">生产代码</option><option value="test">测试代码</option><option value="generated">生成/外部代码</option></select></label>
        <label>风险等级<select value={severityFilter} disabled={loading} onChange={(event) => changeSeverity(event.target.value)}><option value="all">全部</option><option value="error">高风险</option><option value="warning">中风险</option><option value="info">低风险</option></select></label>
        <label>检测规则<select value={ruleFilter} disabled={loading} onChange={(event) => changeRule(event.target.value)}><option value="all">全部规则</option>{report.rules.map((rule) => <option value={rule.id} key={rule.id}>{rule.title}</option>)}</select></label>
      </div>
      <section className="quality-findings">
        {report.findings.map((finding) => (
          <article className={`quality-finding severity-${finding.severity}`} key={finding.id}>
            <div className="finding-level"><span>{severityLabels[finding.severity]}</span><code>{finding.rule_id}</code><small>{scopeLabels[finding.scope] ?? "未分类"}</small></div>
            <div className="finding-main">
              <header><div><strong>{finding.title}</strong><span>{finding.file_path}{finding.start_line ? ` · 第 ${finding.start_line}${finding.end_line && finding.end_line !== finding.start_line ? `–${finding.end_line}` : ""} 行` : ""}</span></div><small>{qualityMetricSummary(finding)}</small></header>
              <p>{finding.description}</p>
              <div className="finding-suggestion"><b>建议</b><span>{finding.suggestion}</span></div>
            </div>
          </article>
        ))}
        {!report.findings.length && !loading && <div className="mini-empty">当前筛选条件下没有质量问题</div>}
        {loading && <div className="mini-empty"><div className="spinner" />正在读取质量问题…</div>}
        {report.has_more && (
          <div className="structure-load-more quality-load-more">
            <button
              type="button"
              disabled={loading}
              onClick={() => void onRequestPage(severityFilter, ruleFilter, scopeFilter, report.findings.length, true)}
            >
              {loading ? "LOADING..." : "LOAD_NEXT"} <span>＋{Math.min(100, filteredTotal - report.findings.length)} ROWS</span>
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default App;
