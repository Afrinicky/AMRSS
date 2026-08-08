from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select

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
LOCKOUT_DURATION = timedelta(minutes=15)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class ProfileResponse(BaseModel):
    email: str
    full_name: str
    role: Role
    facility_id: str | None
    regional_block_id: str | None
    permissions: list[str]


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: DbSession, client: ClientContext) -> TokenResponse:
    ip, user_agent = client
    user = db.scalar(select(AppUser).where(AppUser.email == payload.email.lower()))

    # One failure response for every cause. Distinguishing "no such account" from
    # "wrong password" turns the login form into an account-enumeration oracle.
    failure = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password"
    )

    def log_failure(reason: str) -> None:
        audit.record(
            db,
            action=AuditAction.LOGIN_FAILED,
            entity="app_user",
            entity_id=user.id if user else None,
            actor_label=payload.email,
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


@router.get("/me", response_model=ProfileResponse)
def me(principal: CurrentPrincipal) -> ProfileResponse:
    return ProfileResponse(
        email=principal.email,
        full_name=principal.full_name,
        role=principal.role,
        facility_id=str(principal.facility_id) if principal.facility_id else None,
        regional_block_id=(
            str(principal.regional_block_id) if principal.regional_block_id else None
        ),
        permissions=sorted(p.value for p in principal.permissions),
    )
