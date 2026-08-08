"""Canonical dictionary and per-facility code mapping.

The dictionary is regional-block-agnostic by design (SDD 3.4). Each facility's
WHONET configuration maps *into* it. Without this layer a future national
antibiogram would silently combine incompatible local codes.
"""

import uuid

from sqlalchemy import Boolean, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from amrss.models.base import Base, TimestampMixin, pg_enum, pk_column
from amrss.models.enums import (
    AntimicrobialClass,
    DictionaryEntityType,
    MappingStatus,
    OrganismKingdom,
)


class CanonicalOrganism(Base, TimestampMixin):
    __tablename__ = "canonical_organism"

    id: Mapped[uuid.UUID] = pk_column()
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    kingdom: Mapped[OrganismKingdom] = mapped_column(
        pg_enum(OrganismKingdom, "organism_kingdom"), nullable=False
    )
    genus: Mapped[str | None] = mapped_column(String(128))
    family: Mapped[str | None] = mapped_column(String(128))
    gram_stain: Mapped[str | None] = mapped_column(String(16))
    #: Enterobacterales membership drives several screening phenotype flags.
    is_enterobacterales: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    #: Whether this organism is under below-threshold alert surveillance (SDD 5.2).
    #: Configurable by the regional AMR team, never hardcoded.
    is_organism_of_special_importance: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class CanonicalAntibiotic(Base, TimestampMixin):
    """Covers antibacterial and antifungal agents alike; fungal susceptibility is a
    co-equal first-class output (SDD 5.6), not a separate subsystem."""

    __tablename__ = "canonical_antibiotic"

    id: Mapped[uuid.UUID] = pk_column()
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    antimicrobial_class: Mapped[AntimicrobialClass] = mapped_column(
        pg_enum(AntimicrobialClass, "antimicrobial_class"), nullable=False
    )
    #: Which organism kingdom this agent is tested against.
    target_kingdom: Mapped[OrganismKingdom] = mapped_column(
        pg_enum(OrganismKingdom, "antibiotic_target_kingdom"), nullable=False
    )
    who_aware_category: Mapped[str | None] = mapped_column(String(16))
    atc_code: Mapped[str | None] = mapped_column(String(16))
    display_order: Mapped[int] = mapped_column(nullable=False, default=1000)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class CanonicalSpecimenType(Base, TimestampMixin):
    __tablename__ = "canonical_specimen_type"

    id: Mapped[uuid.UUID] = pk_column()
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    #: Site of infection is derived from specimen type (SDD 3.1) rather than
    #: collected separately, so it cannot disagree with the specimen.
    infection_site: Mapped[str] = mapped_column(String(64), nullable=False)
    is_sterile_site: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class FacilityCodeMapping(Base, TimestampMixin):
    """Maps one facility's local WHONET code onto a canonical dictionary entry.

    New mappings arrive as PROPOSED and require Data Steward approval (SDD 3.4,
    SDD 7) before the data they describe contributes to any aggregate.
    """

    __tablename__ = "facility_code_mapping"
    __table_args__ = (UniqueConstraint("facility_id", "entity_type", "local_code"),)

    id: Mapped[uuid.UUID] = pk_column()
    facility_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("facility.id"), nullable=False, index=True
    )
    entity_type: Mapped[DictionaryEntityType] = mapped_column(
        pg_enum(DictionaryEntityType, "dictionary_entity_type"), nullable=False
    )
    local_code: Mapped[str] = mapped_column(String(64), nullable=False)
    local_label: Mapped[str | None] = mapped_column(String(256))
    canonical_code: Mapped[str | None] = mapped_column(String(32))
    status: Mapped[MappingStatus] = mapped_column(
        pg_enum(MappingStatus, "mapping_status"),
        nullable=False,
        default=MappingStatus.PROPOSED,
    )
    reviewed_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))
    review_note: Mapped[str | None] = mapped_column(Text)
    #: Count of records seen carrying this local code, so a steward can triage the
    #: mapping queue by impact rather than alphabetically.
    observed_record_count: Mapped[int] = mapped_column(nullable=False, default=0)
