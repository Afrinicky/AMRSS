"""Administrative endpoints: enrollment, blocks, stewardship, audit.

Everything here changes configuration rather than computing over data, and every
write is audited. The distinction matters because these actions have no visible
effect at the moment they happen — activating a facility changes what next
month's antibiogram says, and without a trail there is no way to answer "why did
this figure move" a quarter later.

Adding a regional block is an endpoint, not a migration (ADR-0002, SDD 9.3).
That is the whole reason a second Ghanaian region is an afternoon of data entry
rather than a release.
"""

import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from amrss import audit
from amrss.admin import enrollment, purge
from amrss.api.deps import CurrentPrincipal, DbSession, client_context, requires
from amrss.audit import AuditAction
from amrss.models import (
    AuditLog,
    CanonicalOrganism,
    District,
    Facility,
    FacilityCodeMapping,
    MethodologyVersion,
    RegionalBlock,
)
from amrss.models.enums import (
    FacilityStatus,
    MappingStatus,
    MethodologyComponent,
    UploadSchedule,
)
from amrss.security.permissions import Permission

router = APIRouter(prefix="/admin", tags=["admin"])


# ---- Regional blocks -------------------------------------------------------


class BlockResponse(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    governing_body: str
    status: str
    activated_on: date | None
    whonet_config_standard: str | None
    district_count: int
    facility_count: int


class BlockCreate(BaseModel):
    code: str = Field(max_length=16)
    name: str = Field(max_length=128)
    governing_body: str = Field(max_length=256)
    whonet_config_standard: str | None = Field(default=None, max_length=64)
    #: Districts to create alongside the block. A block with no districts cannot
    #: enrol anybody, and creating them in one call keeps onboarding a single
    #: administrative act rather than a checklist someone half-finishes.
    districts: list[str] = Field(default_factory=list)


class DistrictResponse(BaseModel):
    id: uuid.UUID
    name: str
    regional_block_id: uuid.UUID
    facility_count: int


def _block_response(db: DbSession, block: RegionalBlock) -> BlockResponse:
    districts = db.scalars(select(District.id).where(District.regional_block_id == block.id)).all()
    facilities = (
        db.scalar(select(func.count(Facility.id)).where(Facility.district_id.in_(districts))) or 0
        if districts
        else 0
    )
    return BlockResponse(
        id=block.id,
        code=block.code,
        name=block.name,
        governing_body=block.governing_body,
        status=block.status,
        activated_on=block.activated_at,
        whonet_config_standard=block.whonet_config_standard,
        district_count=len(districts),
        facility_count=facilities,
    )


@router.get(
    "/blocks",
    response_model=list[BlockResponse],
    dependencies=[Depends(requires(Permission.MANAGE_BLOCK))],
)
def list_blocks(db: DbSession) -> list[BlockResponse]:
    blocks = db.scalars(select(RegionalBlock).order_by(RegionalBlock.name)).all()
    return [_block_response(db, block) for block in blocks]


@router.post(
    "/blocks",
    response_model=BlockResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(requires(Permission.MANAGE_BLOCK))],
)
def create_block(
    request: Request, db: DbSession, principal: CurrentPrincipal, payload: BlockCreate
) -> BlockResponse:
    """Create a surveillance block. Configuration, never a code change (ADR-0002)."""
    if db.scalar(select(RegionalBlock).where(RegionalBlock.code == payload.code)):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A regional block with code {payload.code!r} already exists.",
        )

    block = RegionalBlock(
        code=payload.code,
        name=payload.name,
        governing_body=payload.governing_body,
        whonet_config_standard=payload.whonet_config_standard,
        status="active",
        activated_at=date.today(),
    )
    db.add(block)
    db.flush()

    for name in payload.districts:
        if name.strip():
            db.add(District(regional_block_id=block.id, name=name.strip()))

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.BLOCK_CREATED,
        entity="regional_block",
        entity_id=block.id,
        principal=principal,
        after={
            "code": block.code,
            "name": block.name,
            "governing_body": block.governing_body,
            "districts": payload.districts,
        },
        source_ip=ip,
        user_agent=agent,
    )
    db.commit()
    db.refresh(block)
    return _block_response(db, block)


@router.get(
    "/districts",
    response_model=list[DistrictResponse],
    dependencies=[Depends(requires(Permission.MANAGE_BLOCK))],
)
def list_districts(
    db: DbSession, regional_block_id: uuid.UUID | None = None
) -> list[DistrictResponse]:
    query = select(District).order_by(District.name)
    if regional_block_id is not None:
        query = query.where(District.regional_block_id == regional_block_id)

    return [
        DistrictResponse(
            id=district.id,
            name=district.name,
            regional_block_id=district.regional_block_id,
            facility_count=db.scalar(
                select(func.count(Facility.id)).where(Facility.district_id == district.id)
            )
            or 0,
        )
        for district in db.scalars(query)
    ]


@router.post(
    "/districts",
    response_model=DistrictResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(requires(Permission.MANAGE_BLOCK))],
)
def create_district(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    regional_block_id: Annotated[uuid.UUID, Query()],
    name: Annotated[str, Query(max_length=128)],
) -> DistrictResponse:
    if db.get(RegionalBlock, regional_block_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown regional block")

    district = District(regional_block_id=regional_block_id, name=name.strip())
    db.add(district)
    db.flush()

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.BLOCK_UPDATED,
        entity="district",
        entity_id=district.id,
        principal=principal,
        after={"name": district.name, "regional_block_id": str(regional_block_id)},
        source_ip=ip,
        user_agent=agent,
    )
    db.commit()
    return DistrictResponse(
        id=district.id,
        name=district.name,
        regional_block_id=district.regional_block_id,
        facility_count=0,
    )


# ---- Facility enrollment ---------------------------------------------------


class FacilityResponse(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    district_id: uuid.UUID
    district_name: str
    regional_block_id: uuid.UUID
    status: FacilityStatus
    whonet_config_version: str | None
    upload_schedule: UploadSchedule
    upload_interval_days: int | None
    mou_signed_on: date | None
    mou_reference: str | None
    enrollment_notes: str | None
    last_accepted_upload_at: datetime | None
    qc_status: str
    eqa_status: str
    #: Which lifecycle moves this facility can make right now, so an
    #: administrator is offered the legal options rather than discovering the
    #: rules by being refused.
    available_transitions: list[FacilityStatus]
    #: Enrollment fields still outstanding before activation is possible.
    blocking_activation: list[str]


class FacilityCreate(BaseModel):
    code: str = Field(max_length=32)
    name: str = Field(max_length=256)
    district_id: uuid.UUID
    whonet_config_version: str | None = Field(default=None, max_length=64)
    upload_schedule: UploadSchedule = UploadSchedule.WEEKLY
    upload_interval_days: int | None = Field(default=None, ge=1, le=365)
    mou_signed_on: date | None = None
    mou_reference: str | None = Field(default=None, max_length=128)
    enrollment_notes: str | None = None


class FacilityUpdate(BaseModel):
    """Enrollment detail only. Status moves through /transition, which enforces
    the lifecycle; allowing it here would make the graph bypassable."""

    name: str | None = Field(default=None, max_length=256)
    whonet_config_version: str | None = Field(default=None, max_length=64)
    upload_schedule: UploadSchedule | None = None
    upload_interval_days: int | None = Field(default=None, ge=1, le=365)
    mou_signed_on: date | None = None
    mou_reference: str | None = Field(default=None, max_length=128)
    enrollment_notes: str | None = None


class TransitionRequest(BaseModel):
    target: FacilityStatus
    #: Required. A status change without a stated reason is unauditable, and
    #: suspension in particular is a decision someone has to own.
    reason: str = Field(min_length=3, max_length=512)


def _facility_response(facility: Facility) -> FacilityResponse:
    return FacilityResponse(
        id=facility.id,
        code=facility.code,
        name=facility.name,
        district_id=facility.district_id,
        district_name=facility.district.name,
        regional_block_id=facility.district.regional_block_id,
        status=facility.status,
        whonet_config_version=facility.whonet_config_version,
        upload_schedule=facility.upload_schedule,
        upload_interval_days=facility.upload_interval_days,
        mou_signed_on=facility.mou_signed_on,
        mou_reference=facility.mou_reference,
        enrollment_notes=facility.enrollment_notes,
        last_accepted_upload_at=facility.last_accepted_upload_at,
        qc_status=facility.qc_status.value,
        eqa_status=facility.eqa_status.value,
        available_transitions=sorted(
            enrollment.ALLOWED_TRANSITIONS[facility.status], key=lambda s: s.value
        ),
        blocking_activation=enrollment.missing_for_activation(facility),
    )


@router.get(
    "/facilities",
    response_model=list[FacilityResponse],
    dependencies=[Depends(requires(Permission.ENROLL_FACILITY))],
)
def list_facilities(
    db: DbSession,
    regional_block_id: uuid.UUID | None = None,
    facility_status: FacilityStatus | None = None,
) -> list[FacilityResponse]:
    query = select(Facility).join(District).order_by(District.name, Facility.name)
    if regional_block_id is not None:
        query = query.where(District.regional_block_id == regional_block_id)
    if facility_status is not None:
        query = query.where(Facility.status == facility_status)
    return [_facility_response(f) for f in db.scalars(query)]


@router.post(
    "/facilities",
    response_model=FacilityResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(requires(Permission.ENROLL_FACILITY))],
)
def enroll_facility(
    request: Request, db: DbSession, principal: CurrentPrincipal, payload: FacilityCreate
) -> FacilityResponse:
    """Enrol a facility. It starts PENDING and contributes nothing until activated."""
    if db.get(District, payload.district_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown district")
    if db.scalar(select(Facility).where(Facility.code == payload.code)):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A facility with code {payload.code!r} already exists.",
        )

    facility = Facility(status=FacilityStatus.PENDING, **payload.model_dump())
    db.add(facility)
    db.flush()

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.FACILITY_ENROLLED,
        entity="facility",
        entity_id=facility.id,
        principal=principal,
        after={"code": facility.code, "name": facility.name, "status": facility.status.value},
        source_ip=ip,
        user_agent=agent,
    )
    db.commit()
    db.refresh(facility)
    return _facility_response(facility)


@router.patch(
    "/facilities/{facility_id}",
    response_model=FacilityResponse,
    dependencies=[Depends(requires(Permission.ENROLL_FACILITY))],
)
def update_facility(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    facility_id: uuid.UUID,
    payload: FacilityUpdate,
) -> FacilityResponse:
    facility = db.get(Facility, facility_id)
    if facility is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown facility")

    changes = payload.model_dump(exclude_unset=True)
    before = {key: _jsonable(getattr(facility, key)) for key in changes}
    for key, value in changes.items():
        setattr(facility, key, value)

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.FACILITY_STATUS_CHANGED,
        entity="facility",
        entity_id=facility.id,
        principal=principal,
        before=before,
        after={key: _jsonable(value) for key, value in changes.items()},
        source_ip=ip,
        user_agent=agent,
        note="Enrollment detail updated",
    )
    db.commit()
    db.refresh(facility)
    return _facility_response(facility)


@router.post(
    "/facilities/{facility_id}/transition",
    response_model=FacilityResponse,
    dependencies=[Depends(requires(Permission.ENROLL_FACILITY))],
)
def transition_facility(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    facility_id: uuid.UUID,
    payload: TransitionRequest,
) -> FacilityResponse:
    """Move a facility through the enrollment lifecycle (SDD 9.2).

    Refusals are 409 rather than 422: the request is well-formed, the facility is
    simply not in a state that permits it. Distinguishing the two lets a client
    show "you cannot suspend a pending facility" instead of "invalid input".
    """
    facility = db.get(Facility, facility_id)
    if facility is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown facility")

    try:
        previous = enrollment.apply_transition(facility, payload.target)
    except enrollment.ActivationBlockedError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": str(exc), "missing": exc.missing},
        ) from exc
    except enrollment.TransitionNotAllowedError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.FACILITY_STATUS_CHANGED,
        entity="facility",
        entity_id=facility.id,
        principal=principal,
        before={"status": previous.value},
        after={"status": facility.status.value},
        source_ip=ip,
        user_agent=agent,
        note=payload.reason,
    )
    db.commit()
    db.refresh(facility)
    return _facility_response(facility)


# ---- Destructive data management -------------------------------------------
#
# The only endpoints in the platform that genuinely delete. Gated on PURGE_DATA,
# held solely by the overall regional authority, and each one requires the caller
# to type a confirmation so a reset is never a single misplaced click. The
# deletion logic lives in amrss.admin.purge; the audit record it writes outlives
# the data it removed.


class PurgeResult(BaseModel):
    #: Rows removed, per table, zero entries omitted.
    deleted: dict[str, int]
    total: int
    message: str


class FacilityDeletion(BaseModel):
    #: Must equal the facility's own code. A free-text confirmation that names
    #: the target is the cheapest guard against deleting the wrong laboratory.
    confirm: str = Field(min_length=1, max_length=32)


class DataReset(BaseModel):
    #: ``surveillance`` clears uploads and everything computed from them but
    #: keeps the facility roster; ``everything`` also removes the facilities and
    #: districts so the block starts from nothing.
    scope: Literal["surveillance", "everything"] = "surveillance"
    #: Must equal ``RESET``. Distinct from a facility code because this clears
    #: every facility at once, so the confirmation is a word, not a name.
    confirm: str = Field(min_length=1, max_length=32)


@router.post(
    "/facilities/{facility_id}/delete",
    response_model=PurgeResult,
    dependencies=[Depends(requires(Permission.PURGE_DATA))],
)
def delete_facility(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    facility_id: uuid.UUID,
    payload: FacilityDeletion,
) -> PurgeResult:
    """Delete a facility and every record it ever submitted (irreversible).

    Suspending or retiring a facility keeps its data; this removes it. Use it for
    a laboratory enrolled in error, or when clearing a pilot. The facility's
    accounts are detached and deactivated rather than deleted, so the audit trail
    stays attributable.
    """
    facility = db.get(Facility, facility_id)
    if facility is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown facility")

    if payload.confirm.strip() != facility.code:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Type the facility code {facility.code!r} to confirm deletion.",
        )

    before = {"code": facility.code, "name": facility.name, "status": facility.status.value}
    counts = purge.summarise(purge.delete_facility(db, facility))
    total = purge.total_rows(counts)

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.FACILITY_DELETED,
        entity="facility",
        entity_id=facility_id,
        principal=principal,
        before=before,
        after={"deleted_rows": counts, "total": total},
        source_ip=ip,
        user_agent=agent,
        note=f"Facility {before['code']} deleted with all its data",
    )
    db.commit()
    return PurgeResult(
        deleted=counts,
        total=total,
        message=f"{before['name']} and {total} record(s) removed.",
    )


@router.post(
    "/data/reset",
    response_model=PurgeResult,
    dependencies=[Depends(requires(Permission.PURGE_DATA))],
)
def reset_data(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    payload: DataReset,
) -> PurgeResult:
    """Clear surveillance data so the block can begin a new cycle (irreversible).

    Keeps the canonical dictionary, methodology versions, regional blocks and
    user accounts — the configuration the next cycle is built on. With
    ``scope=everything`` it also removes the facilities and districts.
    """
    if payload.confirm.strip().upper() != "RESET":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Type RESET to confirm clearing the surveillance data.",
        )

    include_facilities = payload.scope == "everything"
    counts = purge.summarise(purge.reset_surveillance(db, include_facilities=include_facilities))
    total = purge.total_rows(counts)

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.DATA_RESET,
        entity="surveillance",
        entity_id=None,
        principal=principal,
        before={"scope": payload.scope},
        after={"deleted_rows": counts, "total": total},
        source_ip=ip,
        user_agent=agent,
        note=f"Surveillance data reset (scope={payload.scope})",
    )
    db.commit()
    kept = "facilities kept" if not include_facilities else "facilities and districts removed"
    return PurgeResult(
        deleted=counts,
        total=total,
        message=f"Surveillance data cleared ({kept}); {total} record(s) removed.",
    )


class RegionDeletion(BaseModel):
    #: Must equal the block code (or the district name), so a delete names its
    #: target. Different from the reset word because this removes one thing.
    confirm: str = Field(min_length=1, max_length=128)


@router.post(
    "/districts/{district_id}/delete",
    response_model=PurgeResult,
    dependencies=[Depends(requires(Permission.PURGE_DATA))],
)
def delete_district(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    district_id: uuid.UUID,
    payload: RegionDeletion,
) -> PurgeResult:
    """Delete a district. Refused while it still holds facilities — those, and
    their data, are removed one at a time as a deliberate separate act."""
    district = db.get(District, district_id)
    if district is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown district")

    facilities = db.scalar(
        select(func.count(Facility.id)).where(Facility.district_id == district_id)
    )
    if facilities:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{district.name} still has {facilities} facility(ies). Delete or move them "
                "before deleting the district."
            ),
        )
    if payload.confirm.strip().lower() != district.name.strip().lower():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Type the district name {district.name!r} to confirm deletion.",
        )

    counts = purge.summarise(purge.delete_district(db, district))
    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.DISTRICT_DELETED,
        entity="district",
        entity_id=district_id,
        principal=principal,
        before={"name": district.name, "regional_block_id": str(district.regional_block_id)},
        after={"deleted_rows": counts},
        source_ip=ip,
        user_agent=agent,
        note=f"District {district.name} deleted",
    )
    db.commit()
    return PurgeResult(
        deleted=counts, total=purge.total_rows(counts), message=f"District {district.name} deleted."
    )


@router.post(
    "/blocks/{block_id}/delete",
    response_model=PurgeResult,
    dependencies=[Depends(requires(Permission.PURGE_DATA))],
)
def delete_block(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    block_id: uuid.UUID,
    payload: RegionDeletion,
) -> PurgeResult:
    """Delete a regional block. Refused while it still holds districts."""
    block = db.get(RegionalBlock, block_id)
    if block is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown regional block")

    districts = db.scalar(
        select(func.count(District.id)).where(District.regional_block_id == block_id)
    )
    if districts:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{block.name} still has {districts} district(s). Delete them before deleting "
                "the block."
            ),
        )
    if payload.confirm.strip().lower() != block.code.strip().lower():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Type the block code {block.code!r} to confirm deletion.",
        )

    counts = purge.summarise(purge.delete_region(db, block))
    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.BLOCK_DELETED,
        entity="regional_block",
        entity_id=block_id,
        principal=principal,
        before={"code": block.code, "name": block.name},
        after={"deleted_rows": counts},
        source_ip=ip,
        user_agent=agent,
        note=f"Regional block {block.code} deleted",
    )
    db.commit()
    return PurgeResult(
        deleted=counts,
        total=purge.total_rows(counts),
        message=f"Regional block {block.name} deleted.",
    )


# ---- Dictionary mapping queue ----------------------------------------------


class MappingResponse(BaseModel):
    id: uuid.UUID
    facility_id: uuid.UUID
    facility_name: str
    entity_type: str
    local_code: str
    local_label: str | None
    canonical_code: str | None
    status: MappingStatus
    observed_record_count: int
    review_note: str | None


class MappingReview(BaseModel):
    status: MappingStatus
    canonical_code: str | None = Field(default=None, max_length=32)
    review_note: str | None = Field(default=None, max_length=512)


@router.get(
    "/mappings",
    response_model=list[MappingResponse],
    dependencies=[Depends(requires(Permission.REVIEW_MAPPING))],
)
def list_mappings(
    db: DbSession,
    mapping_status: MappingStatus | None = MappingStatus.PROPOSED,
    facility_id: uuid.UUID | None = None,
) -> list[MappingResponse]:
    """The stewardship queue, busiest first.

    Ordered by how many records carry the unmapped code rather than
    alphabetically: a code appearing on four hundred isolates is holding four
    hundred isolates out of the antibiogram, and one appearing twice is not.
    """
    query = (
        select(FacilityCodeMapping, Facility.name)
        .join(Facility, FacilityCodeMapping.facility_id == Facility.id)
        .order_by(FacilityCodeMapping.observed_record_count.desc())
    )
    if mapping_status is not None:
        query = query.where(FacilityCodeMapping.status == mapping_status)
    if facility_id is not None:
        query = query.where(FacilityCodeMapping.facility_id == facility_id)

    return [
        MappingResponse(
            id=mapping.id,
            facility_id=mapping.facility_id,
            facility_name=facility_name,
            entity_type=mapping.entity_type.value,
            local_code=mapping.local_code,
            local_label=mapping.local_label,
            canonical_code=mapping.canonical_code,
            status=mapping.status,
            observed_record_count=mapping.observed_record_count,
            review_note=mapping.review_note,
        )
        for mapping, facility_name in db.execute(query)
    ]


@router.post(
    "/mappings/{mapping_id}/review",
    response_model=MappingResponse,
    dependencies=[Depends(requires(Permission.REVIEW_MAPPING))],
)
def review_mapping(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    mapping_id: uuid.UUID,
    payload: MappingReview,
) -> MappingResponse:
    """Approve, reject or park a proposed code mapping (SDD 3.4).

    An approved mapping needs a canonical code. Approving without one would let
    a facility's local code enter aggregates mapped to nothing, which is exactly
    the silent-miscombination failure the dictionary layer exists to prevent.
    """
    mapping = db.get(FacilityCodeMapping, mapping_id)
    if mapping is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown mapping")

    target_code = payload.canonical_code or mapping.canonical_code
    if payload.status is MappingStatus.APPROVED and not target_code:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="An approved mapping must name the canonical code it maps to.",
        )

    before = {"status": mapping.status.value, "canonical_code": mapping.canonical_code}
    mapping.status = payload.status
    if payload.canonical_code is not None:
        mapping.canonical_code = payload.canonical_code
    if payload.review_note is not None:
        mapping.review_note = payload.review_note
    mapping.reviewed_by_id = principal.user_id

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.MAPPING_REVIEWED,
        entity="facility_code_mapping",
        entity_id=mapping.id,
        principal=principal,
        before=before,
        after={"status": mapping.status.value, "canonical_code": mapping.canonical_code},
        source_ip=ip,
        user_agent=agent,
        note=payload.review_note,
    )
    db.commit()
    db.refresh(mapping)

    facility = db.get(Facility, mapping.facility_id)
    return MappingResponse(
        id=mapping.id,
        facility_id=mapping.facility_id,
        facility_name=facility.name if facility else "",
        entity_type=mapping.entity_type.value,
        local_code=mapping.local_code,
        local_label=mapping.local_label,
        canonical_code=mapping.canonical_code,
        status=mapping.status,
        observed_record_count=mapping.observed_record_count,
        review_note=mapping.review_note,
    )


# ---- Methodology versions --------------------------------------------------


class MethodologyResponse(BaseModel):
    id: uuid.UUID
    component: MethodologyComponent
    version: str
    description: str
    effective_from: date
    is_provisional: bool
    regional_block_id: uuid.UUID | None
    #: Parameter keys only. The AST breakpoint component holds a whole CLSI
    #: table, and returning it inline would make the methodology list a
    #: multi-megabyte response nobody reads.
    parameter_keys: list[str]
    entry_count: int | None


@router.get(
    "/methodology",
    response_model=list[MethodologyResponse],
    dependencies=[Depends(requires(Permission.MANAGE_METHODOLOGY))],
)
def list_methodology(
    db: DbSession, regional_block_id: uuid.UUID | None = None
) -> list[MethodologyResponse]:
    query = select(MethodologyVersion).order_by(
        MethodologyVersion.component, MethodologyVersion.effective_from.desc()
    )
    if regional_block_id is not None:
        query = query.where(MethodologyVersion.regional_block_id == regional_block_id)

    versions = []
    for version in db.scalars(query):
        parameters: dict[str, Any] = version.parameters or {}
        breakpoints = parameters.get("breakpoints")
        versions.append(
            MethodologyResponse(
                id=version.id,
                component=version.component,
                version=version.version,
                description=version.description,
                effective_from=version.effective_from,
                is_provisional=version.is_provisional,
                regional_block_id=version.regional_block_id,
                parameter_keys=sorted(parameters),
                entry_count=len(breakpoints) if isinstance(breakpoints, list) else None,
            )
        )
    return versions


# ---- Audit trail -----------------------------------------------------------


class AuditEntry(BaseModel):
    id: uuid.UUID
    occurred_at: datetime
    actor_label: str
    actor_role: str | None
    action: str
    entity: str
    entity_id: str | None
    before_state: dict[str, Any] | None
    after_state: dict[str, Any] | None
    source_ip: str | None
    note: str | None


class AuditPage(BaseModel):
    entries: list[AuditEntry]
    total: int
    #: Every action name present in the trail, so a client can offer a filter
    #: built from what actually happened rather than the full enum.
    actions: list[str]


@router.get(
    "/audit",
    response_model=AuditPage,
    dependencies=[Depends(requires(Permission.READ_AUDIT))],
)
def read_audit(
    db: DbSession,
    action: str | None = None,
    entity: str | None = None,
    entity_id: str | None = None,
    since: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AuditPage:
    """Read the append-only trail (SDD 10.2).

    Read-only by construction: there is no update or delete path to this table
    anywhere in application code, and none is added here.
    """
    query = select(AuditLog)
    if action:
        query = query.where(AuditLog.action == action)
    if entity:
        query = query.where(AuditLog.entity == entity)
    if entity_id:
        query = query.where(AuditLog.entity_id == entity_id)
    if since:
        query = query.where(AuditLog.occurred_at >= since)

    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.scalars(query.order_by(AuditLog.occurred_at.desc()).limit(limit).offset(offset)).all()
    actions = db.scalars(select(AuditLog.action).distinct().order_by(AuditLog.action)).all()

    return AuditPage(
        entries=[
            AuditEntry(
                id=row.id,
                occurred_at=row.occurred_at,
                actor_label=row.actor_label,
                actor_role=row.actor_role,
                action=row.action,
                entity=row.entity,
                entity_id=row.entity_id,
                before_state=row.before_state,
                after_state=row.after_state,
                source_ip=row.source_ip,
                note=row.note,
            )
            for row in rows
        ],
        total=total,
        actions=list(actions),
    )


# ---- Dictionary summary ----------------------------------------------------


class DictionarySummary(BaseModel):
    organisms: int
    organisms_of_special_importance: int
    organisms_without_clsi_groups: int
    antibiotics: int
    specimen_types: int
    pending_mappings: int


@router.get(
    "/dictionary/summary",
    response_model=DictionarySummary,
    dependencies=[Depends(requires(Permission.MANAGE_DICTIONARY))],
)
def dictionary_summary(db: DbSession) -> DictionarySummary:
    """Dictionary health at a glance.

    ``organisms_without_clsi_groups`` is the one worth watching: an organism with
    no CLSI group mapping can never have its measurements interpreted, so it
    silently contributes nothing to any antibiogram however many isolates it has.
    """
    from amrss.models import CanonicalAntibiotic, CanonicalSpecimenType

    organisms = list(db.scalars(select(CanonicalOrganism)))
    return DictionarySummary(
        organisms=len(organisms),
        organisms_of_special_importance=sum(
            1 for o in organisms if o.is_organism_of_special_importance
        ),
        organisms_without_clsi_groups=sum(1 for o in organisms if not o.clsi_organism_groups),
        antibiotics=db.scalar(select(func.count(CanonicalAntibiotic.id))) or 0,
        specimen_types=db.scalar(select(func.count(CanonicalSpecimenType.id))) or 0,
        pending_mappings=db.scalar(
            select(func.count(FacilityCodeMapping.id)).where(
                FacilityCodeMapping.status == MappingStatus.PROPOSED
            )
        )
        or 0,
    )


def _jsonable(value: Any) -> Any:
    """Audit states are JSONB; dates and enums must survive the round trip."""
    if isinstance(value, date | datetime):
        return value.isoformat()
    if hasattr(value, "value"):
        return value.value
    return value
