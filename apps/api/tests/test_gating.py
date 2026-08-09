"""The QC/EQA gating rule (SDD 6.6).

This rule decides which laboratories' data appears in the verified regional
antibiogram, so getting it wrong publishes figures from facilities whose testing
quality is unverified — or silently drops facilities whose quality is fine. Both
failures look like a working system from the outside.

The engine reads from the database, so these tests drive it through a fake
session rather than a live one: the rules under test are about dates and
statuses, and a Postgres round trip would test SQLAlchemy instead.
"""

import uuid
from dataclasses import dataclass
from datetime import date, timedelta

from amrss.models.enums import EqaStatus, FacilityStatus, QcStatus
from amrss.quality import gating
from tests.conftest import make_methodology

TODAY = date(2026, 8, 9)


@dataclass
class FakeAttestation:
    id: uuid.UUID
    period_end: date
    status: QcStatus


@dataclass
class FakeEqa:
    id: uuid.UUID
    assessment_date: date
    performance: EqaStatus
    valid_until: date | None = None


@dataclass
class FakeFacility:
    id: uuid.UUID
    status: FacilityStatus = FacilityStatus.ACTIVE
    qc_status: QcStatus = QcStatus.NOT_SUBMITTED
    qc_valid_until: date | None = None
    eqa_status: EqaStatus = EqaStatus.NOT_SUBMITTED
    eqa_valid_until: date | None = None


class FakeSession:
    """Returns the newest record the engine asks for, as the real query would.

    Records are held unsorted deliberately: the engine must order them itself,
    because a facility catching up on a backlog submits out of order.
    """

    def __init__(self, attestations=(), eqa_records=()):
        self._attestations = list(attestations)
        self._eqa = list(eqa_records)

    def scalars(self, query):
        # The engine issues exactly two shapes of query; distinguish by the
        # entity it selects rather than by parsing SQL.
        entity = query.column_descriptions[0]["entity"].__name__
        rows = (
            sorted(self._attestations, key=lambda a: a.period_end, reverse=True)
            if entity == "QcAttestation"
            else sorted(self._eqa, key=lambda e: e.assessment_date, reverse=True)
        )
        return _Result(rows[:1])


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def first(self):
        return self._rows[0] if self._rows else None


def methodology():
    return make_methodology(qc_rules={"qc_attestation_validity_days": 92, "eqa_validity_days": 366})


FACILITY = uuid.uuid4()


# ---- Tier 1: QC attestation ------------------------------------------------


def test_no_attestation_is_not_submitted_rather_than_unsatisfactory():
    """ "Never attested" and "attested and failed" call for different
    conversations: one is onboarding, the other is a quality problem."""
    state = gating.qc_state(FakeSession(), FACILITY, methodology(), as_of=TODAY)

    assert state.status is QcStatus.NOT_SUBMITTED
    assert state.valid_until is None
    assert not state.is_current_and_satisfactory


def test_a_recent_satisfactory_attestation_is_current():
    state = gating.qc_state(
        FakeSession(
            [FakeAttestation(uuid.uuid4(), TODAY - timedelta(days=10), QcStatus.SATISFACTORY)]
        ),
        FACILITY,
        methodology(),
        as_of=TODAY,
    )

    assert state.status is QcStatus.SATISFACTORY
    assert state.is_current_and_satisfactory


def test_an_attestation_expires_after_the_methodology_validity_period():
    """An attestation made two years ago says nothing about the laboratory's QC
    today. Treating it as current would let a facility contribute indefinitely
    on the strength of one submission."""
    stale = TODAY - timedelta(days=200)
    state = gating.qc_state(
        FakeSession([FakeAttestation(uuid.uuid4(), stale, QcStatus.SATISFACTORY)]),
        FACILITY,
        methodology(),
        as_of=TODAY,
    )

    assert state.status is QcStatus.EXPIRED
    assert state.valid_until == stale + timedelta(days=92)


def test_the_validity_period_comes_from_methodology_not_a_literal():
    """ADR-0003: a block running a different QC cycle changes a row, not code."""
    period_end = TODAY - timedelta(days=200)
    generous = make_methodology(
        qc_rules={"qc_attestation_validity_days": 400, "eqa_validity_days": 366}
    )
    state = gating.qc_state(
        FakeSession([FakeAttestation(uuid.uuid4(), period_end, QcStatus.SATISFACTORY)]),
        FACILITY,
        generous,
        as_of=TODAY,
    )

    assert state.status is QcStatus.SATISFACTORY


def test_an_unsatisfactory_attestation_is_not_rescued_by_being_recent():
    """The laboratory said its QC failed. The gate takes it at its word."""
    state = gating.qc_state(
        FakeSession([FakeAttestation(uuid.uuid4(), TODAY, QcStatus.UNSATISFACTORY)]),
        FACILITY,
        methodology(),
        as_of=TODAY,
    )

    assert state.status is QcStatus.UNSATISFACTORY
    assert not state.is_current_and_satisfactory


def test_the_latest_period_wins_regardless_of_submission_order():
    """A facility catching up on a backlog must not have an old period override
    a newer one just because it was entered last."""
    old = FakeAttestation(uuid.uuid4(), TODAY - timedelta(days=200), QcStatus.UNSATISFACTORY)
    recent = FakeAttestation(uuid.uuid4(), TODAY - timedelta(days=5), QcStatus.SATISFACTORY)
    state = gating.qc_state(FakeSession([recent, old]), FACILITY, methodology(), as_of=TODAY)

    assert state.status is QcStatus.SATISFACTORY
    assert state.source_id == recent.id


def test_the_state_names_the_record_that_produced_it():
    """A reviewer should go straight to the record, not search the history for
    whatever the engine happened to use."""
    attestation = FakeAttestation(uuid.uuid4(), TODAY - timedelta(days=5), QcStatus.SATISFACTORY)
    state = gating.qc_state(FakeSession([attestation]), FACILITY, methodology(), as_of=TODAY)

    assert state.source_id == attestation.id
    assert state.source_date == attestation.period_end


# ---- Tier 2: EQA -----------------------------------------------------------


def test_eqa_expires_on_the_default_period_when_the_scheme_states_none():
    old = TODAY - timedelta(days=400)
    state = gating.eqa_state(
        FakeSession(eqa_records=[FakeEqa(uuid.uuid4(), old, EqaStatus.SATISFACTORY)]),
        FACILITY,
        methodology(),
        as_of=TODAY,
    )

    assert state.status is EqaStatus.EXPIRED


def test_the_schemes_own_expiry_wins_over_the_default():
    """A proficiency scheme knows its own cycle. Overriding it with a
    platform-wide period would expire a valid result early, or extend a lapsed
    one past the point the provider considers it meaningful."""
    assessed = TODAY - timedelta(days=400)
    state = gating.eqa_state(
        FakeSession(
            eqa_records=[
                FakeEqa(
                    uuid.uuid4(),
                    assessed,
                    EqaStatus.SATISFACTORY,
                    valid_until=TODAY + timedelta(days=30),
                )
            ]
        ),
        FACILITY,
        methodology(),
        as_of=TODAY,
    )

    assert state.status is EqaStatus.SATISFACTORY
    assert state.valid_until == TODAY + timedelta(days=30)


def test_a_scheme_expiry_in_the_past_expires_the_record_early():
    state = gating.eqa_state(
        FakeSession(
            eqa_records=[
                FakeEqa(
                    uuid.uuid4(),
                    TODAY - timedelta(days=30),
                    EqaStatus.SATISFACTORY,
                    valid_until=TODAY - timedelta(days=1),
                )
            ]
        ),
        FACILITY,
        methodology(),
        as_of=TODAY,
    )

    assert state.status is EqaStatus.EXPIRED


# ---- The gate itself -------------------------------------------------------


def _gate(qc: QcStatus, eqa: EqaStatus, enrollment=FacilityStatus.ACTIVE) -> gating.GateResult:
    return gating.GateResult(
        facility_id=FACILITY,
        qc=gating.TierState(status=qc, valid_until=TODAY),
        eqa=gating.TierState(status=eqa, valid_until=TODAY),
        enrollment_ok=enrollment is FacilityStatus.ACTIVE,
    )


def test_both_tiers_must_pass():
    assert _gate(QcStatus.SATISFACTORY, EqaStatus.SATISFACTORY).passes
    assert not _gate(QcStatus.SATISFACTORY, EqaStatus.EXPIRED).passes
    assert not _gate(QcStatus.EXPIRED, EqaStatus.SATISFACTORY).passes


def test_enrollment_is_a_separate_gate_from_quality():
    """A suspended facility with perfect quality is still excluded, and an
    active facility with lapsed EQA is still excluded. Two independent gates
    (SDD 9.2 and 6.6); collapsing them loses which one failed."""
    suspended = _gate(
        QcStatus.SATISFACTORY, EqaStatus.SATISFACTORY, enrollment=FacilityStatus.SUSPENDED
    )

    assert not suspended.passes
    assert suspended.reasons == ["The facility is not active in the enrollment lifecycle"]


def test_a_passing_facility_has_no_reasons():
    assert _gate(QcStatus.SATISFACTORY, EqaStatus.SATISFACTORY).reasons == []


def test_every_failing_reason_is_reported_not_just_the_first():
    """A laboratory told only that its QC lapsed will fix that and be surprised
    to remain excluded because its EQA had also expired."""
    reasons = _gate(QcStatus.NOT_SUBMITTED, EqaStatus.UNSATISFACTORY).reasons

    assert len(reasons) == 2
    assert any("QC attestation" in r for r in reasons)
    assert any("EQA result" in r for r in reasons)


def test_expiry_and_absence_produce_different_reasons():
    """One is a form to chase, the other an onboarding conversation."""
    expired = _gate(QcStatus.EXPIRED, EqaStatus.SATISFACTORY).reasons
    absent = _gate(QcStatus.NOT_SUBMITTED, EqaStatus.SATISFACTORY).reasons

    assert "expired" in expired[0]
    assert "has been submitted" in absent[0]
    assert expired != absent


def test_refresh_writes_the_cached_columns_from_the_records():
    """The denormalised columns exist so the gate can be applied inside an
    aggregate query. They are a cache with exactly one writer — a cache with two
    writers is a cache that disagrees with itself."""
    facility = FakeFacility(id=FACILITY)
    session = FakeSession(
        [FakeAttestation(uuid.uuid4(), TODAY - timedelta(days=5), QcStatus.SATISFACTORY)],
        [FakeEqa(uuid.uuid4(), TODAY - timedelta(days=20), EqaStatus.SATISFACTORY)],
    )

    result = gating.refresh(session, facility, methodology(), as_of=TODAY)

    assert facility.qc_status is QcStatus.SATISFACTORY
    assert facility.eqa_status is EqaStatus.SATISFACTORY
    assert facility.qc_valid_until == TODAY - timedelta(days=5) + timedelta(days=92)
    assert result.passes


def test_refresh_records_expiry_without_any_new_submission():
    """Expiry is a function of time. A facility whose attestation lapses
    overnight changes state with no event to trigger it, which is why the
    refresh has to be runnable on a schedule."""
    facility = FakeFacility(id=FACILITY, qc_status=QcStatus.SATISFACTORY)
    session = FakeSession(
        [FakeAttestation(uuid.uuid4(), TODAY - timedelta(days=200), QcStatus.SATISFACTORY)],
        [FakeEqa(uuid.uuid4(), TODAY - timedelta(days=20), EqaStatus.SATISFACTORY)],
    )

    result = gating.refresh(session, facility, methodology(), as_of=TODAY)

    assert facility.qc_status is QcStatus.EXPIRED
    assert not result.passes
