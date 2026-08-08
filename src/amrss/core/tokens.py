"""JWT access tokens and rotating refresh tokens.

Access tokens are short-lived, signed JWTs carrying the subject, roles and a
session id. Refresh tokens are opaque random strings - never JWTs - stored only
as SHA-256 hashes and rotated on every use. Presenting an already-rotated
refresh token is treated as theft: the whole session family is revoked.
"""

from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt

from amrss.config import Settings
from amrss.core.crypto import hash_token

REFRESH_TOKEN_BYTES = 32


class TokenError(Exception):
    """Raised when a token is absent, malformed, expired or not ours."""


@dataclass(frozen=True)
class AccessTokenClaims:
    subject: str
    session_id: str
    roles: tuple[str, ...]
    expires_at: datetime
    jti: str
    mfa_satisfied: bool


@dataclass(frozen=True)
class IssuedRefreshToken:
    token: str  # returned to the client exactly once
    token_hash: str  # what we persist
    expires_at: datetime


class TokenService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def issue_access_token(
        self,
        *,
        subject: str,
        session_id: str,
        roles: tuple[str, ...],
        mfa_satisfied: bool,
    ) -> tuple[str, AccessTokenClaims]:
        now = datetime.now(UTC)
        expires_at = now + timedelta(seconds=self._settings.access_token_ttl_seconds)
        jti = str(uuid.uuid4())
        payload = {
            "sub": subject,
            "sid": session_id,
            "roles": list(roles),
            "mfa": mfa_satisfied,
            "iat": int(now.timestamp()),
            "nbf": int(now.timestamp()),
            "exp": int(expires_at.timestamp()),
            "iss": self._settings.jwt_issuer,
            "aud": self._settings.jwt_audience,
            "jti": jti,
            "typ": "access",
        }
        token = jwt.encode(
            payload, self._settings.jwt_secret, algorithm=self._settings.jwt_algorithm
        )
        return token, AccessTokenClaims(
            subject=subject,
            session_id=session_id,
            roles=roles,
            expires_at=expires_at,
            jti=jti,
            mfa_satisfied=mfa_satisfied,
        )

    def decode_access_token(self, token: str) -> AccessTokenClaims:
        try:
            payload = jwt.decode(
                token,
                self._settings.jwt_secret,
                # Pin the algorithm: accepting the token's own `alg` header is
                # how "alg: none" and HS/RS confusion attacks get in.
                algorithms=[self._settings.jwt_algorithm],
                issuer=self._settings.jwt_issuer,
                audience=self._settings.jwt_audience,
                options={
                    "require": ["exp", "iat", "nbf", "sub", "iss", "aud", "jti"],
                    "verify_exp": True,
                    "verify_nbf": True,
                    "verify_iss": True,
                    "verify_aud": True,
                    "verify_signature": True,
                },
            )
        except jwt.PyJWTError as exc:
            raise TokenError(str(exc)) from exc

        if payload.get("typ") != "access":
            raise TokenError("not an access token")
        sid = payload.get("sid")
        if not isinstance(sid, str) or not sid:
            raise TokenError("missing session id")
        roles = payload.get("roles") or []
        if not isinstance(roles, list) or not all(isinstance(r, str) for r in roles):
            raise TokenError("malformed roles claim")

        return AccessTokenClaims(
            subject=str(payload["sub"]),
            session_id=sid,
            roles=tuple(roles),
            expires_at=datetime.fromtimestamp(payload["exp"], tz=UTC),
            jti=str(payload["jti"]),
            mfa_satisfied=bool(payload.get("mfa", False)),
        )

    def issue_refresh_token(self) -> IssuedRefreshToken:
        token = secrets.token_urlsafe(REFRESH_TOKEN_BYTES)
        return IssuedRefreshToken(
            token=token,
            token_hash=hash_token(token),
            expires_at=datetime.now(UTC)
            + timedelta(seconds=self._settings.refresh_token_ttl_seconds),
        )

    @staticmethod
    def hash_refresh_token(token: str) -> str:
        return hash_token(token)
