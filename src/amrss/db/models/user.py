"""Users, sessions and login throttling."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    ARRAY,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from amrss.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Argon2id encoded hash - never a raw password, never reversible.
    password_hash: Mapped[str] = mapped_column(String(256), nullable=False)
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    roles: Mapped[list[str]] = mapped_column(ARRAY(String(50)), nullable=False, default=list)
    laboratory_code: Mapped[str | None] = mapped_column(String(50), index=True)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # TOTP secret, stored encrypted with the field cipher (never plaintext).
    mfa_secret_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    failed_login_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    sessions: Mapped[list[AuthSession]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )

    @property
    def mfa_context(self) -> str:
        """AAD binding the encrypted TOTP secret to this user row."""
        return f"user:{self.id}:mfa_secret"


class AuthSession(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One login session, holding the current refresh token hash.

    Refresh tokens rotate on every use. `previous_token_hashes` retains the
    hashes this session has already burned so that replaying an old token is
    detectable - that is the signature of a stolen token, and it revokes the
    whole session.
    """

    __tablename__ = "auth_sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    refresh_token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    previous_token_hashes: Mapped[list[str]] = mapped_column(
        ARRAY(String(64)), nullable=False, default=list
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_reason: Mapped[str | None] = mapped_column(String(100))

    mfa_satisfied: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Recorded for anomaly review, not for authorisation decisions.
    created_ip: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(300))

    user: Mapped[User] = relationship(back_populates="sessions")

    __table_args__ = (Index("ix_auth_sessions_user_active", "user_id", "revoked_at"),)


class LoginAttempt(UUIDPrimaryKeyMixin, Base):
    """Throttling ledger. Keyed by email *and* source address so one attacker
    cannot lock out a legitimate user by spraying their address alone."""

    __tablename__ = "login_attempts"

    email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)
    source_ip: Mapped[str | None] = mapped_column(INET, index=True)
    attempted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    succeeded: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    __table_args__ = (Index("ix_login_attempts_email_time", "email", "attempted_at"),)


class UserInvitation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Single-use invitation, stored as a hash so the database holds no usable token."""

    __tablename__ = "user_invitations"

    email: Mapped[str] = mapped_column(String(320), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    roles: Mapped[list[str]] = mapped_column(ARRAY(String(50)), nullable=False, default=list)
    invited_by: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (UniqueConstraint("email", "token_hash", name="uq_invitation"),)
