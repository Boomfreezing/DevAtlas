export interface ProjectFile {
  id: number;
  relative_path: string;
  extension: string;
  language: string | null;
  size_bytes: number;
  line_count: number;
  content_hash: string;
}

export interface ProjectFileContent {
  file_id: number;
  file_path: string;
  language: string | null;
  size_bytes: number;
  total_lines: number;
  lines: string[];
}

export interface ProjectSummary {
  id: number;
  name: string;
  source_filename: string;
  status: string;
  primary_language: string | null;
  file_count: number;
  code_line_count: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectDetail extends ProjectSummary {
  files: ProjectFile[];
}

export interface CodeSymbol {
  id: number;
  file_id: number;
  name: string;
  qualified_name: string;
  kind: "class" | "interface" | "function" | "method";
  start_line: number;
  end_line: number;
  file_path: string;
}

export interface ImportRelation {
  id: number;
  file_id: number;
  resolved_file_id: number | null;
  source_path: string;
  target_module: string;
  line_number: number;
}

export interface ParseIssue {
  id: number;
  file_id: number;
  file_path: string;
  message: string;
}

export interface ProjectStructureSummary {
  symbol_count: number;
  class_count: number;
  function_count: number;
  import_count: number;
  resolved_import_count: number;
  issue_count: number;
}

export interface ProjectStructure extends ProjectStructureSummary {
  symbols: CodeSymbol[];
  imports: ImportRelation[];
  issues: ParseIssue[];
}

export interface StructurePage<T> {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  items: T[];
}

export interface CodeSearchResult {
  chunk_id: number;
  file_id: number;
  file_path: string;
  symbol_name: string | null;
  kind: string;
  start_line: number;
  end_line: number;
  snippet_start_line: number;
  snippet_end_line: number;
  snippet: string;
  score: number;
}

export interface CodeSearchResponse {
  query: string;
  indexed_chunks: number;
  total_matches: number;
  limit: number;
  offset: number;
  has_more: boolean;
  elapsed_ms: number;
  results: CodeSearchResult[];
}

export interface DependencyNode {
  id: number;
  path: string;
  language: string | null;
  in_degree: number;
  out_degree: number;
}

export interface DependencyEdge {
  source_id: number;
  target_id: number;
  source_path: string;
  target_path: string;
  import_count: number;
  line_numbers: number[];
}

export interface DependencyCycle {
  file_ids: number[];
  paths: string[];
}

export interface DependencyGraph {
  total_node_count: number;
  total_edge_count: number;
  internal_import_count: number;
  external_import_count: number;
  cycle_count: number;
  truncated: boolean;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  cycles: DependencyCycle[];
}

export interface QualityRule {
  id: string;
  title: string;
  description: string;
  default_severity: "error" | "warning" | "info";
}

export interface QualityFinding {
  id: string;
  rule_id: string;
  severity: "error" | "warning" | "info";
  title: string;
  description: string;
  suggestion: string;
  file_id: number | null;
  file_path: string;
  start_line: number | null;
  end_line: number | null;
  metric: number;
  threshold: number;
}

export interface QualityScoring {
  model: string;
  size_factor: number;
  scale_units: number;
  project_size: { file_count: number; code_line_count: number; symbol_count: number };
  reference_size: { file_count: number; code_line_count: number; symbol_count: number };
  base_weights: Record<"error" | "warning" | "info", number>;
  effective_weights: Record<"error" | "warning" | "info", number>;
  base_penalty: number;
  adjusted_penalty: number;
  rule_penalties: Record<string, number>;
  explanation: string;
}

export interface QualityReport {
  score: number;
  grade: string;
  scoring: QualityScoring;
  total_findings: number;
  severity_counts: Record<"error" | "warning" | "info", number>;
  rule_counts: Record<string, number>;
  rules: QualityRule[];
  findings: QualityFinding[];
  truncated: boolean;
  elapsed_ms: number;
}

export interface AnalysisJob {
  id: string;
  source_type: "zip" | "folder" | "github";
  source_label: string;
  status: "queued" | "running" | "completed" | "failed";
  stage: string;
  progress: number;
  message: string;
  project_id: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ImportLimits {
  max_upload_mb: number;
  max_folder_files: number;
  max_source_file_mb: number;
}

export interface IncrementalAnalysisResult {
  project_id: number;
  added_file_count: number;
  changed_file_count: number;
  deleted_file_count: number;
  unchanged_file_count: number;
  parsed_file_count: number;
  added_paths: string[];
  changed_paths: string[];
  deleted_paths: string[];
  elapsed_ms: number;
}

export interface ReportGenerator {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  available: boolean;
  requires_configuration: boolean;
  cost_label: string;
  configured: boolean;
  base_url: string;
  model: string;
  has_api_key: boolean;
  connection_status: "ready" | "untested" | "success" | "failed";
  connection_message: string;
  tested_at: string | null;
}

export interface ReportGeneratorConfiguration {
  base_url: string;
  model: string;
  api_key?: string;
}

export interface ReportGeneratorTestResult {
  ok: boolean;
  message: string;
  provider: ReportGenerator;
}

export interface GeneratedReport {
  generator: string;
  generated_at: string;
  filename: string;
  content: string;
}
