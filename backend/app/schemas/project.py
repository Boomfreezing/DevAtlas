from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ProjectFileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    relative_path: str
    extension: str
    language: str | None
    size_bytes: int
    line_count: int
    content_hash: str


class ProjectSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    source_filename: str
    status: str
    primary_language: str | None
    file_count: int
    code_line_count: int
    created_at: datetime
    updated_at: datetime


class ProjectDetail(ProjectSummary):
    files: list[ProjectFileResponse]


class GitHubImportRequest(BaseModel):
    url: str


class CodeSymbolResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    file_id: int
    name: str
    qualified_name: str
    kind: str
    start_line: int
    end_line: int
    file_path: str


class ImportRelationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    file_id: int
    resolved_file_id: int | None
    source_path: str
    target_module: str
    line_number: int


class ParseIssueResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    file_id: int
    file_path: str
    message: str


class ProjectStructureResponse(BaseModel):
    symbol_count: int
    class_count: int
    function_count: int
    import_count: int
    resolved_import_count: int
    issue_count: int
    symbols: list[CodeSymbolResponse]
    imports: list[ImportRelationResponse]
    issues: list[ParseIssueResponse]


class CodeSearchResult(BaseModel):
    chunk_id: int
    file_id: int
    file_path: str
    symbol_name: str | None
    kind: str
    start_line: int
    end_line: int
    snippet_start_line: int
    snippet_end_line: int
    snippet: str
    score: float


class CodeSearchResponse(BaseModel):
    query: str
    indexed_chunks: int
    total_matches: int
    limit: int
    offset: int
    has_more: bool
    elapsed_ms: float
    results: list[CodeSearchResult]


class DependencyNodeResponse(BaseModel):
    id: int
    path: str
    language: str | None
    in_degree: int
    out_degree: int


class DependencyEdgeResponse(BaseModel):
    source_id: int
    target_id: int
    source_path: str
    target_path: str
    import_count: int
    line_numbers: list[int]


class DependencyCycleResponse(BaseModel):
    file_ids: list[int]
    paths: list[str]


class DependencyGraphResponse(BaseModel):
    total_node_count: int
    total_edge_count: int
    internal_import_count: int
    external_import_count: int
    cycle_count: int
    truncated: bool
    nodes: list[DependencyNodeResponse]
    edges: list[DependencyEdgeResponse]
    cycles: list[DependencyCycleResponse]


class QualityRuleResponse(BaseModel):
    id: str
    title: str
    description: str
    default_severity: str


class QualityFindingResponse(BaseModel):
    id: str
    rule_id: str
    severity: str
    title: str
    description: str
    suggestion: str
    file_id: int | None
    file_path: str
    start_line: int | None
    end_line: int | None
    metric: int
    threshold: int


class QualityReportResponse(BaseModel):
    score: int
    grade: str
    total_findings: int
    severity_counts: dict[str, int]
    rule_counts: dict[str, int]
    rules: list[QualityRuleResponse]
    findings: list[QualityFindingResponse]
    truncated: bool
    elapsed_ms: float


class AnalysisJobResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    source_type: str
    source_label: str
    status: str
    stage: str
    progress: int
    message: str
    project_id: int | None
    error: str | None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None


class IncrementalAnalysisResponse(BaseModel):
    project_id: int
    added_file_count: int
    changed_file_count: int
    deleted_file_count: int
    unchanged_file_count: int
    parsed_file_count: int
    added_paths: list[str]
    changed_paths: list[str]
    deleted_paths: list[str]
    elapsed_ms: float


class ReportProviderConfigurationRequest(BaseModel):
    base_url: str = Field(min_length=8, max_length=500)
    model: str = Field(min_length=1, max_length=200)
    api_key: str | None = Field(default=None, max_length=500)
