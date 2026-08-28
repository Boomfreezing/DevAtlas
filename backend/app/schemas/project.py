from datetime import datetime
from typing import Any, Literal

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


class ProjectFileContentResponse(BaseModel):
    file_id: int
    file_path: str
    language: str | None
    size_bytes: int
    total_lines: int
    lines: list[str]


class ProjectFileTreeNodeResponse(BaseModel):
    kind: str
    name: str
    path: str
    file_count: int
    id: int | None
    extension: str | None
    language: str | None
    size_bytes: int | None
    line_count: int | None


class ProjectFileTreeResponse(BaseModel):
    path: str
    total_files: int
    items: list[ProjectFileTreeNodeResponse]


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


class GitCommitResponse(BaseModel):
    sha: str
    message: str
    author: str
    authored_at: str


class ProjectGitSummaryResponse(BaseModel):
    available: bool
    refreshable: bool
    repository_url: str | None
    default_branch: str | None
    head_commit: str | None
    history_available: bool
    recent_commits: list[GitCommitResponse]
    fetched_at: datetime | None
    message: str


class GitFileChangeResponse(BaseModel):
    path: str
    status: str
    additions: int
    deletions: int
    changes: int


class GitComparisonResponse(BaseModel):
    repository_url: str
    base_commit: str
    head_commit: str
    status: str
    ahead_by: int
    behind_by: int
    total_commits: int
    additions: int
    deletions: int
    changed_files: int
    files: list[GitFileChangeResponse]
    truncated: bool


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


class ProjectStructureSummaryResponse(BaseModel):
    symbol_count: int
    class_count: int
    function_count: int
    import_count: int
    resolved_import_count: int
    issue_count: int


class CodeSymbolPageResponse(BaseModel):
    total: int
    limit: int
    offset: int
    has_more: bool
    items: list[CodeSymbolResponse]


class ImportRelationPageResponse(BaseModel):
    total: int
    limit: int
    offset: int
    has_more: bool
    items: list[ImportRelationResponse]


class ParseIssuePageResponse(BaseModel):
    total: int
    limit: int
    offset: int
    has_more: bool
    items: list[ParseIssueResponse]


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
    unresolved_import_count: int
    classified_import_count: int
    classification_confidence: float
    confidence_level: str
    cycle_count: int
    truncated: bool
    nodes: list[DependencyNodeResponse]
    edges: list[DependencyEdgeResponse]
    cycles: list[DependencyCycleResponse]


class ImpactTargetResponse(BaseModel):
    target_type: str
    target_id: int
    file_id: int
    file_path: str
    name: str
    kind: str
    start_line: int
    end_line: int


class ImpactRelationResponse(BaseModel):
    file_id: int
    file_path: str
    relation: str
    confidence: str
    depth: int
    line_numbers: list[int]
    symbol_id: int | None
    symbol_name: str | None
    symbol_kind: str | None
    start_line: int | None
    end_line: int | None


class ImpactRiskFactorResponse(BaseModel):
    key: str
    label: str
    actual: float
    reference: float
    unit: str
    contribution: int
    explanation: str


class ImpactRiskResponse(BaseModel):
    model: str
    base_score: int
    level: str
    score: int
    confidence: str
    reasons: list[str]
    factors: list[ImpactRiskFactorResponse]


class ImpactCycleResponse(BaseModel):
    file_ids: list[int]
    paths: list[str]


class ImpactRecommendationResponse(BaseModel):
    code: str
    priority: Literal["high", "medium", "low"]
    title: str
    detail: str
    related_paths: list[str]


class ChangeImpactResponse(BaseModel):
    target: ImpactTargetResponse
    definition: ImpactRelationResponse
    risk: ImpactRiskResponse
    direct_callers: list[ImpactRelationResponse]
    called_objects: list[ImpactRelationResponse]
    dependencies: list[ImpactRelationResponse]
    indirect_impacts: list[ImpactRelationResponse]
    related_tests: list[ImpactRelationResponse]
    related_apis: list[ImpactRelationResponse]
    database_entities: list[ImpactRelationResponse]
    cycles: list[ImpactCycleResponse]
    recommendations: list[ImpactRecommendationResponse]
    limitations: str


class QualityRuleResponse(BaseModel):
    id: str
    title: str
    description: str
    default_severity: str


class QualityFindingResponse(BaseModel):
    id: str
    rule_id: str
    severity: str
    scope: str
    title: str
    description: str
    suggestion: str
    file_id: int | None
    file_path: str
    start_line: int | None
    end_line: int | None
    metric: int
    threshold: int


class QualityProjectSizeResponse(BaseModel):
    file_count: int
    code_line_count: int
    symbol_count: int


class QualityScoringResponse(BaseModel):
    model: str
    size_factor: float
    scale_units: float
    project_size: QualityProjectSizeResponse
    reference_size: QualityProjectSizeResponse
    base_weights: dict[str, float]
    effective_weights: dict[str, float]
    base_penalty: float
    adjusted_penalty: int
    rule_penalties: dict[str, float]
    scope_weights: dict[str, float]
    effective_scope_weights: dict[str, float]
    excluded_scopes: list[str]
    source_file_count: int
    parser_supported_file_count: int
    applicable_rule_count: int
    total_rule_count: int
    parser_coverage: float
    coverage_level: str
    coverage_message: str
    explanation: str


class QualityScopeSummaryResponse(BaseModel):
    scope: str
    label: str
    score: int | None
    grade: str | None
    available: bool
    configured_weight: float
    effective_weight: float
    exclusion_reason: str | None
    finding_count: int
    severity_counts: dict[str, int]
    project_size: QualityProjectSizeResponse


class QualityReportResponse(BaseModel):
    score: int
    grade: str
    score_scope: str
    scoring: QualityScoringResponse
    scope_scores: dict[str, QualityScopeSummaryResponse]
    total_findings: int
    severity_counts: dict[str, int]
    rule_counts: dict[str, int]
    rules: list[QualityRuleResponse]
    filtered_findings: int
    limit: int
    offset: int
    has_more: bool
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


class AnalysisSnapshotCreateRequest(BaseModel):
    label: str | None = Field(default=None, max_length=120)


class AnalysisSnapshotSummaryResponse(BaseModel):
    id: int
    project_id: int
    label: str
    reason: str
    created_at: datetime
    score: int
    grade: str
    file_count: int
    symbol_count: int
    import_count: int
    finding_count: int
    cycle_count: int
    parse_issue_count: int


class SnapshotMetricChangeResponse(BaseModel):
    key: str
    label: str
    base: int
    target: int
    delta: int


class SnapshotItemComparisonResponse(BaseModel):
    new_count: int
    fixed_count: int
    persistent_count: int
    new_items: list[dict[str, Any]]
    fixed_items: list[dict[str, Any]]
    persistent_items: list[dict[str, Any]]
    truncated: bool


class AnalysisSnapshotComparisonResponse(BaseModel):
    base: AnalysisSnapshotSummaryResponse
    target: AnalysisSnapshotSummaryResponse
    metric_changes: list[SnapshotMetricChangeResponse]
    quality: SnapshotItemComparisonResponse
    parse_issues: SnapshotItemComparisonResponse
    cycles: SnapshotItemComparisonResponse


class ReportProviderConfigurationRequest(BaseModel):
    base_url: str = Field(min_length=8, max_length=500)
    model: str = Field(min_length=1, max_length=200)
    api_key: str | None = Field(default=None, max_length=500)


class RepositoryQuestionHistoryItem(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=4_000)


class RepositoryQuestionRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2_000)
    provider: str = Field(min_length=1, max_length=80)
    history: list[RepositoryQuestionHistoryItem] = Field(default_factory=list, max_length=10)


class RepositoryCitationResponse(BaseModel):
    file_id: int
    file_path: str
    start_line: int
    end_line: int
    symbol_name: str | None
    snippet: str
    source: str


class RepositoryAnswerResponse(BaseModel):
    question: str
    answer: str
    provider: str
    engine_name: str
    citations: list[RepositoryCitationResponse]
    evidence_count: int
    reference_count: int
    confidence: Literal["low", "medium", "high"]
    grounding_status: Literal[
        "project_context", "grounded", "insufficient", "reference_failed"
    ]
    elapsed_ms: float
