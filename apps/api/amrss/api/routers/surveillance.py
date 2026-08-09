"""Surveillance analytics endpoints.

Response shapes enforce the SDD 11.3 display rules at the API layer rather than
trusting each client to follow them: a susceptibility percentage is only ever
returned inside an object that also carries its n and period, and a
below-threshold or suppressed cell carries a state with no percentage at all. A
client cannot render a bare percentage because the API never hands it one.
"""

import uuid
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from amrss.analytics import alerts as alerts_engine
from amrss.analytics import antibiogram as antibiogram_engine
from amrss.analytics import coverage as coverage_engine
from amrss.analytics import methodology as methodology_engine
from amrss.analytics import provenance, query, signals, trends
from amrss.api.deps import CurrentPrincipal, DbSession
from amrss.api.scope_resolution import resolve
from amrss.models import CanonicalAntibiotic, CanonicalOrganism, CanonicalSpecimenType
from amrss.models.enums import CareSetting, OrganismKingdom
from amrss.security.permissions import Permission
from amrss.security.scope import resolve_block_id

router = APIRouter(prefix="/surveillance", tags=["surveillance"])

CLINICAL_FRAMING = (
    "Susceptibility data reflect regional surveillance patterns and support clinical "
    "decision-making; they do not replace individualized clinical judgment."
)


class DictionaryRef(BaseModel):
    id: uuid.UUID
    code: str
    name: str


class FreshnessResponse(BaseModel):
    """Required on every analytical view (SDD 4.2)."""

    data_last_updated: str | None
    coverage_start: str | None
    coverage_end: str | None
    facilities_contributing: int
    facilities_expected: int
    latest_facility_submission: str | None
    completeness_percent: float | None
    is_stale: bool


class CellResponse(BaseModel):
    antibiotic_id: uuid.UUID
    state: str
    #: Present only when state is "reportable". A suppressed cell carries no
    #: counts either — releasing n while hiding the percentage would leak the
    #: same small cell.
    susceptible_percent: float | None = None
    resistant_percent: float | None = None
    tested: int | None = None
    interpretable: int | None = None
    confidence_lower: float | None = None
    confidence_upper: float | None = None
    uncertainty_cue: bool = False


class RowResponse(BaseModel):
    organism: DictionaryRef
    organism_kingdom: OrganismKingdom
    isolate_count: int
    cells: list[CellResponse]


class QualityExclusionResponse(BaseModel):
    """SDD 6.6 requires exclusion to be visible, never silent."""

    facilities_excluded: int
    isolates_excluded: int
    note: str


class AntibiogramResponse(BaseModel):
    aggregation_level: str
    rows: list[RowResponse]
    antibiotics: list[DictionaryRef]
    freshness: FreshnessResponse
    quality_exclusion: QualityExclusionResponse
    raw_isolate_count: int
    antibiogram_eligible_count: int
    minimum_isolates: int
    small_cell_threshold: int
    suppression_applied: bool
    #: Measurements awaiting breakpoint interpretation. A large value alongside
    #: an empty table means breakpoints are missing, not data.
    pending_interpretation_count: int
    methodology: dict[str, Any]
    clinical_framing: str = CLINICAL_FRAMING


FilterQuery = Annotated[list[uuid.UUID] | None, Query()]


def _dictionary_maps(
    db: Session,
) -> tuple[dict[uuid.UUID, CanonicalOrganism], dict[uuid.UUID, CanonicalAntibiotic]]:
    organisms = {o.id: o for o in db.scalars(select(CanonicalOrganism))}
    antibiotics = {a.id: a for a in db.scalars(select(CanonicalAntibiotic))}
    return organisms, antibiotics


def _ref(entry: CanonicalOrganism | CanonicalAntibiotic | CanonicalSpecimenType) -> DictionaryRef:
    return DictionaryRef(id=entry.id, code=entry.code, name=entry.name)


@router.get("/antibiogram", response_model=AntibiogramResponse)
def get_antibiogram(
    db: DbSession,
    principal: CurrentPrincipal,
    district_id: uuid.UUID | None = None,
    facility_id: uuid.UUID | None = None,
    organism_id: FilterQuery = None,
    specimen_type_id: FilterQuery = None,
    care_setting: CareSetting | None = None,
    organism_kingdom: OrganismKingdom | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> AntibiogramResponse:
    scope = resolve(
        db,
        principal,
        district_id=district_id,
        facility_id=facility_id,
        organism_ids=organism_id,
        specimen_type_ids=specimen_type_id,
        care_setting=care_setting,
        organism_kingdom=organism_kingdom,
        date_from=date_from,
        date_to=date_to,
    )

    methodology = methodology_engine.resolve(db, regional_block_id=scope.regional_block_id)
    records = query.load_isolates(db, scope.filters)
    result = antibiogram_engine.compute(
        records,
        methodology,
        level=scope.level,
        apply_suppression=scope.apply_suppression,
        verified_only=scope.verified_only,
    )

    organisms, antibiotics = _dictionary_maps(db)
    ordered_antibiotic_ids = sorted(
        (aid for aid in result.antibiotic_ids if aid in antibiotics),
        key=lambda aid: (antibiotics[aid].display_order, antibiotics[aid].name),
    )

    rows = []
    for row in result.rows:
        organism = organisms.get(row.organism_id)
        if organism is None:
            continue
        cells = []
        for antibiotic_id in ordered_antibiotic_ids:
            cell = row.cells.get(antibiotic_id)
            if cell is None:
                continue
            summary = cell.summary
            interval = cell.confidence_interval
            cells.append(
                CellResponse(
                    antibiotic_id=antibiotic_id,
                    state=cell.state.value,
                    susceptible_percent=summary.susceptible_percent if summary else None,
                    resistant_percent=summary.resistant_percent if summary else None,
                    tested=summary.tested if summary else None,
                    interpretable=summary.interpretable if summary else None,
                    confidence_lower=interval.lower if interval else None,
                    confidence_upper=interval.upper if interval else None,
                    uncertainty_cue=cell.uncertainty_cue,
                )
            )
        rows.append(
            RowResponse(
                organism=_ref(organism),
                organism_kingdom=row.organism_kingdom,
                isolate_count=row.isolate_count,
                cells=cells,
            )
        )

    freshness = coverage_engine.freshness(
        db,
        regional_block_id=scope.regional_block_id,
        contributing_facility_ids=result.contributing_facility_ids,
        coverage_start=result.period_start,
        coverage_end=result.period_end,
    )

    excluded = result.quality_exclusion
    return AntibiogramResponse(
        aggregation_level=result.level.value,
        rows=rows,
        antibiotics=[_ref(antibiotics[aid]) for aid in ordered_antibiotic_ids],
        freshness=_freshness_response(freshness),
        quality_exclusion=QualityExclusionResponse(
            facilities_excluded=excluded.excluded_facility_count,
            isolates_excluded=excluded.excluded_isolate_count,
            note=(
                f"{excluded.excluded_facility_count} facility(ies) are excluded from this "
                "verified aggregate because their QC attestation or EQA status is not "
                "current and satisfactory."
                if excluded.excluded_facility_count
                else "No facilities are currently excluded on quality grounds."
            ),
        ),
        raw_isolate_count=result.raw_isolate_count,
        antibiogram_eligible_count=result.deduplication.retained_isolates,
        minimum_isolates=result.minimum_isolates,
        small_cell_threshold=result.small_cell_threshold,
        suppression_applied=result.suppression_applied,
        pending_interpretation_count=result.pending_interpretation_count,
        methodology=provenance.describe(result, methodology, scope.filters),
    )


def _contributing_facilities(records: list, verified_only: bool) -> set[uuid.UUID]:
    """Facilities whose data actually reached the figures on this page.

    Must match the population the view computed over. Counting quality-excluded
    facilities as contributing would show a different coverage fraction on the
    alerts page than on the antibiogram for the same period — and a user who
    notices two coverage numbers disagreeing has no way to tell which is wrong.
    """
    return {
        record.facility_id for record in records if record.quality_verified or not verified_only
    }


def _freshness_response(freshness: coverage_engine.DataFreshness) -> FreshnessResponse:
    return FreshnessResponse(
        data_last_updated=(
            freshness.data_last_updated.isoformat() if freshness.data_last_updated else None
        ),
        coverage_start=freshness.coverage_start.isoformat() if freshness.coverage_start else None,
        coverage_end=freshness.coverage_end.isoformat() if freshness.coverage_end else None,
        facilities_contributing=freshness.facilities_contributing,
        facilities_expected=freshness.facilities_expected,
        latest_facility_submission=(
            freshness.latest_facility_submission.isoformat()
            if freshness.latest_facility_submission
            else None
        ),
        completeness_percent=freshness.completeness_percent,
        is_stale=freshness.is_stale,
    )


class TrendPointResponse(BaseModel):
    label: str
    bucket_start: str
    bucket_end: str
    susceptible_percent: float | None
    isolate_count: int
    sufficient: bool
    confidence_lower: float | None = None
    confidence_upper: float | None = None


class TrendResponse(BaseModel):
    organism: DictionaryRef
    antibiotic: DictionaryRef
    bucket: str
    minimum_isolates: int
    points: list[TrendPointResponse]
    freshness: FreshnessResponse
    clinical_framing: str = CLINICAL_FRAMING


@router.get("/trend", response_model=TrendResponse)
def get_trend(
    db: DbSession,
    principal: CurrentPrincipal,
    organism_id: uuid.UUID,
    antibiotic_id: uuid.UUID,
    bucket: trends.TimeBucket = trends.TimeBucket.MONTH,
    district_id: uuid.UUID | None = None,
    facility_id: uuid.UUID | None = None,
    care_setting: CareSetting | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> TrendResponse:
    """Susceptibility over time. Buckets below the minimum isolate count return
    ``sufficient: false`` with no percentage, so a client cannot draw a line
    through them (SDD 5.7)."""
    scope = resolve(
        db,
        principal,
        district_id=district_id,
        facility_id=facility_id,
        organism_ids=[organism_id],
        care_setting=care_setting,
        date_from=date_from,
        date_to=date_to,
    )

    organism = db.get(CanonicalOrganism, organism_id)
    antibiotic = db.get(CanonicalAntibiotic, antibiotic_id)
    if organism is None or antibiotic is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Organism or antibiotic not found"
        )

    methodology = methodology_engine.resolve(db, regional_block_id=scope.regional_block_id)
    records = query.load_isolates(db, scope.filters)
    series = trends.compute_series(
        records,
        methodology,
        organism_id=organism_id,
        antibiotic_id=antibiotic_id,
        bucket=bucket,
        verified_only=scope.verified_only,
    )

    freshness = coverage_engine.freshness(
        db,
        regional_block_id=scope.regional_block_id,
        contributing_facility_ids=_contributing_facilities(records, scope.verified_only),
        coverage_start=scope.filters.date_from,
        coverage_end=scope.filters.date_to,
    )

    return TrendResponse(
        organism=_ref(organism),
        antibiotic=_ref(antibiotic),
        bucket=series.bucket.value,
        minimum_isolates=series.minimum_isolates,
        points=[
            TrendPointResponse(
                label=point.label,
                bucket_start=point.bucket_start.isoformat(),
                bucket_end=point.bucket_end.isoformat(),
                susceptible_percent=(point.summary.susceptible_percent if point.summary else None),
                isolate_count=point.isolate_count,
                sufficient=point.sufficient,
                confidence_lower=(
                    point.confidence_interval.lower if point.confidence_interval else None
                ),
                confidence_upper=(
                    point.confidence_interval.upper if point.confidence_interval else None
                ),
            )
            for point in series.points
        ],
        freshness=_freshness_response(freshness),
    )


class SignalResponse(BaseModel):
    organism: DictionaryRef
    antibiotic: DictionaryRef
    baseline_start: str
    baseline_end: str
    baseline_susceptible_percent: float
    baseline_n: int
    current_start: str
    current_end: str
    current_susceptible_percent: float
    current_n: int
    change_percentage_points: float
    #: Always "Signal — requires expert review". AMRSS does not determine outbreaks.
    status_label: str


class AlertResponse(BaseModel):
    organism: DictionaryRef
    antibiotic: DictionaryRef
    non_susceptible_count: int
    isolates: int
    first_seen: str
    last_seen: str
    facility_count: int
    caveat: str


class AlertsResponse(BaseModel):
    emerging_signals: list[SignalResponse]
    below_threshold_alerts: list[AlertResponse]
    freshness: FreshnessResponse
    note: str = (
        "Signals and below-threshold observations are separated from the antibiogram "
        "because they do not meet the reporting threshold. They are for situational "
        "awareness and expert review, not susceptibility rates."
    )


@router.get("/alerts", response_model=AlertsResponse)
def get_alerts(
    db: DbSession,
    principal: CurrentPrincipal,
    district_id: uuid.UUID | None = None,
    facility_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> AlertsResponse:
    scope = resolve(
        db,
        principal,
        district_id=district_id,
        facility_id=facility_id,
        date_from=date_from,
        date_to=date_to,
    )
    methodology = methodology_engine.resolve(db, regional_block_id=scope.regional_block_id)
    records = query.load_isolates(db, scope.filters)
    organisms, antibiotics = _dictionary_maps(db)

    detected = signals.detect(records, methodology, verified_only=scope.verified_only)
    watch_list = {
        organism.id for organism in organisms.values() if organism.is_organism_of_special_importance
    }
    below_threshold = alerts_engine.detect(
        records, methodology, watch_list, verified_only=scope.verified_only
    )

    freshness = coverage_engine.freshness(
        db,
        regional_block_id=scope.regional_block_id,
        contributing_facility_ids=_contributing_facilities(records, scope.verified_only),
        coverage_start=scope.filters.date_from,
        coverage_end=scope.filters.date_to,
    )

    return AlertsResponse(
        emerging_signals=[
            SignalResponse(
                organism=_ref(organisms[signal.organism_id]),
                antibiotic=_ref(antibiotics[signal.antibiotic_id]),
                baseline_start=signal.baseline.start.isoformat(),
                baseline_end=signal.baseline.end.isoformat(),
                baseline_susceptible_percent=signal.baseline.susceptible_percent,
                baseline_n=signal.baseline.interpretable,
                current_start=signal.current.start.isoformat(),
                current_end=signal.current.end.isoformat(),
                current_susceptible_percent=signal.current.susceptible_percent,
                current_n=signal.current.interpretable,
                change_percentage_points=signal.change_percentage_points,
                status_label=signal.status_label,
            )
            for signal in detected
            if signal.organism_id in organisms and signal.antibiotic_id in antibiotics
        ],
        below_threshold_alerts=[
            AlertResponse(
                organism=_ref(organisms[alert.organism_id]),
                antibiotic=_ref(antibiotics[alert.antibiotic_id]),
                non_susceptible_count=alert.non_susceptible_count,
                isolates=alert.summary.interpretable,
                first_seen=alert.first_seen.isoformat(),
                last_seen=alert.last_seen.isoformat(),
                facility_count=alert.facility_count,
                caveat=alert.caveat,
            )
            for alert in below_threshold
            if alert.organism_id in organisms and alert.antibiotic_id in antibiotics
        ],
        freshness=_freshness_response(freshness),
    )


class FacilityReportingResponse(BaseModel):
    facility_id: uuid.UUID
    facility_name: str
    district_name: str
    schedule: str
    expected_interval_days: int
    last_accepted_upload_at: str | None
    days_since_last_upload: int | None
    is_overdue: bool
    quality_verified: bool


class CoverageResponse(BaseModel):
    enrolled_facilities: int
    active_facilities: int
    reporting_this_week: int
    reporting_this_month: int
    overdue_facilities: int
    isolates_this_month: int
    districts_covered: int
    districts_total: int
    facilities_excluded_by_quality: int
    #: Per-facility detail, including which laboratories are overdue. Empty for
    #: callers without cross-facility access: the aggregate counts are the
    #: representativeness context a clinician needs, whereas naming individual
    #: laboratories as overdue is an administrative matter (SDD 4.3).
    facilities: list[FacilityReportingResponse]


@router.get("/coverage", response_model=CoverageResponse)
def get_coverage(db: DbSession, principal: CurrentPrincipal) -> CoverageResponse:
    """Whether the regional pattern is actually representative (SDD 4.3)."""
    if not (
        principal.has(Permission.VIEW_REGIONAL) or principal.has(Permission.VIEW_CROSS_FACILITY)
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Requires permission: surveillance:view_regional",
        )

    summary = coverage_engine.summarise_coverage(
        db, regional_block_id=resolve_block_id(db, principal)
    )
    include_facility_detail = principal.has(Permission.VIEW_CROSS_FACILITY)

    return CoverageResponse(
        enrolled_facilities=summary.enrolled_facilities,
        active_facilities=summary.active_facilities,
        reporting_this_week=summary.reporting_this_week,
        reporting_this_month=summary.reporting_this_month,
        overdue_facilities=summary.overdue_facilities,
        isolates_this_month=summary.isolates_this_month,
        districts_covered=summary.districts_covered,
        districts_total=summary.districts_total,
        facilities_excluded_by_quality=summary.facilities_excluded_by_quality,
        facilities=[
            FacilityReportingResponse(
                facility_id=facility.facility_id,
                facility_name=facility.facility_name,
                district_name=facility.district_name,
                schedule=facility.schedule.value,
                expected_interval_days=facility.expected_interval_days,
                last_accepted_upload_at=(
                    facility.last_accepted_upload_at.isoformat()
                    if facility.last_accepted_upload_at
                    else None
                ),
                days_since_last_upload=facility.days_since_last_upload,
                is_overdue=facility.is_overdue,
                quality_verified=facility.quality_verified,
            )
            for facility in (summary.facility_status if include_facility_detail else [])
        ],
    )


class ReferenceResponse(BaseModel):
    organisms: list[dict[str, Any]]
    antibiotics: list[dict[str, Any]]
    specimen_types: list[dict[str, Any]]


@router.get("/reference", response_model=ReferenceResponse, tags=["reference"])
def get_reference(db: DbSession, principal: CurrentPrincipal) -> ReferenceResponse:
    """Canonical dictionary, for populating filters in any client."""
    return ReferenceResponse(
        organisms=[
            {
                "id": str(organism.id),
                "code": organism.code,
                "name": organism.name,
                "kingdom": organism.kingdom.value,
                "gram_stain": organism.gram_stain,
                "special_importance": organism.is_organism_of_special_importance,
            }
            for organism in db.scalars(
                select(CanonicalOrganism)
                .where(CanonicalOrganism.is_active.is_(True))
                .order_by(CanonicalOrganism.name)
            )
        ],
        antibiotics=[
            {
                "id": str(antibiotic.id),
                "code": antibiotic.code,
                "name": antibiotic.name,
                "class": antibiotic.antimicrobial_class.value,
                "target_kingdom": antibiotic.target_kingdom.value,
                "who_aware_category": antibiotic.who_aware_category,
                "display_order": antibiotic.display_order,
            }
            for antibiotic in db.scalars(
                select(CanonicalAntibiotic)
                .where(CanonicalAntibiotic.is_active.is_(True))
                .order_by(CanonicalAntibiotic.display_order)
            )
        ],
        specimen_types=[
            {
                "id": str(specimen.id),
                "code": specimen.code,
                "name": specimen.name,
                "infection_site": specimen.infection_site,
                "sterile_site": specimen.is_sterile_site,
            }
            for specimen in db.scalars(
                select(CanonicalSpecimenType)
                .where(CanonicalSpecimenType.is_active.is_(True))
                .order_by(CanonicalSpecimenType.name)
            )
        ],
    )
