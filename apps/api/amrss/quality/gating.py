"""The QC/EQA gating rule (SDD 6.6), and the state it runs on.

The rule itself is one sentence: a facility's data enters the **verified**
regional or district antibiogram only while its QC attestation and its EQA
result are both current and satisfactory. Everything here exists to make that
sentence computable and, more importantly, explicable — a facility excluded from
the regional figure is owed a precise reason, and the regional team is owed a
count of how many facilities that applies to.

Three properties are deliberate and each prevents a specific failure:

1. **Exclusion is never silent.** A facility that fails the gate is counted and
   named in the response, not quietly dropped. A denominator that shrinks
   without explanation is indistinguishable from a denominator that is wrong.
2. **A facility always sees its own data in full.** Gating governs the verified
   *aggregate*, not access. A laboratory whose EQA lapsed still needs its own
   figures — most likely it needs them precisely because something is wrong.
3. **Expiry is a status, not an absence.** "Attested satisfactory in March, now
   expired" and "never attested" are different situations with different
   remedies, and collapsing them into one loses the distinction that tells an
   administrator whether to chase a form or start an onboarding conversation.

The validity periods come from versioned methodology (ADR-0003), never from
literals here: a regional block that runs a different QC cycle changes a row,
not this file.
"""

import uuid
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from amrss.analytics.methodology import MethodologySet
from amrss.models import EqaRecord, Facility, QcAttestation
from amrss.models.enums import EqaStatus, FacilityStatus, QcStatus


@dataclass(frozen=True)
class TierState:
    """One tier's current standing, with the record that produced it."""

    status: QcStatus | EqaStatus
    valid_until: date | None
    #: The most recent record considered, so a reviewer can go straight to it
    #: rather than searching the facility's history for what the engine used.
    source_id: uuid.UUID | None = None
    source_date: date | None = None

    @property
    def is_current_and_satisfactory(self) -> bool:
        return self.status in (QcStatus.SATISFACTORY, EqaStatus.SATISFACTORY)

    @property
    def days_remaining(self) -> int | None:
        if self.valid_until is None:
            return None
        return (self.valid_until - date.today()).days


@dataclass(frozen=True)
class GateResult:
    """Whether a facility's data may enter the verified aggregate, and why not."""

    facility_id: uuid.UUID
    qc: TierState
    eqa: TierState
    #: Enrollment status is a separate gate (SDD 9.2), evaluated alongside so a
    #: caller gets one answer rather than having to remember there are two.
    enrollment_ok: bool

    @property
    def passes(self) -> bool:
        return (
            self.enrollment_ok
            and self.qc.is_current_and_satisfactory
            and self.eqa.is_current_and_satisfactory
        )

    @property
    def reasons(self) -> list[str]:
        """Every reason the facility is excluded, in plain words.

        All of them, not the first: a laboratory told only that its QC lapsed
        will fix that and be surprised to remain excluded because its EQA had
        also expired.
        """
        if self.passes:
            return []

        reasons: list[str] = []
        if not self.enrollment_ok:
            reasons.append("The facility is not active in the enrollment lifecycle")
        reasons.extend(_tier_reason("QC attestation", self.qc))
        reasons.extend(_tier_reason("EQA result", self.eqa))
        return reasons


def _tier_reason(label: str, tier: TierState) -> list[str]:
    if tier.is_current_and_satisfactory:
        return []
    if tier.status in (QcStatus.NOT_SUBMITTED, EqaStatus.NOT_SUBMITTED):
        return [f"No {label} has been submitted"]
    if tier.status in (QcStatus.EXPIRED, EqaStatus.EXPIRED):
        expiry = f" on {tier.valid_until.isoformat()}" if tier.valid_until else ""
        return [f"The {label} expired{expiry}"]
    return [f"The most recent {label} was unsatisfactory"]


def qc_state(
    db: Session,
    facility_id: uuid.UUID,
    methodology: MethodologySet,
    *,
    as_of: date | None = None,
) -> TierState:
    """Current Tier-1 standing from the facility's attestation history.

    The most recent attestation by period end wins, whatever order the records
    arrived in — a facility catching up on a backlog must not have an old period
    override a newer one just because it was submitted last.
    """
    as_of = as_of or date.today()
    attestation = db.scalars(
        select(QcAttestation)
        .where(QcAttestation.facility_id == facility_id)
        .order_by(QcAttestation.period_end.desc())
        .limit(1)
    ).first()

    if attestation is None:
        return TierState(status=QcStatus.NOT_SUBMITTED, valid_until=None)

    valid_until = attestation.period_end + timedelta(days=methodology.qc_attestation_validity_days)
    status: QcStatus
    if attestation.status is not QcStatus.SATISFACTORY:
        # An unsatisfactory attestation is not made current by being recent. The
        # laboratory said its QC failed; the gate takes it at its word.
        status = attestation.status
    elif valid_until < as_of:
        status = QcStatus.EXPIRED
    else:
        status = QcStatus.SATISFACTORY

    return TierState(
        status=status,
        valid_until=valid_until,
        source_id=attestation.id,
        source_date=attestation.period_end,
    )


def eqa_state(
    db: Session,
    facility_id: uuid.UUID,
    methodology: MethodologySet,
    *,
    as_of: date | None = None,
) -> TierState:
    """Current Tier-2 standing from the facility's EQA history.

    The provider's own ``valid_until`` wins where one was recorded: a proficiency
    scheme knows its own cycle better than a default does, and overriding it with
    a platform-wide period would either expire a valid result early or extend a
    lapsed one.
    """
    as_of = as_of or date.today()
    record = db.scalars(
        select(EqaRecord)
        .where(EqaRecord.facility_id == facility_id)
        .order_by(EqaRecord.assessment_date.desc())
        .limit(1)
    ).first()

    if record is None:
        return TierState(status=EqaStatus.NOT_SUBMITTED, valid_until=None)

    valid_until = record.valid_until or (
        record.assessment_date + timedelta(days=methodology.eqa_validity_days)
    )
    status: EqaStatus
    if record.performance is not EqaStatus.SATISFACTORY:
        status = record.performance
    elif valid_until < as_of:
        status = EqaStatus.EXPIRED
    else:
        status = EqaStatus.SATISFACTORY

    return TierState(
        status=status,
        valid_until=valid_until,
        source_id=record.id,
        source_date=record.assessment_date,
    )


def evaluate(
    db: Session,
    facility: Facility,
    methodology: MethodologySet,
    *,
    as_of: date | None = None,
) -> GateResult:
    """Apply the gating rule to one facility."""
    return GateResult(
        facility_id=facility.id,
        qc=qc_state(db, facility.id, methodology, as_of=as_of),
        eqa=eqa_state(db, facility.id, methodology, as_of=as_of),
        enrollment_ok=facility.status is FacilityStatus.ACTIVE,
    )


def refresh(
    db: Session,
    facility: Facility,
    methodology: MethodologySet,
    *,
    as_of: date | None = None,
) -> GateResult:
    """Recompute a facility's denormalised quality columns from its records.

    Those columns exist so the gating rule can be applied inside an aggregate
    query without a correlated subquery per facility. They are a cache, and this
    is the only thing that writes them — a cache with two writers is a cache that
    disagrees with itself.

    Called after every attestation, every EQA record and every accepted upload,
    and safe to run on a schedule: expiry is a function of time, so a facility
    whose attestation lapses overnight needs no event to change status.
    """
    result = evaluate(db, facility, methodology, as_of=as_of)

    # The enum families are separate types with identical members; the state
    # objects carry whichever the tier produced, so narrow on the way in.
    facility.qc_status = QcStatus(result.qc.status.value)
    facility.qc_valid_until = result.qc.valid_until
    facility.eqa_status = EqaStatus(result.eqa.status.value)
    facility.eqa_valid_until = result.eqa.valid_until
    return result


def refresh_all(
    db: Session, methodology: MethodologySet, *, as_of: date | None = None
) -> dict[uuid.UUID, GateResult]:
    """Recompute every facility, returning what changed for the audit trail."""
    return {
        facility.id: refresh(db, facility, methodology, as_of=as_of)
        for facility in db.scalars(select(Facility))
    }
