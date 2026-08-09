from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from amrss.api.deps import CurrentUser, require
from amrss.core.permissions import Permission
from amrss.db.models.reference import BreakpointSetRecord, Organism
from amrss.db.session import get_db
from amrss.schemas.clsi import BreakpointSetSummary, InterpretRequest, InterpretResponse
from amrss.services import breakpoint_service
from amrss_clsi.breakpoints import Method
from amrss_clsi.interpretation import interpret
from amrss_clsi.mic import MICValue

router = APIRouter(prefix="/clsi", tags=["clsi"])


@router.post("/interpret", response_model=InterpretResponse)
def interpret_measurement(
    payload: InterpretRequest,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(require(Permission.AST_INTERPRET)),
) -> InterpretResponse:
    """Interpret a single measurement without persisting anything.

    Used by the bench workflow to preview a category before a result is saved.
    """
    organism = db.scalar(select(Organism).where(Organism.code == payload.organism_code.upper()))
    if organism is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown organism code")

    if payload.breakpoint_set_version:
        bp_set = breakpoint_service.load_set(db, payload.breakpoint_set_version)
    else:
        bp_set = breakpoint_service.load_active_set(db)
    if bp_set is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No active breakpoint set. Import and activate one before interpreting.",
        )

    mic = None
    if payload.method.is_mic_like:
        if not payload.mic:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="An MIC value is required for MIC and gradient methods",
            )
        try:
            mic = MICValue.parse(payload.mic)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
            ) from exc
    elif payload.zone_mm is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A zone diameter is required for disk diffusion",
        )

    # Organism groups are ordered most specific first; prepend the organism's
    # own scientific name so a species-level criterion wins.
    groups = (organism.scientific_name, *(organism.groups or ()))

    result = interpret(
        breakpoint_set=bp_set,
        organism_groups=groups,
        agent_code=payload.agent_code.upper(),
        method=payload.method,
        mic=mic,
        zone_mm=payload.zone_mm,
        site=payload.site,
        route=payload.route,
    )

    return InterpretResponse(
        category=str(result.category),
        method=Method(result.method),
        interpretable=result.is_interpretable,
        requires_review=result.requires_review,
        breakpoint_set_version=result.set_version,
        table_reference=result.table_reference,
        organism_group=result.organism_group,
        tier=str(result.tier),
        reason=result.reason,
        comments=result.comments,
    )


@router.get("/breakpoint-sets", response_model=list[BreakpointSetSummary])
def list_breakpoint_sets(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(require(Permission.BREAKPOINT_READ)),
) -> list[BreakpointSetSummary]:
    records = db.scalars(
        select(BreakpointSetRecord).order_by(BreakpointSetRecord.created_at.desc())
    ).all()
    return [
        BreakpointSetSummary(
            version=r.version,
            source_edition=r.source_edition,
            standard_body=r.standard_body,
            is_active=r.is_active,
            breakpoint_count=len(r.breakpoints),
            activated_at=r.activated_at.isoformat() if r.activated_at else None,
        )
        for r in records
    ]


@router.post("/breakpoint-sets/{version}/activate", response_model=BreakpointSetSummary)
def activate_breakpoint_set(
    version: str,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(require(Permission.BREAKPOINT_ACTIVATE)),
) -> BreakpointSetSummary:
    try:
        record = breakpoint_service.activate_set(db, version=version, actor_id=user.id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    db.commit()
    return BreakpointSetSummary(
        version=record.version,
        source_edition=record.source_edition,
        standard_body=record.standard_body,
        is_active=record.is_active,
        breakpoint_count=len(record.breakpoints),
        activated_at=record.activated_at.isoformat() if record.activated_at else None,
    )
