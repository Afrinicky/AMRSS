"""Turning a request plus a principal into an analysis scope.

Every surveillance endpoint routes through here so the rules that decide *what a
caller may see* live in one reviewable place. Scattering them across handlers is
how one endpoint ends up honouring suppression while its export counterpart does
not — the exact failure SDD 7 warns about when it requires enforcement at the API
layer rather than in the UI.
"""

import uuid
from dataclasses import dataclass
from datetime import date, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from amrss.analytics.antibiogram import AggregationLevel
from amrss.analytics.query import SurveillanceFilter
from amrss.models import District, Facility
from amrss.models.enums import CareSetting, OrganismKingdom
from amrss.security.permissions import Permission
from amrss.security.scope import Principal, resolve_block_id

DEFAULT_PERIOD_DAYS = 365


@dataclass(frozen=True)
class ResolvedScope:
    filters: SurveillanceFilter
    level: AggregationLevel
    regional_block_id: uuid.UUID | None
    apply_suppression: bool
    verified_only: bool


def resolve(
    db: Session,
    principal: Principal,
    *,
    district_id: uuid.UUID | None = None,
    facility_id: uuid.UUID | None = None,
    organism_ids: list[uuid.UUID] | None = None,
    specimen_type_ids: list[uuid.UUID] | None = None,
    care_setting: CareSetting | None = None,
    organism_kingdom: OrganismKingdom | None = None,
    age_bands: list[str] | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> ResolvedScope:
    if not (
        principal.has(Permission.VIEW_REGIONAL)
        or principal.has(Permission.VIEW_CROSS_FACILITY)
        or principal.has(Permission.VIEW_OWN_FACILITY)
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This role has no surveillance data access.",
        )

    block_id = resolve_block_id(db, principal)

    # A facility-scoped user is pinned to their own facility whatever they ask
    # for. Honouring the parameter would let a laboratory account read a
    # neighbouring facility by editing a URL.
    if principal.facility_id is not None:
        if facility_id is not None and facility_id != principal.facility_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You may only view your own facility's data.",
            )
        facility_id = principal.facility_id
    elif facility_id is not None and not principal.has(Permission.VIEW_CROSS_FACILITY):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Requires permission: surveillance:view_cross_facility",
        )

    if facility_id is not None:
        _assert_in_block(db, block_id, facility_id=facility_id)
        level = AggregationLevel.FACILITY
    elif district_id is not None:
        _assert_in_block(db, block_id, district_id=district_id)
        level = AggregationLevel.DISTRICT
    else:
        level = AggregationLevel.REGIONAL

    if date_to is None:
        date_to = date.today()
    if date_from is None:
        date_from = date_to - timedelta(days=DEFAULT_PERIOD_DAYS)
    if date_from > date_to:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="date_from is after date_to.",
        )

    # Suppression is lifted only when every facility in scope belongs to the
    # caller. A regional administrator viewing one facility still gets it, since
    # breadth of access is what makes small-cell inference possible.
    own_facility_only = facility_id is not None and principal.sees_unsuppressed(facility_id)

    return ResolvedScope(
        filters=SurveillanceFilter(
            regional_block_id=block_id,
            district_ids=[district_id] if district_id else None,
            facility_ids=[facility_id] if facility_id else None,
            organism_ids=organism_ids,
            specimen_type_ids=specimen_type_ids,
            care_setting=care_setting,
            organism_kingdom=organism_kingdom,
            age_bands=age_bands,
            date_from=date_from,
            date_to=date_to,
        ),
        level=level,
        regional_block_id=block_id,
        apply_suppression=not own_facility_only,
        # A facility's own view includes its data regardless of QC/EQA status; the
        # verified aggregate does not (SDD 6.6).
        verified_only=not own_facility_only,
    )


def _assert_in_block(
    db: Session,
    block_id: uuid.UUID | None,
    *,
    facility_id: uuid.UUID | None = None,
    district_id: uuid.UUID | None = None,
) -> None:
    """Reject a facility or district outside the caller's block.

    Without this, a caller scoped to one block could read another block's data by
    supplying its identifier — the multi-region schema makes cross-block reads
    expressible, so they have to be explicitly refused.
    """
    if block_id is None:
        return

    if facility_id is not None:
        owner = db.scalar(
            select(District.regional_block_id)
            .join(Facility, Facility.district_id == District.id)
            .where(Facility.id == facility_id)
        )
        target = facility_id
    else:
        owner = db.scalar(select(District.regional_block_id).where(District.id == district_id))
        target = district_id

    if owner is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if owner != block_id:
        # Deliberately 404, not 403: confirming that an identifier exists in
        # another block is itself a disclosure.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Not found: {target}")
