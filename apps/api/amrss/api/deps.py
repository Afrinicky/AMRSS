from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from amrss.db import get_db
from amrss.models import AppUser
from amrss.security.permissions import Permission
from amrss.security.scope import Principal, principal_from_user
from amrss.security.tokens import TokenError, decode_token

_bearer = HTTPBearer(auto_error=False)

DbSession = Annotated[Session, Depends(get_db)]


def current_principal(
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> Principal:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        user_id = decode_token(credentials.credentials, "access")
    except TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    # Role and scope are read fresh rather than trusted from the token, so a
    # deactivation or role change takes effect on the next request rather than
    # at token expiry.
    user = db.get(AppUser, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account is inactive")
    if user.locked_until is not None and user.locked_until > datetime.now(UTC):
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="Account is locked")
    return principal_from_user(user)


CurrentPrincipal = Annotated[Principal, Depends(current_principal)]


def requires(*permissions: Permission) -> Callable[[Principal], Principal]:
    """Endpoint guard. All listed permissions must be held.

    Endpoints declare permissions, never roles — see amrss.security.permissions.
    """

    def guard(principal: CurrentPrincipal) -> Principal:
        missing = [p for p in permissions if not principal.has(p)]
        if missing:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires permission: {', '.join(missing)}",
            )
        return principal

    return guard


def client_context(request: Request) -> tuple[str | None, str | None]:
    """Source IP and user agent for the audit trail."""
    forwarded = request.headers.get("x-forwarded-for")
    ip = (
        forwarded.split(",")[0].strip()
        if forwarded
        else (request.client.host if request.client else None)
    )
    return ip, request.headers.get("user-agent")


ClientContext = Annotated[tuple[str | None, str | None], Depends(client_context)]
