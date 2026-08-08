"""Request dependencies: authentication, authorisation, and services."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from amrss.config import Settings, get_settings
from amrss.core.crypto import FieldCipher, PasswordHasherService, Pseudonymiser
from amrss.core.permissions import Permission, permissions_for
from amrss.core.tokens import TokenError, TokenService
from amrss.db.models.user import AuthSession, User
from amrss.db.session import get_db

# auto_error=False so a missing header produces our own 401 with a
# WWW-Authenticate challenge rather than FastAPI's 403.
_bearer = HTTPBearer(auto_error=False)

_UNAUTHENTICATED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


@dataclass
class CurrentUser:
    id: uuid.UUID
    email: str
    roles: tuple[str, ...]
    session_id: uuid.UUID
    mfa_satisfied: bool
    laboratory_code: str | None

    def has(self, permission: Permission) -> bool:
        return permission in permissions_for(self.roles)


@lru_cache(maxsize=1)
def get_token_service() -> TokenService:
    return TokenService(get_settings())


@lru_cache(maxsize=1)
def get_password_hasher() -> PasswordHasherService:
    return PasswordHasherService(get_settings())


@lru_cache(maxsize=1)
def get_field_cipher() -> FieldCipher:
    return FieldCipher(get_settings().field_encryption_key)


@lru_cache(maxsize=1)
def get_pseudonymiser() -> Pseudonymiser:
    return Pseudonymiser(get_settings().pseudonym_hmac_key)


def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
    tokens: TokenService = Depends(get_token_service),
    settings: Settings = Depends(get_settings),
) -> CurrentUser:
    """Resolve and validate the bearer token.

    A valid signature is not sufficient: the session must still exist and be
    unrevoked, and the user must still be active. That is what makes logout,
    session revocation and account deactivation take effect immediately rather
    than at token expiry.
    """
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _UNAUTHENTICATED

    try:
        claims = tokens.decode_access_token(credentials.credentials)
    except TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": 'Bearer error="invalid_token"'},
        ) from exc

    try:
        session_uuid = uuid.UUID(claims.session_id)
        user_uuid = uuid.UUID(claims.subject)
    except ValueError as exc:
        raise _UNAUTHENTICATED from exc

    auth_session = db.scalar(
        select(AuthSession).where(
            AuthSession.id == session_uuid,
            AuthSession.user_id == user_uuid,
            AuthSession.revoked_at.is_(None),
        )
    )
    if auth_session is None or auth_session.expires_at <= datetime.now(UTC):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session is no longer valid",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.get(User, user_uuid)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account inactive")

    # Roles come from the database, not the token: a role revoked a minute ago
    # must not stay effective until the access token expires.
    roles = tuple(user.roles or ())

    if not auth_session.mfa_satisfied and any(r in settings.require_mfa_for_roles for r in roles):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Multi-factor authentication is required for this account",
        )

    request.state.actor_id = user.id
    return CurrentUser(
        id=user.id,
        email=user.email,
        roles=roles,
        session_id=auth_session.id,
        mfa_satisfied=auth_session.mfa_satisfied,
        laboratory_code=user.laboratory_code,
    )


def require(*permissions: Permission):
    """Dependency factory enforcing that the caller holds every permission."""

    def _dependency(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        missing = [p for p in permissions if not user.has(p)]
        if missing:
            # Deliberately vague: enumerating the missing permission tells an
            # attacker how the model is shaped.
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions for this operation",
            )
        return user

    return _dependency


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None
