"""Breakpoint table import and measurement interpretation.

Both endpoints are administrative and both are audited. Importing a breakpoint
table changes what every subsequent antibiogram says, and running an
interpretation pass rewrites stored results — neither is something that should
be possible without a name attached to it.

The import is deliberately a file upload of the laboratory's own licensed CLSI
table rather than anything AMRSS ships. See packages/clsi/README.md for why.

Two shapes are accepted. A CSV in the template's shape is taken as reviewed and
goes straight to strict validation. A workbook — what a laboratory usually has,
being an extraction of the printed document — is converted first, and that
conversion drops everything it cannot vouch for. Preview the conversion before
importing: the drop list is the part worth reading, because it says which agents
the laboratory will *not* be able to report.
"""

import io
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
from amrss.analytics.breakpoint_import import (
    BreakpointImportError,
    agent_lookup,
    import_breakpoints,
    parse_breakpoint_csv,
)
from amrss.analytics.m100_workbook import (
    WorkbookFormatError,
    convert_workbook,
    to_template_csv,
)
from amrss.api.deps import CurrentPrincipal, DbSession, client_context, requires
from amrss.audit import AuditAction
from amrss.models import MethodologyVersion
from amrss.models.enums import MethodologyComponent
from amrss.security.permissions import Permission

router = APIRouter(prefix="/breakpoints", tags=["breakpoints"])

#: A workbook carries styling and shared strings a CSV does not, so it needs
#: more headroom than the 4 MB a template CSV ever reaches.
MAX_UPLOAD_BYTES = 12 * 1024 * 1024

WORKBOOK_SUFFIXES = (".xlsx", ".xlsm")


class ConversionReport(BaseModel):
    """What reading a workbook decided, for review before anything is stored."""

    criteria: int
    organism_groups: list[str]
    agent_codes: list[str]
    #: Source rows that produced no criterion, each with its reason. The
    #: important half of this response: a laboratory that cannot see what was
    #: left out will believe its table is complete.
    dropped: list[str]
    #: Rows whose agent was identified by repairing a damaged label. Mechanical,
    #: but still worth a human eye before they interpret an isolate.
    repairs: list[str]


class ImportResponse(BaseModel):
    version: str
    source_edition: str
    imported: int
    #: Non-blocking observations — an incomplete panel is legitimate, so these
    #: are surfaced rather than treated as failures.
    warnings: list[str]
    #: Present only when a workbook was converted on the way in.
    conversion: ConversionReport | None = None


class PreviewResponse(BaseModel):
    conversion: ConversionReport
    warnings: list[str]
    #: The converted table in the template's shape, so it can be saved, diffed
    #: against the printed tables and imported as a reviewed CSV instead.
    template_csv: str


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


async def _read_upload(file: UploadFile) -> bytes:
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Breakpoint table exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit",
        )
    return raw


def _to_template_csv(
    db: DbSession, filename: str | None, raw: bytes
) -> tuple[str, ConversionReport | None]:
    """Get a template-shaped CSV out of whatever the laboratory uploaded.

    A CSV is passed through untouched: it is the reviewable artefact, and
    softening it here would defeat the strict validation it is about to meet.
    A workbook is converted, and the conversion's decisions come back with it so
    they can be recorded and shown.
    """
    if not (filename or "").lower().endswith(WORKBOOK_SUFFIXES):
        try:
            return raw.decode("utf-8-sig"), None
        except UnicodeDecodeError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    "The file is neither a workbook nor UTF-8 text. Upload the .xlsx, "
                    "or export it from your spreadsheet as CSV (UTF-8)."
                ),
            ) from exc

    try:
        conversion = convert_workbook(io.BytesIO(raw), agents=agent_lookup(db))
    except WorkbookFormatError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    report = ConversionReport(
        criteria=len(conversion.rows),
        organism_groups=conversion.organism_groups,
        agent_codes=conversion.agent_codes,
        dropped=[str(d) for d in conversion.dropped],
        repairs=[str(r) for r in conversion.repairs],
    )
    return to_template_csv(conversion.rows), report


@router.post(
    "/preview",
    response_model=PreviewResponse,
    dependencies=[Depends(requires(Permission.MANAGE_METHODOLOGY))],
)
async def preview_breakpoint_table(
    db: DbSession,
    file: UploadFile = File(..., description="CLSI workbook (.xlsx) or template CSV"),
    version: str = Form(default="preview"),
) -> PreviewResponse:
    """Parse a table and report what it would import, storing nothing.

    Separate from the import because the two questions are different. The
    import asks "is this table structurally sound"; the preview asks "is this
    the table I meant to load" — which only a person holding the printed
    document can answer, and only if they are shown what was dropped first.
    """
    raw = await _read_upload(file)
    text, report = _to_template_csv(db, file.filename, raw)

    try:
        rows, warnings = parse_breakpoint_csv(text, version=version)
    except BreakpointImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": str(exc), "problems": exc.problems},
        ) from exc

    if report is None:
        report = ConversionReport(
            criteria=len(rows),
            organism_groups=sorted({str(r["organism_group"]) for r in rows}),
            agent_codes=sorted({str(r["agent_code"]) for r in rows}),
            dropped=[],
            repairs=[],
        )
    return PreviewResponse(conversion=report, warnings=warnings, template_csv=text)


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
    file: UploadFile = File(..., description="CLSI workbook (.xlsx) or template CSV"),
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
    raw = await _read_upload(file)
    text, report = _to_template_csv(db, file.filename, raw)

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
            # A conversion's drops are part of what this table *is*. Recording
            # only the criteria that survived would leave the audit trail
            # unable to answer why an agent has no breakpoint.
            "converted_from_workbook": report is not None,
            "dropped_source_rows": len(report.dropped) if report else 0,
            "repaired_labels": len(report.repairs) if report else 0,
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
        conversion=report,
    )


class ActiveBreakpointsResponse(BaseModel):
    """The effective table, in the shape the template CSV declares it.

    Rows are passed through unchanged rather than reshaped, so an offline client
    interpreting a measurement is reading the same numbers, under the same
    column names, as the server that will re-interpret it after upload. A second
    shape here would be a second chance to transpose a threshold.
    """

    version: str | None
    label: str | None
    effective_from: date | None
    criteria: list[dict]


@router.get("/active", response_model=ActiveBreakpointsResponse)
def active_breakpoints(
    db: DbSession,
    principal: CurrentPrincipal,
    regional_block_id: uuid.UUID | None = None,
) -> ActiveBreakpointsResponse:
    """The breakpoint table currently in force, for clients that interpret offline.

    The desktop uploader shows a laboratory its own results as S/I/R before they
    are sent, which it cannot do from a zone diameter alone. Reading the table
    from here rather than shipping one with the client is the whole point: there
    is exactly one set of thresholds in the programme, the one the laboratory
    imported from its licensed edition, and both halves cite the same version.

    Empty rather than an error when nothing is loaded — a laboratory that has not
    yet imported its tables gets measurements marked pending, which is the honest
    answer, not a failed sync it cannot act on.
    """
    scope = regional_block_id if regional_block_id is not None else principal.regional_block_id
    methodology = methodology_engine.resolve(
        db,
        regional_block_id=scope,
        components=[MethodologyComponent.AST_BREAKPOINTS],
    )
    component = methodology.get(MethodologyComponent.AST_BREAKPOINTS)
    if component is None:
        return ActiveBreakpointsResponse(version=None, label=None, effective_from=None, criteria=[])

    row = db.get(MethodologyVersion, component.id)
    return ActiveBreakpointsResponse(
        version=component.version,
        label=component.get("label"),
        effective_from=row.effective_from if row else None,
        criteria=list(component.get("breakpoints") or []),
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
