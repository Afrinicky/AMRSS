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

import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, fields
from datetime import date

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from amrss.analytics.records import IsolateRecord
from amrss.config import get_settings
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

    def cache_key(self) -> tuple[object, ...]:
        """A hashable form of this scope, for the record cache below.

        Every field that narrows the population is included, and the list fields
        are sorted so that two callers who asked for the same districts in a
        different order share an entry rather than computing it twice. Leaving a
        field out here would serve one scope's isolates to another's request, so
        this is derived from the dataclass fields rather than hand-listed: adding
        a filter without extending the key becomes impossible.
        """
        parts: list[object] = []
        for field_ in fields(self):
            value = getattr(self, field_.name)
            parts.append(tuple(sorted(value, key=str)) if isinstance(value, list) else value)
        return tuple(parts)


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


#: Loaded record sets, keyed by scope. See ``load_isolates`` for why this exists.
#:
#: Holds the *input* to the analytics engine, never a rendered response. That
#: distinction is the safety property: suppression, QC gating and the caller's
#: own scope are all applied downstream, per request, on top of whatever this
#: returns. A cache of finished responses could serve a facility's unsuppressed
#: figures to a public caller; this one cannot, because the key is the population
#: filter and the disclosure rules never enter it.
_records_cache: "OrderedDict[tuple[object, ...], tuple[float, list[IsolateRecord]]]" = OrderedDict()
_records_cache_lock = threading.Lock()


def invalidate_record_cache() -> None:
    """Drop every cached record set.

    Called when accepted data changes — an upload accepted, a batch retracted or
    quarantined — because those are exactly the events that change which isolates
    are eligible. Cheap and total rather than selective: a retraction can affect
    any scope containing that facility, and working out which entries those are
    costs more than rebuilding the few that are live.
    """
    with _records_cache_lock:
        _records_cache.clear()


def load_isolates(
    db: Session,
    filters: SurveillanceFilter,
    *,
    as_of: date | None = None,
    with_panels: bool = True,
) -> list[IsolateRecord]:
    """Load eligible isolates, by default with their AST panels.

    Two queries rather than one join, so that an isolate with a wide panel does
    not multiply the isolate-level rows and inflate memory on large blocks.

    ``with_panels=False`` skips the AST query entirely, leaving every record's
    ``results`` empty. Pass it only from a computation that counts isolates
    without reading a susceptibility — the specimen and organism-by-site
    explorers are the two — because the panel is the expensive half by an order
    of magnitude: on the demonstration block the isolate rows cost about 130 ms
    and their panels about 900 ms, and both explorers discarded all of it.

    Results are cached per scope for a short window. The cost being avoided is
    not the database's — Postgres answers the panel query in about 14 ms — but
    the Python-side materialisation of some 64,000 rows into objects, which is
    CPU-bound and therefore serialises behind the GIL when a dashboard page
    fetches several endpoints at once. Caching the loaded records turns the
    second and subsequent calls into a dictionary lookup, so a page's fan-out
    costs one load rather than one per endpoint.
    """
    as_of = as_of or date.today()
    settings = get_settings()
    ttl = settings.analytics_cache_ttl_seconds
    key = (*filters.cache_key(), as_of, with_panels)

    if ttl > 0:
        with _records_cache_lock:
            entry = _records_cache.get(key)
            if entry is not None:
                expires_at, cached = entry
                if expires_at > time.monotonic():
                    _records_cache.move_to_end(key)
                    return cached
                del _records_cache[key]

    records = _load_isolates_uncached(db, filters, as_of=as_of, with_panels=with_panels)

    if ttl > 0:
        with _records_cache_lock:
            _records_cache[key] = (time.monotonic() + ttl, records)
            _records_cache.move_to_end(key)
            # Bounded because each entry holds every isolate in its scope —
            # roughly 17 MB for the demonstration block — and the free tier this
            # runs on has 512 MB for the whole process.
            while len(_records_cache) > settings.analytics_cache_entries:
                _records_cache.popitem(last=False)

    return records


def _load_isolates_uncached(
    db: Session, filters: SurveillanceFilter, *, as_of: date, with_panels: bool
) -> list[IsolateRecord]:
    rows = db.execute(_base_statement(filters, as_of)).all()
    if not rows:
        return []

    panels: dict[uuid.UUID, dict[uuid.UUID, object]] = {}
    if with_panels:
        isolate_ids = [row.id for row in rows]
        for chunk_start in range(0, len(isolate_ids), 10_000):
            chunk = isolate_ids[chunk_start : chunk_start + 10_000]
            for ast in db.execute(
                select(
                    AstResult.isolate_id, AstResult.canonical_antibiotic_id, AstResult.result
                ).where(AstResult.isolate_id.in_(chunk))
            ).all():
                panels.setdefault(ast.isolate_id, {})[ast.canonical_antibiotic_id] = ast.result

    # One shared empty panel rather than one per isolate, which matters when the
    # caller asked for no panels at all and every record would otherwise allocate
    # its own. Safe because a loaded record is read-only by contract: the engine
    # only ever reads ``results``, and it has to, since the cache above hands the
    # same records to concurrent requests. Anything that needs to change a panel
    # must build a new record rather than write through this one.
    empty: dict[uuid.UUID, object] = {}
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
                results=panels.get(row.id, empty),  # type: ignore[arg-type]
            )
        )
    return records
