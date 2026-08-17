"""Account administration.

Two kinds of administrator reach this module:

- a **regional AMR administrator** — the platform's single overall authority —
  manages every account across the platform;
- a **facility administrator** manages accounts at their own facility and
  nowhere else.

Nobody else can create a user. A data steward or clinician holds no account
authority; widening that here — because it would be convenient — would quietly
hand out logins to a role the design keeps clear of them.

Four rules below are load-bearing and each has a test:

1. A facility administrator may only touch users at their own facility, and may
   only grant facility-scoped roles. Otherwise the smallest administrative role
   in the system could mint a system administrator.
2. Nobody may change their own role, scope or active flag. Self-service
   privilege changes remove the second pair of eyes that makes the audit trail
   worth reading.
3. The last active account able to manage users cannot be deactivated or
   demoted. Losing it means nobody can administer the platform without shell
   access to the database.
4. An administrator setting a password necessarily learns it, so the account is
   flagged to change it at next sign-in.
"""

import re
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from amrss import audit
from amrss.api.deps import CurrentPrincipal, DbSession, client_context
from amrss.audit import AuditAction
from amrss.models import AppUser, District, Facility, RegionalBlock
from amrss.models.enums import Role
from amrss.security.passwords import hash_password
from amrss.security.permissions import Permission, permissions_for
from amrss.security.scope import Principal, resolve_block_id

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


def _may_manage(principal: Principal, user: AppUser) -> bool:
    if principal.has(Permission.MANAGE_USERS):
        return True
    # Facility administrators reach exactly their own facility (rule 1).
    return principal.facility_id is not None and user.facility_id == principal.facility_id


def _assert_may_manage(principal: Principal, user: AppUser) -> None:
    if not _may_manage(principal, user):
        # 404 rather than 403: confirming that an account exists at another
        # facility is itself a disclosure.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user")


def _assert_may_grant(principal: Principal, role: Role) -> None:
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
    query = select(AppUser).order_by(AppUser.full_name)
    if principal.has(Permission.MANAGE_USERS):
        return query
    return query.where(AppUser.facility_id == principal.facility_id)


@router.get("", response_model=list[UserResponse])
def list_users(db: DbSession, principal: Principal = Depends(manages_users)) -> list[UserResponse]:
    return [
        _response(user, editable=_may_manage(principal, user))
        for user in db.scalars(_visible(db, principal))
    ]


class ScopeOption(BaseModel):
    id: uuid.UUID
    name: str


class UserScopeOptions(BaseModel):
    """What a caller may assign, so the console offers only what will be accepted."""

    roles: list[str]
    facilities: list[ScopeOption]
    blocks: list[ScopeOption]


@router.get("/options", response_model=UserScopeOptions)
def scope_options(db: DbSession, principal: Principal = Depends(manages_users)) -> UserScopeOptions:
    system_wide = principal.has(Permission.MANAGE_USERS)
    roles = [r for r in Role] if system_wide else sorted(FACILITY_GRANTABLE_ROLES, key=str)

    facility_query = select(Facility).order_by(Facility.name)
    if not system_wide:
        facility_query = facility_query.where(Facility.id == principal.facility_id)
    else:
        block_id = resolve_block_id(db, principal)
        if block_id is not None:
            facility_query = facility_query.join(District).where(
                District.regional_block_id == block_id
            )

    return UserScopeOptions(
        roles=[r.value for r in roles],
        facilities=[ScopeOption(id=f.id, name=f.name) for f in db.scalars(facility_query)],
        blocks=(
            [
                ScopeOption(id=b.id, name=b.name)
                for b in db.scalars(select(RegionalBlock).order_by(RegionalBlock.name))
            ]
            if system_wide
            else []
        ),
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
    _assert_may_manage(principal, user)

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

    if "role" in changes or "is_active" in changes:
        _assert_not_self(principal, user, "change the role or status of")

    if payload.role is not None:
        _assert_may_grant(principal, payload.role)
        _assert_not_last_user_admin(db, user, becoming=payload.role)

    if payload.is_active is False:
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
    _assert_may_manage(principal, user)

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
    _assert_may_manage(principal, user)

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
