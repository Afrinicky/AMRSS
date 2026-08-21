"""Who may change a breakpoint, and whose table a facility reads.

The rule this module exists to hold is one sentence long and easy to get wrong
in four different places, so it is written once:

    Breakpoints are set nationally. A facility reads the national table unless
    the national authority has granted it an exception, and even then only an
    account with local editing authority *at that facility* may use it.

Three things have to be true at once for a local edit to be allowed, and they
are three different kinds of thing — a permission, a facility flag, and a
scope. Requiring all three is deliberate:

- the **permission** (``EDIT_LOCAL_BREAKPOINTS``) says the role is one that
  edits tables at all, which excludes laboratory staff and clinicians;
- the **grant** (``facility.breakpoint_override_granted``) says the national
  authority has agreed that *this* facility may depart from the national table;
- the **scope** says the account belongs to that facility, or holds authority
  over it.

Any two without the third is a hole. A facility administrator with the
permission but no grant would quietly fork the programme's definition of
resistance; a grant without the scope check would let one facility's
administrator edit another's exception.

The national authority is exempt from the grant, not from the audit: a
superadmin editing a facility's table is doing so as the person who defines the
table in the first place.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy.orm import Session

from amrss.models import Facility
from amrss.security.permissions import Permission
from amrss.security.scope import Principal


@dataclass(frozen=True)
class BreakpointAuthority:
    """What a principal may do to breakpoints, and — when it may not — why not.

    The reason is carried rather than reconstructed at the call site so the API
    can tell a facility administrator *"your facility reads the national table;
    ask the national programme for an override"* instead of a bare 403, which
    teaches nobody anything and generates a support ticket.
    """

    #: May publish the national table every facility reads by default.
    may_publish_national: bool
    #: May grant or revoke a facility's exception.
    may_grant_override: bool
    #: May edit the table in force for ``facility_id``.
    may_edit_locally: bool
    #: Which facility the local answer was computed for, if any.
    facility_id: uuid.UUID | None
    #: Why local editing is refused. Empty when it is allowed.
    refusal: str = ""


NATIONAL_REFUSAL = (
    "Breakpoints are set nationally. This facility reads the national table, "
    "which is what keeps one definition of resistance across the programme. A "
    "superadmin can grant this facility a local override if your laboratory "
    "needs to depart from it."
)


def authority(
    db: Session, principal: Principal, *, facility_id: uuid.UUID | None = None
) -> BreakpointAuthority:
    """Resolve what this principal may do, for the facility in question.

    ``facility_id`` defaults to the principal's own facility, which is the case
    that matters: a facility administrator asking whether it may edit *its*
    table. Passing one explicitly is how a regional or national account asks the
    same question about somebody else's.
    """
    target = facility_id if facility_id is not None else principal.facility_id

    if principal.is_national:
        return BreakpointAuthority(
            may_publish_national=True,
            may_grant_override=True,
            may_edit_locally=True,
            facility_id=target,
        )

    publish = principal.has(Permission.PUBLISH_NATIONAL_BREAKPOINTS)
    grant = principal.has(Permission.GRANT_BREAKPOINT_OVERRIDE)

    def refused(reason: str) -> BreakpointAuthority:
        return BreakpointAuthority(
            may_publish_national=publish,
            may_grant_override=grant,
            may_edit_locally=False,
            facility_id=target,
            refusal=reason,
        )

    if not principal.has(Permission.EDIT_LOCAL_BREAKPOINTS):
        return refused("This role does not edit breakpoint tables.")
    if target is None:
        return refused("Name the facility whose table you mean to edit.")
    if not principal.may_read_facility(target):
        # 'Unknown' rather than 'forbidden': see the 404 convention in users.py.
        return refused("Unknown facility.")

    facility = db.get(Facility, target)
    if facility is None:
        return refused("Unknown facility.")
    if not facility.breakpoint_override_granted:
        return refused(NATIONAL_REFUSAL)

    return BreakpointAuthority(
        may_publish_national=publish,
        may_grant_override=grant,
        may_edit_locally=True,
        facility_id=target,
    )
