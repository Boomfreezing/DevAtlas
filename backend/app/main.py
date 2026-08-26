from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config import get_settings
from app.core.database import SessionLocal, create_database, get_db
from app.services.job_service import fail_interrupted_jobs


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    settings.ensure_directories()
    create_database()
    if get_db not in application.dependency_overrides:
        fail_interrupted_jobs(SessionLocal)
    yield


settings = get_settings()
app = FastAPI(
    title=settings.app_name,
    version="0.8.0",
    description="Local-first source repository analysis API.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(api_router, prefix="/api")


@app.get("/")
def root() -> dict[str, str]:
    return {"name": settings.app_name, "docs": "/docs"}
