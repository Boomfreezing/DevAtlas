from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload, sessionmaker

from app.core.config import Settings, get_settings
from app.core.database import get_db
from app.models.analysis import AnalysisJob
from app.models.project import Project
from app.schemas.project import (
    AnalysisJobResponse,
    AnalysisSnapshotComparisonResponse,
    AnalysisSnapshotCreateRequest,
    AnalysisSnapshotSummaryResponse,
    ChangeImpactResponse,
    CodeSearchResponse,
    CodeSymbolPageResponse,
    DependencyGraphResponse,
    GitComparisonResponse,
    GitHubImportRequest,
    ImpactTargetResponse,
    ImportRelationPageResponse,
    IncrementalAnalysisResponse,
    ParseIssuePageResponse,
    ProjectDetail,
    ProjectFileContentResponse,
    ProjectFileTreeResponse,
    ProjectGitSummaryResponse,
    ProjectStructureResponse,
    ProjectStructureSummaryResponse,
    ProjectSummary,
    QualityReportResponse,
    ReportProviderConfigurationRequest,
    RepositoryAnswerResponse,
    RepositoryQuestionRequest,
)
from app.services.analysis_cache import invalidate_project_analysis
from app.services.archive_service import (
    ArchiveValidationError,
    infer_project_name,
    save_and_extract_archive,
)
from app.services.dependency_graph_service import load_dependency_graph
from app.services.file_content_service import (
    FileContentError,
    FileContentNotFoundError,
    load_project_file_content,
)
from app.services.folder_service import save_uploaded_folder
from app.services.git_metadata_service import (
    get_git_summary,
    repository_for_project,
    save_git_metadata,
)
from app.services.github_service import (
    GitHubComparison,
    GitHubDownloadError,
    GitHubMetadata,
    GitHubMetadataError,
    GitHubValidationError,
    download_github_repository,
    fetch_github_comparison,
    fetch_github_metadata,
    parse_github_repository,
)
from app.services.impact_analysis_service import (
    ImpactTargetNotFoundError,
    analyze_change_impact,
    search_impact_targets,
)
from app.services.incremental_analyzer import incrementally_analyze_project
from app.services.job_service import run_github_job, run_github_sync_job, run_repository_job
from app.services.project_service import (
    create_scanned_project,
    load_project_file_tree,
    remove_managed_repository,
)
from app.services.quality_service import build_quality_report
from app.services.report_provider_service import (
    ReportProviderError,
    enhance_markdown_report,
    list_report_providers,
    save_report_provider,
    test_report_provider,
)
from app.services.report_service import build_markdown_report
from app.services.repository_path_service import resolve_project_storage_path
from app.services.repository_qa_service import answer_repository_question
from app.services.search_service import remove_persisted_search_index, search_project
from app.services.semantic_search_service import warm_project_semantic_index
from app.services.snapshot_service import (
    SnapshotNotFoundError,
    compare_analysis_snapshots,
    create_analysis_snapshot,
    delete_analysis_snapshot,
    list_analysis_snapshots,
)
from app.services.structure_analyzer import (
    analyze_project_structure,
    load_project_imports,
    load_project_issues,
    load_project_structure,
    load_project_structure_summary,
    load_project_symbols,
)

router = APIRouter()


@router.get("", response_model=list[ProjectSummary])
def list_projects(database: Session = Depends(get_db)) -> list[Project]:
    statement = select(Project).order_by(Project.created_at.desc(), Project.id.desc())
    return list(database.scalars(statement))


@router.post("", response_model=ProjectDetail, status_code=status.HTTP_201_CREATED)
async def import_zip_project(
    archive: UploadFile = File(...),
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Project:
    try:
        repository_path, original_name = await save_and_extract_archive(archive, settings)
    except ArchiveValidationError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    return _persist_import(
        database,
        settings,
        repository_path,
        source_filename=original_name,
        project_name=infer_project_name(original_name),
    )


@router.post("/folder", response_model=ProjectDetail, status_code=status.HTTP_201_CREATED)
async def import_folder_project(
    files: list[UploadFile] = File(...),
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Project:
    try:
        repository_path, source_name, project_name = await save_uploaded_folder(files, settings)
    except ArchiveValidationError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    return _persist_import(
        database,
        settings,
        repository_path,
        source_filename=source_name,
        project_name=project_name,
    )


@router.post("/github", response_model=ProjectDetail, status_code=status.HTTP_201_CREATED)
async def import_github_project(
    request: GitHubImportRequest,
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Project:
    try:
        repository = parse_github_repository(request.url)
    except GitHubValidationError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error

    git_metadata: GitHubMetadata | None = None
    try:
        git_metadata = await fetch_github_metadata(repository)
    except GitHubMetadataError:
        pass
    try:
        repository_path = await download_github_repository(repository, settings)
    except GitHubDownloadError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(error)) from error

    return _persist_import(
        database,
        settings,
        repository_path,
        source_filename=repository.display_source,
        project_name=repository.name,
        git_metadata=git_metadata,
    )


@router.post(
    "/jobs/zip", response_model=AnalysisJobResponse, status_code=status.HTTP_202_ACCEPTED
)
async def queue_zip_project(
    background_tasks: BackgroundTasks,
    archive: UploadFile = File(...),
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AnalysisJob:
    try:
        repository_path, original_name = await save_and_extract_archive(archive, settings)
    except ArchiveValidationError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    job = _create_job(database, "zip", original_name)
    background_tasks.add_task(
        run_repository_job,
        job.id,
        repository_path,
        original_name,
        infer_project_name(original_name),
        settings,
        _session_factory(database),
    )
    return job


@router.post(
    "/jobs/folder", response_model=AnalysisJobResponse, status_code=status.HTTP_202_ACCEPTED
)
async def queue_folder_project(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AnalysisJob:
    try:
        repository_path, source_name, project_name = await save_uploaded_folder(files, settings)
    except ArchiveValidationError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    job = _create_job(database, "folder", source_name)
    background_tasks.add_task(
        run_repository_job,
        job.id,
        repository_path,
        source_name,
        project_name,
        settings,
        _session_factory(database),
    )
    return job


@router.post(
    "/jobs/github", response_model=AnalysisJobResponse, status_code=status.HTTP_202_ACCEPTED
)
def queue_github_project(
    request: GitHubImportRequest,
    background_tasks: BackgroundTasks,
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AnalysisJob:
    try:
        repository = parse_github_repository(request.url)
    except GitHubValidationError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    job = _create_job(database, "github", repository.display_source)
    background_tasks.add_task(
        run_github_job,
        job.id,
        repository,
        settings,
        _session_factory(database),
    )
    return job


@router.get("/jobs/{job_id}", response_model=AnalysisJobResponse)
def get_analysis_job(job_id: str, database: Session = Depends(get_db)) -> AnalysisJob:
    job = database.get(AnalysisJob, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Analysis job not found.")
    return job


@router.get("/{project_id}/git-summary", response_model=ProjectGitSummaryResponse)
def get_project_git_summary(
    project_id: int,
    database: Session = Depends(get_db),
) -> dict[str, object]:
    project = database.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return get_git_summary(database, project)


@router.post(
    "/{project_id}/sync-github",
    response_model=AnalysisJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def queue_github_sync(
    project_id: int,
    background_tasks: BackgroundTasks,
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AnalysisJob:
    project = database.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    repository = repository_for_project(project)
    if repository is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only projects imported from a GitHub repository URL can synchronize remote source.",
        )
    active_job = database.scalar(
        select(AnalysisJob).where(
            AnalysisJob.project_id == project_id,
            AnalysisJob.source_type == "github_sync",
            AnalysisJob.status.in_(["queued", "running"]),
        )
    )
    if active_job is not None:
        return active_job
    job = _create_job(database, "github_sync", repository.display_source)
    job.project_id = project_id
    database.commit()
    database.refresh(job)
    background_tasks.add_task(
        run_github_sync_job,
        job.id,
        project_id,
        repository,
        settings,
        _session_factory(database),
    )
    return job


@router.post("/{project_id}/git-summary/refresh", response_model=ProjectGitSummaryResponse)
async def refresh_project_git_summary(
    project_id: int,
    database: Session = Depends(get_db),
) -> dict[str, object]:
    project = database.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    repository = repository_for_project(project)
    if repository is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only projects imported from a GitHub repository URL can load Git metadata.",
        )
    try:
        metadata = await fetch_github_metadata(repository)
    except GitHubMetadataError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(error)) from error
    save_git_metadata(database, project, metadata)
    return get_git_summary(database, project)


@router.get("/{project_id}/git-compare", response_model=GitComparisonResponse)
async def compare_project_git_commits(
    project_id: int,
    base: str = Query(min_length=40, max_length=40, pattern="^[0-9a-fA-F]{40}$"),
    head: str = Query(min_length=40, max_length=40, pattern="^[0-9a-fA-F]{40}$"),
    database: Session = Depends(get_db),
) -> GitHubComparison:
    project = database.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    repository = repository_for_project(project)
    if repository is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only projects imported from a GitHub repository URL can compare commits.",
        )
    try:
        return await fetch_github_comparison(repository, base, head)
    except GitHubMetadataError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(error)) from error


@router.get("/report-generators")
def list_report_generators(
    settings: Settings = Depends(get_settings),
) -> list[dict[str, object]]:
    return list_report_providers(settings)


@router.put("/report-generators/{provider_id}")
def configure_report_generator(
    provider_id: str,
    request: ReportProviderConfigurationRequest,
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    try:
        return save_report_provider(
            settings,
            provider_id,
            base_url=request.base_url,
            model=request.model,
            api_key=request.api_key,
        )
    except ReportProviderError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.post("/report-generators/{provider_id}/test")
def test_report_generator(
    provider_id: str,
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    try:
        return test_report_provider(settings, provider_id)
    except ReportProviderError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.get("/{project_id}", response_model=ProjectSummary)
def get_project(project_id: int, database: Session = Depends(get_db)) -> Project:
    project = database.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return project


@router.get("/{project_id}/files/tree", response_model=ProjectFileTreeResponse)
def get_project_file_tree(
    project_id: int,
    path: str = Query(default="", max_length=1_000),
    database: Session = Depends(get_db),
) -> dict[str, object]:
    _ensure_project_exists(database, project_id)
    try:
        return load_project_file_tree(database, project_id, path)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error


@router.get(
    "/{project_id}/files/{file_id}/content",
    response_model=ProjectFileContentResponse,
)
def get_project_file_content(
    project_id: int,
    file_id: int,
    database: Session = Depends(get_db),
) -> dict[str, object]:
    try:
        return load_project_file_content(database, project_id, file_id)
    except FileContentNotFoundError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except FileContentError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.get("/{project_id}/structure", response_model=ProjectStructureResponse)
def get_project_structure(
    project_id: int, database: Session = Depends(get_db)
) -> dict[str, object]:
    if database.get(Project, project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return load_project_structure(database, project_id)


@router.get(
    "/{project_id}/structure/summary",
    response_model=ProjectStructureSummaryResponse,
)
def get_project_structure_summary(
    project_id: int, database: Session = Depends(get_db)
) -> dict[str, int]:
    _ensure_project_exists(database, project_id)
    return load_project_structure_summary(database, project_id)


@router.get("/{project_id}/symbols", response_model=CodeSymbolPageResponse)
def get_project_symbols(
    project_id: int,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=150, ge=1, le=500),
    q: str | None = Query(default=None, max_length=200),
    kind: str | None = Query(default=None, pattern="^(class|interface|function|method)$"),
    database: Session = Depends(get_db),
) -> dict[str, object]:
    _ensure_project_exists(database, project_id)
    return load_project_symbols(
        database,
        project_id,
        offset=offset,
        limit=limit,
        query=q.strip() if q and q.strip() else None,
        kind=kind,
    )


@router.get("/{project_id}/imports", response_model=ImportRelationPageResponse)
def get_project_imports(
    project_id: int,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=150, ge=1, le=500),
    q: str | None = Query(default=None, max_length=200),
    scope: str = Query(default="all", pattern="^(all|internal|external)$"),
    database: Session = Depends(get_db),
) -> dict[str, object]:
    _ensure_project_exists(database, project_id)
    return load_project_imports(
        database,
        project_id,
        offset=offset,
        limit=limit,
        query=q.strip() if q and q.strip() else None,
        scope=scope,
    )


@router.get("/{project_id}/issues", response_model=ParseIssuePageResponse)
def get_project_issues(
    project_id: int,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=150, ge=1, le=500),
    database: Session = Depends(get_db),
) -> dict[str, object]:
    _ensure_project_exists(database, project_id)
    return load_project_issues(database, project_id, offset=offset, limit=limit)


@router.get("/{project_id}/search", response_model=CodeSearchResponse)
def search_project_code(
    project_id: int,
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=10, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    statement = (
        select(Project)
        .where(Project.id == project_id)
        .options(selectinload(Project.files))
    )
    project = database.scalar(statement)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return search_project(
        database, project, q.strip(), limit, offset, settings.search_index_root
    )


@router.get("/{project_id}/dependency-graph", response_model=DependencyGraphResponse)
def get_dependency_graph(
    project_id: int,
    limit: int = Query(default=40, ge=5, le=100),
    cycle: int | None = Query(default=None, ge=1, le=20),
    database: Session = Depends(get_db),
) -> dict[str, object]:
    if database.get(Project, project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    try:
        return load_dependency_graph(
            database,
            project_id,
            limit,
            cycle_index=cycle - 1 if cycle is not None else None,
        )
    except IndexError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error


@router.get("/{project_id}/impact-targets", response_model=list[ImpactTargetResponse])
def get_impact_targets(
    project_id: int,
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=20, ge=1, le=30),
    database: Session = Depends(get_db),
) -> list[dict[str, object]]:
    _ensure_project_exists(database, project_id)
    return search_impact_targets(database, project_id, q, limit)


@router.get("/{project_id}/impact", response_model=ChangeImpactResponse)
def get_change_impact(
    project_id: int,
    target_type: str = Query(pattern="^(file|symbol)$"),
    target_id: int = Query(ge=1),
    database: Session = Depends(get_db),
) -> dict[str, object]:
    _ensure_project_exists(database, project_id)
    try:
        return analyze_change_impact(database, project_id, target_type, target_id)
    except ImpactTargetNotFoundError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error


@router.get("/{project_id}/quality", response_model=QualityReportResponse)
def get_quality_report(
    project_id: int,
    limit: int = Query(default=100, ge=1, le=300),
    offset: int = Query(default=0, ge=0),
    severity: str | None = Query(default=None, pattern="^(error|warning|info)$"),
    rule: str | None = Query(default=None, max_length=80),
    scope: str | None = Query(default=None, pattern="^(production|test|generated)$"),
    database: Session = Depends(get_db),
) -> dict[str, object]:
    if database.get(Project, project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return build_quality_report(
        database,
        project_id,
        limit=limit,
        offset=offset,
        severity=severity,
        rule_id=rule,
        scope=scope,
    )


@router.post("/{project_id}/ask", response_model=RepositoryAnswerResponse)
def ask_repository(
    project_id: int,
    request: RepositoryQuestionRequest,
    background_tasks: BackgroundTasks,
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    project = database.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    if request.provider == "local":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="智能问答必须选择已配置的生成模型；本地规则引擎仅用于分析报告。",
        )
    provider = next(
        (item for item in list_report_providers(settings) if item["id"] == request.provider),
        None,
    )
    if provider is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown question provider.")
    if not provider["available"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="所选生成模型尚未完成配置，请先前往 API 配置。",
        )
    try:
        answer = answer_repository_question(
            database,
            settings,
            project,
            request.question,
            request.provider,
            [item.model_dump() for item in request.history],
        )
        if settings.semantic_search_enabled and int(answer["evidence_count"]) > 0:
            background_tasks.add_task(
                warm_project_semantic_index,
                project.id,
                settings.search_index_root,
            )
        return answer
    except ReportProviderError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(error)) from error


@router.get("/{project_id}/report.md", response_class=Response)
def export_project_report(
    project_id: int,
    generator: str = Query(default="local"),
    mode: Literal["summary", "full"] = Query(default="summary"),
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    statement = (
        select(Project)
        .where(Project.id == project_id)
        .options(selectinload(Project.files))
    )
    project = database.scalar(statement)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    report = _generate_report(database, settings, project, generator, mode)
    return Response(
        content=report,
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="devatlas-project-{project.id}-{mode}-report.md"'
        },
    )


@router.get("/{project_id}/report")
def generate_project_report(
    project_id: int,
    generator: str = Query(default="local"),
    mode: Literal["summary", "full"] = Query(default="summary"),
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    statement = (
        select(Project)
        .where(Project.id == project_id)
        .options(selectinload(Project.files))
    )
    project = database.scalar(statement)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return {
        "generator": generator,
        "mode": mode,
        "generated_at": datetime.now(UTC).isoformat(),
        "filename": f"devatlas-project-{project.id}-{mode}-report.md",
        "content": _generate_report(database, settings, project, generator, mode),
    }


@router.post("/{project_id}/reanalyze", response_model=ProjectStructureSummaryResponse)
def reanalyze_project(
    project_id: int,
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    statement = (
        select(Project)
        .where(Project.id == project_id)
        .options(selectinload(Project.files))
    )
    project = database.scalar(statement)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    analyze_project_structure(
        database,
        project,
        search_index_root=settings.search_index_root,
    )
    database.commit()
    create_analysis_snapshot(database, project, reason="full", use_runtime_cache=False)
    return load_project_structure_summary(database, project_id)


@router.post(
    "/{project_id}/incremental-reanalyze", response_model=IncrementalAnalysisResponse
)
def incremental_reanalyze_project(
    project_id: int,
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict[str, object]:
    statement = (
        select(Project)
        .where(Project.id == project_id)
        .options(selectinload(Project.files))
    )
    project = database.scalar(statement)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    result = incrementally_analyze_project(
        database,
        project,
        settings.search_index_root,
    )
    if result["added_file_count"] or result["changed_file_count"] or result["deleted_file_count"]:
        create_analysis_snapshot(database, project, reason="incremental", use_runtime_cache=False)
    return result


@router.post(
    "/{project_id}/snapshots",
    response_model=AnalysisSnapshotSummaryResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_project_snapshot(
    project_id: int,
    request: AnalysisSnapshotCreateRequest,
    database: Session = Depends(get_db),
) -> dict[str, object]:
    project = database.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return create_analysis_snapshot(database, project, label=request.label, reason="manual")


@router.get("/{project_id}/snapshots", response_model=list[AnalysisSnapshotSummaryResponse])
def get_project_snapshots(
    project_id: int, database: Session = Depends(get_db)
) -> list[dict[str, object]]:
    _ensure_project_exists(database, project_id)
    return list_analysis_snapshots(database, project_id)


@router.get(
    "/{project_id}/snapshots/compare",
    response_model=AnalysisSnapshotComparisonResponse,
)
def compare_project_snapshots(
    project_id: int,
    base_id: int = Query(gt=0),
    target_id: int = Query(gt=0),
    database: Session = Depends(get_db),
) -> dict[str, object]:
    _ensure_project_exists(database, project_id)
    try:
        return compare_analysis_snapshots(database, project_id, base_id, target_id)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    except SnapshotNotFoundError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error


@router.delete("/{project_id}/snapshots/{snapshot_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_snapshot(
    project_id: int,
    snapshot_id: int,
    database: Session = Depends(get_db),
) -> None:
    _ensure_project_exists(database, project_id)
    try:
        delete_analysis_snapshot(database, project_id, snapshot_id)
    except SnapshotNotFoundError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: int,
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> None:
    project = database.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")

    storage_path = resolve_project_storage_path(project.storage_path)
    invalidate_project_analysis(database, project_id)
    remove_persisted_search_index(settings.search_index_root, project)
    database.delete(project)
    database.commit()
    remove_managed_repository(storage_path, settings.repository_root)


def _generate_report(
    database: Session,
    settings: Settings,
    project: Project,
    generator: str,
    mode: Literal["summary", "full"],
) -> str:
    provider = next(
        (item for item in list_report_providers(settings) if item["id"] == generator), None
    )
    if provider is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown report generator.")
    if not provider["available"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Report generator '{generator}' is not configured.",
        )
    local_report = build_markdown_report(
        database,
        project,
        mode=mode,
        generator_name=str(provider["name"]),
        uses_generation_model=generator != "local",
    )
    if generator == "local":
        return local_report
    try:
        return enhance_markdown_report(settings, generator, local_report)
    except ReportProviderError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(error)) from error


def _persist_import(
    database: Session,
    settings: Settings,
    repository_path: Path,
    source_filename: str,
    project_name: str,
    git_metadata: GitHubMetadata | None = None,
) -> Project:
    try:
        project = create_scanned_project(
            database,
            repository_path,
            source_filename=source_filename,
            project_name=project_name,
            search_index_root=settings.search_index_root,
        )
        if git_metadata is not None:
            save_git_metadata(database, project, git_metadata)
        return get_project(project.id, database)
    except Exception:
        database.rollback()
        remove_managed_repository(repository_path, settings.repository_root)
        raise


def _create_job(database: Session, source_type: str, source_label: str) -> AnalysisJob:
    job = AnalysisJob(
        id=str(uuid4()),
        source_type=source_type,
        source_label=source_label,
        status="queued",
        stage="queued",
        progress=5,
        message="任务已进入后台队列",
    )
    database.add(job)
    database.commit()
    database.refresh(job)
    return job


def _session_factory(database: Session) -> sessionmaker[Session]:
    return sessionmaker(bind=database.get_bind(), autoflush=False, expire_on_commit=False)


def _ensure_project_exists(database: Session, project_id: int) -> None:
    if database.get(Project, project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
