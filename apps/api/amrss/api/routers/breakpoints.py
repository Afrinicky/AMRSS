"""Breakpoint table import and measurement interpretation.

Both endpoints are administrative and both are audited. Importing a breakpoint
table changes what every subsequent antibiogram says, and running an
interpretation pass rewrites stored results — neither is something that should
be possible without a name attached to it.

The import is deliberately a file upload of the laboratory's own licensed CLSI
table rather than anything AMRSS ships. See packages/clsi/README.md for why.
"""

import uuid
from datetime import date

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from pydantic import BaseModel

from amrss import audit
from amrss.analytics import interpretation as interpretation_engine
from amrss.analytics import methodology as methodology_engine
from amrss.analytics.breakpoint_import import BreakpointImportError, import_breakpoints
from amrss.api.deps import CurrentPrincipal, DbSession, client_context, requires
from amrss.audit import AuditAction
from amrss.security.permissions import Permission

router = APIRouter(prefix="/breakpoints", tags=["breakpoints"])

MAX_UPLOAD_BYTES = 4 * 1024 * 1024


class ImportResponse(BaseModel):
    version: str
    source_edition: str
    imported: int
    #: Non-blocking observations — an incomplete panel is legitimate, so these
    #: are surfaced rather than treated as failures.
    warnings: list[str]


class InterpretationResponse(BaseModel):
    examined: int
    interpreted: int
    still_pending: int
    not_interpretable: int
    coverage_percent: float
    breakpoint_set_version: str | None
    #: Organism/agent/method combinations the loaded table does not cover, most
    #: frequent first, so the next import can be prioritised by impact rather
    #: than alphabetically.
    uncovered: list[dict]


@router.post(
    "/import",
    response_model=ImportResponse,
    dependencies=[Depends(requires(Permission.MANAGE_METHODOLOGY))],
    status_code=status.HTTP_201_CREATED,
)
async def import_breakpoint_table(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    file: UploadFile = File(..., description="CSV in the shape of clsi_m100.template.csv"),
    version: str = Form(..., description="e.g. M100-Ed36"),
    source_edition: str = Form(..., description="e.g. CLSI M100 36th ed. (2026)"),
    effective_from: date = Form(...),
    regional_block_id: uuid.UUID | None = Form(default=None),
    description: str = Form(default=""),
) -> ImportResponse:
    """Load a licensed CLSI table as a new, versioned methodology row.

    Any validation error blocks the whole import. Accepting a table with three
    bad rows out of nine hundred would put three wrong thresholds into clinical
    reports, and there is no way to tell afterwards which results they touched.
    """
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Breakpoint table exceeds the 4 MB limit",
        )
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The file is not UTF-8 text. Export it from your spreadsheet as CSV (UTF-8).",
        ) from exc

    try:
        result = import_breakpoints(
            db,
            text,
            version=version,
            source_edition=source_edition,
            effective_from=effective_from,
            regional_block_id=regional_block_id,
            description=description,
        )
    except BreakpointImportError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": str(exc), "problems": exc.problems},
        ) from exc

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.BREAKPOINTS_IMPORTED,
        entity="methodology_version",
        principal=principal,
        after={
            "version": version,
            "source_edition": source_edition,
            "breakpoints": result.imported,
            "warnings": len(result.warnings),
        },
        source_ip=ip,
        user_agent=agent,
        note=f"Imported {result.imported} breakpoints from {source_edition}",
    )
    db.commit()

    return ImportResponse(
        version=result.version,
        source_edition=result.source_edition,
        imported=result.imported,
        warnings=result.warnings,
    )


@router.post(
    "/interpret",
    response_model=InterpretationResponse,
    dependencies=[Depends(requires(Permission.MANAGE_METHODOLOGY))],
)
def run_interpretation(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    facility_id: uuid.UUID | None = None,
    regional_block_id: uuid.UUID | None = None,
) -> InterpretationResponse:
    """Interpret every measurement still awaiting a category.

    Safe to re-run: only results still pending are touched, so a second pass
    after loading a fuller table picks up what the first could not cover and
    leaves everything else alone.
    """
    methodology = methodology_engine.resolve(db, regional_block_id=regional_block_id)
    try:
        report = interpretation_engine.interpret_pending(
            db, methodology, facility_id=facility_id, commit=False
        )
    except interpretation_engine.BreakpointsNotConfiguredError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.RESULTS_INTERPRETED,
        entity="ast_result",
        principal=principal,
        after={
            "examined": report.examined,
            "interpreted": report.interpreted,
            "still_pending": report.still_pending,
            "not_interpretable": report.not_interpretable,
            "breakpoint_set_version": report.breakpoint_set_version,
            "facility_id": str(facility_id) if facility_id else None,
        },
        source_ip=ip,
        user_agent=agent,
        note=(
            f"Interpreted {report.interpreted} of {report.examined} pending "
            f"measurements under {report.breakpoint_set_version}"
        ),
    )
    db.commit()

    uncovered = sorted(report.uncovered.items(), key=lambda item: -item[1])
    return InterpretationResponse(
        examined=report.examined,
        interpreted=report.interpreted,
        still_pending=report.still_pending,
        not_interpretable=report.not_interpretable,
        coverage_percent=report.coverage_percent,
        breakpoint_set_version=report.breakpoint_set_version,
        uncovered=[{"combination": key, "measurements": count} for key, count in uncovered[:50]],
    )
