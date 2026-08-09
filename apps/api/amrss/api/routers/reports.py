"""Report generation and retrieval (SDD 9.7).

Generation is gated on the same permission as viewing the regional antibiogram.
That is deliberate rather than lax: a report contains exactly what the requester
can already see on the dashboard — same engine, same thresholds, same
suppression, same QC gating — so requiring a separate, higher permission to
export it would gate the file format rather than the information.

Downloads serve the stored artefact rather than regenerating. A report
circulated to a stewardship committee in April has to keep saying in October
what the committee discussed, even after a threshold is tuned or a late upload
changes the underlying aggregate.
"""

import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select

from amrss import audit
from amrss.api.deps import CurrentPrincipal, DbSession, client_context, requires
from amrss.audit import AuditAction
from amrss.models import GeneratedReport
from amrss.models.enums import ReportPeriod
from amrss.reports import build as report_builder
from amrss.reports import excel, pdf
from amrss.security.permissions import Permission
from amrss.security.scope import resolve_block_id

router = APIRouter(prefix="/reports", tags=["reports"])

CONTENT_TYPES = {
    "pdf": "application/pdf",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


class ReportRequest(BaseModel):
    period: ReportPeriod
    #: Any date inside the period for a scheduled cadence; the calendar bounds
    #: are derived. Ad-hoc reports must state both ends themselves.
    anchor: date | None = None
    period_start: date | None = None
    period_end: date | None = None
    district_id: uuid.UUID | None = None
    facility_id: uuid.UUID | None = None
    notes: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def check(self) -> "ReportRequest":
        if self.period is ReportPeriod.AD_HOC:
            if not (self.period_start and self.period_end):
                raise ValueError("An ad-hoc report must state period_start and period_end")
            if self.period_end < self.period_start:
                raise ValueError("period_end cannot precede period_start")
        elif not (self.anchor or (self.period_start and self.period_end)):
            raise ValueError("Give an anchor date inside the period, or explicit bounds")
        return self

    def bounds(self) -> tuple[date, date]:
        if self.period_start and self.period_end:
            return self.period_start, self.period_end
        assert self.anchor is not None
        return report_builder.period_bounds(self.period, self.anchor)


class ReportSummary(BaseModel):
    id: uuid.UUID
    title: str
    period: ReportPeriod
    period_start: date
    period_end: date
    generated_at: datetime
    organism_count: int
    isolate_count: int
    facilities_contributing: int
    facilities_excluded: int
    notes: str | None
    formats: list[str]


def _summary(report: GeneratedReport) -> ReportSummary:
    return ReportSummary(
        id=report.id,
        title=report.title,
        period=report.period,
        period_start=report.period_start,
        period_end=report.period_end,
        generated_at=report.generated_at,
        organism_count=report.organism_count,
        isolate_count=report.isolate_count,
        facilities_contributing=report.facilities_contributing,
        facilities_excluded=report.facilities_excluded,
        notes=report.notes,
        formats=[
            name for name, blob in (("pdf", report.pdf_bytes), ("xlsx", report.xlsx_bytes)) if blob
        ],
    )


@router.get(
    "",
    response_model=list[ReportSummary],
    dependencies=[Depends(requires(Permission.VIEW_REGIONAL))],
)
def list_reports(db: DbSession, principal: CurrentPrincipal) -> list[ReportSummary]:
    """Published reports, newest period first.

    Scoped to the caller's regional block. A report is a snapshot of one block's
    surveillance and carries no meaning outside it.
    """
    block_id = resolve_block_id(db, principal)
    query = select(GeneratedReport).order_by(
        GeneratedReport.period_start.desc(), GeneratedReport.generated_at.desc()
    )
    if block_id is not None:
        query = query.where(GeneratedReport.regional_block_id == block_id)
    return [_summary(report) for report in db.scalars(query)]


@router.post(
    "",
    response_model=ReportSummary,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(requires(Permission.VIEW_REGIONAL))],
)
def generate_report(
    request: Request, db: DbSession, principal: CurrentPrincipal, payload: ReportRequest
) -> ReportSummary:
    """Compute a report and store both artefacts.

    Both formats are rendered at generation rather than on demand. Rendering the
    PDF in April and the spreadsheet in October from a changed aggregate would
    produce two documents with the same title that disagree.
    """
    period_start, period_end = payload.bounds()
    block_id = resolve_block_id(db, principal)

    content = report_builder.build(
        db,
        period=payload.period,
        period_start=period_start,
        period_end=period_end,
        regional_block_id=block_id,
        district_id=payload.district_id,
        facility_id=payload.facility_id,
    )

    report = GeneratedReport(
        title=content.title,
        period=payload.period,
        period_start=period_start,
        period_end=period_end,
        regional_block_id=block_id,
        district_id=payload.district_id,
        facility_id=payload.facility_id,
        generated_at=datetime.now(UTC),
        generated_by_id=principal.user_id,
        organism_count=len(content.rows),
        isolate_count=content.eligible_isolate_count,
        facilities_contributing=content.facilities_contributing,
        facilities_excluded=content.facilities_excluded_by_quality,
        methodology_snapshot=content.methodology,
        notes=payload.notes,
        pdf_bytes=pdf.render(content),
        xlsx_bytes=excel.render(content),
    )
    db.add(report)
    db.flush()

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.REPORT_GENERATED,
        entity="generated_report",
        entity_id=report.id,
        principal=principal,
        after={
            "title": report.title,
            "period": payload.period.value,
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "organisms": report.organism_count,
            "isolates": report.isolate_count,
        },
        source_ip=ip,
        user_agent=agent,
        note=payload.notes,
    )
    db.commit()
    db.refresh(report)
    return _summary(report)


@router.get(
    "/{report_id}/download",
    dependencies=[Depends(requires(Permission.VIEW_REGIONAL))],
    response_class=Response,
)
def download_report(
    db: DbSession, principal: CurrentPrincipal, report_id: uuid.UUID, file_format: str = "pdf"
) -> Response:
    """Serve the stored artefact exactly as it was generated."""
    if file_format not in CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported format {file_format!r}. Use pdf or xlsx.",
        )

    report = db.get(GeneratedReport, report_id)
    if report is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown report")

    # Block scoping is a real access control, not a listing convenience: a
    # report is a whole block's surveillance picture in one file.
    block_id = resolve_block_id(db, principal)
    if block_id is not None and report.regional_block_id not in (None, block_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown report")

    blob = report.pdf_bytes if file_format == "pdf" else report.xlsx_bytes
    if not blob:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"This report has no {file_format} artefact",
        )

    slug = report.title.lower().replace(" ", "-").replace("—", "-")
    filename = f"{''.join(c for c in slug if c.isalnum() or c == '-')}.{file_format}"
    return Response(
        content=blob,
        media_type=CONTENT_TYPES[file_format],
        headers={"content-disposition": f'attachment; filename="{filename}"'},
    )
