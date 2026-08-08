"""Login, refresh-token rotation and lockout logic."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pyotp
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from amrss.config import Settings
from amrss.core.audit import AuditAction
from amrss.core.crypto import FieldCipher, PasswordHasherService
from amrss.core.tokens import TokenService
from amrss.db.models.user import AuthSession, LoginAttempt, User
from amrss.services import audit_service


class AuthenticationError(Exception):
    """Login failed. The message is deliberately uniform for the caller."""


class MFARequired(Exception):
    """Credentials were correct but a TOTP code is still needed."""


class AccountLocked(Exception):
    def __init__(self, until: datetime) -> None:
        super().__init__("Account temporarily locked")
        self.until = until


@dataclass
class LoginResult:
    access_token: str
    refresh_token: str
    expires_in: int
    user: User
    session: AuthSession


def authenticate(
    db: Session,
    *,
    email: str,
    password: str,
    totp_code: str | None,
    settings: Settings,
    hasher: PasswordHasherService,
    tokens: TokenService,
    cipher: FieldCipher,
    source_ip: str | None,
    user_agent: str | None,
) -> LoginResult:
    """Verify credentials and open a session.

    Every failure path raises `AuthenticationError` with the same message, and
    the unknown-user path still performs an Argon2 verification, so neither the
    response body nor the response time reveals whether an account exists.
    """
    normalised_email = email.strip().lower()
    now = datetime.now(UTC)

    _enforce_attempt_throttle(db, normalised_email, source_ip, settings, now)

    user = db.scalar(select(User).where(func.lower(User.email) == normalised_email))

    if user is None:
        hasher.dummy_verify()
        _record_attempt(db, normalised_email, source_ip, succeeded=False, at=now)
        audit_service.record(
            db,
            action=AuditAction.LOGIN_FAILURE,
            outcome="failure",
            actor_ip=source_ip,
            detail={"email": normalised_email, "reason": "unknown_account"},
        )
        raise AuthenticationError("Invalid email or password")

    if user.locked_until and user.locked_until > now:
        _record_attempt(db, normalised_email, source_ip, succeeded=False, at=now)
        raise AccountLocked(user.locked_until)

    if not user.is_active:
        hasher.dummy_verify()
        _record_attempt(db, normalised_email, source_ip, succeeded=False, at=now)
        audit_service.record(
            db,
            action=AuditAction.LOGIN_FAILURE,
            outcome="failure",
            actor_id=user.id,
            actor_ip=source_ip,
            detail={"reason": "inactive_account"},
        )
        raise AuthenticationError("Invalid email or password")

    if not hasher.verify(user.password_hash, password):
        _register_failure(db, user, normalised_email, source_ip, settings, now)
        raise AuthenticationError("Invalid email or password")

    # Password was correct - now the second factor, if enrolled.
    mfa_satisfied = True
    if user.mfa_enabled:
        if not totp_code:
            raise MFARequired
        if not _verify_totp(user, totp_code, cipher):
            _register_failure(db, user, normalised_email, source_ip, settings, now)
            raise AuthenticationError("Invalid email or password")
    elif any(role in settings.require_mfa_for_roles for role in (user.roles or ())):
        # Policy requires MFA for this role but none is enrolled: refuse the
        # session rather than silently downgrading the requirement.
        raise AuthenticationError("Multi-factor authentication must be enrolled before signing in")

    # Opportunistically upgrade the hash if the cost parameters have changed.
    if hasher.needs_rehash(user.password_hash):
        user.password_hash = hasher.hash(password)

    user.failed_login_count = 0
    user.locked_until = None
    user.last_login_at = now

    refresh = tokens.issue_refresh_token()
    session = AuthSession(
        user_id=user.id,
        refresh_token_hash=refresh.token_hash,
        previous_token_hashes=[],
        expires_at=refresh.expires_at,
        mfa_satisfied=mfa_satisfied,
        created_ip=source_ip,
        user_agent=(user_agent or "")[:300] or None,
    )
    db.add(session)
    db.flush()

    access_token, _ = tokens.issue_access_token(
        subject=str(user.id),
        session_id=str(session.id),
        roles=tuple(user.roles or ()),
        mfa_satisfied=mfa_satisfied,
    )

    _record_attempt(db, normalised_email, source_ip, succeeded=True, at=now)
    audit_service.record(
        db,
        action=AuditAction.LOGIN_SUCCESS,
        actor_id=user.id,
        actor_ip=source_ip,
        target_type="auth_session",
        target_id=str(session.id),
        detail={"mfa": mfa_satisfied},
    )

    return LoginResult(
        access_token=access_token,
        refresh_token=refresh.token,
        expires_in=settings.access_token_ttl_seconds,
        user=user,
        session=session,
    )


def rotate_refresh_token(
    db: Session,
    *,
    presented_token: str,
    tokens: TokenService,
    settings: Settings,
    source_ip: str | None,
) -> LoginResult:
    """Exchange a refresh token for a new pair, invalidating the old one.

    If the presented token is one this session has already rotated away from,
    it has been replayed - the legitimate client and an attacker now both hold
    tokens. The session is revoked outright and the event audited.
    """
    presented_hash = TokenService.hash_refresh_token(presented_token)
    now = datetime.now(UTC)

    session = db.scalar(select(AuthSession).where(AuthSession.refresh_token_hash == presented_hash))

    if session is None:
        replayed = db.scalar(
            select(AuthSession).where(
                AuthSession.previous_token_hashes.any(presented_hash)  # type: ignore[attr-defined]
            )
        )
        if replayed is not None:
            replayed.revoked_at = now
            replayed.revoked_reason = "refresh_token_reuse"
            audit_service.record(
                db,
                action=AuditAction.TOKEN_REUSE_DETECTED,
                outcome="failure",
                actor_id=replayed.user_id,
                actor_ip=source_ip,
                target_type="auth_session",
                target_id=str(replayed.id),
                detail={"action_taken": "session_revoked"},
            )
        raise AuthenticationError("Invalid refresh token")

    if session.revoked_at is not None or session.expires_at <= now:
        raise AuthenticationError("Invalid refresh token")

    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise AuthenticationError("Invalid refresh token")

    new_refresh = tokens.issue_refresh_token()
    # Cap the replay-detection history so a long-lived session cannot grow the
    # row without bound; the most recent entries are the ones that matter.
    session.previous_token_hashes = ([*(session.previous_token_hashes or []), presented_hash])[-20:]
    session.refresh_token_hash = new_refresh.token_hash
    session.expires_at = new_refresh.expires_at

    access_token, _ = tokens.issue_access_token(
        subject=str(user.id),
        session_id=str(session.id),
        roles=tuple(user.roles or ()),
        mfa_satisfied=session.mfa_satisfied,
    )
    audit_service.record(
        db,
        action=AuditAction.TOKEN_REFRESH,
        actor_id=user.id,
        actor_ip=source_ip,
        target_type="auth_session",
        target_id=str(session.id),
    )
    return LoginResult(
        access_token=access_token,
        refresh_token=new_refresh.token,
        expires_in=settings.access_token_ttl_seconds,
        user=user,
        session=session,
    )


def revoke_session(
    db: Session, *, session_id: uuid.UUID, actor_id: uuid.UUID, source_ip: str | None
) -> None:
    session = db.get(AuthSession, session_id)
    if session is None or session.revoked_at is not None:
        return
    session.revoked_at = datetime.now(UTC)
    session.revoked_reason = "logout"
    audit_service.record(
        db,
        action=AuditAction.LOGOUT,
        actor_id=actor_id,
        actor_ip=source_ip,
        target_type="auth_session",
        target_id=str(session_id),
    )


def _verify_totp(user: User, code: str, cipher: FieldCipher) -> bool:
    if not user.mfa_secret_encrypted:
        return False
    try:
        secret = cipher.decrypt(user.mfa_secret_encrypted, context=user.mfa_context)
    except Exception:  # noqa: BLE001 - a failed decrypt must not authenticate
        return False
    # valid_window=1 tolerates one 30 s step of clock drift, no more.
    return pyotp.TOTP(secret).verify(code, valid_window=1)


def _register_failure(
    db: Session,
    user: User,
    email: str,
    source_ip: str | None,
    settings: Settings,
    now: datetime,
) -> None:
    user.failed_login_count = (user.failed_login_count or 0) + 1
    detail: dict[str, object] = {"failed_count": user.failed_login_count}
    if user.failed_login_count >= settings.max_failed_logins:
        user.locked_until = now + timedelta(seconds=settings.lockout_seconds)
        detail["locked_until"] = user.locked_until.isoformat()
        audit_service.record(
            db,
            action=AuditAction.ACCOUNT_LOCKED,
            outcome="failure",
            actor_id=user.id,
            actor_ip=source_ip,
            detail=detail,
        )
    _record_attempt(db, email, source_ip, succeeded=False, at=now)
    audit_service.record(
        db,
        action=AuditAction.LOGIN_FAILURE,
        outcome="failure",
        actor_id=user.id,
        actor_ip=source_ip,
        detail=detail,
    )


def _record_attempt(
    db: Session, email: str, source_ip: str | None, *, succeeded: bool, at: datetime
) -> None:
    db.add(LoginAttempt(email=email, source_ip=source_ip, attempted_at=at, succeeded=succeeded))


def _enforce_attempt_throttle(
    db: Session,
    email: str,
    source_ip: str | None,
    settings: Settings,
    now: datetime,
) -> None:
    """Block bursts from one address before any password is checked."""
    if source_ip is None:
        return
    since = now - timedelta(minutes=1)
    recent = db.scalar(
        select(func.count())
        .select_from(LoginAttempt)
        .where(
            LoginAttempt.source_ip == source_ip,
            LoginAttempt.attempted_at >= since,
            LoginAttempt.succeeded.is_(False),
        )
    )
    if (recent or 0) >= settings.login_rate_limit_per_minute:
        raise AccountLocked(now + timedelta(seconds=60))
