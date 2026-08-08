import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from jose import JWTError, jwt

from amrss.config import get_settings


class TokenError(Exception):
    pass


def _encode(subject: uuid.UUID, token_type: Literal["access", "refresh"], ttl: timedelta) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    claims = {
        "sub": str(subject),
        "type": token_type,
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(claims, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_access_token(user_id: uuid.UUID) -> str:
    """Carries identity only.

    Role and scope are deliberately absent: they are read from the database on
    every request. A token minted before a user was demoted or deactivated must
    not keep conferring the access it was minted with.
    """
    settings = get_settings()
    return _encode(user_id, "access", timedelta(minutes=settings.access_token_ttl_minutes))


def create_refresh_token(user_id: uuid.UUID) -> str:
    settings = get_settings()
    return _encode(user_id, "refresh", timedelta(days=settings.refresh_token_ttl_days))


def decode_token(token: str, expected_type: Literal["access", "refresh"]) -> uuid.UUID:
    settings = get_settings()
    try:
        claims: dict[str, Any] = jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
    except JWTError as exc:
        raise TokenError("token is invalid or expired") from exc

    if claims.get("type") != expected_type:
        raise TokenError("wrong token type")
    try:
        return uuid.UUID(claims["sub"])
    except (KeyError, ValueError) as exc:
        raise TokenError("token subject is malformed") from exc
