from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload, sessionmaker

from app.core.config import Settings, get_settings
from app.core.database import get_db
from app.models.analysis import AnalysisJob
from app.models.project import Project
from app.schemas.project import (
    AnalysisJobResponse,
    CodeSearchResponse,
    DependencyGraphResponse,
    QualityReportResponse,
    GitHubImportRequest,
    IncrementalAnalysisResponse,
    ProjectDetail,
    ProjectFileContentResponse,
    ProjectStructureResponse,
    ProjectSummary,
    ReportProviderConfigurationRequest,
)
from app.services.archive_service import (
    ArchiveValidationError,
    infer_project_name,
    save_and_extract_archive,
)
from app.services.folder_service import save_uploaded_folder
from app.services.file_content_service import (
    FileContentError,
    FileContentNotFoundError,
    load_project_file_content,
)
from app.services.github_service import (
    GitHubDownloadError,
    GitHubValidationError,
    download_github_repository,
    parse_github_repository,
)
from app.services.project_service import create_scanned_project, remove_managed_repository
from app.services.dependency_graph_service import load_dependency_graph
from app.services.quality_service import build_quality_report
from app.services.report_service import build_markdown_report
from app.services.report_provider_service import (
    ReportProviderError,
    enhance_markdown_report,
    list_report_providers,
    save_report_provider,
    test_report_provider,
)
from app.services.job_service import run_github_job, run_repository_job
from app.services.incremental_analyzer import incrementally_analyze_project
from app.services.search_service import search_project
from app.services.structure_analyzer import analyze_project_structure, load_project_structure

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


@router.get("/{project_id}", response_model=ProjectDetail)
def get_project(project_id: int, database: Session = Depends(get_db)) -> Project:
    statement = (
        select(Project)
        .where(Project.id == project_id)
        .options(selectinload(Project.files))
    )
    project = database.scalar(statement)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return project


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


@router.get("/{project_id}/search", response_model=CodeSearchResponse)
def search_project_code(
    project_id: int,
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=10, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
    database: Session = Depends(get_db),
) -> dict[str, object]:
    statement = (
        select(Project)
        .where(Project.id == project_id)
        .options(selectinload(Project.files))
    )
    project = database.scalar(statement)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return search_project(database, project, q.strip(), limit, offset)


@router.get("/{project_id}/dependency-graph", response_model=DependencyGraphResponse)
def get_dependency_graph(
    project_id: int,
    limit: int = Query(default=40, ge=5, le=100),
    database: Session = Depends(get_db),
) -> dict[str, object]:
    if database.get(Project, project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return load_dependency_graph(database, project_id, limit)


@router.get("/{project_id}/quality", response_model=QualityReportResponse)
def get_quality_report(
    project_id: int,
    limit: int = Query(default=300, ge=1, le=1_000),
    database: Session = Depends(get_db),
) -> dict[str, object]:
    if database.get(Project, project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return build_quality_report(database, project_id, limit)


@router.get("/{project_id}/report.md", response_class=Response)
def export_project_report(
    project_id: int,
    generator: str = Query(default="local"),
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
    report = _generate_report(database, settings, project, generator)
    return Response(
        content=report,
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="devatlas-project-{project.id}-report.md"'
        },
    )


@router.get("/{project_id}/report")
def generate_project_report(
    project_id: int,
    generator: str = Query(default="local"),
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
        "generated_at": datetime.now(UTC).isoformat(),
        "filename": f"devatlas-project-{project.id}-report.md",
        "content": _generate_report(database, settings, project, generator),
    }


@router.post("/{project_id}/reanalyze", response_model=ProjectStructureResponse)
def reanalyze_project(
    project_id: int, database: Session = Depends(get_db)
) -> dict[str, object]:
    statement = (
        select(Project)
        .where(Project.id == project_id)
        .options(selectinload(Project.files))
    )
    project = database.scalar(statement)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    analyze_project_structure(database, project)
    database.commit()
    return load_project_structure(database, project_id)


@router.post(
    "/{project_id}/incremental-reanalyze", response_model=IncrementalAnalysisResponse
)
def incremental_reanalyze_project(
    project_id: int, database: Session = Depends(get_db)
) -> dict[str, object]:
    statement = (
        select(Project)
        .where(Project.id == project_id)
        .options(selectinload(Project.files))
    )
    project = database.scalar(statement)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    return incrementally_analyze_project(database, project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: int,
    database: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> None:
    project = database.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")

    storage_path = Path(project.storage_path)
    database.delete(project)
    database.commit()
    remove_managed_repository(storage_path, settings.repository_root)


def _generate_report(
    database: Session, settings: Settings, project: Project, generator: str
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
    local_report = build_markdown_report(database, project)
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
) -> Project:
    try:
        project = create_scanned_project(
            database,
            repository_path,
            source_filename=source_filename,
            project_name=project_name,
        )
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
