"""Audit trail, methodology versioning and emerging-signal records.

Together these make every published statistic traceable to the exact rules that
produced it (SDD 10.3, 10.4; ADR-0003).
"""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from amrss.models.base import Base, TimestampMixin, pg_enum, pk_column
from amrss.models.enums import MethodologyComponent


class MethodologyVersion(Base, TimestampMixin):
    """An effective-dated, parameterised rule set.

    No threshold, window length or trigger value appears as a literal in engine
    code. The engine resolves the version applicable to a computation and stamps
    its ID onto the result, so tuning a rule later never silently rewrites the
    provenance of an earlier number.
    """

    __tablename__ = "methodology_version"
    __table_args__ = (
        UniqueConstraint("component", "version"),
        Index("ix_methodology_effective", "component", "effective_from"),
    )

    id: Mapped[uuid.UUID] = pk_column()
    component: Mapped[MethodologyComponent] = mapped_column(
        pg_enum(MethodologyComponent, "methodology_component"), nullable=False
    )
    version: Mapped[str] = mapped_column(String(32), nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_until: Mapped[date | None] = mapped_column(Date)
    description: Mapped[str] = mapped_column(Text, nullable=False)

    #: The rule set itself. Shape is documented per component in
    #: amrss.analytics.methodology.
    parameters: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)

    #: Scope. Null means the version applies to every regional block; a value
    #: narrows it to one block, which is how a block can run a different WHONET
    #: configuration standard without forking the platform.
    regional_block_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("regional_block.id"))

    #: Provisional values pending SDD 13 sign-off are marked, so nothing seeded as
    #: a placeholder can be mistaken for an agreed decision.
    is_provisional: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    approved_by: Mapped[str | None] = mapped_column(String(256))
    approved_on: Mapped[date | None] = mapped_column(Date)


class AuditLog(Base):
    """Append-only record of every consequential action (SDD 10.2).

    There is no update or delete path to this table in application code.
    """

    __tablename__ = "audit_log"
    __table_args__ = (
        Index("ix_audit_entity", "entity", "entity_id"),
        Index("ix_audit_actor_time", "actor_id", "occurred_at"),
    )

    id: Mapped[uuid.UUID] = pk_column()
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    #: ON DELETE SET NULL so a user can be deleted without rewriting history: the
    #: pointer is cleared by the database, the append-only trigger permits only
    #: that one cascade, and the actor stays named in ``actor_label`` below.
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("app_user.id", ondelete="SET NULL")
    )
    #: Retained independently of actor_id so the trail stays legible after a user
    #: is deactivated, renamed or deleted.
    actor_label: Mapped[str] = mapped_column(String(256), nullable=False)
    actor_role: Mapped[str | None] = mapped_column(String(64))

    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    entity: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str | None] = mapped_column(String(64))

    before_state: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    after_state: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    source_ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(256))
    note: Mapped[str | None] = mapped_column(Text)


class EmergingSignal(Base, TimestampMixin):
    """A detected change in susceptibility that meets the versioned trigger rule.

    AMRSS never labels a signal an outbreak. Outbreak determination is an
    epidemiological judgment, not a software claim (SDD 5.4).
    """

    __tablename__ = "emerging_signal"
    __table_args__ = (Index("ix_signal_scope", "regional_block_id", "detected_on"),)

    id: Mapped[uuid.UUID] = pk_column()
    regional_block_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("regional_block.id"), nullable=False
    )
    #: Null district and facility mean the signal was detected at block level.
    district_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("district.id"))
    facility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("facility.id"))

    canonical_organism_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("canonical_organism.id"), nullable=False
    )
    canonical_antibiotic_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("canonical_antibiotic.id"), nullable=False
    )

    detected_on: Mapped[date] = mapped_column(Date, nullable=False)
    baseline_start: Mapped[date] = mapped_column(Date, nullable=False)
    baseline_end: Mapped[date] = mapped_column(Date, nullable=False)
    baseline_susceptible_pct: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    baseline_n: Mapped[int] = mapped_column(Integer, nullable=False)

    current_start: Mapped[date] = mapped_column(Date, nullable=False)
    current_end: Mapped[date] = mapped_column(Date, nullable=False)
    current_susceptible_pct: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    current_n: Mapped[int] = mapped_column(Integer, nullable=False)

    change_percentage_points: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    methodology_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("methodology_version.id"), nullable=False
    )

    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    acknowledged_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))
    review_note: Mapped[str | None] = mapped_column(Text)


class AnalyticsRefresh(Base):
    """Record of each analytics recomputation, backing the data-freshness banner
    and the SDD 4.1 processing-time commitment."""

    __tablename__ = "analytics_refresh"

    id: Mapped[uuid.UUID] = pk_column()
    regional_block_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("regional_block.id"), nullable=False, index=True
    )
    triggered_by_batch_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("upload_batch.id"))
    trigger_reason: Mapped[str] = mapped_column(String(64), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    signals_detected: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(Text)
