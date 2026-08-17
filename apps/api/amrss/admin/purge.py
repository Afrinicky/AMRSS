"""Deleting surveillance data, deliberately and irreversibly.

Every other administrative action in AMRSS is additive or reversible: a facility
is suspended rather than removed, a batch is retracted rather than erased, a user
is deactivated rather than deleted. That is the right default for a system that
answers "why did this figure move a quarter later". But a pilot has to be able to
draw a line under its test data and begin the real surveillance cycle on a clean
block, and a facility enrolled by mistake has to be removable. This module is the
one place that genuinely deletes, and it is gated on its own permission
(``PURGE_DATA``) held only by the single overall authority.

Two invariants shape everything here:

- **The audit trail is never touched.** ``audit_log`` is append-only, enforced by
  database triggers, and the deletions below are themselves audited — so the
  record that a reset happened, and who did it, outlives the data it removed.
- **Deletion runs children-first.** Foreign keys are not declared ``ON DELETE
  CASCADE`` in this schema, so the order is explicit and a single wrong order
  would raise rather than silently orphan.

Reference data (the canonical dictionary, methodology versions), regional blocks,
and user accounts are preserved: they are configuration the next cycle is built
on, not the data being cleared. Facility-scoped accounts whose facility is removed
are detached and deactivated rather than deleted, so their audit history stays
attributable while they can no longer sign in to a laboratory that is gone.
"""

from __future__ import annotations

from typing import Any, cast

from sqlalchemy import CursorResult, Select, delete, select, update
from sqlalchemy.orm import Session
from sqlalchemy.sql.expression import Executable

from amrss.models import (
    AnalyticsRefresh,
    AppUser,
    AstResult,
    District,
    EmergingSignal,
    EqaRecord,
    Facility,
    FacilityCodeMapping,
    GeneratedReport,
    Isolate,
    PhenotypeFlag,
    QcAttestation,
    UploadBatch,
    UploadQcFinding,
)
from amrss.models.enums import EqaStatus, QcStatus, Role

#: Roles whose whole reason to exist is a facility. When a facility is deleted
#: they are detached and deactivated; a regional or platform role is untouched
#: because it never pointed at the facility in the first place.
FACILITY_SCOPED_ROLES = frozenset({Role.LABORATORY_STAFF, Role.FACILITY_ADMINISTRATOR})


def _count(db: Session, statement: Executable) -> int:
    """Run a bulk delete/update and return the number of rows it touched."""
    # A DML statement returns a CursorResult, which carries rowcount; the generic
    # Result the stubs infer does not, so the cast states what execute() returns.
    result = cast("CursorResult[Any]", db.execute(statement))
    return result.rowcount or 0


def _delete_isolate_children(db: Session, isolate_filter: Select[Any]) -> dict[str, int]:
    """Delete everything hanging off a set of isolates, then the isolates.

    ``isolate_filter`` is a SELECT of isolate ids, so the same routine serves
    both a single facility and the whole dataset.
    """
    isolate_ids = isolate_filter.scalar_subquery()
    counts = {
        "phenotype_flags": _count(
            db, delete(PhenotypeFlag).where(PhenotypeFlag.isolate_id.in_(isolate_ids))
        ),
        "ast_results": _count(db, delete(AstResult).where(AstResult.isolate_id.in_(isolate_ids))),
    }
    return counts


def delete_facility(db: Session, facility: Facility) -> dict[str, int]:
    """Delete one facility and everything it ever submitted.

    Order: isolate children, then isolates and QC findings hanging off its
    batches, then the batches, then the facility's attestations, mappings and the
    reports/signals/refreshes scoped to it, then the facility row. Its
    facility-scoped accounts are detached and deactivated first so the facility
    row can go without breaking their foreign key.
    """
    fid = facility.id
    batch_ids = select(UploadBatch.id).where(UploadBatch.facility_id == fid).scalar_subquery()

    counts = _delete_isolate_children(db, select(Isolate.id).where(Isolate.facility_id == fid))
    counts["isolates"] = _count(db, delete(Isolate).where(Isolate.facility_id == fid))
    counts["upload_qc_findings"] = _count(
        db, delete(UploadQcFinding).where(UploadQcFinding.upload_batch_id.in_(batch_ids))
    )
    counts["analytics_refreshes"] = _count(
        db, delete(AnalyticsRefresh).where(AnalyticsRefresh.triggered_by_batch_id.in_(batch_ids))
    )
    counts["qc_attestations"] = _count(
        db, delete(QcAttestation).where(QcAttestation.facility_id == fid)
    )
    counts["eqa_records"] = _count(db, delete(EqaRecord).where(EqaRecord.facility_id == fid))
    counts["upload_batches"] = _count(db, delete(UploadBatch).where(UploadBatch.facility_id == fid))
    counts["code_mappings"] = _count(
        db, delete(FacilityCodeMapping).where(FacilityCodeMapping.facility_id == fid)
    )
    counts["emerging_signals"] = _count(
        db, delete(EmergingSignal).where(EmergingSignal.facility_id == fid)
    )
    counts["generated_reports"] = _count(
        db, delete(GeneratedReport).where(GeneratedReport.facility_id == fid)
    )
    counts["accounts_detached"] = _count(
        db,
        update(AppUser).where(AppUser.facility_id == fid).values(facility_id=None, is_active=False),
    )
    counts["facilities"] = _count(db, delete(Facility).where(Facility.id == fid))
    return counts


def reset_surveillance(db: Session, *, include_facilities: bool) -> dict[str, int]:
    """Clear the whole surveillance dataset so a block can start a new cycle.

    Always removes every isolate, result, batch, QC record, mapping, signal,
    report and analytics refresh across all facilities. With ``include_facilities``
    it also removes the facilities and districts themselves and detaches every
    facility-scoped account; without it the facilities remain enrolled and are
    reset to a pre-upload state so the next cycle records against the same roster.
    """
    counts = _delete_isolate_children(db, select(Isolate.id))
    counts["isolates"] = _count(db, delete(Isolate))
    counts["upload_qc_findings"] = _count(db, delete(UploadQcFinding))
    counts["analytics_refreshes"] = _count(db, delete(AnalyticsRefresh))
    counts["qc_attestations"] = _count(db, delete(QcAttestation))
    counts["eqa_records"] = _count(db, delete(EqaRecord))
    counts["upload_batches"] = _count(db, delete(UploadBatch))
    counts["code_mappings"] = _count(db, delete(FacilityCodeMapping))
    counts["emerging_signals"] = _count(db, delete(EmergingSignal))
    counts["generated_reports"] = _count(db, delete(GeneratedReport))

    if include_facilities:
        counts["accounts_detached"] = _count(
            db,
            update(AppUser)
            .where(AppUser.facility_id.isnot(None))
            .values(facility_id=None, is_active=False),
        )
        counts["facilities"] = _count(db, delete(Facility))
        counts["districts"] = _count(db, delete(District))
    else:
        # Keep the roster but return it to a clean slate: no last upload, and
        # quality state back to "not submitted" now that the attestations and
        # EQA records behind it are gone.
        counts["facilities_reset"] = _count(
            db,
            update(Facility).values(
                last_accepted_upload_at=None,
                qc_status=QcStatus.NOT_SUBMITTED,
                qc_valid_until=None,
                eqa_status=EqaStatus.NOT_SUBMITTED,
                eqa_valid_until=None,
            ),
        )

    return counts


def total_rows(counts: dict[str, int]) -> int:
    """Sum of everything a purge removed, for a one-line summary and the audit."""
    return sum(counts.values())


def summarise(counts: dict[str, int]) -> dict[str, int]:
    """Drop the zero entries so an audit record and a response carry only what
    actually happened."""
    return {key: value for key, value in counts.items() if value}
