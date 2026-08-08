"""Tamper-evident audit trail.

Surveillance data feeds public-health decisions and, via released AST reports,
patient treatment. Every state change is recorded in an append-only log whose
entries are chained: each row's `entry_hash` covers the previous row's hash, so
deleting or editing history invalidates every subsequent link. Verification is
a linear scan (`verify_chain`).

This does not make the log unforgeable against an attacker with write access to
the database *and* the ability to recompute the chain - for that, periodically
export `entry_hash` of the newest row to append-only external storage (see
docs/security.md).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

GENESIS_HASH = "0" * 64

# Keys whose values must never reach the audit log in cleartext.
_REDACT_KEYS = frozenset(
    {
        "password",
        "new_password",
        "old_password",
        "token",
        "refresh_token",
        "access_token",
        "secret",
        "mfa_secret",
        "totp",
        "authorization",
        "mrn",
        "national_id",
        "patient_name",
        "date_of_birth",
        "phone",
        "address",
    }
)
_REDACTED = "[redacted]"


class AuditAction:
    """Canonical action names. Strings, so new actions need no migration."""

    LOGIN_SUCCESS = "auth.login.success"
    LOGIN_FAILURE = "auth.login.failure"
    LOGOUT = "auth.logout"
    # The two below are audit action identifiers, not credentials; the
    # trailing markers stop static scanners flagging them as secrets.
    TOKEN_REFRESH = "auth.token.refresh"  # nosec B105
    TOKEN_REUSE_DETECTED = "auth.token.reuse_detected"  # nosec B105
    ACCOUNT_LOCKED = "auth.account.locked"
    MFA_ENROLLED = "auth.mfa.enrolled"

    USER_CREATED = "user.created"
    USER_UPDATED = "user.updated"
    USER_DEACTIVATED = "user.deactivated"
    ROLE_CHANGED = "user.role.changed"

    ISOLATE_CREATED = "isolate.created"
    ISOLATE_UPDATED = "isolate.updated"

    AST_RESULT_RECORDED = "ast.result.recorded"
    AST_INTERPRETED = "ast.interpreted"
    AST_OVERRIDDEN = "ast.overridden"
    AST_RELEASED = "ast.released"
    AST_REINTERPRETED = "ast.reinterpreted"

    QC_RECORDED = "qc.recorded"
    QC_FAILED = "qc.failed"

    BREAKPOINT_SET_IMPORTED = "breakpoint.set.imported"
    BREAKPOINT_SET_ACTIVATED = "breakpoint.set.activated"

    PII_ACCESSED = "patient.pii.accessed"
    REPORT_EXPORTED = "report.exported"


def redact(payload: Any) -> Any:
    """Recursively strip sensitive values before they are persisted."""
    if isinstance(payload, dict):
        return {
            k: (_REDACTED if k.lower() in _REDACT_KEYS else redact(v)) for k, v in payload.items()
        }
    if isinstance(payload, (list, tuple)):
        return [redact(v) for v in payload]
    if isinstance(payload, UUID):
        return str(payload)
    if isinstance(payload, datetime):
        return payload.isoformat()
    return payload


def canonical_json(payload: Any) -> str:
    """Deterministic serialisation - key order and separators must be stable
    or the chain hash is not reproducible."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


@dataclass(frozen=True)
class AuditEntry:
    occurred_at: datetime
    action: str
    actor_id: str | None
    actor_ip: str | None
    target_type: str | None
    target_id: str | None
    outcome: str
    detail: dict[str, Any]
    previous_hash: str

    def compute_hash(self) -> str:
        material = canonical_json(
            {
                "occurred_at": self.occurred_at.astimezone(UTC).isoformat(),
                "action": self.action,
                "actor_id": self.actor_id,
                "actor_ip": self.actor_ip,
                "target_type": self.target_type,
                "target_id": self.target_id,
                "outcome": self.outcome,
                "detail": redact(self.detail),
                "previous_hash": self.previous_hash,
            }
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()


def verify_chain(rows: list[Any]) -> tuple[bool, int | None]:
    """Verify a chronologically ordered sequence of audit rows.

    Returns (ok, index_of_first_bad_row). Rows must expose the AuditEntry
    fields plus `entry_hash`.
    """
    expected_prev = GENESIS_HASH
    for idx, row in enumerate(rows):
        if row.previous_hash != expected_prev:
            return False, idx
        entry = AuditEntry(
            occurred_at=row.occurred_at,
            action=row.action,
            actor_id=str(row.actor_id) if row.actor_id else None,
            actor_ip=row.actor_ip,
            target_type=row.target_type,
            target_id=str(row.target_id) if row.target_id else None,
            outcome=row.outcome,
            detail=row.detail or {},
            previous_hash=row.previous_hash,
        )
        if entry.compute_hash() != row.entry_hash:
            return False, idx
        expected_prev = row.entry_hash
    return True, None
