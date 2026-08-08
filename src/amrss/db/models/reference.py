"""Reference data: organisms, antimicrobials, and versioned breakpoint sets."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    ARRAY,
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
from sqlalchemy.orm import Mapped, mapped_column, relationship

from amrss.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Organism(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A reportable organism.

    `groups` lists the CLSI organism groups this organism belongs to, ordered
    most specific first (e.g. ["Escherichia coli", "Enterobacterales"]). The
    interpretation engine walks that list, so a species-level criterion is
    preferred over the family-level one.
    """

    __tablename__ = "organisms"

    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False, index=True)
    scientific_name: Mapped[str] = mapped_column(String(200), nullable=False)
    common_name: Mapped[str | None] = mapped_column(String(200))
    gram_stain: Mapped[str | None] = mapped_column(String(20))  # positive/negative/variable
    groups: Mapped[list[str]] = mapped_column(ARRAY(String(120)), nullable=False, default=list)
    # WHO GLASS pathogen identifier, where the organism is under surveillance.
    glass_pathogen_code: Mapped[str | None] = mapped_column(String(30), index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Antimicrobial(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "antimicrobials"

    code: Mapped[str] = mapped_column(String(10), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # WHONET code, so exports and legacy instrument feeds line up.
    whonet_code: Mapped[str | None] = mapped_column(String(10), index=True)
    atc_code: Mapped[str | None] = mapped_column(String(20))
    drug_class: Mapped[str] = mapped_column(String(80), nullable=False)
    # WHO AWaRe classification - Access / Watch / Reserve.
    aware_category: Mapped[str | None] = mapped_column(String(10))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class BreakpointSetRecord(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A versioned, immutable-once-activated collection of breakpoints."""

    __tablename__ = "breakpoint_sets"

    version: Mapped[str] = mapped_column(String(60), unique=True, nullable=False, index=True)
    source_edition: Mapped[str] = mapped_column(String(200), nullable=False)
    standard_body: Mapped[str] = mapped_column(String(20), nullable=False, default="CLSI")
    # Set once activation happens; activated sets must not be edited.
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    activated_by: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # SHA-256 of the imported source file - proves which document produced this set.
    source_checksum: Mapped[str | None] = mapped_column(String(64))
    notes: Mapped[str | None] = mapped_column(Text)

    breakpoints: Mapped[list[BreakpointRecord]] = relationship(
        back_populates="breakpoint_set", cascade="all, delete-orphan"
    )

    @property
    def is_active(self) -> bool:
        return self.activated_at is not None and self.retired_at is None


class BreakpointRecord(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One interpretive criterion. Mirrors amrss.clsi.breakpoints.Breakpoint."""

    __tablename__ = "breakpoints"

    breakpoint_set_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("breakpoint_sets.id", ondelete="CASCADE"),
        nullable=False,
    )
    standard: Mapped[str] = mapped_column(String(20), nullable=False, default="M100")
    table_reference: Mapped[str | None] = mapped_column(String(40))
    organism_group: Mapped[str] = mapped_column(String(120), nullable=False)
    agent_code: Mapped[str] = mapped_column(String(10), nullable=False)
    method: Mapped[str] = mapped_column(String(10), nullable=False)

    disk_content: Mapped[str | None] = mapped_column(String(20))
    site: Mapped[str | None] = mapped_column(String(40))
    route: Mapped[str | None] = mapped_column(String(20))
    dosage_note: Mapped[str | None] = mapped_column(Text)

    mic_susceptible_max: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    mic_sdd_min: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    mic_sdd_max: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    mic_intermediate_min: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    mic_intermediate_max: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    mic_resistant_min: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))

    disk_susceptible_min: Mapped[int | None] = mapped_column(Integer)
    disk_sdd_min: Mapped[int | None] = mapped_column(Integer)
    disk_sdd_max: Mapped[int | None] = mapped_column(Integer)
    disk_intermediate_min: Mapped[int | None] = mapped_column(Integer)
    disk_intermediate_max: Mapped[int | None] = mapped_column(Integer)
    disk_resistant_max: Mapped[int | None] = mapped_column(Integer)

    tier: Mapped[str] = mapped_column(String(2), nullable=False, default="U")
    comment: Mapped[str | None] = mapped_column(Text)

    breakpoint_set: Mapped[BreakpointSetRecord] = relationship(back_populates="breakpoints")

    __table_args__ = (
        UniqueConstraint(
            "breakpoint_set_id",
            "organism_group",
            "agent_code",
            "method",
            "site",
            "route",
            name="uq_breakpoint_scope",
        ),
        Index("ix_breakpoints_lookup", "breakpoint_set_id", "organism_group", "agent_code"),
        CheckConstraint("method IN ('MIC','DISK','GRADIENT')", name="method_valid"),
        CheckConstraint(
            "mic_susceptible_max IS NULL OR mic_resistant_min IS NULL "
            "OR mic_susceptible_max < mic_resistant_min",
            name="mic_bounds_ordered",
        ),
        CheckConstraint(
            "disk_susceptible_min IS NULL OR disk_resistant_max IS NULL "
            "OR disk_susceptible_min > disk_resistant_max",
            name="disk_bounds_ordered",
        ),
    )


class IntrinsicResistanceRecord(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Organism/agent combinations resistant by nature (M100 Appendix B)."""

    __tablename__ = "intrinsic_resistance"

    organism_group: Mapped[str] = mapped_column(String(120), nullable=False)
    agent_code: Mapped[str] = mapped_column(String(10), nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(120), nullable=False, default="CLSI M100 App. B")
    breakpoint_set_version: Mapped[str | None] = mapped_column(String(60), index=True)
    verified_locally: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    __table_args__ = (
        UniqueConstraint(
            "organism_group", "agent_code", "breakpoint_set_version", name="uq_intrinsic"
        ),
    )
