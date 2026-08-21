import uuid

from fastapi import APIRouter, Header, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select

from amrss.api.deps import ClientContext, CurrentPrincipal, DbSession
from amrss.config import get_settings
from amrss.ingestion import service
from amrss.models import Facility, UploadBatch, UploadQcFinding
from amrss.models.enums import BatchStatus, FacilityStatus, QcFindingSeverity
from amrss.security.permissions import Permission
from amrss.security.scope import Principal, resolve_block_id

router = APIRouter(prefix="/ingestion", tags=["ingestion"])


def _resolve_upload_facility(
    db: DbSession, principal: Principal, payload_facility_code: str
) -> Facility:
    """Which facility a submitted batch belongs to.

    A facility-scoped account (laboratory staff) can only be one laboratory, and
    the payload must agree with it. A non-scoped authority — the regional AMR
    administrator uploading on a laboratory's behalf — names the facility in the
    payload instead, and may reach any facility within its own block; the
    national authority reaches any facility at all. Either way the batch lands
    against a real, in-scope facility rather than wherever the payload asked.
    """
    if principal.home_facility_id is not None:
        facility = db.get(Facility, principal.facility_id)
        if facility is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Facility not found")
        if payload_facility_code != facility.code:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "The payload declares a different facility than the authenticated "
                    "account is scoped to."
                ),
            )
        return facility

    # Not tied to one facility: only a cross-facility authority may upload this
    # way, and only inside its block.
    if not principal.has(Permission.VIEW_CROSS_FACILITY):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Upload accounts must be scoped to a facility",
        )
    facility = db.scalar(select(Facility).where(Facility.code == payload_facility_code))
    if facility is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No facility with code {payload_facility_code!r}",
        )
    block_id = resolve_block_id(db, principal)
    if block_id is not None and facility.regional_block_id != block_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="That facility is outside your regional block.",
        )
    return facility


class FindingResponse(BaseModel):
    code: str
    severity: QcFindingSeverity
    message: str
    affected_record_count: int


class IngestionResponse(BaseModel):
    batch_id: uuid.UUID
    status: BatchStatus
    isolates_accepted: int
    message: str
    findings: list[FindingResponse]


@router.post(
    "/batches",
    response_model=IngestionResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Submit a de-identified surveillance batch",
)
async def submit_batch(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    client: ClientContext,
    x_amrss_checksum: str = Header(..., description="SHA-256 of the compressed payload"),
) -> IngestionResponse:
    """Accept one transmission from a facility's offline uploader.

    The body is gzip-compressed JSON matching ``UploadPayload``. The checksum
    header covers the compressed bytes as sent, so it verifies exactly what
    crossed the network.
    """
    if not principal.has(Permission.UPLOAD_SUBMIT):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Requires permission: upload:submit",
        )

    settings = get_settings()
    body = await request.body()
    source_ip, _ = client

    # Decode first: the facility the batch belongs to may be named in the payload
    # (a regional authority uploading for a laboratory), not carried on the token.
    try:
        payload = service.decode_envelope(body, x_amrss_checksum, settings.max_upload_bytes)
        service.check_uploader_version(payload.uploader_version, settings.minimum_uploader_version)
    except service.IngestionError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    facility = _resolve_upload_facility(db, principal, payload.facility_code)

    # A suspended or retired facility must not be able to keep contributing.
    # Enrollment status gates submission, not just aggregation.
    if facility.status not in (FacilityStatus.ACTIVE, FacilityStatus.UNDER_VERIFICATION):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Facility status is '{facility.status.value}'. Only active or "
                "under-verification facilities may submit data."
            ),
        )

    result = service.ingest(
        db,
        facility=facility,
        payload=payload,
        raw_bytes=len(body),
        checksum=x_amrss_checksum,
        principal=principal,
        source_ip=source_ip,
    )

    return IngestionResponse(
        batch_id=result.batch_id,
        status=result.status,
        isolates_accepted=result.isolates_accepted,
        message=result.message,
        findings=[
            FindingResponse(
                code=finding.code,
                severity=finding.severity,
                message=finding.message,
                affected_record_count=finding.affected_record_count,
            )
            for finding in result.findings
        ],
    )


class BatchSummary(BaseModel):
    id: uuid.UUID
    facility_code: str
    uploaded_at: str
    status: BatchStatus
    record_count: int
    accepted_isolate_count: int
    uploader_version: str
    coverage_start: str | None
    coverage_end: str | None
    finding_count: int
    decision_reason: str | None


@router.get("/batches", response_model=list[BatchSummary])
def list_batches(
    db: DbSession,
    principal: CurrentPrincipal,
    batch_status: BatchStatus | None = None,
    limit: int = 50,
) -> list[BatchSummary]:
    """Upload history. Facility-scoped users see only their own batches."""
    statement = (
        select(UploadBatch, Facility.code)
        .join(Facility, Facility.id == UploadBatch.facility_id)
        .order_by(UploadBatch.uploaded_at.desc())
        .limit(min(limit, 200))
    )

    if principal.home_facility_id is not None:
        statement = statement.where(UploadBatch.facility_id == principal.facility_id)
    elif not principal.has(Permission.REVIEW_BATCH):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Requires permission: batch:review"
        )

    if batch_status is not None:
        statement = statement.where(UploadBatch.status == batch_status)

    summaries = []
    for batch, facility_code in db.execute(statement).all():
        finding_count = db.scalar(
            select(UploadQcFinding.id).where(UploadQcFinding.upload_batch_id == batch.id).limit(1)
        )
        summaries.append(
            BatchSummary(
                id=batch.id,
                facility_code=facility_code,
                uploaded_at=batch.uploaded_at.isoformat(),
                status=batch.status,
                record_count=batch.record_count,
                accepted_isolate_count=batch.accepted_isolate_count,
                uploader_version=batch.uploader_version,
                coverage_start=(batch.coverage_start.isoformat() if batch.coverage_start else None),
                coverage_end=batch.coverage_end.isoformat() if batch.coverage_end else None,
                finding_count=1 if finding_count else 0,
                decision_reason=batch.decision_reason,
            )
        )
    return summaries


class TransitionRequest(BaseModel):
    to_status: BatchStatus
    reason: str


@router.post("/batches/{batch_id}/transition", response_model=BatchSummary)
def transition_batch(
    batch_id: uuid.UUID,
    payload: TransitionRequest,
    db: DbSession,
    principal: CurrentPrincipal,
) -> BatchSummary:
    """Move a held batch to accepted, or quarantine and retract a faulty one.

    Retraction is a state change, never a delete. Because analytics filters on
    ACCEPTED, the aggregates the batch fed drop it automatically on the next
    computation (SDD 9.6).
    """
    if not principal.has(Permission.REVIEW_BATCH):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Requires permission: batch:review"
        )
    if payload.to_status is BatchStatus.RETRACTED and not principal.has(Permission.RETRACT_BATCH):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Requires permission: batch:retract"
        )
    if not payload.reason.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A reason is required: every lifecycle transition is auditable.",
        )

    batch = db.get(UploadBatch, batch_id)
    if batch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Batch not found")

    service.transition(
        db, batch=batch, to_status=payload.to_status, principal=principal, reason=payload.reason
    )

    facility_code = db.scalar(select(Facility.code).where(Facility.id == batch.facility_id))
    return BatchSummary(
        id=batch.id,
        facility_code=facility_code or "",
        uploaded_at=batch.uploaded_at.isoformat(),
        status=batch.status,
        record_count=batch.record_count,
        accepted_isolate_count=batch.accepted_isolate_count,
        uploader_version=batch.uploader_version,
        coverage_start=batch.coverage_start.isoformat() if batch.coverage_start else None,
        coverage_end=batch.coverage_end.isoformat() if batch.coverage_end else None,
        finding_count=0,
        decision_reason=batch.decision_reason,
    )
