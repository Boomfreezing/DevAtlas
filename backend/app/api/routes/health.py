from fastapi import APIRouter, Depends

from app.core.config import Settings, get_settings

router = APIRouter()


@router.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/import-limits")
def import_limits(settings: Settings = Depends(get_settings)) -> dict[str, int]:
    return {
        "max_upload_mb": settings.max_upload_mb,
        "max_folder_files": settings.max_folder_files,
        "max_source_file_mb": settings.max_source_file_mb,
    }
