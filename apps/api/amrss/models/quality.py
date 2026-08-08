"""Tier 1 and Tier 2 quality records.

AMRSS v1 tracks *attestation and compliance*, and gates data trust on it. It is
not the facility's laboratory quality management system, and it does not perform
wet-lab QC analytics such as Levey-Jennings charting (SDD 6.1).
"""

import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from amrss.models.base import Base, TimestampMixin, pg_enum, pk_column
from amrss.models.enums import EqaStatus, QcStatus


class QcAttestation(Base, TimestampMixin):
    """Tier 1 — the facility's own statement of its internal AST QC status for a
    period. A structured attestation record, not raw QC-strain measurements."""

    __tablename__ = "qc_attestation"
    __table_args__ = (UniqueConstraint("facility_id", "period_start"),)

    id: Mapped[uuid.UUID] = pk_column()
    facility_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("facility.id"), nullable=False, index=True
    )
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[QcStatus] = mapped_column(
        pg_enum(QcStatus, "qc_attestation_status"), nullable=False
    )
    corrective_action: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    submitted_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))
    #: The batch this attestation arrived with, when captured during upload (SDD 8.2 item 7).
    upload_batch_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("upload_batch.id"))


class EqaRecord(Base, TimestampMixin):
    """Tier 2 — external quality assessment / proficiency testing participation."""

    __tablename__ = "eqa_record"

    id: Mapped[uuid.UUID] = pk_column()
    facility_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("facility.id"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(128), nullable=False)
    panel: Mapped[str] = mapped_column(String(128), nullable=False)
    assessment_date: Mapped[date] = mapped_column(Date, nullable=False)
    valid_until: Mapped[date | None] = mapped_column(Date)
    result: Mapped[str | None] = mapped_column(Text)
    expected_result: Mapped[str | None] = mapped_column(Text)
    performance: Mapped[EqaStatus] = mapped_column(
        pg_enum(EqaStatus, "eqa_performance"), nullable=False
    )
    corrective_action: Mapped[str | None] = mapped_column(Text)
    submitted_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))
