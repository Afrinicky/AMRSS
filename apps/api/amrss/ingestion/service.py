"""Batch ingestion: stage, gate, promote or hold.

The lifecycle (SDD 9.6) is staged → qc_hold → accepted → quarantined → retracted.
Two properties are non-negotiable:

- **Accepted data is never hard-deleted.** A batch found faulty after acceptance
  is quarantined and retracted, preserving the audit trail. Because the analytics
  query filters on ACCEPTED status, retraction removes the data from every
  aggregate automatically — recomputation is a consequence of the state change,
  not a separate cleanup that could be forgotten.
- **Nothing is silently dropped or silently accepted.** Every batch ends in a
  recorded state with a reason, and every state transition is audited.
"""

import gzip
import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from amrss import audit
from amrss.analytics import methodology
from amrss.analytics import methodology as methodology_engine
from amrss.analytics.query import invalidate_record_cache
from amrss.audit import AuditAction
from amrss.ingestion import qc
from amrss.ingestion.payload import UploadPayload
from amrss.ingestion.whonet_aliases import aliased_codes, whonet_alias
from amrss.models import (
    AstResult,
    CanonicalAntibiotic,
    CanonicalOrganism,
    CanonicalSpecimenType,
    District,
    Facility,
    FacilityCodeMapping,
    Isolate,
    QcAttestation,
    RegionalBlock,
    UploadBatch,
    UploadQcFinding,
)
from amrss.models.enums import (
    BatchStatus,
    DictionaryEntityType,
    MappingStatus,
    MethodologyComponent,
    QcFindingSeverity,
)
from amrss.quality import gating
from amrss.security.scope import Principal


class IngestionError(Exception):
    """Rejection before a batch record exists — malformed envelope, bad checksum,
    unsupported client. These never reach the database as a batch because there is
    nothing trustworthy to record."""


@dataclass
class IngestionResult:
    batch_id: uuid.UUID
    status: BatchStatus
    isolates_accepted: int
    findings: list[qc.Finding]

    @property
    def message(self) -> str:
        if self.status is BatchStatus.ACCEPTED:
            return f"Accepted {self.isolates_accepted} isolates."
        if self.status is BatchStatus.QC_HOLD:
            return (
                "Held for Data Steward review. The data is retained and will be "
                "included once the findings are resolved."
            )
        return "Rejected. No data from this batch has been retained."


def decode_envelope(body: bytes, declared_checksum: str, max_bytes: int) -> UploadPayload:
    """Verify and decode a transmitted payload.

    The checksum is computed over the *compressed* bytes as received, so it
    verifies exactly what crossed the network rather than something derived after
    parsing.
    """
    if len(body) > max_bytes:
        raise IngestionError(f"Payload exceeds the maximum accepted size of {max_bytes} bytes")

    actual = hashlib.sha256(body).hexdigest()
    if actual != declared_checksum:
        raise IngestionError(
            "Checksum mismatch: the payload does not match the checksum declared by the "
            "uploader, so it may have been altered or truncated in transit."
        )

    try:
        decompressed = gzip.decompress(body)
    except (OSError, EOFError) as exc:
        raise IngestionError("Payload is not valid gzip data") from exc

    try:
        document: Any = json.loads(decompressed)
    except json.JSONDecodeError as exc:
        raise IngestionError(f"Payload is not valid JSON: {exc}") from exc

    try:
        return UploadPayload.model_validate(document)
    except ValueError as exc:
        raise IngestionError(f"Payload does not match the expected schema: {exc}") from exc


def _version_tuple(version: str) -> tuple[int, ...]:
    parts = []
    for chunk in version.split("."):
        digits = "".join(character for character in chunk if character.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def check_uploader_version(declared: str, minimum: str) -> None:
    """SDD 8.4: reject clients below the minimum supported version.

    An outdated uploader may carry de-identification logic that a later release
    corrected, so accepting its data would import the defect the fix addressed.
    """
    if _version_tuple(declared) < _version_tuple(minimum):
        raise IngestionError(
            f"Uploader version {declared} is below the minimum supported version "
            f"{minimum}. Update the AMRSS uploader before submitting."
        )


def _build_qc_context(db: Session, facility: Facility, payload: UploadPayload) -> qc.QcContext:
    organisms = {
        code
        for (code,) in db.execute(
            select(CanonicalOrganism.code).where(CanonicalOrganism.is_active.is_(True))
        )
    }
    antibiotic_rows = db.execute(
        select(CanonicalAntibiotic.code, CanonicalAntibiotic.target_kingdom).where(
            CanonicalAntibiotic.is_active.is_(True)
        )
    ).all()
    specimens = {
        code
        for (code,) in db.execute(
            select(CanonicalSpecimenType.code).where(CanonicalSpecimenType.is_active.is_(True))
        )
    }

    # Approved facility mappings extend the set of codes the facility may use, so
    # a laboratory keeping its own local codes is not permanently in the warning
    # queue once a steward has mapped them.
    for entity_type, target in (
        (DictionaryEntityType.ORGANISM, organisms),
        (DictionaryEntityType.SPECIMEN_TYPE, specimens),
    ):
        for (local_code,) in db.execute(
            select(FacilityCodeMapping.local_code).where(
                FacilityCodeMapping.facility_id == facility.id,
                FacilityCodeMapping.entity_type == entity_type,
                FacilityCodeMapping.status == MappingStatus.APPROVED,
            )
        ):
            target.add(local_code)

    antibiotic_kingdoms = {code: kingdom for code, kingdom in antibiotic_rows}
    antibiotics = set(antibiotic_kingdoms)
    for (local_code,) in db.execute(
        select(FacilityCodeMapping.local_code).where(
            FacilityCodeMapping.facility_id == facility.id,
            FacilityCodeMapping.entity_type == DictionaryEntityType.ANTIBIOTIC,
            FacilityCodeMapping.status == MappingStatus.APPROVED,
        )
    ):
        antibiotics.add(local_code)

    # Built-in WHONET aliases resolve to a canonical entry too, so a file using
    # them must not be flagged as carrying unknown codes.
    organisms |= aliased_codes(DictionaryEntityType.ORGANISM)
    specimens |= aliased_codes(DictionaryEntityType.SPECIMEN_TYPE)
    antibiotics |= aliased_codes(DictionaryEntityType.ANTIBIOTIC)

    existing_hashes = {
        record_hash
        for (record_hash,) in db.execute(
            select(Isolate.source_record_hash).where(Isolate.facility_id == facility.id)
        )
    }

    recent_mean = db.scalar(
        select(func.avg(UploadBatch.accepted_isolate_count)).where(
            UploadBatch.facility_id == facility.id,
            UploadBatch.status == BatchStatus.ACCEPTED,
        )
    )

    block_id, expected_config = db.execute(
        select(RegionalBlock.id, RegionalBlock.whonet_config_standard)
        .join(District, District.regional_block_id == RegionalBlock.id)
        .where(District.id == facility.district_id)
    ).one()

    rules = methodology.resolve(
        db,
        regional_block_id=block_id,
        components=[MethodologyComponent.QC_RULES],
    ).get(MethodologyComponent.QC_RULES)

    return qc.QcContext(
        known_organism_codes=organisms,
        known_antibiotic_codes=antibiotics,
        known_specimen_codes=specimens,
        antibiotic_kingdoms=antibiotic_kingdoms,
        existing_record_hashes=existing_hashes,
        expected_whonet_config=expected_config,
        recent_mean_isolate_count=float(recent_mean) if recent_mean is not None else None,
        rules=dict(rules.parameters) if rules else {},
        today=date.today(),
    )


def ingest(
    db: Session,
    *,
    facility: Facility,
    payload: UploadPayload,
    raw_bytes: int,
    checksum: str,
    principal: Principal,
    source_ip: str | None = None,
) -> IngestionResult:
    """Stage a batch, run Tier-3 QC, and either accept it or hold it."""
    batch = UploadBatch(
        facility_id=facility.id,
        submitted_by_id=principal.user_id,
        uploaded_at=datetime.now(UTC),
        record_count=len(payload.isolates),
        checksum=checksum,
        payload_bytes=raw_bytes,
        status=BatchStatus.STAGED,
        uploader_version=payload.uploader_version,
        whonet_config_version=payload.whonet_config_version,
        ast_breakpoint_standard=payload.ast_breakpoint_standard,
        coverage_start=payload.coverage_start,
        coverage_end=payload.coverage_end,
    )
    db.add(batch)
    db.flush()

    audit.record(
        db,
        action=AuditAction.UPLOAD_SUBMITTED,
        entity="upload_batch",
        entity_id=batch.id,
        principal=principal,
        source_ip=source_ip,
        after={"record_count": len(payload.isolates), "facility": facility.code},
    )

    context = _build_qc_context(db, facility, payload)
    outcome = qc.run(payload, context)

    for finding in outcome.findings:
        db.add(
            UploadQcFinding(
                upload_batch_id=batch.id,
                code=finding.code,
                severity=finding.severity,
                message=finding.message,
                affected_record_count=finding.affected_record_count,
                detail=finding.detail or None,
            )
        )

    if outcome.has_error:
        batch.status = BatchStatus.REJECTED
        batch.decided_at = datetime.now(UTC)
        batch.decision_reason = "; ".join(
            f.message for f in outcome.findings if f.severity is QcFindingSeverity.ERROR
        )
        audit.record(
            db,
            action=AuditAction.UPLOAD_REJECTED,
            entity="upload_batch",
            entity_id=batch.id,
            principal=principal,
            source_ip=source_ip,
            note=batch.decision_reason,
        )
        db.commit()
        return IngestionResult(batch.id, batch.status, 0, outcome.findings)

    accepted = _persist_isolates(
        db,
        batch=batch,
        facility=facility,
        payload=payload,
        already_accepted=context.existing_record_hashes,
    )
    batch.accepted_isolate_count = accepted

    if payload.qc_attestation is not None:
        _record_attestation(
            db, batch=batch, facility=facility, payload=payload, principal=principal
        )

    if outcome.has_warning:
        batch.status = BatchStatus.QC_HOLD
        batch.decision_reason = "Held for Data Steward review; see QC findings."
        action = AuditAction.UPLOAD_HELD
    else:
        batch.status = BatchStatus.ACCEPTED
        batch.decided_at = datetime.now(UTC)
        facility.last_accepted_upload_at = batch.uploaded_at
        action = AuditAction.UPLOAD_ACCEPTED
        # New isolates are now eligible; anything loaded before this is stale.
        invalidate_record_cache()

    audit.record(
        db,
        action=action,
        entity="upload_batch",
        entity_id=batch.id,
        principal=principal,
        source_ip=source_ip,
        after={"status": batch.status.value, "isolates": accepted},
    )
    db.commit()
    return IngestionResult(batch.id, batch.status, accepted, outcome.findings)


def _persist_isolates(
    db: Session,
    *,
    batch: UploadBatch,
    facility: Facility,
    payload: UploadPayload,
    already_accepted: set[str],
) -> int:
    """Persist the isolates a batch contributes.

    Records this facility already sent are skipped rather than re-inserted. Under
    incremental sync a resend is a normal client-side condition — a reset
    last-sync marker, a retried transmission — not corruption, so it is reported
    as a QC finding and the surviving records are still accepted. Attempting the
    insert would abort the whole batch on a unique-constraint violation and lose
    the genuinely new records alongside the repeats.
    """
    organisms = {o.code: o for o in db.scalars(select(CanonicalOrganism))}
    antibiotics = {a.code: a for a in db.scalars(select(CanonicalAntibiotic))}
    specimens = {s.code: s for s in db.scalars(select(CanonicalSpecimenType))}

    mappings: dict[tuple[DictionaryEntityType, str], str] = {}
    for mapping in db.scalars(
        select(FacilityCodeMapping).where(
            FacilityCodeMapping.facility_id == facility.id,
            FacilityCodeMapping.status == MappingStatus.APPROVED,
        )
    ):
        if mapping.canonical_code:
            mappings[(mapping.entity_type, mapping.local_code)] = mapping.canonical_code

    def canonical(entity_type: DictionaryEntityType, local_code: str) -> str:
        # A steward-approved facility mapping wins (it is a deliberate local
        # decision); then a built-in WHONET alias; then the code stands for
        # itself, which is the common case now the dictionary is seeded with
        # WHONET codes.
        if (entity_type, local_code) in mappings:
            return mappings[(entity_type, local_code)]
        return whonet_alias(entity_type, local_code) or local_code

    seen: set[str] = set(already_accepted)
    accepted = 0

    for entry in payload.isolates:
        if entry.source_record_hash in seen:
            continue
        seen.add(entry.source_record_hash)

        organism = organisms.get(canonical(DictionaryEntityType.ORGANISM, entry.organism_code))
        specimen = specimens.get(
            canonical(DictionaryEntityType.SPECIMEN_TYPE, entry.specimen_type_code)
        )
        # Unmapped codes were already reported as a QC finding; the isolate is not
        # persisted because it has nothing to aggregate against, and inventing a
        # placeholder canonical entry would corrupt every future statistic.
        if organism is None or specimen is None:
            continue

        iso_year, iso_week, _ = entry.specimen_date.isocalendar()
        isolate = Isolate(
            facility_id=facility.id,
            upload_batch_id=batch.id,
            specimen_date=entry.specimen_date,
            specimen_iso_year=iso_year,
            specimen_iso_week=iso_week,
            age_band=entry.age_band,
            age_exact_years=entry.age_exact_years,
            sex=entry.sex,
            care_setting=entry.care_setting,
            canonical_specimen_type_id=specimen.id,
            canonical_organism_id=organism.id,
            organism_kingdom=organism.kingdom,
            patient_linkage_key=bytes.fromhex(entry.patient_linkage_key),
            source_record_hash=entry.source_record_hash,
        )
        db.add(isolate)
        db.flush()

        for result in entry.ast_results:
            antibiotic = antibiotics.get(
                canonical(DictionaryEntityType.ANTIBIOTIC, result.antibiotic_code)
            )
            if antibiotic is None:
                continue
            db.add(
                AstResult(
                    isolate_id=isolate.id,
                    canonical_antibiotic_id=antibiotic.id,
                    result=result.result,
                    mic_value=result.mic_value,
                    mic_operator=result.mic_operator,
                    zone_diameter_mm=result.zone_diameter_mm,
                    test_method=result.test_method,
                )
            )
        accepted += 1

    return accepted


def _record_attestation(
    db: Session,
    *,
    batch: UploadBatch,
    facility: Facility,
    payload: UploadPayload,
    principal: Principal,
) -> None:
    attestation = payload.qc_attestation
    assert attestation is not None

    existing = db.scalar(
        select(QcAttestation).where(
            QcAttestation.facility_id == facility.id,
            QcAttestation.period_start == attestation.period_start,
        )
    )
    if existing is not None:
        return

    db.add(
        QcAttestation(
            facility_id=facility.id,
            period_start=attestation.period_start,
            period_end=attestation.period_end,
            status=attestation.status,
            corrective_action=attestation.corrective_action,
            notes=attestation.notes,
            submitted_at=datetime.now(UTC),
            submitted_by_id=principal.user_id,
            upload_batch_id=batch.id,
        )
    )
    audit.record(
        db,
        action=AuditAction.QC_ATTESTATION_SUBMITTED,
        entity="qc_attestation",
        entity_id=batch.id,
        principal=principal,
        after={"status": attestation.status.value},
    )

    # An attestation arriving with an upload changes whether this facility's data
    # enters the verified aggregate, and it changes it *for this batch*. Deferring
    # the recomputation to a later job would leave the antibiogram and the quality
    # dashboard disagreeing about the same facility in the interval.
    db.flush()
    gating.refresh(
        db,
        facility,
        methodology_engine.resolve(db, regional_block_id=facility.district.regional_block_id),
    )


def transition(
    db: Session,
    *,
    batch: UploadBatch,
    to_status: BatchStatus,
    principal: Principal,
    reason: str,
) -> UploadBatch:
    """Move a batch to a new lifecycle state.

    Retraction is a state change rather than a delete: the rows stay, the audit
    trail stays, and every aggregate the batch fed drops it on the next
    computation because the analytics query filters on ACCEPTED.
    """
    before = batch.status
    actions = {
        BatchStatus.ACCEPTED: AuditAction.UPLOAD_ACCEPTED,
        BatchStatus.QUARANTINED: AuditAction.UPLOAD_QUARANTINED,
        BatchStatus.RETRACTED: AuditAction.UPLOAD_RETRACTED,
        BatchStatus.REJECTED: AuditAction.UPLOAD_REJECTED,
        BatchStatus.QC_HOLD: AuditAction.UPLOAD_HELD,
    }

    batch.status = to_status
    batch.decided_at = datetime.now(UTC)
    batch.decided_by_id = principal.user_id
    batch.decision_reason = reason

    # Any move into or out of ACCEPTED changes which isolates the aggregates may
    # count — a retraction most of all, which has to stop being reported now
    # rather than whenever a cache window happens to close.
    if BatchStatus.ACCEPTED in (before, to_status):
        invalidate_record_cache()

    if to_status is BatchStatus.ACCEPTED:
        facility = db.get(Facility, batch.facility_id)
        if facility is not None and (
            facility.last_accepted_upload_at is None
            or facility.last_accepted_upload_at < batch.uploaded_at
        ):
            facility.last_accepted_upload_at = batch.uploaded_at

    audit.record(
        db,
        action=actions[to_status],
        entity="upload_batch",
        entity_id=batch.id,
        principal=principal,
        before={"status": before.value},
        after={"status": to_status.value},
        note=reason,
    )
    db.commit()
    return batch
