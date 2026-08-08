from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from amrss.api.deps import (
    CurrentUser,
    client_ip,
    get_current_user,
    get_field_cipher,
    get_password_hasher,
    get_token_service,
)
from amrss.config import Settings, get_settings
from amrss.core.crypto import FieldCipher, PasswordHasherService
from amrss.core.permissions import permissions_for
from amrss.core.tokens import TokenService
from amrss.db.models.user import User
from amrss.db.session import get_db
from amrss.schemas.auth import (
    CurrentUserResponse,
    LoginRequest,
    RefreshRequest,
    TokenResponse,
)
from amrss.services import auth_service

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    hasher: PasswordHasherService = Depends(get_password_hasher),
    tokens: TokenService = Depends(get_token_service),
    cipher: FieldCipher = Depends(get_field_cipher),
) -> TokenResponse:
    try:
        result = auth_service.authenticate(
            db,
            email=payload.email,
            password=payload.password,
            totp_code=payload.totp_code,
            settings=settings,
            hasher=hasher,
            tokens=tokens,
            cipher=cipher,
            source_ip=client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    except auth_service.MFARequired:
        # The audit trail already records the attempt; committing keeps it.
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="A one-time code is required",
            headers={"WWW-Authenticate": 'Bearer error="mfa_required"'},
        ) from None
    except auth_service.AccountLocked as exc:
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed attempts. Try again later.",
            headers={"Retry-After": "900"},
        ) from exc
    except auth_service.AuthenticationError as exc:
        db.commit()  # persist the failed-attempt and audit rows
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from None

    db.commit()
    response.headers["Cache-Control"] = "no-store"
    return TokenResponse(
        access_token=result.access_token,
        refresh_token=result.refresh_token,
        expires_in=result.expires_in,
    )


@router.post("/refresh", response_model=TokenResponse)
def refresh(
    payload: RefreshRequest,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    tokens: TokenService = Depends(get_token_service),
) -> TokenResponse:
    try:
        result = auth_service.rotate_refresh_token(
            db,
            presented_token=payload.refresh_token,
            tokens=tokens,
            settings=settings,
            source_ip=client_ip(request),
        )
    except auth_service.AuthenticationError as exc:
        db.commit()  # keep the reuse-detection revocation and its audit entry
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from None
    db.commit()
    return TokenResponse(
        access_token=result.access_token,
        refresh_token=result.refresh_token,
        expires_in=result.expires_in,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    auth_service.revoke_session(
        db, session_id=user.session_id, actor_id=user.id, source_ip=client_ip(request)
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=CurrentUserResponse)
def me(
    db: Session = Depends(get_db),
    user: CurrentUser = Depends(get_current_user),
) -> CurrentUserResponse:
    record = db.get(User, user.id)
    if record is None:  # pragma: no cover - get_current_user already checked
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return CurrentUserResponse(
        id=str(record.id),
        email=record.email,
        full_name=record.full_name,
        roles=list(record.roles or []),
        permissions=sorted(str(p) for p in permissions_for(record.roles or [])),
        laboratory_code=record.laboratory_code,
        mfa_enabled=record.mfa_enabled,
    )
