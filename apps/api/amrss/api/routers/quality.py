"""Tier-1 QC attestation, Tier-2 EQA, and the quality dashboard (SDD 6.2, 6.3, 6.5).

Submitting either record changes which facilities contribute to the verified
regional antibiogram, so both writes refresh the gating state in the same
transaction and both are audited. A quality submission that did not take effect
until some later job ran would leave the dashboard and the antibiogram
disagreeing about the same facility.

What this is not: the facility's laboratory quality management system. AMRSS
records attestation and compliance and gates trust on it; it performs no
wet-lab QC analytics (SDD 6.1). A facility submitting an attestation is making a
statement about its own QC, and the platform takes that statement at face value
while making its age and its consequences visible.
"""

import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select

from amrss import audit
from amrss.analytics import methodology as methodology_engine
from amrss.api.deps import CurrentPrincipal, DbSession, client_context, requires
from amrss.audit import AuditAction
from amrss.models import District, EqaRecord, Facility, QcAttestation
from amrss.models.enums import EqaStatus, QcStatus
from amrss.quality import gating
from amrss.security.permissions import Permission

router = APIRouter(prefix="/quality", tags=["quality"])


# ---- Submission ------------------------------------------------------------


class AttestationSubmission(BaseModel):
    """A facility's statement about its own internal AST QC for one period."""

    facility_id: uuid.UUID
    period_start: date
    period_end: date
    result: QcStatus
    #: Required when the attestation is unsatisfactory. A laboratory reporting a
    #: QC failure with no stated remedy leaves the regional team nothing to
    #: follow up, and the failure itself is not the useful part of the record.
    corrective_action: str | None = Field(default=None, max_length=2000)
    notes: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def check(self) -> "AttestationSubmission":
        if self.period_end < self.period_start:
            raise ValueError("period_end cannot precede period_start")
        if self.period_start > date.today():
            raise ValueError("A QC period cannot start in the future")
        if self.result is QcStatus.UNSATISFACTORY and not (self.corrective_action or "").strip():
            raise ValueError("An unsatisfactory attestation must record the corrective action")
        if self.result is QcStatus.EXPIRED:
            raise ValueError(
                "Expiry is derived from the period and the methodology, not submitted. "
                "Submit the attestation's actual result."
            )
        return self


class EqaSubmission(BaseModel):
    facility_id: uuid.UUID
    provider: str = Field(max_length=128)
    panel: str = Field(max_length=128)
    assessment_date: date
    performance: EqaStatus
    #: The scheme's own expiry where it states one. It knows its cycle better
    #: than a platform-wide default does.
    valid_until: date | None = None
    result: str | None = Field(default=None, max_length=2000)
    expected_result: str | None = Field(default=None, max_length=2000)
    corrective_action: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def check(self) -> "EqaSubmission":
        if self.assessment_date > date.today():
            raise ValueError("An EQA assessment cannot be dated in the future")
        if self.valid_until and self.valid_until < self.assessment_date:
            raise ValueError("valid_until cannot precede the assessment date")
        if (
            self.performance is EqaStatus.UNSATISFACTORY
            and not (self.corrective_action or "").strip()
        ):
            raise ValueError("An unsatisfactory EQA result must record the corrective action")
        if self.performance is EqaStatus.EXPIRED:
            raise ValueError(
                "Expiry is derived, not submitted. Submit the panel's actual performance."
            )
        return self


class TierStateResponse(BaseModel):
    status: str
    valid_until: date | None
    days_remaining: int | None
    #: The record the engine actually used, so a reviewer goes straight to it
    #: rather than searching the history for what produced this status.
    source_date: date | None


class GateResponse(BaseModel):
    facility_id: uuid.UUID
    facility_name: str
    contributes_to_verified_aggregate: bool
    qc: TierStateResponse
    eqa: TierStateResponse
    enrollment_status: str
    #: Every reason for exclusion, not the first — a laboratory told only that
    #: its QC lapsed will fix that and be surprised to remain excluded.
    exclusion_reasons: list[str]


def _tier(state: gating.TierState) -> TierStateResponse:
    return TierStateResponse(
        status=state.status.value,
        valid_until=state.valid_until,
        days_remaining=state.days_remaining,
        source_date=state.source_date,
    )


def _gate_response(facility: Facility, result: gating.GateResult) -> GateResponse:
    return GateResponse(
        facility_id=facility.id,
        facility_name=facility.name,
        contributes_to_verified_aggregate=result.passes,
        qc=_tier(result.qc),
        eqa=_tier(result.eqa),
        enrollment_status=facility.status.value,
        exclusion_reasons=result.reasons,
    )


def _facility_or_404(db: DbSession, facility_id: uuid.UUID) -> Facility:
    facility = db.get(Facility, facility_id)
    if facility is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown facility")
    return facility


@router.post(
    "/attestations",
    response_model=GateResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(requires(Permission.QC_ATTEST))],
)
def submit_attestation(
    request: Request,
    db: DbSession,
    principal: CurrentPrincipal,
    payload: AttestationSubmission,
) -> GateResponse:
    """Record a Tier-1 QC attestation and re-evaluate the gate immediately.

    Re-submitting the same period replaces the earlier statement rather than
    adding a second: a facility correcting a mistake should not leave two
    contradictory attestations covering the same weeks, with the engine picking
    whichever it happened to read first. The audit trail keeps both.
    """
    facility = _facility_or_404(db, payload.facility_id)

    existing = db.scalar(
        select(QcAttestation).where(
            QcAttestation.facility_id == facility.id,
            QcAttestation.period_start == payload.period_start,
        )
    )
    before = (
        {"result": existing.status.value, "period_end": existing.period_end.isoformat()}
        if existing
        else None
    )

    attestation = existing or QcAttestation(
        facility_id=facility.id, period_start=payload.period_start
    )
    attestation.period_end = payload.period_end
    attestation.status = payload.result
    attestation.corrective_action = payload.corrective_action
    attestation.notes = payload.notes
    attestation.submitted_at = datetime.now(UTC)
    attestation.submitted_by_id = principal.user_id
    if existing is None:
        db.add(attestation)
    db.flush()

    methodology = methodology_engine.resolve(
        db, regional_block_id=facility.district.regional_block_id
    )
    result = gating.refresh(db, facility, methodology)

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.QC_ATTESTATION_SUBMITTED,
        entity="qc_attestation",
        entity_id=attestation.id,
        principal=principal,
        before=before,
        after={
            "result": payload.result.value,
            "period_start": payload.period_start.isoformat(),
            "period_end": payload.period_end.isoformat(),
            "contributes_after": result.passes,
        },
        source_ip=ip,
        user_agent=agent,
        note=payload.notes,
    )
    db.commit()
    db.refresh(facility)
    return _gate_response(facility, result)


@router.post(
    "/eqa",
    response_model=GateResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(requires(Permission.QC_ATTEST))],
)
def submit_eqa(
    request: Request, db: DbSession, principal: CurrentPrincipal, payload: EqaSubmission
) -> GateResponse:
    """Record a Tier-2 EQA result and re-evaluate the gate immediately.

    Appended rather than replaced: EQA rounds are distinct events and a
    facility's participation history is itself the evidence of compliance.
    """
    facility = _facility_or_404(db, payload.facility_id)

    record = EqaRecord(
        facility_id=facility.id,
        provider=payload.provider,
        panel=payload.panel,
        assessment_date=payload.assessment_date,
        valid_until=payload.valid_until,
        result=payload.result,
        expected_result=payload.expected_result,
        performance=payload.performance,
        corrective_action=payload.corrective_action,
        submitted_by_id=principal.user_id,
    )
    db.add(record)
    db.flush()

    methodology = methodology_engine.resolve(
        db, regional_block_id=facility.district.regional_block_id
    )
    result = gating.refresh(db, facility, methodology)

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.EQA_RECORD_SUBMITTED,
        entity="eqa_record",
        entity_id=record.id,
        principal=principal,
        after={
            "provider": payload.provider,
            "panel": payload.panel,
            "performance": payload.performance.value,
            "assessment_date": payload.assessment_date.isoformat(),
            "contributes_after": result.passes,
        },
        source_ip=ip,
        user_agent=agent,
    )
    db.commit()
    db.refresh(facility)
    return _gate_response(facility, result)


# ---- Dashboard (SDD 6.5) ---------------------------------------------------


class QualityProfile(BaseModel):
    """One facility's quality profile, as SDD 6.5 lays it out."""

    facility_id: uuid.UUID
    facility_code: str
    facility_name: str
    district_name: str
    enrollment_status: str
    whonet_config_version: str | None
    qc: TierStateResponse
    eqa: TierStateResponse
    contributes_to_verified_aggregate: bool
    exclusion_reasons: list[str]
    last_accepted_upload_at: datetime | None
    #: Distinguishes "expiring soon" from "already lapsed" so the regional team
    #: can chase a form before it costs the facility its contribution rather
    #: than after.
    expires_within_days: int | None


class QualityDashboard(BaseModel):
    facilities: list[QualityProfile]
    contributing: int
    excluded: int
    expiring_soon: int
    #: The window used for "expiring soon", so the number is never a bare figure
    #: whose definition lives only in the client.
    expiry_warning_days: int
    qc_validity_days: int
    eqa_validity_days: int
    gating_note: str


GATING_NOTE = (
    "A facility's data enters the verified regional or district antibiogram only while its "
    "QC attestation and EQA result are both current and satisfactory. A facility that fails "
    "the gate continues to see its own data in full — gating governs the aggregate, not access."
)

#: How far ahead the dashboard warns. Not a methodology parameter: it changes no
#: published figure, only when a reminder appears.
EXPIRY_WARNING_DAYS = 30


@router.get(
    "/dashboard",
    response_model=QualityDashboard,
    dependencies=[Depends(requires(Permission.MANAGE_QC_GATING))],
)
def quality_dashboard(
    db: DbSession,
    regional_block_id: uuid.UUID | None = None,
    as_of: date | None = None,
) -> QualityDashboard:
    """Per-facility quality profile for the regional team (SDD 6.5).

    Ordered by how much attention the facility needs: excluded first, then
    expiring, then current. A dashboard sorted alphabetically buries the two
    laboratories that need a phone call among the eight that do not.
    """
    query = select(Facility).join(District).order_by(District.name, Facility.name)
    if regional_block_id is not None:
        query = query.where(District.regional_block_id == regional_block_id)

    methodology = methodology_engine.resolve(db, regional_block_id=regional_block_id)
    profiles: list[QualityProfile] = []

    for facility in db.scalars(query):
        result = gating.evaluate(db, facility, methodology, as_of=as_of)
        remaining = [
            days
            for days in (result.qc.days_remaining, result.eqa.days_remaining)
            if days is not None and days >= 0
        ]
        profiles.append(
            QualityProfile(
                facility_id=facility.id,
                facility_code=facility.code,
                facility_name=facility.name,
                district_name=facility.district.name,
                enrollment_status=facility.status.value,
                whonet_config_version=facility.whonet_config_version,
                qc=_tier(result.qc),
                eqa=_tier(result.eqa),
                contributes_to_verified_aggregate=result.passes,
                exclusion_reasons=result.reasons,
                last_accepted_upload_at=facility.last_accepted_upload_at,
                expires_within_days=min(remaining) if remaining else None,
            )
        )

    def urgency(profile: QualityProfile) -> tuple[int, int]:
        if not profile.contributes_to_verified_aggregate:
            return (0, 0)
        if profile.expires_within_days is not None and (
            profile.expires_within_days <= EXPIRY_WARNING_DAYS
        ):
            return (1, profile.expires_within_days)
        return (2, profile.expires_within_days or 9999)

    profiles.sort(key=urgency)

    return QualityDashboard(
        facilities=profiles,
        contributing=sum(1 for p in profiles if p.contributes_to_verified_aggregate),
        excluded=sum(1 for p in profiles if not p.contributes_to_verified_aggregate),
        expiring_soon=sum(
            1
            for p in profiles
            if p.contributes_to_verified_aggregate
            and p.expires_within_days is not None
            and p.expires_within_days <= EXPIRY_WARNING_DAYS
        ),
        expiry_warning_days=EXPIRY_WARNING_DAYS,
        qc_validity_days=methodology.qc_attestation_validity_days,
        eqa_validity_days=methodology.eqa_validity_days,
        gating_note=GATING_NOTE,
    )


class RefreshResponse(BaseModel):
    evaluated: int
    contributing: int
    changed: list[dict]


@router.post(
    "/refresh",
    response_model=RefreshResponse,
    dependencies=[Depends(requires(Permission.MANAGE_QC_GATING))],
)
def refresh_gating(request: Request, db: DbSession, principal: CurrentPrincipal) -> RefreshResponse:
    """Recompute every facility's cached quality state.

    Expiry is a function of time, so a facility whose attestation lapses
    overnight needs no event to change status — the cached columns simply go
    stale. This is what a scheduled job calls; it is exposed so the change is
    attributable and so an administrator can force it after correcting a record.
    """
    facilities = list(db.scalars(select(Facility)))
    methodology = methodology_engine.resolve(db)

    changed: list[dict] = []
    for facility in facilities:
        before = (facility.qc_status.value, facility.eqa_status.value)
        result = gating.refresh(db, facility, methodology)
        after = (facility.qc_status.value, facility.eqa_status.value)
        if before != after:
            changed.append(
                {
                    "facility": facility.name,
                    "qc": {"from": before[0], "to": after[0]},
                    "eqa": {"from": before[1], "to": after[1]},
                    "contributes": result.passes,
                }
            )

    if changed:
        ip, agent = client_context(request)
        audit.record(
            db,
            action=AuditAction.QC_GATING_CHANGED,
            entity="facility",
            principal=principal,
            after={"changed": changed},
            source_ip=ip,
            user_agent=agent,
            note=f"{len(changed)} of {len(facilities)} facilities changed quality state",
        )
    db.commit()

    return RefreshResponse(
        evaluated=len(facilities),
        contributing=sum(
            1 for facility in facilities if gating.evaluate(db, facility, methodology).passes
        ),
        changed=changed,
    )
