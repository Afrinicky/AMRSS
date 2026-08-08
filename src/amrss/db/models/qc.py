"""Quality-control reference strains, ranges and results."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from amrss.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class QCStrainRecord(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "qc_strains"

    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    designation: Mapped[str] = mapped_column(String(40), nullable=False, index=True)  # ATCC ...
    organism_name: Mapped[str] = mapped_column(String(200), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class QCRangeRecord(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Acceptable QC range, versioned with the breakpoint set it ships beside."""

    __tablename__ = "qc_ranges"

    breakpoint_set_version: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    strain_designation: Mapped[str] = mapped_column(String(40), nullable=False)
    agent_code: Mapped[str] = mapped_column(String(10), nullable=False)
    method: Mapped[str] = mapped_column(String(10), nullable=False)
    disk_content: Mapped[str | None] = mapped_column(String(20))

    mic_min: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    mic_max: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    zone_min_mm: Mapped[int | None] = mapped_column(Integer)
    zone_max_mm: Mapped[int | None] = mapped_column(Integer)

    __table_args__ = (
        UniqueConstraint(
            "breakpoint_set_version",
            "strain_designation",
            "agent_code",
            "method",
            name="uq_qc_range",
        ),
        CheckConstraint(
            "mic_min IS NULL OR mic_max IS NULL OR mic_min <= mic_max", name="qc_mic_range_ordered"
        ),
        CheckConstraint(
            "zone_min_mm IS NULL OR zone_max_mm IS NULL OR zone_min_mm <= zone_max_mm",
            name="qc_zone_range_ordered",
        ),
    )


class QCResultRecord(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "qc_results"

    laboratory_code: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    performed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    performed_by: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    strain_designation: Mapped[str] = mapped_column(String(40), nullable=False)
    agent_code: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    method: Mapped[str] = mapped_column(String(10), nullable=False)

    mic_operator: Mapped[str | None] = mapped_column(String(2))
    mic_value: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    zone_diameter_mm: Mapped[int | None] = mapped_column(Integer)

    outcome: Mapped[str] = mapped_column(String(20), nullable=False)
    expected_range: Mapped[str | None] = mapped_column(String(60))
    breakpoint_set_version: Mapped[str | None] = mapped_column(String(60))

    # Out-of-range QC requires documented corrective action before the agent
    # can be reported again.
    corrective_action: Mapped[str | None] = mapped_column(Text)
    corrective_action_by: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    corrective_action_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "outcome IN ('in_range','out_of_range','not_evaluable')", name="qc_outcome_valid"
        ),
        Index("ix_qc_results_agent_time", "laboratory_code", "agent_code", "performed_at"),
    )
