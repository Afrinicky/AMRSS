"""De-identified surveillance records and the upload batches that carry them."""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
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
from sqlalchemy.orm import Mapped, mapped_column, relationship

from amrss.models.base import Base, TimestampMixin, pg_enum, pk_column
from amrss.models.enums import (
    AgeBand,
    BatchStatus,
    CareSetting,
    OrganismKingdom,
    QcFindingSeverity,
    Sex,
    SirResult,
)


class UploadBatch(Base, TimestampMixin):
    """One transmission from one facility's offline uploader.

    Accepted batches are never hard-deleted. A batch found to be faulty after
    acceptance is quarantined and then retracted, which triggers recomputation of
    every aggregate it contributed to (SDD 9.6).
    """

    __tablename__ = "upload_batch"

    id: Mapped[uuid.UUID] = pk_column()
    facility_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("facility.id"), nullable=False, index=True
    )
    submitted_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))

    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    record_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    accepted_isolate_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    #: SHA-256 of the decrypted payload, computed by the uploader and re-verified
    #: on receipt. A mismatch rejects the batch outright.
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    status: Mapped[BatchStatus] = mapped_column(
        pg_enum(BatchStatus, "batch_status"), nullable=False, default=BatchStatus.STAGED
    )
    uploader_version: Mapped[str] = mapped_column(String(32), nullable=False)
    whonet_config_version: Mapped[str | None] = mapped_column(String(64))
    #: AST interpretation standard the source laboratory applied, e.g. "CLSI M100 2026".
    ast_breakpoint_standard: Mapped[str | None] = mapped_column(String(64))

    coverage_start: Mapped[date | None] = mapped_column(Date)
    coverage_end: Mapped[date | None] = mapped_column(Date)

    #: Set when the batch leaves STAGED. Records who decided and why, for the
    #: audit trail — a held or quarantined batch is never silently disposed of.
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))
    decision_reason: Mapped[str | None] = mapped_column(Text)

    isolates: Mapped[list["Isolate"]] = relationship(back_populates="upload_batch")
    qc_findings: Mapped[list["UploadQcFinding"]] = relationship(
        back_populates="upload_batch", cascade="all, delete-orphan"
    )

    @property
    def contributes_to_analytics(self) -> bool:
        return self.status is BatchStatus.ACCEPTED


class UploadQcFinding(Base, TimestampMixin):
    """One Tier-3 automated data QC observation against a batch (SDD 6.4)."""

    __tablename__ = "upload_qc_finding"

    id: Mapped[uuid.UUID] = pk_column()
    upload_batch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("upload_batch.id"), nullable=False, index=True
    )
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    severity: Mapped[QcFindingSeverity] = mapped_column(
        pg_enum(QcFindingSeverity, "qc_finding_severity"), nullable=False
    )
    message: Mapped[str] = mapped_column(Text, nullable=False)
    affected_record_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    detail: Mapped[dict | None] = mapped_column(JSONB)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))
    resolution_note: Mapped[str | None] = mapped_column(Text)

    upload_batch: Mapped[UploadBatch] = relationship(back_populates="qc_findings")


class Isolate(Base, TimestampMixin):
    """One de-identified isolate.

    Nothing here can identify a patient. Direct identifiers are removed inside the
    offline uploader before transmission (SDD 3.1, 8.2) and have no column to land
    in even if a future client tried to send them.
    """

    __tablename__ = "isolate"
    __table_args__ = (
        UniqueConstraint("facility_id", "source_record_hash", name="isolate_source_record"),
        Index("ix_isolate_analytics", "facility_id", "canonical_organism_id", "specimen_date"),
        Index("ix_isolate_dedup", "facility_id", "patient_linkage_key", "canonical_organism_id"),
    )

    id: Mapped[uuid.UUID] = pk_column()
    facility_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("facility.id"), nullable=False, index=True
    )
    upload_batch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("upload_batch.id"), nullable=False, index=True
    )

    #: Exact collection date. Bucketed to ISO week for every cross-facility view;
    #: the exact value is retained for the facility's own view and for internal
    #: trend computation (SDD 3.1). Exposure is a serialisation-layer decision,
    #: never a query-layer one.
    specimen_date: Mapped[date] = mapped_column(Date, nullable=False)
    specimen_iso_year: Mapped[int] = mapped_column(Integer, nullable=False)
    specimen_iso_week: Mapped[int] = mapped_column(Integer, nullable=False)

    age_band: Mapped[AgeBand] = mapped_column(
        pg_enum(AgeBand, "age_band"), nullable=False, default=AgeBand.UNKNOWN
    )
    #: Restricted layer, populated only where a regional block has formally
    #: approved exact-age retention. SDD 13.2 is unresolved, so this is null by
    #: default and the uploader does not transmit it unless configured to.
    age_exact_years: Mapped[int | None] = mapped_column(Integer)
    sex: Mapped[Sex] = mapped_column(pg_enum(Sex, "sex"), nullable=False, default=Sex.UNKNOWN)
    care_setting: Mapped[CareSetting] = mapped_column(
        pg_enum(CareSetting, "care_setting"), nullable=False, default=CareSetting.UNKNOWN
    )

    canonical_specimen_type_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("canonical_specimen_type.id"), nullable=False, index=True
    )
    canonical_organism_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("canonical_organism.id"), nullable=False, index=True
    )
    organism_kingdom: Mapped[OrganismKingdom] = mapped_column(
        pg_enum(OrganismKingdom, "isolate_organism_kingdom"), nullable=False
    )

    #: Argon2id(patient identifier, facility-local salt). The salt never leaves the
    #: facility, so this is not reversible to a patient (ADR-0004). Used only by
    #: the deduplication step; excluded from every response schema and export.
    patient_linkage_key: Mapped[bytes] = mapped_column(LargeBinary(32), nullable=False)

    #: Stable hash of the source record, used to detect the same record arriving
    #: twice across incremental uploads (SDD 6.4, upload-level duplicate detection).
    source_record_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    ast_results: Mapped[list["AstResult"]] = relationship(
        back_populates="isolate", cascade="all, delete-orphan"
    )
    upload_batch: Mapped[UploadBatch] = relationship(back_populates="isolates")


class AstResult(Base, TimestampMixin):
    """One antimicrobial susceptibility test result for one isolate."""

    __tablename__ = "ast_result"
    __table_args__ = (UniqueConstraint("isolate_id", "canonical_antibiotic_id"),)

    id: Mapped[uuid.UUID] = pk_column()
    isolate_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("isolate.id"), nullable=False, index=True
    )
    canonical_antibiotic_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("canonical_antibiotic.id"), nullable=False, index=True
    )
    result: Mapped[SirResult] = mapped_column(pg_enum(SirResult, "sir_result"), nullable=False)

    #: Optional quantitative values where the laboratory reports them.
    mic_value: Mapped[float | None] = mapped_column(Numeric(10, 4))
    mic_operator: Mapped[str | None] = mapped_column(String(2))
    zone_diameter_mm: Mapped[int | None] = mapped_column(Integer)
    test_method: Mapped[str | None] = mapped_column(String(32))

    isolate: Mapped[Isolate] = relationship(back_populates="ast_results")


class PhenotypeFlag(Base, TimestampMixin):
    """Screening-level phenotype observation (SDD 5.5).

    Screening only. AMRSS v1 does not perform confirmatory mechanism detection and
    every surfaced flag is labelled "observed phenotype (screening-level)", never
    "confirmed".
    """

    __tablename__ = "phenotype_flag"
    __table_args__ = (UniqueConstraint("isolate_id", "flag_code"),)

    id: Mapped[uuid.UUID] = pk_column()
    isolate_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("isolate.id"), nullable=False, index=True
    )
    flag_code: Mapped[str] = mapped_column(String(48), nullable=False)
    #: Methodology version of the phenotype rule set that produced this flag, so a
    #: rule change is traceable rather than retroactively invisible.
    methodology_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("methodology_version.id"), nullable=False
    )
    basis: Mapped[str] = mapped_column(Text, nullable=False)
    is_screening_level: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
