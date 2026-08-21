"""Data scope resolution.

Separate from permissions on purpose. A permission answers *may this user do
this kind of thing*; a scope answers *over which facilities, and at what level of
detail*. Both are enforced server-side. Two users with identical permissions can
legitimately see different data, and conflating the two questions is how
cross-facility leakage happens.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from amrss.models import AppUser, District, Facility
from amrss.models.enums import Role
from amrss.security.permissions import Permission, permissions_for


@dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    email: str
    full_name: str
    role: Role
    facility_id: uuid.UUID | None
    regional_block_id: uuid.UUID | None

    @property
    def permissions(self) -> frozenset[Permission]:
        return permissions_for(self.role)

    def has(self, permission: Permission) -> bool:
        return permission in self.permissions

    @property
    def is_national(self) -> bool:
        """Whether this principal's authority is unbounded by geography.

        The superadmin may hold a facility and a block — a national programme
        officer is often seconded from somewhere — and those are recorded as
        their *home*, not as their limit. Every scope decision below asks this
        first, so a national account posted to a facility does not silently
        become a facility account.
        """
        return self.role is Role.SUPERADMIN

    @property
    def home_facility_id(self) -> uuid.UUID | None:
        """The facility whose data this principal is confined to, if any.

        ``facility_id`` says where the account sits; this says where it is
        *bounded*. They differ for exactly one role, and conflating them is what
        would put a national account inside one laboratory.
        """
        return None if self.is_national else self.facility_id

    @property
    def label(self) -> str:
        return f"{self.full_name} <{self.email}>"

    def sees_unsuppressed(self, facility_id: uuid.UUID | None) -> bool:
        """A facility always sees its own full, un-suppressed data (SDD 3.2).

        Small-cell suppression exists to stop a cross-facility viewer inferring
        individuals from thin cells. It is not a secret kept from the facility
        that generated the record, which holds the identifiable source data
        anyway.
        """
        return facility_id is not None and facility_id == self.facility_id

    def may_read_facility(self, facility_id: uuid.UUID) -> bool:
        if self.is_national:
            return True
        if self.facility_id is not None:
            return facility_id == self.facility_id
        return self.has(Permission.VIEW_CROSS_FACILITY) or self.has(Permission.VIEW_REGIONAL)


def principal_from_user(user: AppUser) -> Principal:
    return Principal(
        user_id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        facility_id=user.facility_id,
        regional_block_id=user.regional_block_id,
    )


def resolve_block_id(db: Session, principal: Principal) -> uuid.UUID | None:
    """The regional block a principal's queries are scoped to.

    Facility-scoped users inherit their facility's block rather than carrying it
    redundantly, so a facility moving district can never leave a user pointing at
    the wrong block.
    """
    # National authority is not scoped to a block even when it belongs to one:
    # ``None`` here means "every block", which is precisely the intent.
    if principal.is_national:
        return None
    if principal.regional_block_id is not None:
        return principal.regional_block_id
    if principal.facility_id is None:
        return None
    return db.scalar(
        select(District.regional_block_id)
        .join(Facility, Facility.district_id == District.id)
        .where(Facility.id == principal.facility_id)
    )


def visible_facility_ids(db: Session, principal: Principal) -> list[uuid.UUID] | None:
    """Facilities this principal may read.

    ``None`` means unrestricted across the resolved block, which callers must
    still combine with a block filter. An empty list means genuinely nothing, and
    is distinct from ``None`` — treating the two alike would turn a
    correctly-empty scope into full access.
    """
    if principal.is_national:
        return None
    if principal.facility_id is not None:
        return [principal.facility_id]
    if not (
        principal.has(Permission.VIEW_REGIONAL) or principal.has(Permission.VIEW_CROSS_FACILITY)
    ):
        return []
    return None


def administers_users_of(db: Session, principal: Principal) -> tuple[str, uuid.UUID | None]:
    """How far this principal's account administration reaches.

    Returns the breadth and the boundary it is measured against:

    - ``("national", None)`` — every account on the platform.
    - ``("block", block_id)`` — every account belonging to that block, whether
      it sits at the block itself or at one of its facilities.
    - ``("facility", facility_id)`` — that facility's accounts and no others.
    - ``("none", None)`` — no account authority at all.

    The middle case is the one that used to be missing. ``MANAGE_USERS`` was
    read as "every account anywhere", which made a regional administrator a
    national one the moment it opened the user list. The permission still says
    *may administer accounts*; this says *whose*.
    """
    if principal.is_national:
        return "national", None
    if principal.has(Permission.MANAGE_USERS):
        return "block", resolve_block_id(db, principal)
    if principal.has(Permission.MANAGE_FACILITY_USERS) and principal.facility_id is not None:
        return "facility", principal.facility_id
    return "none", None
