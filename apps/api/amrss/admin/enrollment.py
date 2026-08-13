"""The facility enrollment lifecycle (SDD 9.2).

Enrollment is a defined workflow, not an informal process, and the transition
rules are the part of it that matters: a facility's status decides whether its
data enters the verified regional antibiogram, so an unguarded status field is a
route to publishing data from a laboratory nobody has verified.

The graph is expressed as data and checked in one place, rather than as
scattered ``if status ==`` branches that each drift on their own schedule.
"""

from dataclasses import dataclass

from amrss.analytics.query import invalidate_record_cache
from amrss.models import Facility
from amrss.models.enums import FacilityStatus

#: Permitted transitions, as the SDD 9.2 lifecycle describes it:
#: Pending → Under Verification → Active → Suspended → Inactive → Retired.
#:
#: Three properties are deliberate:
#:
#: - **Suspension is reversible.** A lapsed MOU or a quality problem is usually
#:   fixed, and forcing re-enrollment would lose the facility's history.
#: - **Retirement is terminal.** A retired facility's data stays in the record
#:   (nothing is ever hard-deleted, SDD 9.6) but the facility itself does not come
#:   back; a laboratory that resumes reporting enrolls afresh, so that the break
#:   in contribution is visible rather than papered over.
#: - **Nothing reaches ACTIVE without passing through UNDER_VERIFICATION.** That
#:   step is where the WHONET configuration mapping, MOU and QC/EQA baseline are
#:   checked. Allowing PENDING → ACTIVE would make the check skippable by anyone
#:   in a hurry.
ALLOWED_TRANSITIONS: dict[FacilityStatus, frozenset[FacilityStatus]] = {
    FacilityStatus.PENDING: frozenset({FacilityStatus.UNDER_VERIFICATION, FacilityStatus.INACTIVE}),
    FacilityStatus.UNDER_VERIFICATION: frozenset(
        {FacilityStatus.ACTIVE, FacilityStatus.PENDING, FacilityStatus.INACTIVE}
    ),
    FacilityStatus.ACTIVE: frozenset({FacilityStatus.SUSPENDED, FacilityStatus.INACTIVE}),
    FacilityStatus.SUSPENDED: frozenset({FacilityStatus.ACTIVE, FacilityStatus.INACTIVE}),
    FacilityStatus.INACTIVE: frozenset({FacilityStatus.UNDER_VERIFICATION, FacilityStatus.RETIRED}),
    FacilityStatus.RETIRED: frozenset(),
}

#: Everything that must be on file before a facility can go live. Checked at the
#: transition rather than at enrollment, because these arrive at different times
#: and blocking enrollment on them would push facilities into being tracked in a
#: spreadsheet instead.
ACTIVATION_REQUIREMENTS = (
    ("mou_signed_on", "MOU execution date"),
    ("whonet_config_version", "WHONET configuration version"),
)


class TransitionNotAllowedError(ValueError):
    def __init__(self, current: FacilityStatus, target: FacilityStatus) -> None:
        permitted = sorted(s.value for s in ALLOWED_TRANSITIONS[current])
        super().__init__(
            f"A facility cannot move from {current.value} to {target.value}. "
            + (
                f"Permitted from {current.value}: {', '.join(permitted)}."
                if permitted
                else f"{current.value} is terminal."
            )
        )
        self.current = current
        self.target = target


class ActivationBlockedError(ValueError):
    """Activation was refused because the enrollment record is incomplete.

    Named separately from a rejected transition: the transition is legal, the
    paperwork is not done. The two need different responses from an
    administrator, and collapsing them into one error would hide which.
    """

    def __init__(self, missing: list[str]) -> None:
        super().__init__("Cannot activate: " + ", ".join(missing) + " must be recorded first.")
        self.missing = missing


@dataclass(frozen=True)
class TransitionCheck:
    allowed: bool
    reason: str | None = None


def can_transition(current: FacilityStatus, target: FacilityStatus) -> TransitionCheck:
    """Whether the lifecycle permits this move, ignoring paperwork."""
    if current is target:
        return TransitionCheck(False, f"The facility is already {current.value}.")
    if target in ALLOWED_TRANSITIONS[current]:
        return TransitionCheck(True)
    return TransitionCheck(False, str(TransitionNotAllowedError(current, target)))


def missing_for_activation(facility: Facility) -> list[str]:
    """Enrollment fields still outstanding before a facility may go live."""
    return [
        label
        for attribute, label in ACTIVATION_REQUIREMENTS
        if getattr(facility, attribute, None) in (None, "")
    ]


def apply_transition(facility: Facility, target: FacilityStatus) -> FacilityStatus:
    """Move a facility to ``target``, or refuse with a reason.

    Returns the previous status so the caller can record both sides in the audit
    trail — "changed to suspended" without "from active" is not an audit entry,
    it is a rumour.
    """
    current = facility.status
    check = can_transition(current, target)
    if not check.allowed:
        raise TransitionNotAllowedError(current, target)

    if target is FacilityStatus.ACTIVE:
        missing = missing_for_activation(facility)
        if missing:
            raise ActivationBlockedError(missing)

    facility.status = target
    # Only ACTIVE facilities feed the aggregates, so crossing that line changes
    # the eligible population as surely as an upload does.
    if FacilityStatus.ACTIVE in (current, target):
        invalidate_record_cache()
    return current


def is_eligible_for_verified_aggregate(status: FacilityStatus) -> bool:
    """Only ACTIVE facilities contribute to the verified regional antibiogram
    (SDD 9.2), and then only if the QC/EQA gate also passes (SDD 6.6).

    Two independent gates, deliberately kept separate: enrollment status is an
    administrative fact and quality status is a laboratory one, and a facility
    can fail either without failing the other.
    """
    return status is FacilityStatus.ACTIVE
