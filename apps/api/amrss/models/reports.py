"""Published reports (SDD 9.7).

The rendered artefact is stored, not regenerated on download. That is the whole
point: a report published in March has to keep saying what it said in March,
even after a threshold is tuned or a later upload changes the underlying
aggregate. Regenerating on demand would silently rewrite history, and a
quarterly report circulated to a stewardship committee would stop matching the
copy they discussed.

What the report may contain is not a separate decision. It is built from the
same antibiogram engine, the same thresholds, the same suppression and the same
QC gating as the live dashboard, so a report can never show something the
dashboard would have withheld.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Index, LargeBinary, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from amrss.models.base import Base, TimestampMixin, pg_enum, pk_column
from amrss.models.enums import ReportPeriod


class GeneratedReport(Base, TimestampMixin):
    __tablename__ = "generated_report"
    __table_args__ = (
        Index("ix_report_scope_period", "regional_block_id", "period_start", "period_end"),
    )

    id: Mapped[uuid.UUID] = pk_column()
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    period: Mapped[ReportPeriod] = mapped_column(
        pg_enum(ReportPeriod, "report_period"), nullable=False
    )
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)

    regional_block_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("regional_block.id"))
    district_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("district.id"))
    facility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("facility.id"))

    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    generated_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("app_user.id"))

    #: Counts and coverage as they stood at generation, so a listing can be
    #: meaningful without opening every artefact.
    organism_count: Mapped[int] = mapped_column(nullable=False, default=0)
    isolate_count: Mapped[int] = mapped_column(nullable=False, default=0)
    facilities_contributing: Mapped[int] = mapped_column(nullable=False, default=0)
    facilities_excluded: Mapped[int] = mapped_column(nullable=False, default=0)

    #: The methodology versions in force when this report was produced. Without
    #: it a superseded report is a set of numbers whose rules are unknowable.
    methodology_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    notes: Mapped[str | None] = mapped_column(Text)

    pdf_bytes: Mapped[bytes | None] = mapped_column(LargeBinary)
    xlsx_bytes: Mapped[bytes | None] = mapped_column(LargeBinary)
