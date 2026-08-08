"""Loading eligible isolates for analysis.

Eligibility is enforced here, once, so no downstream computation can accidentally
include data that should not contribute:

- the batch carrying the isolate is ACCEPTED (SDD 9.6 — quarantined and retracted
  batches drop out automatically, which is what makes retraction recompute
  correctly rather than requiring a separate cleanup);
- the facility is ACTIVE (SDD 9.2).

Facility QC/EQA gating is *not* applied as a filter. It is attached to each record
as ``quality_verified``, because SDD 6.6 requires the exclusion to be visible —
the interface has to say how many facilities were held out, which is impossible if
they were filtered away before anything counted them.
"""

import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from amrss.analytics.records import IsolateRecord
from amrss.models import AstResult, District, Facility, Isolate, UploadBatch
from amrss.models.enums import BatchStatus, CareSetting, FacilityStatus, OrganismKingdom


@dataclass(frozen=True)
class SurveillanceFilter:
    """Scope of an analysis. Every field is optional and narrows the population."""

    regional_block_id: uuid.UUID | None = None
    district_ids: list[uuid.UUID] | None = None
    facility_ids: list[uuid.UUID] | None = None
    organism_ids: list[uuid.UUID] | None = None
    specimen_type_ids: list[uuid.UUID] | None = None
    care_setting: CareSetting | None = None
    organism_kingdom: OrganismKingdom | None = None
    age_bands: list[str] | None = None
    date_from: date | None = None
    date_to: date | None = None

    def describe(self) -> dict[str, object]:
        """Human-readable form for the provenance disclosure (SDD 5.9)."""
        described: dict[str, object] = {}
        if self.date_from or self.date_to:
            described["period"] = {
                "from": self.date_from.isoformat() if self.date_from else None,
                "to": self.date_to.isoformat() if self.date_to else None,
            }
        if self.district_ids:
            described["districts"] = len(self.district_ids)
        if self.facility_ids:
            described["facilities"] = len(self.facility_ids)
        if self.care_setting:
            described["care_setting"] = self.care_setting.value
        if self.organism_kingdom:
            described["organism_kingdom"] = self.organism_kingdom.value
        if self.age_bands:
            described["age_bands"] = self.age_bands
        return described


def _base_statement(filters: SurveillanceFilter, as_of: date) -> Select:
    stmt = (
        select(
            Isolate.id,
            Isolate.facility_id,
            District.id.label("district_id"),
            Isolate.specimen_date,
            Isolate.canonical_organism_id,
            Isolate.organism_kingdom,
            Isolate.canonical_specimen_type_id,
            Isolate.care_setting,
            Isolate.age_band,
            Isolate.sex,
            Isolate.patient_linkage_key,
            Facility.qc_status,
            Facility.qc_valid_until,
            Facility.eqa_status,
            Facility.eqa_valid_until,
        )
        .join(UploadBatch, UploadBatch.id == Isolate.upload_batch_id)
        .join(Facility, Facility.id == Isolate.facility_id)
        .join(District, District.id == Facility.district_id)
        .where(
            UploadBatch.status == BatchStatus.ACCEPTED,
            Facility.status == FacilityStatus.ACTIVE,
        )
    )

    if filters.regional_block_id is not None:
        stmt = stmt.where(District.regional_block_id == filters.regional_block_id)
    if filters.district_ids is not None:
        stmt = stmt.where(District.id.in_(filters.district_ids))
    if filters.facility_ids is not None:
        stmt = stmt.where(Facility.id.in_(filters.facility_ids))
    if filters.organism_ids is not None:
        stmt = stmt.where(Isolate.canonical_organism_id.in_(filters.organism_ids))
    if filters.specimen_type_ids is not None:
        stmt = stmt.where(Isolate.canonical_specimen_type_id.in_(filters.specimen_type_ids))
    if filters.care_setting is not None:
        stmt = stmt.where(Isolate.care_setting == filters.care_setting)
    if filters.organism_kingdom is not None:
        stmt = stmt.where(Isolate.organism_kingdom == filters.organism_kingdom)
    if filters.age_bands:
        stmt = stmt.where(Isolate.age_band.in_(filters.age_bands))
    if filters.date_from is not None:
        stmt = stmt.where(Isolate.specimen_date >= filters.date_from)
    if filters.date_to is not None:
        stmt = stmt.where(Isolate.specimen_date <= filters.date_to)

    return stmt


def load_isolates(
    db: Session, filters: SurveillanceFilter, *, as_of: date | None = None
) -> list[IsolateRecord]:
    """Load eligible isolates with their AST panels.

    Two queries rather than one join, so that an isolate with a wide panel does
    not multiply the isolate-level rows and inflate memory on large blocks.
    """
    as_of = as_of or date.today()
    rows = db.execute(_base_statement(filters, as_of)).all()
    if not rows:
        return []

    isolate_ids = [row.id for row in rows]
    panels: dict[uuid.UUID, dict[uuid.UUID, object]] = {}
    for chunk_start in range(0, len(isolate_ids), 10_000):
        chunk = isolate_ids[chunk_start : chunk_start + 10_000]
        for ast in db.execute(
            select(AstResult.isolate_id, AstResult.canonical_antibiotic_id, AstResult.result).where(
                AstResult.isolate_id.in_(chunk)
            )
        ).all():
            panels.setdefault(ast.isolate_id, {})[ast.canonical_antibiotic_id] = ast.result

    records: list[IsolateRecord] = []
    for row in rows:
        qc_ok = row.qc_status == "satisfactory" and (
            row.qc_valid_until is None or row.qc_valid_until >= as_of
        )
        eqa_ok = row.eqa_status == "satisfactory" and (
            row.eqa_valid_until is None or row.eqa_valid_until >= as_of
        )
        records.append(
            IsolateRecord(
                id=row.id,
                facility_id=row.facility_id,
                district_id=row.district_id,
                specimen_date=row.specimen_date,
                organism_id=row.canonical_organism_id,
                organism_kingdom=row.organism_kingdom,
                specimen_type_id=row.canonical_specimen_type_id,
                care_setting=row.care_setting,
                age_band=row.age_band,
                sex=row.sex,
                patient_linkage_key=row.patient_linkage_key,
                quality_verified=qc_ok and eqa_ok,
                results=panels.get(row.id, {}),  # type: ignore[arg-type]
            )
        )
    return records
