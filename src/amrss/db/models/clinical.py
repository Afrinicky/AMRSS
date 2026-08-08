"""Patients, specimens, isolates and susceptibility results.

Patient privacy model
---------------------
Direct identifiers (MRN, national ID, name, date of birth) are stored only as
AES-GCM ciphertext, and are never indexed. All lookup and linkage happens via
`pseudonym`, an HMAC of the identifier - so the ordinary surveillance workload
(counting resistant isolates, deduplicating a patient's repeat isolates) runs
without decrypting anything. Reading a real identifier requires the
`patient:pii:read` permission and writes an audit entry every time.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from amrss.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Patient(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "patients"

    # HMAC-SHA256 of the normalised primary identifier. Stable across visits,
    # irreversible, safe to index.
    pseudonym: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    identifier_type: Mapped[str] = mapped_column(String(30), nullable=False)

    mrn_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)
    name_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)
    date_of_birth_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)

    # Coarse, non-identifying attributes kept in the clear because
    # surveillance stratification needs them and they carry little re-identification risk.
    birth_year: Mapped[int | None] = mapped_column(Integer)
    age_group: Mapped[str | None] = mapped_column(String(20))  # e.g. "15-24"
    sex: Mapped[str | None] = mapped_column(String(10))

    def pii_context(self, field: str) -> str:
        """AAD binding a ciphertext to this row and column."""
        return f"patient:{self.id}:{field}"


class Specimen(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "specimens"

    accession_number: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    patient_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("patients.id", ondelete="RESTRICT"), nullable=False
    )
    laboratory_code: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    specimen_type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    body_site: Mapped[str | None] = mapped_column(String(80))
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Surveillance stratifiers required by WHO GLASS.
    patient_origin: Mapped[str | None] = mapped_column(String(20))  # inpatient/outpatient
    ward: Mapped[str | None] = mapped_column(String(80))
    infection_origin: Mapped[str | None] = mapped_column(String(30))  # community/hospital

    isolates: Mapped[list[Isolate]] = relationship(back_populates="specimen")

    __table_args__ = (
        UniqueConstraint("laboratory_code", "accession_number", name="uq_specimen_accession"),
        Index("ix_specimens_collected", "collected_at"),
    )


class Isolate(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "isolates"

    specimen_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("specimens.id", ondelete="CASCADE"), nullable=False
    )
    organism_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("organisms.id", ondelete="RESTRICT"), nullable=False
    )
    isolate_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    identification_method: Mapped[str | None] = mapped_column(String(60))
    # Site of infection drives site-specific breakpoints (e.g. meningitis).
    infection_site: Mapped[str | None] = mapped_column(String(40))
    # First isolate per patient per organism per period - the WHO GLASS
    # deduplication flag, computed on ingest.
    is_first_isolate: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    notes: Mapped[str | None] = mapped_column(Text)

    specimen: Mapped[Specimen] = relationship(back_populates="isolates")
    ast_results: Mapped[list[ASTResult]] = relationship(
        back_populates="isolate", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("specimen_id", "organism_id", "isolate_number", name="uq_isolate"),
    )


class ASTResult(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One antimicrobial tested against one isolate.

    Both the raw measurement and the derived category are stored. The raw value
    is the fact; the category is an interpretation that can legitimately change
    when the breakpoint edition changes, which is why
    `breakpoint_set_version` is recorded alongside it.
    """

    __tablename__ = "ast_results"

    isolate_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("isolates.id", ondelete="CASCADE"), nullable=False
    )
    agent_code: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    method: Mapped[str] = mapped_column(String(10), nullable=False)

    # MIC stored as operator + value so off-scale results stay off-scale.
    mic_operator: Mapped[str | None] = mapped_column(String(2))
    mic_value: Mapped[Any | None] = mapped_column(Numeric(12, 6))
    zone_diameter_mm: Mapped[int | None] = mapped_column(Integer)
    disk_content: Mapped[str | None] = mapped_column(String(20))

    category: Mapped[str | None] = mapped_column(String(4), index=True)
    breakpoint_set_version: Mapped[str | None] = mapped_column(String(60), index=True)
    breakpoint_table_reference: Mapped[str | None] = mapped_column(String(40))
    interpretation_reason: Mapped[str | None] = mapped_column(String(60))
    tier: Mapped[str | None] = mapped_column(String(2))

    applied_rules: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    comments: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)

    # Manual override by a microbiologist. Both the value and the reason are
    # required; an override without a documented reason is not accepted.
    overridden_category: Mapped[str | None] = mapped_column(String(4))
    override_reason: Mapped[str | None] = mapped_column(Text)
    overridden_by: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    overridden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    requires_review: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    suppressed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    suppression_reason: Mapped[str | None] = mapped_column(String(120))

    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    released_by: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    tested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    isolate: Mapped[Isolate] = relationship(back_populates="ast_results")

    __table_args__ = (
        UniqueConstraint("isolate_id", "agent_code", "method", name="uq_ast_result"),
        CheckConstraint(
            "category IS NULL OR category IN ('S','SDD','I','R','NS','NI')",
            name="category_valid",
        ),
        CheckConstraint(
            "overridden_category IS NULL OR override_reason IS NOT NULL",
            name="override_requires_reason",
        ),
        CheckConstraint(
            "(method = 'DISK' AND zone_diameter_mm IS NOT NULL) "
            "OR (method IN ('MIC','GRADIENT') AND mic_value IS NOT NULL)",
            name="measurement_matches_method",
        ),
        Index("ix_ast_isolate_agent", "isolate_id", "agent_code"),
    )

    @property
    def effective_category(self) -> str | None:
        """The category that will be reported: an override wins if present."""
        return self.overridden_category or self.category


class InterpretationHistory(UUIDPrimaryKeyMixin, Base):
    """Every interpretation an AST result has ever carried.

    When the laboratory adopts a new CLSI edition and re-interprets stored
    MICs, the previous categories must remain recoverable - trend analyses
    published under the old edition have to stay explainable.
    """

    __tablename__ = "interpretation_history"

    ast_result_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("ast_results.id", ondelete="CASCADE"), nullable=False
    )
    category: Mapped[str | None] = mapped_column(String(4))
    breakpoint_set_version: Mapped[str | None] = mapped_column(String(60))
    interpreted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    interpreted_by: Mapped[uuid.UUID | None] = mapped_column(PGUUID(as_uuid=True))
    reason: Mapped[str | None] = mapped_column(String(60))
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)

    __table_args__ = (Index("ix_interp_history_result", "ast_result_id", "interpreted_at"),)


class SurveillanceReportExport(UUIDPrimaryKeyMixin, Base):
    """Record of every aggregate export leaving the system."""

    __tablename__ = "report_exports"

    exported_by: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    exported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    report_type: Mapped[str] = mapped_column(String(50), nullable=False)
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    filters: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    row_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # SHA-256 of the delivered file, so a leaked export can be traced back.
    content_checksum: Mapped[str | None] = mapped_column(String(64))
