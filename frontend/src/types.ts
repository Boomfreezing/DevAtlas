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

export interface ProjectFileTreeNode {
  kind: "directory" | "file";
  name: string;
  path: string;
  file_count: number;
  id: number | null;
  extension: string | null;
  language: string | null;
  size_bytes: number | null;
  line_count: number | null;
}

export interface ProjectFileTreeResponse {
  path: string;
  total_files: number;
  items: ProjectFileTreeNode[];
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

export interface RepositoryCitation {
  file_id: number;
  file_path: string;
  start_line: number;
  end_line: number;
  symbol_name: string | null;
  snippet: string;
  source: string;
}

export interface RepositoryAnswer {
  question: string;
  answer: string;
  provider: string;
  engine_name: string;
  citations: RepositoryCitation[];
  evidence_count: number;
  reference_count: number;
  confidence: "low" | "medium" | "high";
  grounding_status: "project_context" | "grounded" | "insufficient" | "reference_failed";
  elapsed_ms: number;
}

export interface RepositoryConversationItem {
  role: "user" | "assistant";
  content: string;
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
  unresolved_import_count: number;
  classified_import_count: number;
  classification_confidence: number;
  confidence_level: "high" | "medium" | "low";
  cycle_count: number;
  truncated: boolean;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  cycles: DependencyCycle[];
}

export interface ImpactTarget {
  target_type: "file" | "symbol";
  target_id: number;
  file_id: number;
  file_path: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
}

export interface ImpactRelation {
  file_id: number;
  file_path: string;
  relation: string;
  confidence: "high" | "medium" | "low";
  depth: number;
  line_numbers: number[];
  symbol_id: number | null;
  symbol_name: string | null;
  symbol_kind: string | null;
  start_line: number | null;
  end_line: number | null;
}

export interface ChangeImpact {
  target: ImpactTarget;
  definition: ImpactRelation;
  risk: {
    model: string;
    base_score: number;
    level: "high" | "medium" | "low";
    score: number;
    confidence: "high" | "medium" | "low";
    reasons: string[];
    factors: Array<{
      key: string;
      label: string;
      actual: number;
      reference: number;
      unit: string;
      contribution: number;
      explanation: string;
    }>;
  };
  direct_callers: ImpactRelation[];
  called_objects: ImpactRelation[];
  dependencies: ImpactRelation[];
  indirect_impacts: ImpactRelation[];
  related_tests: ImpactRelation[];
  related_apis: ImpactRelation[];
  database_entities: ImpactRelation[];
  cycles: DependencyCycle[];
  recommendations: Array<{
    code: string;
    priority: "high" | "medium" | "low";
    title: string;
    detail: string;
    related_paths: string[];
  }>;
  limitations: string;
}

export interface AnalysisSnapshotSummary {
  id: number;
  project_id: number;
  label: string;
  reason: "manual" | "import" | "full" | "incremental" | "sync";
  created_at: string;
  score: number;
  grade: string;
  file_count: number;
  symbol_count: number;
  import_count: number;
  finding_count: number;
  cycle_count: number;
  parse_issue_count: number;
}

export interface SnapshotMetricChange {
  key: string;
  label: string;
  base: number;
  target: number;
  delta: number;
}

export interface SnapshotComparisonGroup {
  new_count: number;
  fixed_count: number;
  persistent_count: number;
  new_items: Array<Record<string, unknown>>;
  fixed_items: Array<Record<string, unknown>>;
  persistent_items: Array<Record<string, unknown>>;
  truncated: boolean;
}

export interface AnalysisSnapshotComparison {
  base: AnalysisSnapshotSummary;
  target: AnalysisSnapshotSummary;
  metric_changes: SnapshotMetricChange[];
  quality: SnapshotComparisonGroup;
  parse_issues: SnapshotComparisonGroup;
  cycles: SnapshotComparisonGroup;
}

export interface ProjectGitSummary {
  available: boolean;
  refreshable: boolean;
  repository_url: string | null;
  default_branch: string | null;
  head_commit: string | null;
  history_available: boolean;
  recent_commits: Array<{
    sha: string;
    message: string;
    author: string;
    authored_at: string;
  }>;
  fetched_at: string | null;
  message: string;
}

export interface GitComparison {
  repository_url: string;
  base_commit: string;
  head_commit: string;
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  files: Array<{
    path: string;
    status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
    additions: number;
    deletions: number;
    changes: number;
  }>;
  truncated: boolean;
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
  scope: "production" | "test" | "generated";
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
  scope_weights: Record<"production" | "test" | "generated", number>;
  effective_scope_weights: Record<"production" | "test" | "generated", number>;
  excluded_scopes: Array<"production" | "test" | "generated">;
  source_file_count: number;
  parser_supported_file_count: number;
  applicable_rule_count: number;
  total_rule_count: number;
  parser_coverage: number;
  coverage_level: "none" | "limited" | "partial" | "high";
  coverage_message: string;
  explanation: string;
}

export interface QualityReport {
  score: number;
  grade: string;
  score_scope: "composite";
  scoring: QualityScoring;
  scope_scores: Record<"production" | "test" | "generated", {
    scope: "production" | "test" | "generated";
    label: string;
    score: number | null;
    grade: string | null;
    available: boolean;
    configured_weight: number;
    effective_weight: number;
    exclusion_reason: string | null;
    finding_count: number;
    severity_counts: Record<"error" | "warning" | "info", number>;
    project_size: { file_count: number; code_line_count: number; symbol_count: number };
  }>;
  total_findings: number;
  severity_counts: Record<"error" | "warning" | "info", number>;
  rule_counts: Record<string, number>;
  rules: QualityRule[];
  findings: QualityFinding[];
  filtered_findings: number;
  limit: number;
  offset: number;
  has_more: boolean;
  truncated: boolean;
  elapsed_ms: number;
}

export interface AnalysisJob {
  id: string;
  source_type: "zip" | "folder" | "github" | "github_sync";
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
  mode: "summary" | "full";
  generated_at: string;
  filename: string;
  content: string;
}
