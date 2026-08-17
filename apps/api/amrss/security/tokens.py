import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from jose import JWTError, jwt

from amrss.config import get_settings


class TokenError(Exception):
    pass


#: How long a desktop-to-browser handoff code stays usable.
#:
#: Deliberately tiny. The code travels as a query parameter — through the
#: operating system's "open this URL" plumbing and into the browser's history —
#: so it is the one credential in the system that is not kept secret by its
#: transport. A JWT cannot be revoked after issue, so the window is the control:
#: long enough for a browser to start, far too short to be useful to anyone who
#: reads it out of a history file later.
HANDOFF_TTL = timedelta(seconds=90)


def _encode(
    subject: uuid.UUID, token_type: Literal["access", "refresh", "handoff"], ttl: timedelta
) -> str:
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


def create_handoff_token(user_id: uuid.UUID) -> str:
    """A one-hop code that lets an already-authenticated desktop client open the
    web console as the same person.

    Carries no more authority than the access token the caller already holds —
    it is exchanged for one — and expires in ``HANDOFF_TTL``.
    """
    return _encode(user_id, "handoff", HANDOFF_TTL)


def decode_token(token: str, expected_type: Literal["access", "refresh", "handoff"]) -> uuid.UUID:
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
