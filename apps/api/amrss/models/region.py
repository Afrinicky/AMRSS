"""Geography and enrollment.

Region is a configuration entity, not an identity (ADR-0002). Nothing in this
module — or anywhere in application source — names a specific region.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from amrss.models.base import Base, TimestampMixin, pg_enum, pk_column
from amrss.models.enums import EqaStatus, FacilityStatus, QcStatus, UploadSchedule


class RegionalBlock(Base, TimestampMixin):
    """A governed surveillance block. Adding one is an administrative action
    (SDD 9.3), never a code change."""

    __tablename__ = "regional_block"

    id: Mapped[uuid.UUID] = pk_column()
    code: Mapped[str] = mapped_column(String(16), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    governing_body: Mapped[str] = mapped_column(String(256), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active")
    activated_at: Mapped[date | None] = mapped_column(Date)

    #: WHONET configuration standard this block's facilities are expected to run
    #: (SDD 3.5). Uploads declaring a different version are flagged, not silently
    #: accepted or rejected.
    whonet_config_standard: Mapped[str | None] = mapped_column(String(64))

    districts: Mapped[list["District"]] = relationship(back_populates="regional_block")


class District(Base, TimestampMixin):
    __tablename__ = "district"
    __table_args__ = (UniqueConstraint("regional_block_id", "name"),)

    id: Mapped[uuid.UUID] = pk_column()
    regional_block_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("regional_block.id"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)

    regional_block: Mapped[RegionalBlock] = relationship(back_populates="districts")
    facilities: Mapped[list["Facility"]] = relationship(back_populates="district")


class Facility(Base, TimestampMixin):
    __tablename__ = "facility"

    id: Mapped[uuid.UUID] = pk_column()
    district_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("district.id"), nullable=False, index=True
    )
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    status: Mapped[FacilityStatus] = mapped_column(
        pg_enum(FacilityStatus, "facility_status"),
        nullable=False,
        default=FacilityStatus.PENDING,
    )

    whonet_config_version: Mapped[str | None] = mapped_column(String(64))

    #: Denormalised current quality state. Authoritative history lives in
    #: qc_attestation and eqa_record; these columns exist so the gating rule
    #: (SDD 6.6) can be applied inside an aggregate query without a correlated
    #: subquery per facility. Maintained by amrss.quality.gating.
    qc_status: Mapped[QcStatus] = mapped_column(
        pg_enum(QcStatus, "qc_status"), nullable=False, default=QcStatus.NOT_SUBMITTED
    )
    qc_valid_until: Mapped[date | None] = mapped_column(Date)
    eqa_status: Mapped[EqaStatus] = mapped_column(
        pg_enum(EqaStatus, "eqa_status"), nullable=False, default=EqaStatus.NOT_SUBMITTED
    )
    eqa_valid_until: Mapped[date | None] = mapped_column(Date)

    upload_schedule: Mapped[UploadSchedule] = mapped_column(
        pg_enum(UploadSchedule, "upload_schedule"),
        nullable=False,
        default=UploadSchedule.WEEKLY,
    )
    #: Only meaningful when upload_schedule is CUSTOM.
    upload_interval_days: Mapped[int | None] = mapped_column()
    last_accepted_upload_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    mou_signed_on: Mapped[date | None] = mapped_column(Date)
    mou_reference: Mapped[str | None] = mapped_column(String(128))
    enrollment_notes: Mapped[str | None] = mapped_column(Text)

    district: Mapped[District] = relationship(back_populates="facilities")

    @property
    def regional_block_id(self) -> uuid.UUID:
        return self.district.regional_block_id

    def quality_is_current(self, as_of: date) -> bool:
        """Gating rule input (SDD 6.6): both QC attestation and EQA must be
        current and satisfactory for this facility's data to enter the verified
        regional or district antibiogram."""
        qc_ok = self.qc_status is QcStatus.SATISFACTORY and (
            self.qc_valid_until is None or self.qc_valid_until >= as_of
        )
        eqa_ok = self.eqa_status is EqaStatus.SATISFACTORY and (
            self.eqa_valid_until is None or self.eqa_valid_until >= as_of
        )
        return qc_ok and eqa_ok
