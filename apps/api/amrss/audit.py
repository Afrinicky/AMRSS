"""Audit trail writing.

SDD 10.2 requires a full trail for a defined list of actions. Two properties
matter more than the field list: the trail is append-only, with no update or
delete path in application code; and it records the actor's label and role at the
time of the action, so it stays legible after a user is renamed or deactivated.
"""

import uuid
from enum import StrEnum
from typing import Any

from sqlalchemy.orm import Session

from amrss.models import AuditLog
from amrss.security.scope import Principal


class AuditAction(StrEnum):
    """The SDD 10.2 event list, as a closed vocabulary.

    A closed enum rather than free-text strings: a typo in a log action is
    invisible until the day an auditor searches for the events it should have
    matched and finds none.
    """

    LOGIN_SUCCEEDED = "login.succeeded"
    LOGIN_FAILED = "login.failed"
    LOGOUT = "logout"

    UPLOAD_SUBMITTED = "upload.submitted"
    UPLOAD_REJECTED = "upload.rejected"
    UPLOAD_ACCEPTED = "upload.accepted"
    UPLOAD_HELD = "upload.held"
    UPLOAD_QUARANTINED = "upload.quarantined"
    UPLOAD_RETRACTED = "upload.retracted"

    QC_ATTESTATION_SUBMITTED = "qc.attestation_submitted"
    EQA_RECORD_SUBMITTED = "qc.eqa_submitted"
    QC_GATING_CHANGED = "qc.gating_changed"

    FACILITY_ENROLLED = "facility.enrolled"
    FACILITY_STATUS_CHANGED = "facility.status_changed"
    BLOCK_CREATED = "block.created"
    BLOCK_UPDATED = "block.updated"

    DICTIONARY_UPDATED = "dictionary.updated"
    MAPPING_REVIEWED = "mapping.reviewed"
    METHODOLOGY_VERSION_CREATED = "methodology.version_created"
    #: A breakpoint table was loaded, or stored measurements were interpreted
    #: against one. Both change what published antibiograms say — the first for
    #: everything computed afterwards, the second by rewriting stored results —
    #: so both need a name and a timestamp against them.
    BREAKPOINTS_IMPORTED = "breakpoints.imported"
    RESULTS_INTERPRETED = "results.interpreted"
    ALERT_LIST_CONFIGURED = "alert.list_configured"

    SIGNAL_ACKNOWLEDGED = "signal.acknowledged"
    REPORT_GENERATED = "report.generated"

    USER_CREATED = "user.created"
    USER_UPDATED = "user.updated"
    USER_DEACTIVATED = "user.deactivated"
    PERMISSION_CHANGED = "user.permission_changed"


def record(
    db: Session,
    *,
    action: AuditAction,
    entity: str,
    entity_id: str | uuid.UUID | None = None,
    principal: Principal | None = None,
    actor_label: str | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    source_ip: str | None = None,
    user_agent: str | None = None,
    note: str | None = None,
) -> AuditLog:
    """Append one audit entry to the caller's transaction.

    Deliberately not committed here. The entry shares the transaction of the
    change it describes, so a rolled-back action cannot leave a log line claiming
    it happened — and an action cannot commit without its log line.

    A failed login has no authenticated principal, hence ``actor_label``.
    """
    entry = AuditLog(
        actor_id=principal.user_id if principal else None,
        actor_label=actor_label or (principal.label if principal else "anonymous"),
        actor_role=principal.role.value if principal else None,
        action=action.value,
        entity=entity,
        entity_id=str(entity_id) if entity_id is not None else None,
        before_state=before,
        after_state=after,
        source_ip=source_ip,
        user_agent=user_agent,
        note=note,
    )
    db.add(entry)
    return entry
