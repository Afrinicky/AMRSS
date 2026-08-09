"""Loading, validating and activating breakpoint sets."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from amrss.core.audit import AuditAction
from amrss.db.models.reference import BreakpointRecord, BreakpointSetRecord
from amrss.services import audit_service
from amrss_clsi.breakpoints import (
    Breakpoint,
    BreakpointSet,
    Method,
    Tier,
    ValidationIssue,
    validate_breakpoints,
)


class BreakpointImportError(Exception):
    def __init__(self, issues: list[ValidationIssue]) -> None:
        super().__init__(f"{len(issues)} validation error(s) in breakpoint table")
        self.issues = issues


def to_domain(record: BreakpointRecord, set_version: str) -> Breakpoint:
    return Breakpoint(
        set_version=set_version,
        standard=record.standard,
        table_reference=record.table_reference,
        organism_group=record.organism_group,
        agent_code=record.agent_code,
        method=Method(record.method),
        disk_content=record.disk_content,
        site=record.site,
        route=record.route,
        dosage_note=record.dosage_note,
        mic_susceptible_max=record.mic_susceptible_max,
        mic_sdd_min=record.mic_sdd_min,
        mic_sdd_max=record.mic_sdd_max,
        mic_intermediate_min=record.mic_intermediate_min,
        mic_intermediate_max=record.mic_intermediate_max,
        mic_resistant_min=record.mic_resistant_min,
        disk_susceptible_min=record.disk_susceptible_min,
        disk_sdd_min=record.disk_sdd_min,
        disk_sdd_max=record.disk_sdd_max,
        disk_intermediate_min=record.disk_intermediate_min,
        disk_intermediate_max=record.disk_intermediate_max,
        disk_resistant_max=record.disk_resistant_max,
        tier=Tier(record.tier),
        comment=record.comment,
    )


def load_set(db: Session, version: str) -> BreakpointSet | None:
    record = db.scalar(select(BreakpointSetRecord).where(BreakpointSetRecord.version == version))
    if record is None:
        return None
    return BreakpointSet(
        version=record.version,
        source_edition=record.source_edition,
        breakpoints=[to_domain(bp, record.version) for bp in record.breakpoints],
    )


def load_active_set(db: Session) -> BreakpointSet | None:
    record = db.scalar(
        select(BreakpointSetRecord)
        .where(
            BreakpointSetRecord.activated_at.is_not(None),
            BreakpointSetRecord.retired_at.is_(None),
        )
        .order_by(BreakpointSetRecord.activated_at.desc())
        .limit(1)
    )
    if record is None:
        return None
    return BreakpointSet(
        version=record.version,
        source_edition=record.source_edition,
        breakpoints=[to_domain(bp, record.version) for bp in record.breakpoints],
    )


def parse_rows(rows: list[dict[str, Any]], *, set_version: str) -> list[Breakpoint]:
    """Convert imported rows (CSV/JSON) into domain breakpoints."""
    parsed: list[Breakpoint] = []
    for index, row in enumerate(rows):
        try:
            parsed.append(
                Breakpoint(
                    set_version=set_version,
                    standard=str(row.get("standard") or "M100"),
                    table_reference=_opt_str(row.get("table_reference")),
                    organism_group=str(row["organism_group"]).strip(),
                    agent_code=str(row["agent_code"]).strip().upper(),
                    method=Method(str(row["method"]).strip().upper()),
                    disk_content=_opt_str(row.get("disk_content")),
                    site=_opt_str(row.get("site")),
                    route=_opt_str(row.get("route")),
                    dosage_note=_opt_str(row.get("dosage_note")),
                    mic_susceptible_max=_opt_decimal(row.get("mic_susceptible_max")),
                    mic_sdd_min=_opt_decimal(row.get("mic_sdd_min")),
                    mic_sdd_max=_opt_decimal(row.get("mic_sdd_max")),
                    mic_intermediate_min=_opt_decimal(row.get("mic_intermediate_min")),
                    mic_intermediate_max=_opt_decimal(row.get("mic_intermediate_max")),
                    mic_resistant_min=_opt_decimal(row.get("mic_resistant_min")),
                    disk_susceptible_min=_opt_int(row.get("disk_susceptible_min")),
                    disk_sdd_min=_opt_int(row.get("disk_sdd_min")),
                    disk_sdd_max=_opt_int(row.get("disk_sdd_max")),
                    disk_intermediate_min=_opt_int(row.get("disk_intermediate_min")),
                    disk_intermediate_max=_opt_int(row.get("disk_intermediate_max")),
                    disk_resistant_max=_opt_int(row.get("disk_resistant_max")),
                    tier=Tier(str(row.get("tier") or "U")),
                    comment=_opt_str(row.get("comment")),
                )
            )
        except (KeyError, ValueError, InvalidOperation) as exc:
            raise BreakpointImportError(
                [ValidationIssue("error", index, f"row could not be parsed: {exc}")]
            ) from exc
    return parsed


def import_set(
    db: Session,
    *,
    version: str,
    source_edition: str,
    rows: list[dict[str, Any]],
    actor_id: UUID | None,
    standard_body: str = "CLSI",
    notes: str | None = None,
) -> BreakpointSetRecord:
    """Import a breakpoint table as a new, inactive set.

    The set is not usable until it is explicitly activated, so an import can be
    reviewed against the printed tables first. Validation errors abort the
    import entirely - a partially loaded breakpoint table is worse than none.
    """
    if db.scalar(select(BreakpointSetRecord).where(BreakpointSetRecord.version == version)):
        raise ValueError(f"breakpoint set {version} already exists")

    parsed = parse_rows(rows, set_version=version)
    issues = validate_breakpoints(parsed)
    errors = [i for i in issues if i.severity == "error"]
    if errors:
        raise BreakpointImportError(errors)

    checksum = hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()

    record = BreakpointSetRecord(
        version=version,
        source_edition=source_edition,
        standard_body=standard_body,
        source_checksum=checksum,
        notes=notes,
    )
    db.add(record)
    db.flush()

    for bp in parsed:
        db.add(
            BreakpointRecord(
                breakpoint_set_id=record.id,
                standard=bp.standard,
                table_reference=bp.table_reference,
                organism_group=bp.organism_group,
                agent_code=bp.agent_code,
                method=str(bp.method),
                disk_content=bp.disk_content,
                site=bp.site,
                route=bp.route,
                dosage_note=bp.dosage_note,
                mic_susceptible_max=bp.mic_susceptible_max,
                mic_sdd_min=bp.mic_sdd_min,
                mic_sdd_max=bp.mic_sdd_max,
                mic_intermediate_min=bp.mic_intermediate_min,
                mic_intermediate_max=bp.mic_intermediate_max,
                mic_resistant_min=bp.mic_resistant_min,
                disk_susceptible_min=bp.disk_susceptible_min,
                disk_sdd_min=bp.disk_sdd_min,
                disk_sdd_max=bp.disk_sdd_max,
                disk_intermediate_min=bp.disk_intermediate_min,
                disk_intermediate_max=bp.disk_intermediate_max,
                disk_resistant_max=bp.disk_resistant_max,
                tier=str(bp.tier),
                comment=bp.comment,
            )
        )

    audit_service.record(
        db,
        action=AuditAction.BREAKPOINT_SET_IMPORTED,
        actor_id=actor_id,
        target_type="breakpoint_set",
        target_id=str(record.id),
        detail={
            "version": version,
            "source_edition": source_edition,
            "row_count": len(parsed),
            "checksum": checksum,
            "warnings": [i.message for i in issues if i.severity == "warning"],
        },
    )
    return record


def activate_set(db: Session, *, version: str, actor_id: UUID | None) -> BreakpointSetRecord:
    """Make a set current, retiring whichever set was active before.

    Existing results keep the version they were interpreted under; adopting a
    new edition does not silently rewrite history. Re-interpretation is a
    separate, audited operation.
    """
    record = db.scalar(select(BreakpointSetRecord).where(BreakpointSetRecord.version == version))
    if record is None:
        raise ValueError(f"unknown breakpoint set: {version}")
    if record.retired_at is not None:
        raise ValueError("cannot activate a retired breakpoint set")

    now = datetime.now(UTC)
    previous = db.scalars(
        select(BreakpointSetRecord).where(
            BreakpointSetRecord.activated_at.is_not(None),
            BreakpointSetRecord.retired_at.is_(None),
            BreakpointSetRecord.id != record.id,
        )
    ).all()
    for old in previous:
        old.retired_at = now

    record.activated_at = now
    record.activated_by = actor_id

    audit_service.record(
        db,
        action=AuditAction.BREAKPOINT_SET_ACTIVATED,
        actor_id=actor_id,
        target_type="breakpoint_set",
        target_id=str(record.id),
        detail={"version": version, "retired": [p.version for p in previous]},
    )
    return record


def _opt_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _opt_decimal(value: Any) -> Decimal | None:
    text = _opt_str(value)
    return None if text is None else Decimal(text)


def _opt_int(value: Any) -> int | None:
    text = _opt_str(value)
    return None if text is None else int(text)
