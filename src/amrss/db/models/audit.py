"""Append-only, hash-chained audit log.

Application code never updates or deletes these rows. Enforce that at the
database level too - see the grants and the reject-trigger in the migration
`alembic/versions/0002_audit_append_only.py`.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, Index, String
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from amrss.db.base import Base


class AuditLogEntry(Base):
    __tablename__ = "audit_log"

    # Monotonic sequence defines chain order; a UUID would not.
    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    action: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(PGUUID(as_uuid=True), index=True)
    actor_ip: Mapped[str | None] = mapped_column(INET)
    target_type: Mapped[str | None] = mapped_column(String(60), index=True)
    target_id: Mapped[str | None] = mapped_column(String(64), index=True)
    outcome: Mapped[str] = mapped_column(String(20), nullable=False)
    # Redacted before it gets here - see amrss.core.audit.redact.
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)

    previous_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    entry_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)

    __table_args__ = (
        Index("ix_audit_log_action_time", "action", "occurred_at"),
        Index("ix_audit_log_target", "target_type", "target_id"),
    )
