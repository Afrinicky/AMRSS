"""Writes chained audit entries."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from amrss.core.audit import GENESIS_HASH, AuditEntry, redact
from amrss.db.models.audit import AuditLogEntry

# Arbitrary but fixed key for the advisory lock that serialises appends.
_AUDIT_LOCK_KEY = 0x414D_5253  # "AMRS"


def record(
    db: Session,
    *,
    action: str,
    outcome: str = "success",
    actor_id: uuid.UUID | None = None,
    actor_ip: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    detail: dict[str, Any] | None = None,
) -> AuditLogEntry:
    """Append one entry, linked to the current chain head.

    Takes a transaction-scoped advisory lock so two concurrent requests cannot
    both read the same head and produce a fork. The lock is released when the
    transaction ends, so callers must commit (or roll back) promptly.
    """
    db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _AUDIT_LOCK_KEY})

    head = db.scalar(select(AuditLogEntry).order_by(AuditLogEntry.seq.desc()).limit(1))
    previous_hash = head.entry_hash if head else GENESIS_HASH

    occurred_at = datetime.now(UTC)
    safe_detail = redact(detail or {})
    entry = AuditEntry(
        occurred_at=occurred_at,
        action=action,
        actor_id=str(actor_id) if actor_id else None,
        actor_ip=actor_ip,
        target_type=target_type,
        target_id=str(target_id) if target_id else None,
        outcome=outcome,
        detail=safe_detail,
        previous_hash=previous_hash,
    )

    row = AuditLogEntry(
        occurred_at=occurred_at,
        action=action,
        actor_id=actor_id,
        actor_ip=actor_ip,
        target_type=target_type,
        target_id=str(target_id) if target_id else None,
        outcome=outcome,
        detail=safe_detail,
        previous_hash=previous_hash,
        entry_hash=entry.compute_hash(),
    )
    db.add(row)
    db.flush()
    return row
