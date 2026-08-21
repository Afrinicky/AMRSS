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
    Response,
    UploadFile,
    status,
)
from pydantic import BaseModel
from sqlalchemy import select

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
from amrss.models import Facility, MethodologyVersion
from amrss.models.enums import MethodologyComponent
from amrss.security import breakpoint_scope
from amrss.security.permissions import Permission
from amrss.security.scope import resolve_block_id

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
    #: Rows the draft carried that nobody had typed a threshold into, left
    #: behind rather than published as coverage that does not exist. They stay
    #: in the draft to be finished. Zero for a file import, which has no draft.
    held_back: int = 0


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


class BreakpointAuthorityResponse(BaseModel):
    """What the signed-in account may do to breakpoints, and where its table
    comes from.

    Clients ask this once at sign-in rather than inferring it from the
    permission list. Local editing needs three things to line up — a permission,
    a facility grant and a scope — and an interface that guessed at the
    combination would offer an editable table the server then refuses, which is
    the worst of both.
    """

    #: May publish the national table every facility reads by default.
    may_publish_national: bool
    #: May grant or revoke another facility's local override.
    may_grant_override: bool
    #: May edit breakpoints for the facility in question.
    may_edit_locally: bool
    #: Whether the facility carries the national authority's grant at all,
    #: independent of whether *this* account could use it.
    facility_override_granted: bool
    #: Why local editing is refused, in words worth showing. Empty when allowed.
    refusal: str
    #: "national" or "facility" — whose table this facility interprets against.
    source: str


@router.get("/authority", response_model=BreakpointAuthorityResponse)
def breakpoint_authority(
    db: DbSession,
    principal: CurrentPrincipal,
    facility_id: uuid.UUID | None = None,
) -> BreakpointAuthorityResponse:
    """Resolve breakpoint authority for a facility, defaulting to one's own."""
    resolved = breakpoint_scope.authority(db, principal, facility_id=facility_id)
    facility = db.get(Facility, resolved.facility_id) if resolved.facility_id else None
    granted = bool(facility and facility.breakpoint_override_granted)
    return BreakpointAuthorityResponse(
        may_publish_national=resolved.may_publish_national,
        may_grant_override=resolved.may_grant_override,
        may_edit_locally=resolved.may_edit_locally,
        facility_override_granted=granted,
        refusal=resolved.refusal,
        source="facility" if granted else "national",
    )


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
    scope = _reading_scope(db, principal, regional_block_id)
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


# --------------------------------------------------------------------------- #
# The editable table.
# --------------------------------------------------------------------------- #
#
# A published breakpoint version is not editable in place, and that is not an
# oversight: every result already interpreted cites the version it was
# interpreted under, so changing a threshold inside it would silently rewrite
# what past antibiograms mean without leaving a trace. Editing therefore works
# on a *draft* — a methodology row dated far enough in the future that
# ``methodology.resolve`` will never pick it up — which is corrected as often as
# needed and then published as a new version with its own effective date.
#
# The draft is validated by the same code the file import uses, over the whole
# table rather than the edited row alone. One row's thresholds can be
# individually sane and still duplicate another row's scope or overlap its band,
# and the engine that catches that only sees it when it sees the set.


def _reading_scope(
    db: DbSession, principal: CurrentPrincipal, regional_block_id: uuid.UUID | None
) -> uuid.UUID | None:
    """Whose table this caller *reads*.

    Deliberately permissive where publication is strict. Every account needs to
    read the table in force — a laboratory syncing its uploader holds no
    administrative permission at all — and reading a block's published
    thresholds discloses nothing a published table was meant to keep. What it
    must not do is let a caller read a *different* block's table by editing a
    query parameter, so an out-of-scope request falls back to the caller's own
    scope rather than being honoured.
    """
    if regional_block_id is None:
        return resolve_block_id(db, principal)
    if principal.is_national or regional_block_id == resolve_block_id(db, principal):
        return regional_block_id
    return resolve_block_id(db, principal)


def _publication_scope(
    db: DbSession, principal: CurrentPrincipal, regional_block_id: uuid.UUID | None
) -> uuid.UUID | None:
    """Which table this caller is editing: the national one, or a block's.

    ``None`` means national — the table every facility falls back to, and the
    one ``methodology.resolve`` reaches when no block-scoped row applies. That
    is precisely why it needs its own permission: a block-scoped edit affects
    one region, a national one affects the whole programme, and the two arrive
    at this router through the same endpoints.

    A regional administrator therefore always lands on its own block, even if it
    asks for another or for none. Only national authority resolves to ``None``.
    """
    scope = regional_block_id if regional_block_id is not None else principal.regional_block_id

    if scope is None:
        if not principal.has(Permission.PUBLISH_NATIONAL_BREAKPOINTS):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "Publishing the national breakpoint table requires "
                    "superadmin authority. Name a regional block to edit that "
                    "block's table instead."
                ),
            )
        return None

    if not principal.is_national and scope != principal.regional_block_id:
        # Reaching into another region's table. 404 rather than 403 for the same
        # reason as everywhere else: the existence of the block is not this
        # caller's business.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown regional block")
    return scope


#: Where a draft sits so no computation can resolve it. Any date beyond the
#: programme's life would do; the maximum makes the intent unmistakable.
DRAFT_EFFECTIVE_FROM = date(9999, 12, 31)

DRAFT_VERSION_SUFFIX = "-draft"


def _draft_row(db: DbSession, regional_block_id: uuid.UUID | None) -> MethodologyVersion | None:
    return db.scalar(
        select(MethodologyVersion).where(
            MethodologyVersion.component == MethodologyComponent.AST_BREAKPOINTS,
            MethodologyVersion.effective_from == DRAFT_EFFECTIVE_FROM,
            MethodologyVersion.regional_block_id == regional_block_id,
        )
    )


def _criteria_of(row: MethodologyVersion) -> list[dict]:
    return list(row.parameters.get("breakpoints") or [])


def _scope_key(criterion: dict) -> tuple[str, ...]:
    """What the interpretation engine selects on, and so what identifies a row.

    Exactly the key ``amrss_clsi.breakpoints.validate_breakpoints`` refuses
    duplicates on. Two rows sharing it are a duplicate no engine can choose
    between, which makes the reported category depend on the order rows happen
    to sit in.

    Disk content is deliberately absent. It looks like it belongs — 10 µg and
    30 µg gentamicin are different tests — but the validator refuses two rows
    differing only in disk content, so treating them as distinct here would let
    the editor build a draft that can never be published.
    """
    return tuple(
        str(criterion.get(field) or "").strip().lower()
        for field in ("organism_group", "agent_code", "method", "site", "route")
    )


#: Threshold columns. A row with none of them is a placeholder.
THRESHOLD_FIELDS = (
    "mic_susceptible_max",
    "mic_sdd_min",
    "mic_sdd_max",
    "mic_intermediate_min",
    "mic_intermediate_max",
    "mic_resistant_min",
    "disk_susceptible_min",
    "disk_sdd_min",
    "disk_sdd_max",
    "disk_intermediate_min",
    "disk_intermediate_max",
    "disk_resistant_max",
)


def _is_placeholder(criterion: dict) -> bool:
    """Whether this row states no threshold at all.

    A **placeholder**: the combination is real, the numbers have not been typed
    yet. Drafts are full of them, because a draft usually starts from the
    blueprint — the printed table's shape with every value left blank — and a
    programme works through it organism group by organism group over days.

    They are safe to hold and impossible to be misled by: the interpretation
    engine selects on thresholds, so a row with none never matches and the
    measurement stays pending, which is exactly what it is.
    """
    return all(
        criterion.get(field) is None or str(criterion.get(field)).strip() == ""
        for field in THRESHOLD_FIELDS
    )


def _validate_table(criteria: list[dict], version: str) -> list[str]:
    """Every problem in the draft, using the importer's own checks.

    Deliberately the same path a file takes. A threshold typed into a form and a
    threshold read from a CSV are the same claim about a patient's result, and it
    would be indefensible for one route to be checked and the other not.
    """
    stated = [c for c in criteria if not _is_placeholder(c)]
    if not stated:
        return []
    try:
        parse_breakpoint_csv(to_template_csv(stated), version=version)
    except BreakpointImportError as exc:
        return exc.problems
    return []


class DraftCriterion(BaseModel):
    """One row of the table, in the template's own field names.

    The names are the template's rather than something friendlier so that what
    an operator edits on screen, what the CSV carries and what the engine reads
    are visibly the same thing.
    """

    organism_group: str
    agent_code: str
    method: str
    standard: str = "CLSI M100"
    table_reference: str | None = None
    tier: str | None = None
    site: str | None = None
    route: str | None = None
    disk_content: str | None = None
    mic_susceptible_max: str | None = None
    mic_sdd_min: str | None = None
    mic_sdd_max: str | None = None
    mic_intermediate_min: str | None = None
    mic_intermediate_max: str | None = None
    mic_resistant_min: str | None = None
    disk_susceptible_min: int | None = None
    disk_sdd_min: int | None = None
    disk_sdd_max: int | None = None
    disk_intermediate_min: int | None = None
    disk_intermediate_max: int | None = None
    disk_resistant_max: int | None = None
    dosage_note: str | None = None
    comment: str | None = None


class DraftResponse(BaseModel):
    """The draft as the editor shows it."""

    version: str
    label: str | None
    #: The published version this draft started from, so the editor can say what
    #: is being changed rather than presenting the table as if from nowhere.
    based_on: str | None
    criteria_count: int
    #: Rows that state at least one threshold — the ones that would actually be
    #: published. Distinct from ``criteria_count`` because a draft started from
    #: the blueprint has hundreds of rows and, on day one, none of these.
    stated_count: int
    criteria: list[dict]
    #: Everything wrong with the draft as it stands. A draft is allowed to be
    #: invalid while it is being worked on; publishing is what refuses.
    problems: list[str]


@router.get("/export", dependencies=[Depends(requires(Permission.MANAGE_METHODOLOGY))])
def export_breakpoint_table(
    db: DbSession,
    principal: CurrentPrincipal,
    regional_block_id: uuid.UUID | None = None,
) -> Response:
    """The table in force, as the template CSV.

    The same file the importer reads, so a programme can export the table,
    correct a threshold in a spreadsheet and import the result as the next
    version. Round-tripping is the point: an export in some other shape would
    have to be reworked by hand before it could go back in, which is where
    transcription errors come from.
    """
    scope = _publication_scope(db, principal, regional_block_id)
    methodology = methodology_engine.resolve(
        db, regional_block_id=scope, components=[MethodologyComponent.AST_BREAKPOINTS]
    )
    component = methodology.get(MethodologyComponent.AST_BREAKPOINTS)
    criteria = list(component.get("breakpoints") or []) if component else []
    version = component.version if component else "none"

    return Response(
        content=to_template_csv(criteria),
        media_type="text/csv",
        headers={
            "content-disposition": f'attachment; filename="amrss-breakpoints-{version}.csv"',
        },
    )


@router.get(
    "/draft",
    response_model=DraftResponse,
    dependencies=[Depends(requires(Permission.MANAGE_METHODOLOGY))],
)
def read_draft(
    db: DbSession,
    principal: CurrentPrincipal,
    regional_block_id: uuid.UUID | None = None,
) -> DraftResponse:
    """The draft, creating one from the table in force if none exists.

    Starting from the published table rather than from nothing is what makes the
    editor usable for its commonest job: a single threshold that differs from
    what was imported. Starting empty would mean re-entering nine hundred rows to
    change one.
    """
    scope = _publication_scope(db, principal, regional_block_id)
    row = _draft_row(db, scope)

    if row is None:
        methodology = methodology_engine.resolve(
            db, regional_block_id=scope, components=[MethodologyComponent.AST_BREAKPOINTS]
        )
        component = methodology.get(MethodologyComponent.AST_BREAKPOINTS)
        based_on = component.version if component else None
        criteria = list(component.get("breakpoints") or []) if component else []
        row = MethodologyVersion(
            component=MethodologyComponent.AST_BREAKPOINTS,
            version=f"{based_on or 'new'}{DRAFT_VERSION_SUFFIX}"[:32],
            description="Working draft of the breakpoint table. Not resolvable until published.",
            effective_from=DRAFT_EFFECTIVE_FROM,
            regional_block_id=scope,
            is_provisional=True,
            parameters={
                "label": f"Draft from {based_on}" if based_on else "New breakpoint table",
                "based_on": based_on,
                "breakpoints": criteria,
            },
        )
        db.add(row)
        db.commit()
        db.refresh(row)

    criteria = _criteria_of(row)
    return DraftResponse(
        version=row.version,
        label=row.parameters.get("label"),
        based_on=row.parameters.get("based_on"),
        criteria_count=len(criteria),
        stated_count=sum(1 for c in criteria if not _is_placeholder(c)),
        criteria=criteria,
        problems=_validate_table(criteria, row.version) if criteria else [],
    )


@router.put(
    "/draft/criteria",
    response_model=DraftResponse,
    dependencies=[Depends(requires(Permission.MANAGE_METHODOLOGY))],
)
def upsert_draft_criterion(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    criterion: DraftCriterion,
    regional_block_id: uuid.UUID | None = None,
) -> DraftResponse:
    """Add or replace one criterion in the draft.

    A criterion whose scope already exists replaces it rather than joining it,
    because two rows the engine cannot choose between is a worse state than
    either row alone.
    """
    scope = _publication_scope(db, principal, regional_block_id)
    row = _draft_row(db, scope)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="There is no draft to edit. Open the breakpoint editor first.",
        )

    incoming = criterion.model_dump()
    incoming["agent_code"] = incoming["agent_code"].strip().upper()
    incoming["method"] = incoming["method"].strip().upper()

    key = _scope_key(incoming)
    criteria = [c for c in _criteria_of(row) if _scope_key(c) != key]
    criteria.append(incoming)

    row.parameters = {**row.parameters, "breakpoints": criteria}
    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.BREAKPOINTS_IMPORTED,
        entity="methodology_version",
        entity_id=row.id,
        principal=principal,
        after={"draft": row.version, "criterion": incoming},
        source_ip=ip,
        user_agent=agent,
        note=f"Edited draft breakpoint {incoming['organism_group']} / {incoming['agent_code']}",
    )
    db.commit()

    return DraftResponse(
        version=row.version,
        label=row.parameters.get("label"),
        based_on=row.parameters.get("based_on"),
        criteria_count=len(criteria),
        stated_count=sum(1 for c in criteria if not _is_placeholder(c)),
        criteria=criteria,
        problems=_validate_table(criteria, row.version),
    )


@router.delete(
    "/draft/criteria",
    response_model=DraftResponse,
    dependencies=[Depends(requires(Permission.MANAGE_METHODOLOGY))],
)
def remove_draft_criterion(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    organism_group: str,
    agent_code: str,
    method: str,
    site: str = "",
    route: str = "",
    regional_block_id: uuid.UUID | None = None,
) -> DraftResponse:
    """Remove one criterion from the draft, addressed by its scope."""
    scope = _publication_scope(db, principal, regional_block_id)
    row = _draft_row(db, scope)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="There is no draft.")

    key = _scope_key(
        {
            "organism_group": organism_group,
            "agent_code": agent_code,
            "method": method,
            "site": site,
            "route": route,
        }
    )
    criteria = [c for c in _criteria_of(row) if _scope_key(c) != key]
    if len(criteria) == len(_criteria_of(row)):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That criterion is no longer in the draft.",
        )

    row.parameters = {**row.parameters, "breakpoints": criteria}
    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.BREAKPOINTS_IMPORTED,
        entity="methodology_version",
        entity_id=row.id,
        principal=principal,
        after={"draft": row.version, "removed": f"{organism_group} / {agent_code} / {method}"},
        source_ip=ip,
        user_agent=agent,
        note=f"Removed draft breakpoint {organism_group} / {agent_code}",
    )
    db.commit()

    return DraftResponse(
        version=row.version,
        label=row.parameters.get("label"),
        based_on=row.parameters.get("based_on"),
        criteria_count=len(criteria),
        stated_count=sum(1 for c in criteria if not _is_placeholder(c)),
        criteria=criteria,
        problems=_validate_table(criteria, row.version) if criteria else [],
    )


class PublishRequest(BaseModel):
    version: str
    source_edition: str
    effective_from: date
    description: str = ""


@router.post(
    "/draft/publish",
    response_model=ImportResponse,
    dependencies=[Depends(requires(Permission.MANAGE_METHODOLOGY))],
    status_code=status.HTTP_201_CREATED,
)
def publish_draft(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    body: PublishRequest,
    regional_block_id: uuid.UUID | None = None,
) -> ImportResponse:
    """Turn the draft into a new, dated version, or refuse it entire.

    Publishing goes through the file importer rather than around it: the draft is
    rendered as the template CSV and imported. One code path decides what a valid
    breakpoint table is, so a table typed in here cannot be looser than one
    uploaded as a file.

    A single error blocks the whole publication. Accepting a table with three bad
    rows out of nine hundred would put three wrong thresholds into clinical
    reports, with no way afterwards to tell which results they touched.
    """
    scope = _publication_scope(db, principal, regional_block_id)
    row = _draft_row(db, scope)
    if row is None or not _criteria_of(row):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The draft is empty. There is nothing to publish.",
        )

    # A published table has to interpret something, so rows nobody has typed a
    # threshold into are left behind rather than published as coverage that
    # does not exist. They are not an error and they are not discarded: the
    # draft keeps them, so the next edition of the same table can be finished
    # from where this one stopped.
    draft_criteria = _criteria_of(row)
    stated = [c for c in draft_criteria if not _is_placeholder(c)]
    held_back = len(draft_criteria) - len(stated)
    if not stated:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"None of the draft's {len(draft_criteria)} rows has a threshold in it "
                "yet, so there is nothing to interpret against. Fill some in first."
            ),
        )

    try:
        result = import_breakpoints(
            db,
            to_template_csv(stated),
            version=body.version,
            source_edition=body.source_edition,
            effective_from=body.effective_from,
            regional_block_id=scope,
            description=body.description or f"Published from the breakpoint editor ({row.version})",
            commit=False,
        )
    except BreakpointImportError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": str(exc), "problems": exc.problems},
        ) from exc

    # The draft has become the published version; keeping it whole would leave
    # two tables in play and no way to tell which one an operator was editing.
    #
    # Unless rows were held back. Those are the programme's unfinished work —
    # combinations it has not got to yet — and throwing them away would mean
    # re-deriving the list from the blueprint to carry on. So the draft
    # survives holding exactly them, and the next publication adds whatever has
    # been filled in since.
    if held_back:
        row.parameters = {
            **row.parameters,
            "based_on": body.version,
            "label": f"Still to fill in after {body.version}",
            "breakpoints": [c for c in draft_criteria if _is_placeholder(c)],
        }
    else:
        db.delete(row)

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.BREAKPOINTS_IMPORTED,
        entity="methodology_version",
        principal=principal,
        after={
            "version": body.version,
            "source_edition": body.source_edition,
            "breakpoints": result.imported,
            "published_from_draft": row.version,
            "based_on": row.parameters.get("based_on"),
        },
        source_ip=ip,
        user_agent=agent,
        note=f"Published {result.imported} breakpoints as {body.version} from the editor",
    )
    db.commit()

    return ImportResponse(
        version=result.version,
        source_edition=result.source_edition,
        imported=result.imported,
        warnings=(
            result.warnings
            + (
                [
                    f"{held_back} row(s) had no threshold typed into them and were not "
                    "published. They are still in the draft, ready to be finished."
                ]
                if held_back
                else []
            )
        ),
        conversion=None,
        held_back=held_back,
    )
