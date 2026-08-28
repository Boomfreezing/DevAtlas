from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.analysis import (
        AnalysisSnapshot,
        CodeSymbol,
        ImportRelation,
        ParseIssue,
        SearchChunk,
    )


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), index=True)
    source_filename: Mapped[str] = mapped_column(String(255))
    storage_path: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="ready", index=True)
    primary_language: Mapped[str | None] = mapped_column(String(64), nullable=True)
    file_count: Mapped[int] = mapped_column(Integer, default=0)
    code_line_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    files: Mapped[list["ProjectFile"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    symbols: Mapped[list["CodeSymbol"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    imports: Mapped[list["ImportRelation"]] = relationship(
        back_populates="project", cascade="all, delete-orphan",
        foreign_keys="ImportRelation.project_id",
    )
    parse_issues: Mapped[list["ParseIssue"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    search_chunks: Mapped[list["SearchChunk"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    snapshots: Mapped[list["AnalysisSnapshot"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    git_metadata: Mapped["ProjectGitMetadata | None"] = relationship(
        back_populates="project", cascade="all, delete-orphan", uselist=False
    )


class ProjectFile(Base):
    __tablename__ = "project_files"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    relative_path: Mapped[str] = mapped_column(Text)
    extension: Mapped[str] = mapped_column(String(32), default="")
    language: Mapped[str | None] = mapped_column(String(64), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    line_count: Mapped[int] = mapped_column(Integer, default=0)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    modified_time_ns: Mapped[int] = mapped_column(Integer, default=0)

    project: Mapped[Project] = relationship(back_populates="files")


class ProjectGitMetadata(Base):
    __tablename__ = "project_git_metadata"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), unique=True, index=True
    )
    repository_url: Mapped[str] = mapped_column(Text)
    default_branch: Mapped[str] = mapped_column(String(255))
    head_commit: Mapped[str] = mapped_column(String(64))
    history_available: Mapped[bool] = mapped_column(Boolean, default=True)
    recent_commits_json: Mapped[str] = mapped_column(Text, default="[]")
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    project: Mapped[Project] = relationship(back_populates="git_metadata")
