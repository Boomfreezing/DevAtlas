import type { AnalysisJob, CodeSearchResponse, CodeSymbol, DependencyGraph, GeneratedReport, ImportLimits, ImportRelation, IncrementalAnalysisResult, ParseIssue, ProjectFileContent, ProjectFileTreeResponse, ProjectStructure, ProjectStructureSummary, ProjectSummary, QualityReport, ReportGenerator, ReportGeneratorConfiguration, ReportGeneratorTestResult, StructurePage } from "./types";

const API_ROOT = "/api";
export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  max_upload_mb: 200,
  max_folder_files: 20_000,
  max_source_file_mb: 5,
};
const IGNORED_UPLOAD_DIRECTORIES = new Set([
  ".git", ".idea", ".mypy_cache", ".next", ".nuxt", ".pytest_cache", ".ruff_cache",
  ".venv", ".vscode", "__pycache__", "build", "coverage", "dist", "node_modules", "target", "vendor", "venv",
]);
const ANALYZABLE_UPLOAD_EXTENSIONS = new Set([
  ".c", ".cpp", ".cs", ".css", ".env", ".go", ".html", ".java", ".js", ".json", ".jsx",
  ".kt", ".md", ".php", ".py", ".rb", ".rs", ".scss", ".sql", ".swift", ".toml", ".ts",
  ".tsx", ".txt", ".vue", ".yaml", ".yml",
]);

export interface FolderUploadPreparation {
  acceptedFiles: File[];
  originalCount: number;
  originalBytes: number;
  ignoredCount: number;
  ignoredBytes: number;
  totalBytes: number;
  directoryIgnoredCount: number;
  unsupportedCount: number;
  oversizedCount: number;
  selectionMode: "safe" | "legacy";
  scannedEntryCount: number;
  skippedDirectoryCount: number;
  skippedDirectoryNames: string[];
}

export function isIgnoredUploadDirectory(name: string): boolean {
  return IGNORED_UPLOAD_DIRECTORIES.has(name.toLowerCase());
}

export function isAnalyzableUploadFilename(name: string): boolean {
  const normalized = name.toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  return ANALYZABLE_UPLOAD_EXTENSIONS.has(dotIndex >= 0 ? normalized.slice(dotIndex) : "");
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly status: number,
    readonly detail: string | null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const DETAIL_GUIDANCE: Array<{ pattern: RegExp; summary: string; action: string }> = [
  { pattern: /Project file is no longer available on disk/i, summary: "仓库目录中的源文件已被删除或移动", action: "执行一次增量分析以刷新文件索引，然后重新打开源码" },
  { pattern: /Project file not found/i, summary: "当前项目中没有这条文件记录", action: "刷新项目后重新选择搜索结果" },
  { pattern: /Project file resolves outside the repository/i, summary: "文件路径超出了当前仓库的安全范围", action: "检查仓库中的符号链接或异常相对路径" },
  { pattern: /Project file metadata could not be read|Project file could not be read/i, summary: "系统没有成功读取该源文件", action: "检查文件是否被占用以及当前账户是否具有读取权限" },
  { pattern: /Project file exceeds the 2 MB viewer limit/i, summary: "文件超过源码查看器的 2 MB 上限", action: "使用本地编辑器打开该文件，或拆分过大的源文件" },
  { pattern: /Binary files cannot be displayed/i, summary: "该文件是二进制文件，不能作为源码显示", action: "在文件树中选择文本或源代码文件" },
  { pattern: /Project not found/i, summary: "项目不存在或已经被删除", action: "刷新项目列表后重新选择项目" },
  { pattern: /Analysis job not found/i, summary: "后台分析任务已经失效或服务已重启", action: "返回项目列表并重新发起导入" },
  { pattern: /Only ZIP archives are supported/i, summary: "上传文件不是 ZIP 压缩包", action: "重新选择扩展名为 .zip 的仓库压缩包" },
  { pattern: /ZIP archive is empty/i, summary: "ZIP 压缩包中没有可分析文件", action: "确认压缩包内容后重新上传" },
  { pattern: /extracted archive is too large/i, summary: "仓库解压后的体积超过安全上限", action: "删除大型资源文件后重新打包" },
  { pattern: /archive contains an unsafe path/i, summary: "压缩包包含可能越界写入的危险路径", action: "重新创建结构正常的 ZIP 压缩包" },
  { pattern: /archive contains more than .* entries/i, summary: "仓库压缩包包含的条目数量超过安全上限", action: "删除依赖、缓存和构建产物后重新导入" },
  { pattern: /extracted archive exceeds the .* MB safety limit/i, summary: "仓库展开后的总体积超过安全上限", action: "精简大型资源文件后重试" },
  { pattern: /Analyzable files exceed the .* MB safety limit/i, summary: "仓库中的可分析源码超过总量限制", action: "拆分仓库或排除生成代码后重试" },
  { pattern: /does not contain supported source or text files/i, summary: "仓库中没有找到支持的源码或文本文件", action: "确认仓库内容和文件类型后重试" },
  { pattern: /archive contains a symbolic link/i, summary: "仓库压缩包包含符号链接", action: "更新后端后重试；系统应安全跳过链接而不是创建它" },
  { pattern: /not a valid ZIP archive/i, summary: "文件内容不是有效的 ZIP 压缩包", action: "检查文件是否损坏并重新压缩" },
  { pattern: /public GitHub repository was not found/i, summary: "没有找到这个公开 GitHub 仓库", action: "检查仓库地址、拼写和公开权限" },
  { pattern: /Cannot connect to GitHub/i, summary: "后端无法连接 GitHub", action: "检查网络、代理和后端外网权限后重试" },
  { pattern: /GitHub download timed out/i, summary: "下载 GitHub 仓库超时", action: "检查网络后重试，或改用 ZIP 导入" },
  { pattern: /anonymous downloads may be rate-limited/i, summary: "GitHub 拒绝了匿名下载", action: "稍后重试，或下载 ZIP 后从本地导入" },
  { pattern: /Repository archive exceeds the .* MB limit/i, summary: "GitHub 仓库压缩包超过导入大小限制", action: "使用更小的仓库或本地精简后导入" },
  { pattern: /Report generator .* is not configured/i, summary: "所选分析接口尚未配置", action: "点击“配置 API”，保存并测试连接后再生成报告" },
  { pattern: /Unknown report generator/i, summary: "所选分析接口不存在", action: "刷新页面并重新选择可用的分析接口" },
];

function hasChinese(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function statusGuidance(status: number): { summary: string; action: string } {
  if (status === 400 || status === 422) return { summary: "请求内容不符合接口要求", action: "检查输入内容后重试" };
  if (status === 401 || status === 403) return { summary: "当前请求没有通过权限验证", action: "检查 API Key、仓库权限或服务配置" };
  if (status === 404) return { summary: "请求的项目或资源不存在", action: "刷新项目列表后重试" };
  if (status === 408 || status === 504) return { summary: "服务处理请求超时", action: "检查网络状态后重试" };
  if (status === 413) return { summary: "上传内容超过服务器大小限制", action: "精简仓库后重新导入" };
  if (status === 429) return { summary: "请求过于频繁或外部服务已限流", action: "等待片刻后重试" };
  if (status === 502 || status === 503) return { summary: "后端依赖的服务暂时不可用", action: "确认后端、GitHub 或模型服务正常后重试" };
  if (status >= 500) return { summary: "后端处理请求时发生异常", action: "稍后重试；如果持续出现，请查看后端日志" };
  return { summary: "请求没有成功完成", action: "刷新页面后重试" };
}

function extractDetail(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("detail" in body)) return null;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail.trim() || null;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => item && typeof item === "object" && "msg" in item ? String(item.msg) : "")
      .filter(Boolean);
    return messages.length ? messages.join("；") : null;
  }
  return null;
}

export function formatOperationError(operation: string, status: number, detail: string | null): string {
  const matched = detail ? DETAIL_GUIDANCE.find((item) => item.pattern.test(detail)) : undefined;
  if (matched) return `${operation}失败：${matched.summary}。建议：${matched.action}。`;

  const fallback = statusGuidance(status);
  const summary = detail && hasChinese(detail) ? detail.replace(/[。.]$/, "") : fallback.summary;
  return `${operation}失败：${summary}。建议：${fallback.action}。`;
}

async function request<T>(path: string, operation: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, options);
  } catch (error) {
    const folderUploadInterrupted = operation === "导入本地文件夹";
    throw new ApiRequestError(
      folderUploadInterrupted
        ? "导入本地文件夹失败：上传连接在传输过程中中断。建议：刷新后重试，并确认筛选后的源码没有超过导入界面显示的文件数和体积限制。"
        : `${operation}失败：无法连接 DevAtlas 本地后端。建议：确认后端服务已启动，并检查 8000 端口是否可访问。`,
      operation,
      0,
      error instanceof Error ? error.message : null,
    );
  }
  if (!response.ok) {
    let detail: string | null = null;
    try {
      detail = extractDetail(await response.json());
    } catch {
      // The status-based guidance remains useful when the response is not JSON.
    }
    throw new ApiRequestError(formatOperationError(operation, response.status, detail), operation, response.status, detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function listProjects(): Promise<ProjectSummary[]> {
  return request<ProjectSummary[]>("/projects", "加载项目列表");
}

export function getProject(id: number): Promise<ProjectSummary> {
  return request<ProjectSummary>(`/projects/${id}`, "读取项目详情");
}

export function getImportLimits(): Promise<ImportLimits> {
  return request<ImportLimits>("/import-limits", "读取导入限制");
}

export function getProjectFileContent(projectId: number, fileId: number): Promise<ProjectFileContent> {
  return request<ProjectFileContent>(`/projects/${projectId}/files/${fileId}/content`, "打开源码");
}

export function getProjectFileTree(projectId: number, path = ""): Promise<ProjectFileTreeResponse> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  const query = params.size ? `?${params}` : "";
  return request<ProjectFileTreeResponse>(`/projects/${projectId}/files/tree${query}`, "读取文件目录");
}

export function getProjectStructure(id: number): Promise<ProjectStructure> {
  return request<ProjectStructure>(`/projects/${id}/structure`, "加载结构分析");
}

export function getProjectStructureSummary(id: number): Promise<ProjectStructureSummary> {
  return request<ProjectStructureSummary>(`/projects/${id}/structure/summary`, "加载结构摘要");
}

export function getProjectSymbols(id: number, limit = 150, offset = 0): Promise<StructurePage<CodeSymbol>> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<StructurePage<CodeSymbol>>(`/projects/${id}/symbols?${params}`, "加载符号列表");
}

export function getProjectImports(id: number, limit = 150, offset = 0): Promise<StructurePage<ImportRelation>> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<StructurePage<ImportRelation>>(`/projects/${id}/imports?${params}`, "加载依赖列表");
}

export function getProjectIssues(id: number, limit = 150, offset = 0): Promise<StructurePage<ParseIssue>> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<StructurePage<ParseIssue>>(`/projects/${id}/issues?${params}`, "加载解析问题");
}

export function reanalyzeProject(id: number): Promise<ProjectStructureSummary> {
  return request<ProjectStructureSummary>(`/projects/${id}/reanalyze`, "重新分析项目", { method: "POST" });
}

export function incrementalReanalyzeProject(id: number): Promise<IncrementalAnalysisResult> {
  return request<IncrementalAnalysisResult>(`/projects/${id}/incremental-reanalyze`, "增量分析项目", { method: "POST" });
}

export function searchProject(id: number, query: string, limit = 10, offset = 0): Promise<CodeSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
  return request<CodeSearchResponse>(`/projects/${id}/search?${params}`, "搜索代码");
}

export function getDependencyGraph(id: number, limit = 40, cycle?: number): Promise<DependencyGraph> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cycle !== undefined) params.set("cycle", String(cycle));
  return request<DependencyGraph>(`/projects/${id}/dependency-graph?${params}`, cycle === undefined ? "加载依赖图谱" : "加载循环依赖");
}

export function getQualityReport(id: number, limit = 100, offset = 0, severity = "all", rule = "all"): Promise<QualityReport> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (severity !== "all") params.set("severity", severity);
  if (rule !== "all") params.set("rule", rule);
  return request<QualityReport>(`/projects/${id}/quality?${params}`, "生成质量报告");
}

export function getReportGenerators(): Promise<ReportGenerator[]> {
  return request<ReportGenerator[]>("/projects/report-generators", "加载分析接口");
}

export function configureReportGenerator(id: string, configuration: ReportGeneratorConfiguration): Promise<ReportGenerator> {
  return request<ReportGenerator>(`/projects/report-generators/${encodeURIComponent(id)}`, "保存 API 配置", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(configuration),
  });
}

export function testReportGenerator(id: string): Promise<ReportGeneratorTestResult> {
  return request<ReportGeneratorTestResult>(`/projects/report-generators/${encodeURIComponent(id)}/test`, "测试 API 连接", { method: "POST" });
}

export function generateProjectReport(id: number, generator = "local", mode: "summary" | "full" = "summary"): Promise<GeneratedReport> {
  const params = new URLSearchParams({ generator, mode });
  return request<GeneratedReport>(`/projects/${id}/report?${params}`, "生成分析报告");
}

export function uploadProject(file: File, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): Promise<AnalysisJob> {
  if (file.size > limits.max_upload_mb * 1024 * 1024) {
    throw new ApiRequestError(
      `导入 ZIP 仓库失败：压缩包大小为 ${formatUploadSize(file.size)}，超过 ${limits.max_upload_mb} MB 上限。建议：删除依赖和构建产物后重新压缩。`,
      "导入 ZIP 仓库",
      0,
      null,
    );
  }
  const formData = new FormData();
  formData.append("archive", file);
  return request<AnalysisJob>("/projects/jobs/zip", "导入 ZIP 仓库", { method: "POST", body: formData });
}

export function uploadFolder(files: File[], limits: ImportLimits = DEFAULT_IMPORT_LIMITS): Promise<AnalysisJob> {
  const { acceptedFiles } = prepareFolderUpload(files, limits);
  const formData = new FormData();
  for (const file of acceptedFiles) {
    formData.append("files", file, file.webkitRelativePath || file.name);
  }
  return request<AnalysisJob>("/projects/jobs/folder", "导入本地文件夹", { method: "POST", body: formData });
}

export function prepareFolderUpload(files: File[], limits: ImportLimits = DEFAULT_IMPORT_LIMITS): FolderUploadPreparation {
  const originalBytes = files.reduce((total, file) => total + file.size, 0);
  const acceptedFiles: File[] = [];
  let directoryIgnoredCount = 0;
  let unsupportedCount = 0;
  let oversizedCount = 0;

  for (const file of files) {
    const pathParts = (file.webkitRelativePath || file.name).replaceAll("\\", "/").split("/").filter(Boolean);
    const directories = pathParts.length > 1 ? pathParts.slice(1, -1) : [];
    if (directories.some(isIgnoredUploadDirectory)) {
      directoryIgnoredCount += 1;
      continue;
    }
    const filename = pathParts.at(-1) ?? file.name;
    if (!isAnalyzableUploadFilename(filename)) {
      unsupportedCount += 1;
      continue;
    }
    if (file.size > limits.max_source_file_mb * 1024 * 1024) {
      oversizedCount += 1;
      continue;
    }
    acceptedFiles.push(file);
  }
  const ignoredCount = files.length - acceptedFiles.length;

  if (acceptedFiles.length === 0) {
    throw new ApiRequestError(
      "导入本地文件夹失败：跳过依赖、缓存和构建目录后没有可分析文件。建议：选择包含源代码的项目根目录。",
      "导入本地文件夹",
      0,
      null,
    );
  }
  if (acceptedFiles.length > limits.max_folder_files) {
    throw new ApiRequestError(
      `导入本地文件夹失败：可分析文件共 ${acceptedFiles.length} 个，超过 ${limits.max_folder_files} 个文件上限。建议：移除大型生成目录或改为上传精简后的源码。`,
      "导入本地文件夹",
      0,
      null,
    );
  }

  const totalBytes = acceptedFiles.reduce((total, file) => total + file.size, 0);
  if (totalBytes > limits.max_upload_mb * 1024 * 1024) {
    throw new ApiRequestError(
      `导入本地文件夹失败：可分析文件总大小为 ${formatUploadSize(totalBytes)}，超过 ${limits.max_upload_mb} MB 上限。建议：移除大型资源、数据和构建文件后重试。`,
      "导入本地文件夹",
      0,
      null,
    );
  }
  return {
    acceptedFiles,
    originalCount: files.length,
    originalBytes,
    ignoredCount,
    ignoredBytes: originalBytes - totalBytes,
    totalBytes,
    directoryIgnoredCount,
    unsupportedCount,
    oversizedCount,
    selectionMode: "legacy",
    scannedEntryCount: files.length,
    skippedDirectoryCount: 0,
    skippedDirectoryNames: [],
  };
}

export function formatUploadSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function importGitHubProject(url: string): Promise<AnalysisJob> {
  return request<AnalysisJob>("/projects/jobs/github", "导入 GitHub 仓库", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export function getAnalysisJob(id: string): Promise<AnalysisJob> {
  return request<AnalysisJob>(`/projects/jobs/${id}`, "查询分析进度");
}

export function deleteProject(id: number): Promise<void> {
  return request<void>(`/projects/${id}`, "删除项目", { method: "DELETE" });
}
