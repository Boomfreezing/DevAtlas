from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.project import Project


class CodeSymbol(Base):
    __tablename__ = "code_symbols"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("project_files.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    qualified_name: Mapped[str] = mapped_column(String(512), index=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    start_line: Mapped[int] = mapped_column(Integer)
    end_line: Mapped[int] = mapped_column(Integer)

    project: Mapped["Project"] = relationship(back_populates="symbols")


class ImportRelation(Base):
    __tablename__ = "import_relations"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("project_files.id", ondelete="CASCADE"), index=True)
    resolved_file_id: Mapped[int | None] = mapped_column(
        ForeignKey("project_files.id", ondelete="SET NULL"), nullable=True, index=True
    )
    source_path: Mapped[str] = mapped_column(Text)
    target_module: Mapped[str] = mapped_column(String(512), index=True)
    line_number: Mapped[int] = mapped_column(Integer)

    project: Mapped["Project"] = relationship(
        back_populates="imports", foreign_keys=[project_id]
    )


class ParseIssue(Base):
    __tablename__ = "parse_issues"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("project_files.id", ondelete="CASCADE"), index=True)
    file_path: Mapped[str] = mapped_column(Text)
    message: Mapped[str] = mapped_column(Text)

    project: Mapped["Project"] = relationship(back_populates="parse_issues")


class SearchChunk(Base):
    __tablename__ = "search_chunks"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("project_files.id", ondelete="CASCADE"), index=True)
    symbol_name: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    start_line: Mapped[int] = mapped_column(Integer)
    end_line: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)

    project: Mapped["Project"] = relationship(back_populates="search_chunks")


class AnalysisJob(Base):
    __tablename__ = "analysis_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    source_type: Mapped[str] = mapped_column(String(24), index=True)
    source_label: Mapped[str] = mapped_column(String(512))
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    stage: Mapped[str] = mapped_column(String(32), default="queued")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str] = mapped_column(String(512), default="等待后台处理")
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True
    )
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AnalysisSnapshot(Base):
    __tablename__ = "analysis_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    label: Mapped[str] = mapped_column(String(120))
    reason: Mapped[str] = mapped_column(String(32), default="manual", index=True)
    data_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    project: Mapped["Project"] = relationship(back_populates="snapshots")
