"""The facility enrollment lifecycle (SDD 9.2).

A facility's status decides whether its data enters the verified regional
antibiogram, so these are not administrative niceties: an unguarded status field
is a route to publishing data from a laboratory nobody verified, and a
transition graph that quietly permits a shortcut is the same thing with extra
steps.
"""

from dataclasses import dataclass
from datetime import date

import pytest

from amrss.admin.enrollment import (
    ALLOWED_TRANSITIONS,
    ActivationBlockedError,
    TransitionNotAllowedError,
    apply_transition,
    can_transition,
    is_eligible_for_verified_aggregate,
    missing_for_activation,
)
from amrss.models.enums import FacilityStatus


@dataclass
class FakeFacility:
    """Stands in for the ORM row: these rules touch three fields and no session."""

    status: FacilityStatus = FacilityStatus.PENDING
    mou_signed_on: date | None = date(2026, 1, 15)
    whonet_config_version: str | None = "WHONET 2024 standard"


# ---- The transition graph --------------------------------------------------


def test_every_status_has_an_entry_in_the_graph():
    """A status missing from the table would raise a KeyError the first time a
    facility reached it — in production, during an administrative action."""
    assert set(ALLOWED_TRANSITIONS) == set(FacilityStatus)


def test_a_facility_cannot_go_live_without_being_verified_first():
    """The verification step is where the WHONET mapping, MOU and QC/EQA
    baseline are checked. Allowing PENDING → ACTIVE makes it skippable."""
    check = can_transition(FacilityStatus.PENDING, FacilityStatus.ACTIVE)

    assert not check.allowed
    assert "under_verification" in (check.reason or "")


def test_the_documented_happy_path_is_permitted_end_to_end():
    facility = FakeFacility()
    for target in (
        FacilityStatus.UNDER_VERIFICATION,
        FacilityStatus.ACTIVE,
        FacilityStatus.SUSPENDED,
        FacilityStatus.INACTIVE,
        FacilityStatus.RETIRED,
    ):
        apply_transition(facility, target)

    assert facility.status is FacilityStatus.RETIRED


def test_suspension_is_reversible():
    """A lapsed MOU or quality problem is usually fixed. Forcing re-enrollment
    would lose the facility's contribution history."""
    facility = FakeFacility(status=FacilityStatus.SUSPENDED)
    apply_transition(facility, FacilityStatus.ACTIVE)

    assert facility.status is FacilityStatus.ACTIVE


def test_retirement_is_terminal():
    """A laboratory that resumes reporting enrols afresh, so the break in
    contribution stays visible rather than being papered over."""
    facility = FakeFacility(status=FacilityStatus.RETIRED)

    assert ALLOWED_TRANSITIONS[FacilityStatus.RETIRED] == frozenset()
    with pytest.raises(TransitionNotAllowedError):
        apply_transition(facility, FacilityStatus.ACTIVE)


def test_a_terminal_status_says_so_rather_than_listing_nothing():
    check = can_transition(FacilityStatus.RETIRED, FacilityStatus.ACTIVE)

    assert not check.allowed
    assert "terminal" in (check.reason or "")


def test_transitioning_to_the_current_status_is_refused_not_silently_accepted():
    """A no-op that reports success would put a status-change entry in the audit
    trail for a change that never happened."""
    check = can_transition(FacilityStatus.ACTIVE, FacilityStatus.ACTIVE)

    assert not check.allowed
    assert "already" in (check.reason or "")


def test_a_refused_transition_names_what_is_permitted_instead():
    with pytest.raises(TransitionNotAllowedError) as exc:
        apply_transition(FakeFacility(status=FacilityStatus.ACTIVE), FacilityStatus.PENDING)

    assert "suspended" in str(exc.value)


def test_a_refused_transition_leaves_the_status_untouched():
    facility = FakeFacility(status=FacilityStatus.ACTIVE)
    with pytest.raises(TransitionNotAllowedError):
        apply_transition(facility, FacilityStatus.RETIRED)

    assert facility.status is FacilityStatus.ACTIVE


def test_apply_transition_returns_the_previous_status():
    """ "Changed to suspended" without "from active" is not an audit entry, it is
    a rumour."""
    facility = FakeFacility(status=FacilityStatus.ACTIVE)
    previous = apply_transition(facility, FacilityStatus.SUSPENDED)

    assert previous is FacilityStatus.ACTIVE
    assert facility.status is FacilityStatus.SUSPENDED


# ---- Activation requirements -----------------------------------------------


def test_activation_is_blocked_until_the_mou_is_recorded():
    facility = FakeFacility(status=FacilityStatus.UNDER_VERIFICATION, mou_signed_on=None)

    with pytest.raises(ActivationBlockedError) as exc:
        apply_transition(facility, FacilityStatus.ACTIVE)

    assert exc.value.missing == ["MOU execution date"]
    assert facility.status is FacilityStatus.UNDER_VERIFICATION


def test_activation_is_blocked_until_the_whonet_configuration_is_recorded():
    """Without it there is nothing to map the facility's local codes against,
    so its uploads would land in the stewardship queue rather than the
    antibiogram."""
    facility = FakeFacility(status=FacilityStatus.UNDER_VERIFICATION, whonet_config_version=None)

    with pytest.raises(ActivationBlockedError) as exc:
        apply_transition(facility, FacilityStatus.ACTIVE)

    assert exc.value.missing == ["WHONET configuration version"]


def test_every_missing_requirement_is_reported_at_once():
    facility = FakeFacility(
        status=FacilityStatus.UNDER_VERIFICATION,
        mou_signed_on=None,
        whonet_config_version=None,
    )

    assert len(missing_for_activation(facility)) == 2


def test_an_empty_string_counts_as_missing():
    """A blank WHONET version is a form submitted without the field filled in,
    not a configuration."""
    facility = FakeFacility(status=FacilityStatus.UNDER_VERIFICATION, whonet_config_version="")

    assert missing_for_activation(facility) == ["WHONET configuration version"]


def test_requirements_are_not_checked_on_transitions_other_than_activation():
    """Paperwork gates going live, not going dormant. A facility that has to be
    suspended must not be blocked because its MOU reference is missing."""
    facility = FakeFacility(
        status=FacilityStatus.ACTIVE, mou_signed_on=None, whonet_config_version=None
    )
    apply_transition(facility, FacilityStatus.SUSPENDED)

    assert facility.status is FacilityStatus.SUSPENDED


# ---- Eligibility -----------------------------------------------------------


def test_only_active_facilities_are_eligible_for_the_verified_aggregate():
    eligible = [s for s in FacilityStatus if is_eligible_for_verified_aggregate(s)]

    assert eligible == [FacilityStatus.ACTIVE]


def test_enrollment_eligibility_is_independent_of_the_quality_gate():
    """Two gates, deliberately separate (SDD 9.2 and 6.6): enrollment status is
    an administrative fact and quality status is a laboratory one. Collapsing
    them would make a suspended-but-QC-current facility indistinguishable from
    an active-but-EQA-lapsed one.
    """
    assert is_eligible_for_verified_aggregate(FacilityStatus.ACTIVE)
    assert not is_eligible_for_verified_aggregate(FacilityStatus.SUSPENDED)
