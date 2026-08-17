from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from pydantic import AliasChoices, BaseModel, Field
from sqlalchemy import func, or_, select

from amrss import audit
from amrss.api.deps import ClientContext, CurrentPrincipal, DbSession
from amrss.audit import AuditAction
from amrss.models import AppUser
from amrss.models.enums import Role
from amrss.security.passwords import hash_password, needs_rehash, verify_password
from amrss.security.tokens import (
    TokenError,
    create_access_token,
    create_refresh_token,
    decode_token,
)

router = APIRouter(prefix="/auth", tags=["authentication"])

MAX_FAILED_ATTEMPTS = 5
#: Kept in step with the administrative reset endpoint; see routers/users.py.
MIN_PASSWORD_LENGTH = 12
LOCKOUT_DURATION = timedelta(minutes=15)


class LoginRequest(BaseModel):
    #: A username or an email address. Accepted under either key so an older
    #: client that still posts ``email`` keeps working while the console posts
    #: ``identifier``.
    identifier: str = Field(
        validation_alias=AliasChoices("identifier", "email"),
        min_length=1,
        max_length=256,
    )
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class ProfileResponse(BaseModel):
    email: str
    username: str | None = None
    full_name: str
    role: Role
    facility_id: str | None
    regional_block_id: str | None
    permissions: list[str]
    #: True while the account is using a password an administrator set. The
    #: dashboard sends the user to change it; the flag is advisory to the
    #: client, and the reason it is not enforced server-side is that locking a
    #: user out of the change-password endpoint itself would be a deadlock.
    must_change_password: bool = False


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: DbSession, client: ClientContext) -> TokenResponse:
    ip, user_agent = client
    identifier = payload.identifier.strip().lower()
    # Either handle signs in. Both are stored lower-cased, so a lower-cased
    # comparison is exact rather than a scan, and username being null simply
    # never matches an email typed into the box.
    user = db.scalar(
        select(AppUser).where(
            or_(AppUser.email == identifier, func.lower(AppUser.username) == identifier)
        )
    )

    # One failure response for every cause. Distinguishing "no such account" from
    # "wrong password" turns the login form into an account-enumeration oracle.
    failure = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password"
    )

    def log_failure(reason: str) -> None:
        audit.record(
            db,
            action=AuditAction.LOGIN_FAILED,
            entity="app_user",
            entity_id=user.id if user else None,
            actor_label=identifier,
            source_ip=ip,
            user_agent=user_agent,
            note=reason,
        )
        db.commit()

    if user is None:
        log_failure("unknown account")
        raise failure

    now = datetime.now(UTC)
    if user.locked_until is not None and user.locked_until > now:
        log_failure("account locked")
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail="Account is temporarily locked. Try again later.",
        )

    if not verify_password(payload.password, user.password_hash):
        user.failed_login_count += 1
        if user.failed_login_count >= MAX_FAILED_ATTEMPTS:
            user.locked_until = now + LOCKOUT_DURATION
        log_failure("bad password")
        raise failure

    if not user.is_active:
        log_failure("inactive account")
        raise failure

    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(payload.password)

    user.failed_login_count = 0
    user.locked_until = None
    user.last_login_at = now

    audit.record(
        db,
        action=AuditAction.LOGIN_SUCCEEDED,
        entity="app_user",
        entity_id=user.id,
        actor_label=f"{user.full_name} <{user.email}>",
        source_ip=ip,
        user_agent=user_agent,
    )
    db.commit()

    return TokenResponse(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/refresh", response_model=TokenResponse)
def refresh(payload: RefreshRequest, db: DbSession) -> TokenResponse:
    try:
        user_id = decode_token(payload.refresh_token, "refresh")
    except TokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    user = db.get(AppUser, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account is inactive")

    return TokenResponse(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=256)


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: ChangePasswordRequest,
    db: DbSession,
    principal: CurrentPrincipal,
    client: ClientContext,
) -> None:
    """Change your own password.

    The current password is required even though the caller is already
    authenticated: a token can be lifted from a session left open, and without
    this check that is enough to take the account permanently.
    """
    user = db.get(AppUser, principal.user_id)
    if user is None:  # pragma: no cover - a token cannot outlive its user
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown account")

    ip, user_agent = client
    if not verify_password(payload.current_password, user.password_hash):
        audit.record(
            db,
            action=AuditAction.USER_UPDATED,
            entity="app_user",
            entity_id=user.id,
            principal=principal,
            source_ip=ip,
            user_agent=user_agent,
            note="Password change refused: current password incorrect",
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Current password is incorrect"
        )

    if payload.new_password == payload.current_password:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The new password must differ from the current one.",
        )

    user.password_hash = hash_password(payload.new_password)
    user.password_changed_at = datetime.now(UTC)
    # Whatever an administrator knew is now stale, so the account is the
    # owner's alone again.
    user.must_change_password = False

    audit.record(
        db,
        action=AuditAction.USER_UPDATED,
        entity="app_user",
        entity_id=user.id,
        principal=principal,
        after={"password_changed": True, "must_change_password": False},
        source_ip=ip,
        user_agent=user_agent,
        note="Password changed by its owner",
    )
    db.commit()


@router.get("/me", response_model=ProfileResponse)
def me(principal: CurrentPrincipal, db: DbSession) -> ProfileResponse:
    # Read from the row rather than the token: an administrator resetting a
    # password mid-session must take effect on the next request, not at token
    # expiry.
    user = db.get(AppUser, principal.user_id)
    return ProfileResponse(
        email=principal.email,
        username=user.username if user else None,
        full_name=principal.full_name,
        role=principal.role,
        facility_id=str(principal.facility_id) if principal.facility_id else None,
        regional_block_id=(
            str(principal.regional_block_id) if principal.regional_block_id else None
        ),
        permissions=sorted(p.value for p in principal.permissions),
        must_change_password=bool(user and user.must_change_password),
    )
