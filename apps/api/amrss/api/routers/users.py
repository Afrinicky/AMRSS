"""Account administration.

Three kinds of administrator reach this module, and each reaches exactly as far
as its authority runs:

- a **superadmin** is national: every account on the platform, and the only role
  that can appoint another superadmin;
- a **regional AMR administrator** manages every account belonging to its own
  regional block — the block's own staff and every facility inside it — and
  cannot see another region's accounts at all;
- a **facility administrator** manages accounts at their own facility and
  nowhere else.

Nobody else can create a user. A data steward or clinician holds no account
authority; widening that here — because it would be convenient — would quietly
hand out logins to a role the design keeps clear of them.

Five rules below are load-bearing and each has a test:

1. An administrator reaches only the accounts inside its own scope, and may
   grant only roles it does not have to reach *upward* to name
   (``outranks_or_equals``). Both halves matter: without the first, a regional
   administrator reads the whole country's user list; without the second, it
   promotes itself to national by way of a colleague's account.
2. Nobody may change their own role, scope or active flag. Self-service
   privilege changes remove the second pair of eyes that makes the audit trail
   worth reading.
3. The last active account able to manage users cannot be deactivated or
   demoted. Losing it means nobody can administer the platform without shell
   access to the database.
4. An administrator setting a password necessarily learns it, so the account is
   flagged to change it at next sign-in.
5. Changing a role is its own endpoint (``POST /{id}/role``) as well as a field
   on the general update. Promoting a regional administrator to superadmin is
   not the same kind of act as fixing a typo in their surname, and it reads
   better in the audit trail — and in the console — when it is not buried in a
   form that submits six other fields alongside it.
"""

import re
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import Select, func, select
from sqlalchemy import false as sa_false
from sqlalchemy.orm import Session

from amrss import audit
from amrss.admin import purge
from amrss.api.deps import CurrentPrincipal, DbSession, client_context
from amrss.audit import AuditAction
from amrss.models import AppUser, District, Facility, RegionalBlock
from amrss.models.enums import Role
from amrss.security.passwords import hash_password
from amrss.security.permissions import Permission, outranks_or_equals, permissions_for
from amrss.security.scope import Principal, administers_users_of, resolve_block_id

router = APIRouter(prefix="/admin/users", tags=["administration"])

#: The shortest password the platform accepts. Length beats composition rules:
#: a twelve-character passphrase resists guessing better than eight characters
#: of enforced punctuation, and composition rules push people towards patterns.
MIN_PASSWORD_LENGTH = 12

#: What a username may contain. Kept deliberately narrow — letters, digits and a
#: few separators — so a username can never be mistaken for an email address at
#: the login form, and so it survives being typed by hand without surprises.
USERNAME_PATTERN = r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,62}[A-Za-z0-9])?$"


def _normalise_username(username: str | None) -> str | None:
    """Trim and lower-case a username, treating blank as absent.

    Stored lower-cased so that ``J.Mensah`` and ``j.mensah`` are the same login
    rather than two accounts a hair apart, matching how email is handled.
    """
    if username is None:
        return None
    cleaned = username.strip().lower()
    return cleaned or None


#: Roles a facility administrator may grant. Anything scoped above the facility
#: is out of reach — see rule 1.
FACILITY_GRANTABLE_ROLES = frozenset({Role.LABORATORY_STAFF, Role.FACILITY_ADMINISTRATOR})

#: Roles that require a facility, and roles that require a regional block. A
#: facility-scoped user without a facility sees nothing; a regional user without
#: a block sees every block. Both are configuration mistakes worth refusing.
FACILITY_SCOPED_ROLES = frozenset({Role.LABORATORY_STAFF, Role.FACILITY_ADMINISTRATOR})
BLOCK_SCOPED_ROLES = frozenset(
    {
        Role.DATA_STEWARD,
        Role.REGIONAL_AMR_ADMINISTRATOR,
        Role.CLINICIAN,
        Role.AUDITOR,
    }
)

#: Roles that may be created without any geography at all.
#:
#: Exactly one, and it is the point of the role: a national programme office is
#: not a laboratory and does not sit in one region. A superadmin *may* still be
#: given a facility or a block — many are seconded from one — and that is
#: recorded as their home rather than as a boundary, because scope resolution
#: reads ``Principal.is_national`` before it reads either field.
UNSCOPED_ROLES = frozenset({Role.SUPERADMIN})

USER_ADMIN_PERMISSIONS = (Permission.MANAGE_USERS, Permission.MANAGE_FACILITY_USERS)


def manages_users(principal: CurrentPrincipal) -> Principal:
    """Guard for this router.

    Either permission opens the page; what each one *reaches* is decided per
    request by ``_assert_may_manage``. A single ``requires`` could not express
    "system-wide or own-facility only".
    """
    if not any(principal.has(p) for p in USER_ADMIN_PERMISSIONS):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Requires permission: {Permission.MANAGE_USERS}",
        )
    return principal


class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    username: str | None
    full_name: str
    role: Role
    facility_id: uuid.UUID | None
    facility_name: str | None
    regional_block_id: uuid.UUID | None
    is_active: bool
    last_login_at: datetime | None
    #: True while the account is inside its lockout window. Distinct from
    #: inactive: a lockout is automatic and temporary, deactivation is a
    #: decision someone made.
    is_locked: bool
    must_change_password: bool
    permissions: list[str]
    #: What this caller may do to this user, so the console offers the actions
    #: that will succeed rather than teaching the rules by refusal.
    editable: bool


class UserCreate(BaseModel):
    email: EmailStr
    #: Optional. A login can be an email alone; a username is offered because a
    #: converted demo account, or a laboratory that shares one mailbox, is easier
    #: to sign in as a short name than a full address.
    username: str | None = Field(default=None, pattern=USERNAME_PATTERN)
    full_name: str = Field(min_length=1, max_length=256)
    role: Role
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=256)
    facility_id: uuid.UUID | None = None
    regional_block_id: uuid.UUID | None = None


class UserUpdate(BaseModel):
    """Everything an administrator may correct about an account except its
    password, which moves through /reset-password so the must-change flag is
    always set with it.

    Email and username are editable: converting the demo accounts a pilot runs
    on into real ones means changing the address they were seeded with, and a
    login nobody can change is a demo account forever. Every field here is
    optional and only touched when supplied (``exclude_unset``), so a form that
    submits one field cannot blank the rest."""

    email: EmailStr | None = None
    #: Explicitly nullable: sending ``""`` clears the username back to
    #: email-only login. ``None`` (field absent) leaves it untouched.
    username: str | None = Field(default=None)
    full_name: str | None = Field(default=None, min_length=1, max_length=256)
    role: Role | None = None
    facility_id: uuid.UUID | None = None
    regional_block_id: uuid.UUID | None = None
    is_active: bool | None = None


class PasswordReset(BaseModel):
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=256)


def _response(user: AppUser, *, editable: bool) -> UserResponse:
    now = datetime.now(UTC)
    return UserResponse(
        id=user.id,
        email=user.email,
        username=user.username,
        full_name=user.full_name,
        role=user.role,
        facility_id=user.facility_id,
        facility_name=user.facility.name if user.facility_id and user.facility else None,
        regional_block_id=user.regional_block_id,
        is_active=user.is_active,
        last_login_at=user.last_login_at,
        is_locked=user.locked_until is not None and user.locked_until > now,
        must_change_password=user.must_change_password,
        permissions=sorted(p.value for p in permissions_for(user.role)),
        editable=editable,
    )


def _may_manage(db: Session, principal: Principal, user: AppUser) -> bool:
    """Rule 1, first half: is this account inside the caller's reach?

    Three answers, one per level of authority. The middle one is the one that
    used to be missing — ``MANAGE_USERS`` alone was read as "every account
    anywhere", which silently made every regional administrator a national one.
    """
    breadth, boundary = administers_users_of(db, principal)
    if breadth == "national":
        return True
    if breadth == "block":
        return boundary is not None and _block_of(db, user) == boundary
    if breadth == "facility":
        return user.facility_id is not None and user.facility_id == boundary
    return False


def _block_of(db: Session, user: AppUser) -> uuid.UUID | None:
    """Which block an account belongs to, whether it says so or reaches it
    through a facility.

    A facility-scoped user carries no block of its own by design (see
    ``_resolve_scope``), so asking only ``user.regional_block_id`` would put
    every laboratory account outside every regional administrator's reach —
    which is the opposite of the intent.
    """
    if user.regional_block_id is not None:
        return user.regional_block_id
    if user.facility_id is None:
        return None
    return db.scalar(
        select(District.regional_block_id)
        .join(Facility, Facility.district_id == District.id)
        .where(Facility.id == user.facility_id)
    )


def _assert_may_manage(db: Session, principal: Principal, user: AppUser) -> None:
    if not _may_manage(db, principal, user):
        # 404 rather than 403: confirming that an account exists at another
        # facility is itself a disclosure.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user")


def _assert_may_grant(principal: Principal, role: Role) -> None:
    """Rule 1, second half: is this role one the caller may hand out?

    Precedence first, because it is the rule that stops privilege climbing: an
    administrator may grant a role no higher than its own, so a regional
    administrator cannot appoint a superadmin — not for a colleague, and (with
    rule 2) not for itself. Equality is allowed, so each authority can appoint
    its own successor.

    A facility administrator is then narrowed further to the two facility roles.
    Precedence alone would let it grant a data steward, which is not higher than
    a facility administrator but is not a facility role either.
    """
    if not outranks_or_equals(principal.role, role):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"A {principal.role.value} cannot grant the role {role.value}, "
                "which carries authority above its own."
            ),
        )
    if principal.has(Permission.MANAGE_USERS):
        return
    if role not in FACILITY_GRANTABLE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"A facility administrator may grant only "
                f"{', '.join(sorted(r.value for r in FACILITY_GRANTABLE_ROLES))}."
            ),
        )


def _assert_not_self(principal: Principal, user: AppUser, action: str) -> None:
    """Rule 2.

    Self-service role changes are how an account quietly becomes something it
    was not approved to be, and how an administrator locks themselves out by
    accident. Both need someone else in the loop.
    """
    if user.id == principal.user_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"You cannot {action} your own account. Ask another administrator.",
        )


def _resolve_scope(
    db: Session,
    principal: Principal,
    role: Role,
    facility_id: uuid.UUID | None,
    regional_block_id: uuid.UUID | None,
) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    """Validate and normalise a user's scope for their role.

    A facility administrator's users always land at that administrator's own
    facility, whatever the request said.
    """
    if not principal.has(Permission.MANAGE_USERS):
        facility_id = principal.facility_id
        regional_block_id = None
    elif not principal.is_national:
        # A regional administrator creates accounts in its own block, whatever
        # the request named. Without this, the block field is a free-text way
        # out of one's own region.
        own_block = resolve_block_id(db, principal)
        if own_block is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "Your account is not attached to a regional block, so there "
                    "is no scope to create accounts in. Ask a superadmin to set "
                    "your block."
                ),
            )
        if role in BLOCK_SCOPED_ROLES:
            regional_block_id = own_block
        elif role in FACILITY_SCOPED_ROLES and facility_id is not None:
            _assert_facility_in_block(db, facility_id, own_block)

    if role in UNSCOPED_ROLES:
        # The national role. A facility or a block may be recorded — it is where
        # the person sits, and the console shows it — but neither is required
        # and neither bounds them. Both are validated if given, so a typo does
        # not leave a dangling reference.
        if facility_id is not None and db.get(Facility, facility_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown facility")
        if regional_block_id is not None and db.get(RegionalBlock, regional_block_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown block")
        return facility_id, regional_block_id

    if role in FACILITY_SCOPED_ROLES:
        if facility_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Role {role.value} is facility-scoped and needs a facility.",
            )
        if db.get(Facility, facility_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown facility")
        # A facility-scoped user inherits its block from the facility, so a
        # facility moving district can never leave the user pointing at the
        # wrong one (see security.scope.resolve_block_id).
        return facility_id, None

    if role in BLOCK_SCOPED_ROLES:
        if regional_block_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Role {role.value} is scoped to a regional block and needs one.",
            )
        if db.get(RegionalBlock, regional_block_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown block")
        return None, regional_block_id

    # No unscoped role remains; every role is either facility- or block-scoped.
    # Kept as a safe default rather than an assertion so a future unscoped role
    # lands somewhere sensible instead of raising.
    return None, None


def _assert_facility_in_block(db: Session, facility_id: uuid.UUID, block_id: uuid.UUID) -> None:
    resolved = db.scalar(
        select(District.regional_block_id)
        .join(Facility, Facility.district_id == District.id)
        .where(Facility.id == facility_id)
    )
    if resolved != block_id:
        # 404 for the same reason as everywhere else here: another region's
        # facilities are not a list this administrator gets to probe.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown facility")


def _assert_email_free(db: Session, email: str, *, exclude_id: uuid.UUID | None = None) -> None:
    query = select(AppUser).where(AppUser.email == email)
    if exclude_id is not None:
        query = query.where(AppUser.id != exclude_id)
    if db.scalar(query):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An account with email {email} already exists.",
        )


def _assert_username_free(
    db: Session, username: str, *, exclude_id: uuid.UUID | None = None
) -> None:
    query = select(AppUser).where(AppUser.username == username)
    if exclude_id is not None:
        query = query.where(AppUser.id != exclude_id)
    if db.scalar(query):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An account with username {username!r} already exists.",
        )


def _assert_not_last_user_admin(
    db: Session, user: AppUser, *, becoming: Role | None = None, deactivating: bool = False
) -> None:
    """Rule 3.

    Counting active accounts that can still manage users after this change. If
    the answer is zero, the platform can only be administered by someone with
    shell access to its database — which is a recovery procedure, not an
    operating model.
    """
    keeps_authority = not deactivating and any(
        p in permissions_for(becoming or user.role) for p in USER_ADMIN_PERMISSIONS
    )
    if keeps_authority:
        return
    if not any(p in permissions_for(user.role) for p in USER_ADMIN_PERMISSIONS):
        return  # This account never had the authority; nothing is being lost.

    remaining = db.scalar(
        select(func.count(AppUser.id)).where(
            AppUser.is_active.is_(True),
            AppUser.id != user.id,
            AppUser.role.in_(
                [
                    role
                    for role in Role
                    if any(p in permissions_for(role) for p in USER_ADMIN_PERMISSIONS)
                ]
            ),
        )
    )
    if not remaining:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This is the only active account that can manage users. Create "
                "or activate another one first, or the platform can only be "
                "administered from the database."
            ),
        )


def _visible(db: Session, principal: Principal) -> Select[tuple[AppUser]]:
    """The accounts this administrator may list.

    Mirrors ``_may_manage`` exactly. Listing an account the caller then cannot
    act on is how a console ends up teaching its rules by refusal, and listing
    one it should not know exists is a disclosure in its own right — a regional
    administrator learning the names of another region's staff.
    """
    query = select(AppUser).order_by(AppUser.full_name)
    breadth, boundary = administers_users_of(db, principal)

    if breadth == "national":
        return query
    if breadth == "facility":
        return query.where(AppUser.facility_id == boundary)
    if breadth == "block" and boundary is not None:
        # Either the account names the block itself, or it sits at a facility
        # inside it. Both are "in the block"; only the first says so directly.
        in_block_facilities = (
            select(Facility.id)
            .join(District, District.id == Facility.district_id)
            .where(District.regional_block_id == boundary)
        )
        return query.where(
            (AppUser.regional_block_id == boundary) | AppUser.facility_id.in_(in_block_facilities)
        )
    # No account authority at all, or a block-scoped administrator with no block
    # resolved. Nothing, rather than everything.
    return query.where(sa_false())


@router.get("", response_model=list[UserResponse])
def list_users(db: DbSession, principal: Principal = Depends(manages_users)) -> list[UserResponse]:
    return [
        _response(user, editable=_may_manage(db, principal, user))
        for user in db.scalars(_visible(db, principal))
    ]


class ScopeOption(BaseModel):
    id: uuid.UUID
    name: str


class RoleOption(BaseModel):
    """One assignable role, described well enough to be chosen from.

    A bare enum value is a poor thing to put in front of somebody deciding who
    gets national authority. The console renders the label and the description;
    ``scope`` tells it which of the facility / block selectors to show, so the
    form asks for a facility for a laboratory account and for nothing at all for
    a superadmin.
    """

    value: str
    label: str
    description: str
    #: "facility", "block" or "optional" — what geography this role needs.
    scope: str


class UserScopeOptions(BaseModel):
    """What a caller may assign, so the console offers only what will be accepted."""

    roles: list[RoleOption]
    facilities: list[ScopeOption]
    blocks: list[ScopeOption]
    #: The caller's own role, so a console can explain why the list stops where
    #: it does rather than simply appearing short.
    granting_as: str


ROLE_LABELS: dict[Role, tuple[str, str]] = {
    Role.SUPERADMIN: (
        "Superadmin",
        "National authority over the whole programme. Creates regional blocks, "
        "publishes the breakpoint table every facility interprets against, and "
        "administers every account. Need not belong to any facility or region.",
    ),
    Role.REGIONAL_AMR_ADMINISTRATOR: (
        "Regional AMR administrator",
        "Overall authority within one regional block: enrols its facilities, "
        "reviews its uploads, and administers its accounts. Sees nothing "
        "outside its own region.",
    ),
    Role.DATA_STEWARD: (
        "Data steward",
        "Reviews and retracts batches, curates the dictionary, approves code "
        "mappings and sets quality gating across the block.",
    ),
    Role.FACILITY_ADMINISTRATOR: (
        "Facility administrator",
        "Manages the accounts at one laboratory, and — where the superadmin has "
        "granted an override — that laboratory's local breakpoints.",
    ),
    Role.LABORATORY_STAFF: (
        "Laboratory staff",
        "Uploads results and attests quality control for one laboratory.",
    ),
    Role.CLINICIAN: (
        "Clinician",
        "Reads the regional antibiogram and empiric guidance. No administrative "
        "authority and no access to identifiers.",
    ),
    Role.AUDITOR: (
        "Auditor",
        "Reads the audit trail and nothing else, so accountability stays "
        "independent of the administration it examines.",
    ),
}


def _role_option(role: Role) -> RoleOption:
    label, description = ROLE_LABELS.get(role, (role.value.replace("_", " ").title(), ""))
    scope = (
        "optional"
        if role in UNSCOPED_ROLES
        else "facility"
        if role in FACILITY_SCOPED_ROLES
        else "block"
        if role in BLOCK_SCOPED_ROLES
        else "optional"
    )
    return RoleOption(value=role.value, label=label, description=description, scope=scope)


def _grantable_roles(principal: Principal) -> list[Role]:
    """Every role this caller could hand out, by the same rules ``_assert_may_grant``
    enforces. Offering one the API would refuse is how a console teaches its
    rules by refusal instead of by its own shape."""
    if principal.has(Permission.MANAGE_USERS):
        candidates = list(Role)
    else:
        candidates = sorted(FACILITY_GRANTABLE_ROLES, key=lambda r: r.value)
    return [role for role in candidates if outranks_or_equals(principal.role, role)]


@router.get("/options", response_model=UserScopeOptions)
def scope_options(db: DbSession, principal: Principal = Depends(manages_users)) -> UserScopeOptions:
    system_wide = principal.has(Permission.MANAGE_USERS)

    facility_query = select(Facility).order_by(Facility.name)
    if not system_wide:
        facility_query = facility_query.where(Facility.id == principal.facility_id)
    else:
        block_id = resolve_block_id(db, principal)
        if block_id is not None:
            facility_query = facility_query.join(District).where(
                District.regional_block_id == block_id
            )

    # A regional administrator sees only its own block here, for the same reason
    # it sees only its own block's facilities: the selector is a list of things
    # it may act on, not a directory of the country.
    block_query = select(RegionalBlock).order_by(RegionalBlock.name)
    own_block = resolve_block_id(db, principal)
    if own_block is not None:
        block_query = block_query.where(RegionalBlock.id == own_block)

    return UserScopeOptions(
        roles=[_role_option(role) for role in _grantable_roles(principal)],
        facilities=[ScopeOption(id=f.id, name=f.name) for f in db.scalars(facility_query)],
        blocks=(
            [ScopeOption(id=b.id, name=b.name) for b in db.scalars(block_query)]
            if system_wide
            else []
        ),
        granting_as=principal.role.value,
    )


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    request: Request,
    db: DbSession,
    payload: UserCreate,
    principal: Principal = Depends(manages_users),
) -> UserResponse:
    email = payload.email.strip().lower()
    _assert_email_free(db, email)

    username = _normalise_username(payload.username)
    if username is not None:
        _assert_username_free(db, username)

    _assert_may_grant(principal, payload.role)
    facility_id, block_id = _resolve_scope(
        db, principal, payload.role, payload.facility_id, payload.regional_block_id
    )

    user = AppUser(
        email=email,
        username=username,
        full_name=payload.full_name.strip(),
        password_hash=hash_password(payload.password),
        role=payload.role,
        facility_id=facility_id,
        regional_block_id=block_id,
        is_active=True,
        # Rule 4: whoever typed this password knows it.
        must_change_password=True,
        password_changed_at=datetime.now(UTC),
    )
    db.add(user)
    db.flush()

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.USER_CREATED,
        entity="app_user",
        entity_id=user.id,
        principal=principal,
        after={"email": user.email, "role": user.role.value},
        source_ip=ip,
        user_agent=agent,
    )
    db.commit()
    db.refresh(user)
    return _response(user, editable=True)


@router.patch("/{user_id}", response_model=UserResponse)
def update_user(
    request: Request,
    db: DbSession,
    user_id: uuid.UUID,
    payload: UserUpdate,
    principal: Principal = Depends(manages_users),
) -> UserResponse:
    user = db.get(AppUser, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user")
    _assert_may_manage(db, principal, user)

    changes = payload.model_dump(exclude_unset=True)
    before = {
        "email": user.email,
        "username": user.username,
        "role": user.role.value,
        "is_active": user.is_active,
        "facility_id": str(user.facility_id) if user.facility_id else None,
        "regional_block_id": str(user.regional_block_id) if user.regional_block_id else None,
        "full_name": user.full_name,
    }

    # Only an actual change is a self-edit worth refusing. A form that resubmits
    # the account's current role unchanged — which is what editing your own name
    # or email does, since the role control is shown read-only — must not trip
    # the guard, or an administrator can never correct their own details.
    role_changing = payload.role is not None and payload.role != user.role
    active_changing = payload.is_active is not None and payload.is_active != user.is_active
    if role_changing or active_changing:
        _assert_not_self(principal, user, "change the role or status of")

    if payload.role is not None and payload.role != user.role:
        _assert_may_grant(principal, payload.role)
        # Also the role being left. Reach says which *accounts* are in range;
        # this says which *roles* are, so a facility administrator cannot demote
        # a superadmin who happens to be posted to its facility.
        _assert_may_grant(principal, user.role)
        _assert_not_last_user_admin(db, user, becoming=payload.role)

    if payload.is_active is False and active_changing:
        # Deactivating an account is a way of removing its authority, so the
        # same precedence rule applies: a regional administrator cannot switch
        # off the national one.
        _assert_may_grant(principal, user.role)
        _assert_not_last_user_admin(db, user, deactivating=True)

    if payload.email is not None:
        email = payload.email.strip().lower()
        _assert_email_free(db, email, exclude_id=user.id)
        user.email = email

    if "username" in changes:
        # Empty string clears the username to email-only login; a non-empty one
        # is validated against the pattern here rather than on the field, so
        # that clearing (an intentionally empty value) is still accepted.
        username = _normalise_username(payload.username)
        if username is not None:
            if not re.match(USERNAME_PATTERN, username):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=(
                        "A username may use letters, digits, dot, hyphen and "
                        "underscore, and must start and end with a letter or digit."
                    ),
                )
            _assert_username_free(db, username, exclude_id=user.id)
        user.username = username

    if payload.full_name is not None:
        user.full_name = payload.full_name.strip()

    if payload.role is not None or "facility_id" in changes or "regional_block_id" in changes:
        role = payload.role or user.role
        facility_id, block_id = _resolve_scope(
            db,
            principal,
            role,
            changes.get("facility_id", user.facility_id),
            changes.get("regional_block_id", user.regional_block_id),
        )
        user.role = role
        user.facility_id = facility_id
        user.regional_block_id = block_id

    if payload.is_active is not None:
        user.is_active = payload.is_active
        if payload.is_active:
            # Reactivating clears a stale lockout; otherwise the account is
            # active and still cannot sign in, with nothing saying why.
            user.locked_until = None
            user.failed_login_count = 0

    ip, agent = client_context(request)
    audit.record(
        db,
        action=(
            AuditAction.USER_DEACTIVATED
            if payload.is_active is False
            else AuditAction.PERMISSION_CHANGED
            if payload.role is not None
            else AuditAction.USER_UPDATED
        ),
        entity="app_user",
        entity_id=user.id,
        principal=principal,
        before=before,
        after={
            "email": user.email,
            "username": user.username,
            "role": user.role.value,
            "is_active": user.is_active,
            "facility_id": str(user.facility_id) if user.facility_id else None,
            "regional_block_id": str(user.regional_block_id) if user.regional_block_id else None,
            "full_name": user.full_name,
        },
        source_ip=ip,
        user_agent=agent,
    )
    db.commit()
    db.refresh(user)
    return _response(user, editable=True)


class RoleChange(BaseModel):
    """A role change, and nothing else.

    ``facility_id`` and ``regional_block_id`` are here because a role change
    usually *is* a scope change — promoting a regional administrator to
    superadmin releases them from their block; moving a data steward to a
    facility administrator gives them one. Leaving them out would force a second
    call, between which the account sits in a role its scope does not fit.
    """

    role: Role
    facility_id: uuid.UUID | None = None
    regional_block_id: uuid.UUID | None = None
    #: Why. Optional, recorded in the audit trail. A promotion to national
    #: authority with a sentence attached is a great deal easier to review a
    #: year later than one without.
    reason: str = Field(default="", max_length=512)


@router.post("/{user_id}/role", response_model=UserResponse)
def change_role(
    request: Request,
    db: DbSession,
    user_id: uuid.UUID,
    payload: RoleChange,
    principal: Principal = Depends(manages_users),
) -> UserResponse:
    """Move an account to a different role.

    Reachable through ``PATCH`` as well, and deliberately duplicated here. What
    a role change *is* differs in kind from the other things that endpoint does:
    turning a regional administrator into a superadmin hands one person national
    authority over every region in the programme, and it should not be something
    that happens because a form resubmitted a select box along with a corrected
    surname.

    Every guard the general update applies still applies, in the same order:
    reach (rule 1a), precedence (rule 1b), not-yourself (rule 2), and not the
    last administrator (rule 3).
    """
    user = db.get(AppUser, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user")
    _assert_may_manage(db, principal, user)

    unchanged = (
        payload.role == user.role
        and payload.facility_id is None
        and payload.regional_block_id is None
    )
    if unchanged:
        # Not an error — the console can submit the form unchanged — but there is
        # nothing to audit, so say so rather than writing a no-op entry.
        return _response(user, editable=True)

    _assert_not_self(principal, user, "change the role of")
    _assert_may_grant(principal, payload.role)
    # The account being demoted *out* of an administrative role must not be the
    # last one holding it, and the caller must be allowed to reach the role it
    # currently holds — otherwise a facility administrator could demote a
    # superadmin who happened to be posted to its facility.
    _assert_may_grant(principal, user.role)
    _assert_not_last_user_admin(db, user, becoming=payload.role)

    before = {
        "role": user.role.value,
        "facility_id": str(user.facility_id) if user.facility_id else None,
        "regional_block_id": str(user.regional_block_id) if user.regional_block_id else None,
    }

    facility_id, block_id = _resolve_scope(
        db,
        principal,
        payload.role,
        payload.facility_id if payload.facility_id is not None else user.facility_id,
        (
            payload.regional_block_id
            if payload.regional_block_id is not None
            else user.regional_block_id
        ),
    )
    user.role = payload.role
    user.facility_id = facility_id
    user.regional_block_id = block_id

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.PERMISSION_CHANGED,
        entity="app_user",
        entity_id=user.id,
        principal=principal,
        before=before,
        after={
            "role": user.role.value,
            "facility_id": str(user.facility_id) if user.facility_id else None,
            "regional_block_id": str(user.regional_block_id) if user.regional_block_id else None,
            "reason": payload.reason or None,
        },
        source_ip=ip,
        user_agent=agent,
        note=(
            f"{user.email}: {before['role']} → {user.role.value}"
            + (f" ({payload.reason})" if payload.reason else "")
        ),
    )
    db.commit()
    db.refresh(user)
    return _response(user, editable=True)


@router.post("/{user_id}/reset-password", response_model=UserResponse)
def reset_password(
    request: Request,
    db: DbSession,
    user_id: uuid.UUID,
    payload: PasswordReset,
    principal: Principal = Depends(manages_users),
) -> UserResponse:
    """Set a password on someone else's behalf.

    There is no self-service reset by email in this system, so this is the
    recovery path — and it is also the one action here that hands a live
    credential to a second person. The account is flagged to change it at next
    sign-in, and the reset is audited. Deliver the password out of band.
    """
    user = db.get(AppUser, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user")
    _assert_may_manage(db, principal, user)

    user.password_hash = hash_password(payload.password)
    user.password_changed_at = datetime.now(UTC)
    user.must_change_password = True
    # A reset is also the answer to "locked out and cannot wait".
    user.locked_until = None
    user.failed_login_count = 0

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.USER_UPDATED,
        entity="app_user",
        entity_id=user.id,
        principal=principal,
        after={"password_reset": True, "must_change_password": True},
        source_ip=ip,
        user_agent=agent,
        note="Password reset by an administrator",
    )
    db.commit()
    db.refresh(user)
    return _response(user, editable=True)


@router.post("/{user_id}/unlock", response_model=UserResponse)
def unlock(
    request: Request,
    db: DbSession,
    user_id: uuid.UUID,
    principal: Principal = Depends(manages_users),
) -> UserResponse:
    """Clear an automatic lockout without touching the password.

    Separate from a reset because the causes differ. Someone who mistyped their
    password five times still knows it; forcing a reset there would hand their
    credential to an administrator for no reason.
    """
    user = db.get(AppUser, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user")
    _assert_may_manage(db, principal, user)

    user.locked_until = None
    user.failed_login_count = 0

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.USER_UPDATED,
        entity="app_user",
        entity_id=user.id,
        principal=principal,
        after={"unlocked": True},
        source_ip=ip,
        user_agent=agent,
        note="Lockout cleared by an administrator",
    )
    db.commit()
    db.refresh(user)
    return _response(user, editable=True)


class UserDeletion(BaseModel):
    #: Must equal the account's email or username. Deleting the wrong account is
    #: the failure worth a keystroke to prevent.
    confirm: str = Field(min_length=1, max_length=256)


@router.post("/{user_id}/delete", status_code=status.HTTP_200_OK)
def delete_user(
    request: Request,
    db: DbSession,
    user_id: uuid.UUID,
    payload: UserDeletion,
    principal: Principal = Depends(manages_users),
) -> dict[str, object]:
    """Delete a user account outright.

    Deactivation keeps the account and its ability to be reactivated; this removes
    it. The same guards as deactivation apply — you cannot delete yourself, and
    you cannot delete the last account able to manage users — plus a typed
    confirmation. The audit trail is preserved: the account stays named in every
    entry it produced, only the live login is gone.
    """
    user = db.get(AppUser, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user")
    _assert_may_manage(db, principal, user)
    _assert_not_self(principal, user, "delete")
    _assert_may_grant(principal, user.role)
    _assert_not_last_user_admin(db, user, deactivating=True)

    confirm = payload.confirm.strip().lower()
    if confirm != user.email.lower() and confirm != (user.username or "").lower():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Type the account's email ({user.email}) or username to confirm deletion.",
        )

    before = {"email": user.email, "username": user.username, "role": user.role.value}
    counts = purge.summarise(purge.delete_user(db, user))

    ip, agent = client_context(request)
    audit.record(
        db,
        action=AuditAction.USER_DELETED,
        entity="app_user",
        entity_id=user_id,
        principal=principal,
        before=before,
        after={"deleted_rows": counts},
        source_ip=ip,
        user_agent=agent,
        note=f"Account {before['email']} deleted",
    )
    db.commit()
    return {"deleted": counts, "message": f"{before['email']} deleted."}
