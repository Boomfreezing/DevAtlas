import type { AnalysisJob, CodeSearchResponse, DependencyGraph, GeneratedReport, IncrementalAnalysisResult, ProjectDetail, ProjectFileContent, ProjectStructure, ProjectSummary, QualityReport, ReportGenerator, ReportGeneratorConfiguration, ReportGeneratorTestResult } from "./types";

const API_ROOT = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, options);
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // Keep the status-based fallback message.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function listProjects(): Promise<ProjectSummary[]> {
  return request<ProjectSummary[]>("/projects");
}

export function getProject(id: number): Promise<ProjectDetail> {
  return request<ProjectDetail>(`/projects/${id}`);
}

export function getProjectFileContent(projectId: number, fileId: number): Promise<ProjectFileContent> {
  return request<ProjectFileContent>(`/projects/${projectId}/files/${fileId}/content`);
}

export function getProjectStructure(id: number): Promise<ProjectStructure> {
  return request<ProjectStructure>(`/projects/${id}/structure`);
}

export function reanalyzeProject(id: number): Promise<ProjectStructure> {
  return request<ProjectStructure>(`/projects/${id}/reanalyze`, { method: "POST" });
}

export function incrementalReanalyzeProject(id: number): Promise<IncrementalAnalysisResult> {
  return request<IncrementalAnalysisResult>(`/projects/${id}/incremental-reanalyze`, { method: "POST" });
}

export function searchProject(id: number, query: string, limit = 10, offset = 0): Promise<CodeSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
  return request<CodeSearchResponse>(`/projects/${id}/search?${params}`);
}

export function getDependencyGraph(id: number, limit = 40): Promise<DependencyGraph> {
  return request<DependencyGraph>(`/projects/${id}/dependency-graph?limit=${limit}`);
}

export function getQualityReport(id: number, limit = 500): Promise<QualityReport> {
  return request<QualityReport>(`/projects/${id}/quality?limit=${limit}`);
}

export function getReportGenerators(): Promise<ReportGenerator[]> {
  return request<ReportGenerator[]>("/projects/report-generators");
}

export function configureReportGenerator(id: string, configuration: ReportGeneratorConfiguration): Promise<ReportGenerator> {
  return request<ReportGenerator>(`/projects/report-generators/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(configuration),
  });
}

export function testReportGenerator(id: string): Promise<ReportGeneratorTestResult> {
  return request<ReportGeneratorTestResult>(`/projects/report-generators/${encodeURIComponent(id)}/test`, { method: "POST" });
}

export function generateProjectReport(id: number, generator = "local"): Promise<GeneratedReport> {
  const params = new URLSearchParams({ generator });
  return request<GeneratedReport>(`/projects/${id}/report?${params}`);
}

export function uploadProject(file: File): Promise<AnalysisJob> {
  const formData = new FormData();
  formData.append("archive", file);
  return request<AnalysisJob>("/projects/jobs/zip", { method: "POST", body: formData });
}

export function uploadFolder(files: File[]): Promise<AnalysisJob> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file, file.webkitRelativePath || file.name);
  }
  return request<AnalysisJob>("/projects/jobs/folder", { method: "POST", body: formData });
}

export function importGitHubProject(url: string): Promise<AnalysisJob> {
  return request<AnalysisJob>("/projects/jobs/github", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export function getAnalysisJob(id: string): Promise<AnalysisJob> {
  return request<AnalysisJob>(`/projects/jobs/${id}`);
}

export function deleteProject(id: number): Promise<void> {
  return request<void>(`/projects/${id}`, { method: "DELETE" });
}
