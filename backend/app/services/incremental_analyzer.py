import time
from datetime import datetime, timezone
from sqlalchemy import delete, update
from sqlalchemy.orm import Session

from app.models.analysis import CodeSymbol, ImportRelation, ParseIssue, SearchChunk
from app.models.project import Project, ProjectFile
from app.services.analysis_cache import invalidate_project_analysis
from app.services.code_parser import supports_extension
from app.services.repository_scanner import ScannedFile, scan_repository
from app.services.repository_path_service import resolve_project_storage_path
from app.services.search_service import build_project_search_index
from app.services.structure_analyzer import analyze_project_file_subset


def incrementally_analyze_project(
    database: Session, project: Project
) -> dict[str, object]:
    started = time.perf_counter()
    stored_by_path = {item.relative_path: item for item in project.files}
    scan = scan_repository(resolve_project_storage_path(project.storage_path), stored_by_path)
    scanned_by_path = {item.relative_path: item for item in scan.files}

    added_paths = sorted(scanned_by_path.keys() - stored_by_path.keys())
    deleted_paths = sorted(stored_by_path.keys() - scanned_by_path.keys())
    changed_paths = sorted(
        path
        for path in scanned_by_path.keys() & stored_by_path.keys()
        if scanned_by_path[path].content_hash != stored_by_path[path].content_hash
    )
    unchanged_paths = sorted(
        path
        for path in scanned_by_path.keys() & stored_by_path.keys()
        if scanned_by_path[path].content_hash == stored_by_path[path].content_hash
    )

    metadata_updated = False
    for path in unchanged_paths:
        project_file = stored_by_path[path]
        scanned = scanned_by_path[path]
        if project_file.modified_time_ns != scanned.modified_time_ns:
            project_file.modified_time_ns = scanned.modified_time_ns
            metadata_updated = True

    if not added_paths and not deleted_paths and not changed_paths:
        if metadata_updated:
            database.commit()
        return _result(
            project,
            added_paths,
            changed_paths,
            deleted_paths,
            unchanged_paths,
            0,
            started,
        )

    invalidate_project_analysis(database, project.id)
    deleted_files = [stored_by_path[path] for path in deleted_paths]
    deleted_ids = [item.id for item in deleted_files]
    if deleted_ids:
        database.execute(
            update(ImportRelation)
            .where(ImportRelation.resolved_file_id.in_(deleted_ids))
            .values(resolved_file_id=None)
        )
        database.execute(delete(SearchChunk).where(SearchChunk.file_id.in_(deleted_ids)))
        database.execute(delete(CodeSymbol).where(CodeSymbol.file_id.in_(deleted_ids)))
        database.execute(delete(ImportRelation).where(ImportRelation.file_id.in_(deleted_ids)))
        database.execute(delete(ParseIssue).where(ParseIssue.file_id.in_(deleted_ids)))
        for project_file in deleted_files:
            database.delete(project_file)

    changed_files: list[ProjectFile] = []
    for path in changed_paths:
        project_file = stored_by_path[path]
        _apply_scan(project_file, scanned_by_path[path])
        changed_files.append(project_file)

    added_files: list[ProjectFile] = []
    for path in added_paths:
        scanned = scanned_by_path[path]
        project_file = ProjectFile(project_id=project.id, relative_path=scanned.relative_path)
        _apply_scan(project_file, scanned)
        database.add(project_file)
        added_files.append(project_file)

    database.flush()
    files_to_parse = [*changed_files, *added_files]
    analyze_project_file_subset(database, project, files_to_parse)

    project.primary_language = scan.primary_language
    project.file_count = len(scan.files)
    project.code_line_count = scan.code_line_count
    project.updated_at = datetime.now(timezone.utc)
    build_project_search_index(database, project)
    database.commit()

    parsed_file_count = sum(
        supports_extension(item.extension) for item in files_to_parse
    )
    return _result(
        project,
        added_paths,
        changed_paths,
        deleted_paths,
        unchanged_paths,
        parsed_file_count,
        started,
    )


def _apply_scan(project_file: ProjectFile, scanned: ScannedFile) -> None:
    project_file.extension = scanned.extension
    project_file.language = scanned.language
    project_file.size_bytes = scanned.size_bytes
    project_file.line_count = scanned.line_count
    project_file.content_hash = scanned.content_hash
    project_file.modified_time_ns = scanned.modified_time_ns


def _result(
    project: Project,
    added_paths: list[str],
    changed_paths: list[str],
    deleted_paths: list[str],
    unchanged_paths: list[str],
    parsed_file_count: int,
    started: float,
) -> dict[str, object]:
    return {
        "project_id": project.id,
        "added_file_count": len(added_paths),
        "changed_file_count": len(changed_paths),
        "deleted_file_count": len(deleted_paths),
        "unchanged_file_count": len(unchanged_paths),
        "parsed_file_count": parsed_file_count,
        "added_paths": added_paths,
        "changed_paths": changed_paths,
        "deleted_paths": deleted_paths,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
    }
