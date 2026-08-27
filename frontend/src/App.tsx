import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import CodeViewer from "./CodeViewer";
import {
  DEFAULT_IMPORT_LIMITS,
  configureReportGenerator,
  deleteProject,
  formatOperationError,
  formatUploadSize,
  generateProjectReport,
  getAnalysisJob,
  getDependencyGraph,
  getImportLimits,
  getQualityReport,
  getProject,
  getProjectImports,
  getProjectIssues,
  getProjectStructureSummary,
  getProjectSymbols,
  getReportGenerators,
  importGitHubProject,
  incrementalReanalyzeProject,
  listProjects,
  prepareFolderUpload,
  reanalyzeProject,
  searchProject,
  testReportGenerator,
  uploadFolder,
  uploadProject,
} from "./api";
import type { FolderUploadPreparation } from "./api";
import { formatFolderScanProgress, pickFolderSafely, scanDroppedFolderSafely, supportsSafeFolderDrop, supportsSafeFolderPicker } from "./safeFolderPicker";
import type { FolderScanProgress } from "./safeFolderPicker";
import type { AnalysisJob, CodeSearchResponse, CodeSearchResult, CodeSymbol, DependencyGraph, DependencyNode, GeneratedReport, ImportLimits, ImportRelation, IncrementalAnalysisResult, ParseIssue, ProjectDetail, ProjectFile, ProjectStructureSummary, ProjectSummary, QualityReport, ReportGenerator, ReportGeneratorConfiguration, ReportGeneratorTestResult, StructurePage } from "./types";

type ActiveSection = "projects" | "search" | "graph" | "quality" | "report";
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
  quality: "质量检测",
  report: "分析报告",
};

const PROJECT_TAB_LABELS: Record<ProjectTab, string> = {
  files: "文件",
  symbols: "符号",
  imports: "依赖",
  issues: "问题",
};

const ACTIVE_SECTIONS: ActiveSection[] = ["projects", "search", "graph", "quality", "report"];
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
  const [selected, setSelected] = useState<ProjectDetail | null>(null);
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
  const [dependencyGraph, setDependencyGraph] = useState<DependencyGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [qualityReport, setQualityReport] = useState<QualityReport | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [reportGenerators, setReportGenerators] = useState<ReportGenerator[]>([]);
  const [selectedReportGenerator, setSelectedReportGenerator] = useState("local");
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
  const initialProjectRestoredRef = useRef(false);

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

  async function finishImport(created: ProjectDetail) {
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
    setQualityReport(null);
    setGeneratedReport(null);
    setIncrementalResult(null);
    clearStructurePages();
    setStructureLoading(true);
    try {
      setStructure(await getProjectStructureSummary(created.id));
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
        const report = await generateProjectReport(projectId, selectedReportGenerator);
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
          const report = await generateProjectReport(projectId, selectedReportGenerator);
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
    const requestId = ++selectionRequestRef.current;
    const sectionAtSelection = options.section ?? activeSection;
    const tabAtSelection = options.tab ?? projectTab;
    setActiveSection(sectionAtSelection);
    setProjectTab(tabAtSelection);
    setProjectPickerOpen(false);
    setSelectingProjectId(project.id);
    try {
      setWorkspaceError(null);
      setSearchQuery("");
      setSearchResponse(null);
      setDependencyGraph(null);
      setQualityReport(null);
      setGeneratedReport(null);
      setIncrementalResult(null);
      clearStructurePages();
      setStructureLoading(true);
      setGraphLoading(sectionAtSelection === "graph");
      setQualityLoading(sectionAtSelection === "quality");
      setReportLoading(sectionAtSelection === "report");
      const detail = await getProject(project.id);
      if (selectionRequestRef.current !== requestId) return;
      setSelected(detail);
      if (options.syncUrl !== false) {
        writeNavigationState({ section: sectionAtSelection, tab: tabAtSelection, projectId: project.id });
      }
      setStructure(null);
      try {
        const projectStructure = await getProjectStructureSummary(project.id);
        if (selectionRequestRef.current !== requestId) return;
        setStructure(projectStructure);
      } catch (structureError) {
        setWorkspaceError(structureError instanceof Error ? structureError.message : "无法加载结构分析");
      }
      if (sectionAtSelection === "graph") {
        try {
          const graph = await getDependencyGraph(project.id);
          if (selectionRequestRef.current !== requestId) return;
          setDependencyGraph(graph);
        } catch (graphError) {
          setWorkspaceError(graphError instanceof Error ? graphError.message : "无法加载依赖图谱");
        }
      }
      if (sectionAtSelection === "quality") {
        try {
          const report = await getQualityReport(project.id);
          if (selectionRequestRef.current !== requestId) return;
          setQualityReport(report);
        } catch (qualityError) {
          setWorkspaceError(qualityError instanceof Error ? qualityError.message : "无法生成质量报告");
        }
      }
      if (sectionAtSelection === "report") {
        try {
          const [generators, report] = await Promise.all([
            getReportGenerators(),
            generateProjectReport(project.id, "local"),
          ]);
          if (selectionRequestRef.current !== requestId) return;
          setReportGenerators(generators);
          setSelectedReportGenerator("local");
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
      if (selected?.id === project.id) {
        selectionRequestRef.current += 1;
        setSelected(null);
        setStructure(null);
        clearStructurePages();
        setSearchResponse(null);
        setDependencyGraph(null);
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
    if (!selected || !searchQuery.trim() || searchLoadingMore) return;
    setSearchLoading(true);
    setWorkspaceError(null);
    try {
      setSearchResponse(await searchProject(selected.id, searchQuery.trim()));
    } catch (requestError) {
      setWorkspaceError(requestError instanceof Error ? requestError.message : "代码搜索失败");
    } finally {
      setSearchLoading(false);
    }
  }

  async function handleLoadMoreSearchResults() {
    if (!selected || !searchResponse || searchLoading || searchLoadingMore) return;
    if (!searchResponse.has_more) return;
    const query = searchResponse.query;
    const offset = searchResponse.results.length;
    setSearchLoadingMore(true);
    setWorkspaceError(null);
    try {
      const nextPage = await searchProject(selected.id, query, 10, offset);
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
      setWorkspaceError(requestError instanceof Error ? requestError.message : "加载更多搜索结果失败");
    } finally {
      setSearchLoadingMore(false);
    }
  }

  async function handleGenerateReport(generator = selectedReportGenerator): Promise<GeneratedReport | null> {
    if (!selected) return null;
    setReportLoading(true);
    setWorkspaceError(null);
    try {
      const report = await generateProjectReport(selected.id, generator);
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

  async function handleConfigureReportGenerator(
    generator: string,
    configuration: ReportGeneratorConfiguration,
  ): Promise<ReportGenerator> {
    const provider = await configureReportGenerator(generator, configuration);
    setReportGenerators((current) => current.map((item) => item.id === provider.id ? provider : item));
    handleSelectReportGenerator(provider.id);
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
        generatedReport ? Promise.resolve(generatedReport) : generateProjectReport(selected.id, selectedReportGenerator),
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

  function clearSelectedProject() {
    selectionRequestRef.current += 1;
    setSelected(null);
    setStructure(null);
    clearStructurePages();
    setSearchQuery("");
    setSearchResponse(null);
    setDependencyGraph(null);
    setQualityReport(null);
    setGeneratedReport(null);
    setIncrementalResult(null);
    setSelectingProjectId(null);
    setStructureLoading(false);
    setGraphLoading(false);
    setQualityLoading(false);
    setReportLoading(false);
  }

  function navigateToSection(section: "projects" | "search") {
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
    <div className="app-shell">
      <aside className="sidebar">
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
          <p className="sidebar-label">PROJECT_TOOLS</p>
          <button disabled={!selected} className={`nav-item ${selected && activeSection === "projects" ? "active" : ""}`} onClick={() => navigateToSection("projects")}><span className="nav-icon">⌘</span>仓库概览</button>
          <button
            disabled={!selected}
            className={`nav-item ${selected && activeSection === "search" ? "active" : ""}`}
            onClick={() => navigateToSection("search")}
          ><span className="nav-icon">⌕</span>代码搜索<em>BM25</em></button>
          <button disabled={!selected} className={`nav-item ${selected && activeSection === "graph" ? "active" : ""}`} onClick={() => void handleOpenGraph()}><span className="nav-icon">◇</span>依赖图谱<em>LOCAL</em></button>
          <button disabled={!selected} className={`nav-item ${selected && activeSection === "quality" ? "active" : ""}`} onClick={() => void handleOpenQuality()}><span className="nav-icon">✓</span>质量检测<em>6 RULES</em></button>
          <button disabled={!selected} className={`nav-item ${selected && activeSection === "report" ? "active" : ""}`} onClick={() => void handleOpenReport()}><span className="nav-icon">▤</span>分析报告<em>SMART</em></button>
        </nav>

        <div className="sidebar-note">
          <span className="status-dot" />
          <div><strong>[LOCAL_MODE]</strong><small>code_stays_on_device</small></div>
        </div>
        <div className="version">$ devatlas --version<br />v0.9.0</div>
      </aside>

      <main className={`main-content ${selected || selectingProjectId !== null ? "workspace-mode" : ""}`}>
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {selected
                ? `CURRENT_PROJECT · ${selected.primary_language ?? "未识别语言"} · ${formatNumber(selected.file_count)} 文件`
                : "root@devatlas:~/workspace/projects"}
            </p>
            <h1>{selected?.name ?? "项目管理"}</h1>
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
                <small>$ FONT</small><strong>{displayScale}%</strong>
              </output>
              <button
                type="button"
                aria-label="放大页面字号"
                disabled={displayScale === DISPLAY_SCALES[DISPLAY_SCALES.length - 1]}
                onClick={() => adjustDisplayScale(1)}
              ><span aria-hidden="true">＋</span></button>
            </div>
            <button className="primary-button" onClick={() => openImporter()} disabled={uploading}>
              <span>＋</span>{uploading ? "正在分析…" : "导入仓库"}
            </button>
          </div>
        </header>

        {error && <div className="error-banner"><strong>[ERR] 操作未完成</strong><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}

        {activeJob && <JobProgress job={activeJob} />}

        {!selected && selectingProjectId === null && <>
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

        <div className={`content-grid ${selected || selectingProjectId !== null ? "workspace-single" : "project-manager-grid"}`}>
          {!selected && selectingProjectId === null && (
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

          {(selected || selectingProjectId !== null) && (
          <section className="panel detail-panel" aria-busy={selectingProjectId !== null}>
            <div className="panel-heading">
              <div><p className="eyebrow">{activeSection === "projects" ? "REPOSITORY_OVERVIEW" : "PROJECT_TOOL"}</p><h2>{SECTION_LABELS[activeSection]}</h2></div>
              <div className="workspace-breadcrumb" aria-label="当前位置">
                <strong>{selected?.name ?? "no-project"}</strong><i>/</i><em>{activeSection === "projects" ? PROJECT_TAB_LABELS[projectTab] : SECTION_LABELS[activeSection]}</em>
              </div>
            </div>
            {workspaceError && <div className="workspace-error" role="alert"><strong>操作未完成</strong><span>{workspaceError}</span><button aria-label="关闭工作区错误" onClick={() => setWorkspaceError(null)}>×</button></div>}
            {!selected ? (
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
                  <button className={projectTab === "files" ? "active" : ""} onClick={() => navigateToProjectTab("files")}>文件 <span title="文件总数">{selected.files.length}</span></button>
                  <button className={projectTab === "symbols" ? "active" : ""} onClick={() => navigateToProjectTab("symbols")}>符号 <span title="符号总数">{formatAnalysisValue(structure?.symbol_count, structureLoading)}</span></button>
                  <button className={projectTab === "imports" ? "active" : ""} onClick={() => navigateToProjectTab("imports")}>依赖 <span title="导入关系总数">{formatAnalysisValue(structure?.import_count, structureLoading)}</span></button>
                  <button className={projectTab === "issues" ? "active" : ""} onClick={() => navigateToProjectTab("issues")}>问题 <span title="解析问题总数">{formatAnalysisValue(structure?.issue_count, structureLoading)}</span></button>
                </div>
                </>}
                <div className={`file-list structure-list ${activeSection !== "projects" ? "feature-content" : ""}`}>
                  {activeSection === "quality" && qualityLoading && <div className="mini-empty"><div className="spinner" />正在执行质量规则…</div>}
                  {activeSection === "quality" && qualityReport && <QualityReportView report={qualityReport} />}
                  {activeSection === "graph" && graphLoading && <div className="mini-empty"><div className="spinner" />正在聚合项目内依赖…</div>}
                  {activeSection === "graph" && dependencyGraph && <DependencyGraphView graph={dependencyGraph} />}
                  {activeSection === "report" && (
                    <ReportWorkspace
                      generators={reportGenerators}
                      selectedGenerator={selectedReportGenerator}
                      report={generatedReport}
                      loading={reportLoading}
                      exporting={exportingReport}
                      onSelectGenerator={handleSelectReportGenerator}
                      onConfigureGenerator={handleConfigureReportGenerator}
                      onTestGenerator={handleTestReportGenerator}
                      onGenerate={() => void handleGenerateReport()}
                      onExport={() => void handleExportReport()}
                    />
                  )}
                  {activeSection === "search" && (
                    <div className="search-pane">
                      <form className="search-form" onSubmit={(event) => void handleSearch(event)}>
                        <input
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                          placeholder="搜索函数、类名或代码，例如 authentication"
                          aria-label="代码搜索关键词"
                        />
                        <button disabled={searchLoading || searchLoadingMore || !searchQuery.trim()}>{searchLoading ? "检索中…" : "搜索"}</button>
                      </form>
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
                            <div className="search-result-actions"><small>{result.kind} · {result.score.toFixed(2)}</small><button type="button" onClick={() => setCodeViewerResult(result)}>查看代码</button></div>
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
                  {activeSection === "projects" && projectTab === "files" && <FileTree key={selected.id} files={selected.files} />}
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
          query={searchResponse?.query ?? searchQuery}
          onClose={() => setCodeViewerResult(null)}
        />
      )}
    </div>
  );
}

interface FileTreeNode {
  kind: "directory" | "file";
  name: string;
  path: string;
  file?: ProjectFile;
  children: FileTreeNode[];
  fileCount: number;
}

interface MutableFileTreeNode {
  kind: "directory" | "file";
  name: string;
  path: string;
  file?: ProjectFile;
  children: Map<string, MutableFileTreeNode>;
}

function buildFileTree(files: ProjectFile[]): FileTreeNode[] {
  const root = new Map<string, MutableFileTreeNode>();

  files.forEach((file) => {
    const normalizedPath = file.relative_path.replaceAll("\\", "/");
    const parts = normalizedPath.split("/").filter(Boolean);
    let children = root;
    let currentPath = "";

    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const key = `${isFile ? "file" : "directory"}:${part}`;
      let node = children.get(key);
      if (!node) {
        node = {
          kind: isFile ? "file" : "directory",
          name: part,
          path: currentPath,
          file: isFile ? file : undefined,
          children: new Map(),
        };
        children.set(key, node);
      }
      children = node.children;
    });
  });

  const finalize = (nodes: Map<string, MutableFileTreeNode>): FileTreeNode[] => Array.from(nodes.values())
    .map((node) => {
      const children = finalize(node.children);
      return {
        kind: node.kind,
        name: node.name,
        path: node.path,
        file: node.file,
        children,
        fileCount: node.kind === "file" ? 1 : children.reduce((total, child) => total + child.fileCount, 0),
      };
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN", { numeric: true });
    });

  return finalize(root);
}

function FileTree({ files }: { files: ProjectFile[] }) {
  const nodes = useMemo(() => buildFileTree(files), [files]);
  if (nodes.length === 0) return <div className="mini-empty">当前仓库没有可展示的文件</div>;

  return (
    <div className="file-tree" role="tree" aria-label="仓库文件树">
      {nodes.map((node) => <FileTreeNodeView key={`${node.kind}:${node.path}`} node={node} depth={0} />)}
    </div>
  );
}

function FileTreeNodeView({ node, depth }: { node: FileTreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth === 0);
  if (node.kind === "file" && node.file) {
    return (
      <div className="file-tree-file" role="treeitem" title={node.path}>
        <span className="file-tree-branch">├</span>
        <span className="file-symbol">⌑</span>
        <strong>{node.name}</strong>
        <span>{node.file.language ?? "Text"}</span>
        <small>{formatNumber(node.file.line_count)} 行</small>
        <small>{formatBytes(node.file.size_bytes)}</small>
      </div>
    );
  }

  return (
    <div className="file-tree-directory" role="treeitem" aria-expanded={expanded}>
      <button
        type="button"
        className="file-tree-directory-button"
        aria-expanded={expanded}
        aria-label={`${node.name} 目录，${node.fileCount} 个文件，${expanded ? "点击折叠" : "点击展开"}`}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="file-tree-toggle">{expanded ? "▾" : "▸"}</span>
        <span className="file-tree-folder">{expanded ? "▱" : "□"}</span>
        <strong>{node.name}</strong>
        <small>{formatNumber(node.fileCount)} 个文件</small>
      </button>
      {expanded && (
        <div className="file-tree-children" role="group">
          {node.children.map((child) => <FileTreeNodeView key={`${child.kind}:${child.path}`} node={child} depth={depth + 1} />)}
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

function ReportWorkspace({
  generators,
  selectedGenerator,
  report,
  loading,
  exporting,
  onSelectGenerator,
  onConfigureGenerator,
  onTestGenerator,
  onGenerate,
  onExport,
}: {
  generators: ReportGenerator[];
  selectedGenerator: string;
  report: GeneratedReport | null;
  loading: boolean;
  exporting: boolean;
  onSelectGenerator: (generator: string) => void;
  onConfigureGenerator: (generator: string, configuration: ReportGeneratorConfiguration) => Promise<ReportGenerator>;
  onTestGenerator: (generator: string) => Promise<ReportGeneratorTestResult>;
  onGenerate: () => void;
  onExport: () => void;
}) {
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState({ base_url: "", model: "", api_key: "" });
  const [configurationBusy, setConfigurationBusy] = useState<"save" | "test" | null>(null);
  const [configurationMessage, setConfigurationMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const selectedProvider = generators.find((generator) => generator.id === selectedGenerator);
  const configuringProvider = generators.find((generator) => generator.id === configuringId);

  function openConfiguration(generator: ReportGenerator) {
    onSelectGenerator(generator.id);
    setConfiguringId(generator.id);
    setConfigDraft({ base_url: generator.base_url, model: generator.model, api_key: "" });
    setConfigurationMessage(null);
  }

  function selectProvider(generator: ReportGenerator) {
    if (!generator.available) return;
    onSelectGenerator(generator.id);
    setConfiguringId(null);
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
    <div className="report-workspace">
      <section className="report-generator-section" aria-labelledby="report-generator-title">
        <div className="report-section-heading">
          <div><span>API_PROVIDER</span><h3 id="report-generator-title">选择分析接口</h3></div>
          <small>默认本地分析免费、无需配置</small>
        </div>
        <div className="report-generator-grid">
          {generators.map((generator) => (
            <article
              key={generator.id}
              className={`report-generator-card ${selectedGenerator === generator.id ? "active" : ""} ${!generator.available ? "unavailable" : ""}`}
            >
              <button className="provider-select-button" disabled={loading || !generator.available} onClick={() => selectProvider(generator)} aria-pressed={selectedGenerator === generator.id}>
                <span className={`generator-status status-${generator.connection_status}`}>{providerStatusLabel(generator)}</span>
                <strong>{generator.name}</strong>
                <p>{generator.description}</p>
                <code>{generator.base_url}{generator.endpoint}</code>
                <em>{generator.cost_label}</em>
              </button>
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
                <input value={configDraft.base_url} onChange={(event) => setConfigDraft((current) => ({ ...current, base_url: event.target.value }))} placeholder={configuringProvider.id === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1"} disabled={configurationBusy !== null} />
              </label>
              <label>
                <span>模型名称</span>
                <input value={configDraft.model} onChange={(event) => setConfigDraft((current) => ({ ...current, model: event.target.value }))} placeholder={configuringProvider.id === "ollama" ? "填写 ollama list 中的模型名称" : "填写账号可用的模型 ID"} disabled={configurationBusy !== null} />
              </label>
              {configuringProvider.id === "openai-compatible" && (
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
              <button type="submit" className="primary-button" disabled={configurationBusy !== null || !configDraft.base_url.trim() || !configDraft.model.trim()}>{configurationBusy === "save" ? "保存中…" : "保存配置"}</button>
            </div>
          </form>
        )}
      </section>

      <section className="report-preview-section" aria-labelledby="report-preview-title">
        <div className="report-toolbar">
          <div>
            <span>MARKDOWN_OUTPUT</span>
            <h3 id="report-preview-title">报告预览</h3>
            {report && <small>{report.filename} · {formatDate(report.generated_at)}</small>}
          </div>
          <div className="report-actions">
            <button className="secondary-button" onClick={onGenerate} disabled={loading || exporting || !selectedProvider?.available}>
              <span>↻</span>{loading ? "分析中…" : selectedProvider?.id === "local" ? "重新生成" : "使用当前 API 生成"}
            </button>
            <button className="primary-button report-export-button" title="打开系统保存窗口并选择导出路径" onClick={onExport} disabled={!report || loading || exporting}>
              <span>↓</span>{exporting ? "正在保存…" : "导出 MD"}
            </button>
          </div>
        </div>
        {loading && !report && <div className="report-preview-empty"><div className="spinner" /><strong>正在进行针对性智能分析</strong><span>综合项目结构、依赖热点、质量评分与测试信号…</span></div>}
        {!loading && !report && <div className="report-preview-empty"><strong>{selectedProvider?.available ? "尚未生成报告" : "当前接口尚未配置"}</strong><span>{selectedProvider?.available ? "点击生成按钮，使用当前接口分析项目。" : "点击上方接口卡片填写地址、模型和认证信息。"}</span></div>}
        {report && <pre className="report-preview" aria-label="Markdown 报告预览">{report.content}</pre>}
        <div className="report-save-note"><span>PATH</span> 导出时会打开系统保存窗口，可选择目录和文件名；不支持该能力的浏览器将保存到默认下载目录。</div>
      </section>
    </div>
  );
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

function DependencyGraphView({ graph }: { graph: DependencyGraph }) {
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(graph.nodes[0]?.id ?? null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [moduleFilter, setModuleFilter] = useState("");
  const [zoom, setZoom] = useState(1);
  const width = 900;
  const height = 500;
  const centerX = 440;
  const centerY = 245;
  const cycleNodeIds = useMemo(
    () => new Set(graph.cycles.flatMap((cycle) => cycle.file_ids)),
    [graph.cycles],
  );
  const displayedNodes = useMemo(() => {
    const query = moduleFilter.trim().toLowerCase();
    return query ? graph.nodes.filter((node) => node.path.toLowerCase().includes(query)) : graph.nodes;
  }, [graph.nodes, moduleFilter]);
  const displayedNodeIds = useMemo(() => new Set(displayedNodes.map((node) => node.id)), [displayedNodes]);
  const displayedEdges = useMemo(
    () => graph.edges.filter((edge) => displayedNodeIds.has(edge.source_id) && displayedNodeIds.has(edge.target_id)),
    [displayedNodeIds, graph.edges],
  );
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
      {graph.truncated && <div className="graph-notice">仓库规模较大，图中优先展示循环模块和连接度最高的 {graph.nodes.length} 个文件。</div>}
      <div className="graph-toolbar">
        <label><span>筛选模块</span><input value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)} placeholder="输入文件名或路径" /></label>
        <small>当前显示 {displayedNodes.length} 个模块 / {displayedEdges.length} 条边</small>
        <div className="zoom-controls"><button onClick={() => setZoom((value) => Math.max(1, value - .25))} disabled={zoom <= 1}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((value) => Math.min(2.5, value + .25))} disabled={zoom >= 2.5}>＋</button></div>
      </div>
      <div className="graph-legend" role="note" aria-label="依赖图图例">
        <strong>A → B 表示 A 导入并依赖 B</strong>
        <span><i className="legend-edge outgoing" />当前模块依赖</span>
        <span><i className="legend-edge incoming" />依赖当前模块</span>
        <span><i className="legend-edge cyclic" />循环依赖</span>
        <small>×N 表示两文件间合并后的导入次数 · 点击连线查看文件与行号</small>
      </div>
      <div className="dependency-layout">
        <div className="dependency-canvas">
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
              const cyclic = graph.cycles.some((cycle) => cycle.file_ids.includes(edge.source_id) && cycle.file_ids.includes(edge.target_id));
              const reverseExists = displayedEdges.some((candidate) => candidate.source_id === edge.target_id && candidate.target_id === edge.source_id);
              const geometry = dependencyEdgeGeometry(
                source,
                target,
                dependencyNodeRadius(sourceNode),
                dependencyNodeRadius(targetNode),
                reverseExists ? (edge.source_id < edge.target_id ? 30 : -30) : (edge.source_id < edge.target_id ? 12 : -12),
              );
              const edgeKey = dependencyEdgeKey(edge);
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
                  <title>{edge.source_path} → {edge.target_path} · {edge.import_count} 条导入 · 第 {edge.line_numbers.join("、")} 行</title>
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
        <div className="cycle-heading"><strong>循环依赖</strong><span>{graph.cycle_count ? "建议拆分公共模块或调整依赖方向" : "未检测到强连通依赖环"}</span></div>
        {graph.cycles.map((cycle, index) => <div className="cycle-row" key={cycle.file_ids.join("-")}><strong>环 {index + 1}</strong><span>{cycle.paths.join(" → ")} → {cycle.paths[0]}</span></div>)}
      </section>
    </div>
  );
}

function dependencyNodeRadius(node: DependencyNode): number {
  return 10 + Math.min(8, (node.in_degree + node.out_degree) * 1.4);
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

function QualityReportView({ report }: { report: QualityReport }) {
  const [severityFilter, setSeverityFilter] = useState("all");
  const [ruleFilter, setRuleFilter] = useState("all");
  const filteredFindings = report.findings.filter(
    (finding) => (severityFilter === "all" || finding.severity === severityFilter) && (ruleFilter === "all" || finding.rule_id === ruleFilter),
  );
  const severityLabels = { error: "错误", warning: "警告", info: "提示" } as const;

  return (
    <div className="quality-view">
      <section className="quality-hero">
        <div
          className={`quality-score grade-${report.grade.toLowerCase()}`}
          role="meter"
          aria-label={`质量评分 ${report.score} 分，评级 ${report.grade}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={report.score}
        >
          <strong>{report.score}</strong><span>质量分</span><em>{report.grade}</em>
        </div>
        <div className="quality-overview"><p className="eyebrow">STATIC QUALITY REPORT</p><h3>{report.total_findings ? `发现 ${formatNumber(report.total_findings)} 项可改进问题` : "未发现规则命中的质量问题"}</h3><span>已执行 {report.rules.length} 条规则 · {report.elapsed_ms.toFixed(1)} ms</span></div>
        <div className="severity-summary"><div className="error"><strong>{report.severity_counts.error}</strong><span>错误</span></div><div className="warning"><strong>{report.severity_counts.warning}</strong><span>警告</span></div><div><strong>{report.severity_counts.info}</strong><span>提示</span></div></div>
      </section>
      <section className="quality-scoring-breakdown" aria-label="质量评分依据">
        <div className="scoring-description">
          <p className="eyebrow">SCORE_MODEL::{report.scoring.model.toUpperCase()}</p>
          <strong>按项目规模归一化扣分</strong>
          <span>{report.scoring.explanation}</span>
        </div>
        <div className="scoring-metric"><span>规模系数</span><strong>×{report.scoring.size_factor.toFixed(3)}</strong><small>{formatNumber(report.scoring.project_size.file_count)} 文件 · {formatNumber(report.scoring.project_size.code_line_count)} 行 · {formatNumber(report.scoring.project_size.symbol_count)} 符号</small></div>
        <div className="scoring-metric"><span>扣分校准</span><strong>{report.scoring.base_penalty.toFixed(1)} → {report.scoring.adjusted_penalty}</strong><small>最终得分 = 100 − 校准后扣分</small></div>
        <div className="scoring-weights"><span>当前单项权重</span><code>ERR {report.scoring.effective_weights.error.toFixed(2)}</code><code>WARN {report.scoring.effective_weights.warning.toFixed(2)}</code><code>INFO {report.scoring.effective_weights.info.toFixed(2)}</code></div>
      </section>
      <section className="quality-rules">
        {report.rules.map((rule) => <article key={rule.id}><div><strong>{rule.title}</strong><code>{rule.id}</code></div><span>{report.rule_counts[rule.id] ?? 0}</span><p>{rule.description}</p></article>)}
      </section>
      <div className="quality-toolbar">
        <strong>问题明细</strong>
        <span>显示 {filteredFindings.length} / {report.total_findings}</span>
        <label>严重级别<select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}><option value="all">全部</option><option value="error">错误</option><option value="warning">警告</option><option value="info">提示</option></select></label>
        <label>检测规则<select value={ruleFilter} onChange={(event) => setRuleFilter(event.target.value)}><option value="all">全部规则</option>{report.rules.map((rule) => <option value={rule.id} key={rule.id}>{rule.title}</option>)}</select></label>
      </div>
      <section className="quality-findings">
        {filteredFindings.map((finding) => (
          <article className={`quality-finding severity-${finding.severity}`} key={finding.id}>
            <div className="finding-level"><span>{severityLabels[finding.severity]}</span><code>{finding.rule_id}</code></div>
            <div className="finding-main">
              <header><div><strong>{finding.title}</strong><span>{finding.file_path}{finding.start_line ? ` · 第 ${finding.start_line}${finding.end_line && finding.end_line !== finding.start_line ? `–${finding.end_line}` : ""} 行` : ""}</span></div><small>实际 {finding.metric} / 阈值 {finding.threshold}</small></header>
              <p>{finding.description}</p>
              <div className="finding-suggestion"><b>建议</b><span>{finding.suggestion}</span></div>
            </div>
          </article>
        ))}
        {!filteredFindings.length && <div className="mini-empty">当前筛选条件下没有质量问题</div>}
        {report.truncated && <div className="graph-notice">问题数量较多，当前仅返回前 {report.findings.length} 项；可通过 API 调整 limit。</div>}
      </section>
    </div>
  );
}

export default App;
