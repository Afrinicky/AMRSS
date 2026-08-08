from __future__ import annotations

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    # Bounded so an oversized body cannot be pushed into the password hasher.
    password: str = Field(min_length=1, max_length=1024)
    totp_code: str | None = Field(default=None, pattern=r"^\d{6,8}$")


class RefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    refresh_token: str = Field(min_length=20, max_length=512)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "Bearer"
    expires_in: int


class CurrentUserResponse(BaseModel):
    id: str
    email: EmailStr
    full_name: str
    roles: list[str]
    permissions: list[str]
    laboratory_code: str | None
    mfa_enabled: bool
