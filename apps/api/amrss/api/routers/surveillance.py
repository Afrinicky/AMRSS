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
from amrss.analytics import breakdowns, provenance, query, signals, trends
from amrss.analytics import coverage as coverage_engine
from amrss.analytics import methodology as methodology_engine
from amrss.analytics import profiles as profiles_engine
from amrss.api.deps import CurrentPrincipal, DbSession
from amrss.api.scope_resolution import resolve
from amrss.models import (
    CanonicalAntibiotic,
    CanonicalOrganism,
    CanonicalSpecimenType,
    District,
    Facility,
)
from amrss.models.enums import AgeBand, CareSetting, FacilityStatus, OrganismKingdom
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


class ScopeDistrict(BaseModel):
    id: uuid.UUID
    name: str
    #: Districts routinely hold several participating laboratories, so a
    #: district figure is a pooled figure. Present only where the caller may
    #: also see the facilities themselves — a count is a smaller disclosure
    #: than a roster, but it is still one.
    facility_count: int | None = None


class ScopeFacility(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    district_id: uuid.UUID


class ScopeResponse(BaseModel):
    """The geography a caller may filter by.

    Districts and facilities are returned as separate lists joined by
    ``district_id`` rather than nested, so a client can show facilities grouped
    under their district without either list having to be walked twice.
    """

    districts: list[ScopeDistrict]
    #: Empty unless the caller may see facility-level data. A list of
    #: participating laboratories is the enrolment roster, and withholding the
    #: figures while publishing the names would disclose it anyway.
    facilities: list[ScopeFacility]
    can_select_facility: bool
    #: Set for a facility-scoped account. Their view is pinned to this facility
    #: whatever the URL says, so the interface should state it rather than offer
    #: a choice that will be refused.
    pinned_facility_id: uuid.UUID | None


@router.get("/scope", response_model=ScopeResponse, tags=["reference"])
def get_scope(db: DbSession, principal: CurrentPrincipal) -> ScopeResponse:
    """Districts and facilities available as filters, for populating selectors.

    Mirrors the rules in ``scope_resolution.resolve`` exactly: what this returns
    is what that will accept. Offering a facility the API would refuse teaches a
    user nothing, and hiding one it would accept makes the data unreachable
    except by editing a URL.
    """
    block_id = resolve_block_id(db, principal)

    districts = list(
        db.scalars(
            select(District)
            .where(District.regional_block_id == block_id if block_id else True)
            .order_by(District.name)
        )
    )

    pinned = principal.facility_id
    can_select_facility = pinned is not None or principal.has(Permission.VIEW_CROSS_FACILITY)

    facilities: list[Facility] = []
    if can_select_facility:
        stmt = (
            select(Facility)
            .where(Facility.status == FacilityStatus.ACTIVE)
            .where(Facility.district_id.in_([d.id for d in districts]))
            .order_by(Facility.name)
        )
        if pinned is not None:
            stmt = stmt.where(Facility.id == pinned)
        facilities = list(db.scalars(stmt))

    counts: dict[uuid.UUID, int] = {}
    for facility in facilities:
        counts[facility.district_id] = counts.get(facility.district_id, 0) + 1

    return ScopeResponse(
        districts=[
            ScopeDistrict(
                id=district.id,
                name=district.name,
                facility_count=counts.get(district.id, 0) if can_select_facility else None,
            )
            for district in districts
        ],
        facilities=[
            ScopeFacility(
                id=facility.id,
                code=facility.code,
                name=facility.name,
                district_id=facility.district_id,
            )
            for facility in facilities
        ],
        can_select_facility=can_select_facility,
        pinned_facility_id=pinned,
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


# ---- Antibiotic Explorer ---------------------------------------------------


class AntibioticProfileResponse(BaseModel):
    antibiotic: DictionaryRef
    susceptible_percent: float
    intermediate_percent: float
    resistant_percent: float
    tested: int
    interpretable: int
    #: How pooled this bar is. One organism is a clean statistic; a dozen is a
    #: mixed population whose shape depends on what happened to be isolated.
    organism_count: int


class AntibioticExplorerResponse(BaseModel):
    profiles: list[AntibioticProfileResponse]
    minimum_isolates: int
    freshness: FreshnessResponse
    pooling_caveat: str
    clinical_framing: str = CLINICAL_FRAMING


POOLING_CAVEAT = (
    "Each bar pools one agent across every organism tested against it. Organisms differ "
    "in intrinsic susceptibility, so a pooled figure is shaped partly by which organisms "
    "were isolated. Use the antibiogram for the organism-specific answer."
)


@router.get("/antibiotics", response_model=AntibioticExplorerResponse)
def get_antibiotic_explorer(
    db: DbSession,
    principal: CurrentPrincipal,
    district_id: uuid.UUID | None = None,
    facility_id: uuid.UUID | None = None,
    care_setting: CareSetting | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> AntibioticExplorerResponse:
    """Overall resistance and susceptibility per agent (SDD 11.2, Antibiotic Explorer)."""
    scope = resolve(
        db,
        principal,
        district_id=district_id,
        facility_id=facility_id,
        care_setting=care_setting,
        date_from=date_from,
        date_to=date_to,
    )
    methodology = methodology_engine.resolve(db, regional_block_id=scope.regional_block_id)
    records = query.load_isolates(db, scope.filters)
    profiles = profiles_engine.by_antibiotic(
        records, methodology, verified_only=scope.verified_only
    )
    _, antibiotics = _dictionary_maps(db)

    return AntibioticExplorerResponse(
        profiles=[
            AntibioticProfileResponse(
                antibiotic=_ref(antibiotics[profile.antibiotic_id]),
                susceptible_percent=profile.susceptible_percent,
                intermediate_percent=profile.intermediate_percent,
                resistant_percent=profile.resistant_percent,
                tested=profile.summary.tested,
                interpretable=profile.summary.interpretable,
                organism_count=profile.organism_count,
            )
            for profile in profiles
            if profile.antibiotic_id in antibiotics
        ],
        minimum_isolates=methodology.minimum_isolates,
        freshness=_freshness_response(
            coverage_engine.freshness(
                db,
                regional_block_id=scope.regional_block_id,
                contributing_facility_ids=_contributing_facilities(records, scope.verified_only),
                coverage_start=scope.filters.date_from,
                coverage_end=scope.filters.date_to,
            )
        ),
        pooling_caveat=POOLING_CAVEAT,
    )


# ---- Organism Explorer -----------------------------------------------------


class SiteCountResponse(BaseModel):
    infection_site: str
    isolate_count: int
    percent_of_organism: float


class OrganismSiteResponse(BaseModel):
    organism: DictionaryRef
    organism_kingdom: OrganismKingdom
    isolate_count: int
    percent_of_total: float
    principal_site: str | None
    sites: list[SiteCountResponse]
    #: Isolates whose site of infection fell below the suppression threshold and
    #: is therefore not listed. Published so the listed sites can be seen not to
    #: add up, rather than leaving the shortfall to look like an error.
    withheld_isolates: int


class OrganismExplorerResponse(BaseModel):
    organisms: list[OrganismSiteResponse]
    total_isolates: int
    #: Every distinct site present, so a client can lay out a consistent axis.
    infection_sites: list[str]
    freshness: FreshnessResponse
    clinical_framing: str = CLINICAL_FRAMING


@router.get("/organisms", response_model=OrganismExplorerResponse)
def get_organism_explorer(
    db: DbSession,
    principal: CurrentPrincipal,
    district_id: uuid.UUID | None = None,
    facility_id: uuid.UUID | None = None,
    care_setting: CareSetting | None = None,
    organism_kingdom: OrganismKingdom | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> OrganismExplorerResponse:
    """Which organisms were isolated and from which sites of infection
    (SDD 11.2, Organism Explorer)."""
    scope = resolve(
        db,
        principal,
        district_id=district_id,
        facility_id=facility_id,
        care_setting=care_setting,
        organism_kingdom=organism_kingdom,
        date_from=date_from,
        date_to=date_to,
    )
    methodology = methodology_engine.resolve(db, regional_block_id=scope.regional_block_id)
    records = query.load_isolates(db, scope.filters)

    specimen_types = {s.id: s for s in db.scalars(select(CanonicalSpecimenType))}
    site_of = {
        specimen_id: specimen.infection_site for specimen_id, specimen in specimen_types.items()
    }

    organism_profiles, total = profiles_engine.by_organism_site(
        records,
        methodology,
        site_of,
        verified_only=scope.verified_only,
        apply_suppression=scope.apply_suppression,
    )
    organisms, _ = _dictionary_maps(db)

    sites: list[str] = []
    for profile in organism_profiles:
        for site in profile.sites:
            if site.infection_site not in sites:
                sites.append(site.infection_site)

    return OrganismExplorerResponse(
        organisms=[
            OrganismSiteResponse(
                organism=_ref(organisms[profile.organism_id]),
                organism_kingdom=organisms[profile.organism_id].kingdom,
                isolate_count=profile.isolate_count,
                percent_of_total=profile.percent_of_total,
                principal_site=profile.principal_site,
                sites=[
                    SiteCountResponse(
                        infection_site=site.infection_site,
                        isolate_count=site.isolate_count,
                        percent_of_organism=site.percent_of_organism,
                    )
                    for site in profile.sites
                ],
                withheld_isolates=profile.withheld_count,
            )
            for profile in organism_profiles
            if profile.organism_id in organisms
        ],
        total_isolates=total,
        infection_sites=sites,
        freshness=_freshness_response(
            coverage_engine.freshness(
                db,
                regional_block_id=scope.regional_block_id,
                contributing_facility_ids=_contributing_facilities(records, scope.verified_only),
                coverage_start=scope.filters.date_from,
                coverage_end=scope.filters.date_to,
            )
        ),
    )


# ---- Specimen Explorer -----------------------------------------------------


class SpecimenCountResponse(BaseModel):
    specimen_type: DictionaryRef
    #: Derived from the specimen type rather than collected separately (SDD 3.1),
    #: so the two can never disagree.
    infection_site: str
    #: Whether the specimen comes from a normally sterile site. A growth from
    #: blood or CSF means something a growth from a wound swab does not, and the
    #: distinction is carried in the dictionary rather than inferred from names.
    sterile_site: bool
    isolate_count: int
    percent_of_total: float


class SpecimenExplorerResponse(BaseModel):
    specimens: list[SpecimenCountResponse]
    #: Counts every isolate, including those in specimen types withheld below the
    #: suppression threshold — so the listed rows can be seen not to sum to it.
    total_isolates: int
    withheld_isolates: int
    freshness: FreshnessResponse
    clinical_framing: str = CLINICAL_FRAMING


@router.get("/specimens", response_model=SpecimenExplorerResponse)
def get_specimen_explorer(
    db: DbSession,
    principal: CurrentPrincipal,
    district_id: uuid.UUID | None = None,
    facility_id: uuid.UUID | None = None,
    care_setting: CareSetting | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> SpecimenExplorerResponse:
    """Which specimen types yielded the isolates (SDD 11.2, Specimen Explorer)."""
    scope = resolve(
        db,
        principal,
        district_id=district_id,
        facility_id=facility_id,
        care_setting=care_setting,
        date_from=date_from,
        date_to=date_to,
    )
    methodology = methodology_engine.resolve(db, regional_block_id=scope.regional_block_id)
    records = query.load_isolates(db, scope.filters)

    counts, total = profiles_engine.by_specimen(
        records,
        methodology,
        verified_only=scope.verified_only,
        apply_suppression=scope.apply_suppression,
    )
    specimen_types = {s.id: s for s in db.scalars(select(CanonicalSpecimenType))}

    listed = [
        SpecimenCountResponse(
            specimen_type=_ref(specimen_types[entry.specimen_type_id]),
            infection_site=specimen_types[entry.specimen_type_id].infection_site,
            sterile_site=specimen_types[entry.specimen_type_id].is_sterile_site,
            isolate_count=entry.isolate_count,
            percent_of_total=entry.percent_of_total,
        )
        for entry in counts
        if entry.specimen_type_id in specimen_types
    ]

    return SpecimenExplorerResponse(
        specimens=listed,
        total_isolates=total,
        withheld_isolates=total - sum(entry.isolate_count for entry in listed),
        freshness=_freshness_response(
            coverage_engine.freshness(
                db,
                regional_block_id=scope.regional_block_id,
                contributing_facility_ids=_contributing_facilities(records, scope.verified_only),
                coverage_start=scope.filters.date_from,
                coverage_end=scope.filters.date_to,
            )
        ),
    )


# ---- Drill-downs (SDD 11.2) ------------------------------------------------


class BreakdownGroupResponse(BaseModel):
    """One stratum. Mirrors the antibiogram cell states, deliberately: a reader
    who has learned what "below threshold" means in the table should not have to
    learn a second vocabulary in the breakdown beside it."""

    key: str
    label: str
    state: str
    susceptible_percent: float | None = None
    resistant_percent: float | None = None
    interpretable: int | None = None
    confidence_lower: float | None = None
    confidence_upper: float | None = None
    #: Always present. How many isolates fell here is not a susceptibility rate,
    #: and hiding it would leave a reader unable to tell an empty stratum from a
    #: withheld one.
    isolate_count: int


class BreakdownResponse(BaseModel):
    dimension: str
    description: str
    groups: list[BreakdownGroupResponse]


class OrganismDetailResponse(BaseModel):
    organism: DictionaryRef
    organism_kingdom: OrganismKingdom
    isolate_count: int
    antibiogram_eligible_count: int
    #: The organism's own row of the antibiogram, computed on the same rules so
    #: the drill-down cannot drift from the table it came from.
    agents: list[BreakdownGroupResponse]
    #: Breakdowns are per-agent because a susceptibility rate is meaningless
    #: without one. The agent chosen is named in the response.
    breakdown_antibiotic: DictionaryRef | None
    breakdowns: list[BreakdownResponse]
    minimum_isolates: int
    small_cell_threshold: int
    suppression_applied: bool
    freshness: FreshnessResponse
    methodology: dict[str, Any]
    clinical_framing: str = CLINICAL_FRAMING


class AntibioticDetailResponse(BaseModel):
    antibiotic: DictionaryRef
    #: Every organism tested against this agent. The view that makes a pooled
    #: figure interpretable: 30% susceptible means something quite different
    #: once it is clear which organisms make up the 30%.
    organisms: list[BreakdownGroupResponse]
    breakdowns: list[BreakdownResponse]
    minimum_isolates: int
    small_cell_threshold: int
    suppression_applied: bool
    freshness: FreshnessResponse
    pooling_caveat: str = POOLING_CAVEAT
    methodology: dict[str, Any]
    clinical_framing: str = CLINICAL_FRAMING


def _group_response(group: breakdowns.Group, label: str) -> BreakdownGroupResponse:
    summary = group.summary
    return BreakdownGroupResponse(
        key=str(group.key),
        label=label,
        state=group.state.value,
        susceptible_percent=summary.susceptible_percent if summary else None,
        resistant_percent=summary.resistant_percent if summary else None,
        interpretable=summary.interpretable if summary else None,
        confidence_lower=group.confidence_lower,
        confidence_upper=group.confidence_upper,
        isolate_count=group.isolate_count,
    )


def _labelled(
    groups: list[breakdowns.Group], names: dict[Any, str]
) -> list[BreakdownGroupResponse]:
    """Attach display names, dropping strata whose key is not in the dictionary.

    A stratum the dictionary cannot name is a data problem for the steward, not
    something to surface as "unknown" beside real figures.
    """
    return [_group_response(g, names[g.key]) for g in groups if g.key in names]


@router.get("/organisms/{organism_id}", response_model=OrganismDetailResponse)
def get_organism_detail(
    db: DbSession,
    principal: CurrentPrincipal,
    organism_id: uuid.UUID,
    antibiotic_id: uuid.UUID | None = None,
    district_id: uuid.UUID | None = None,
    facility_id: uuid.UUID | None = None,
    care_setting: CareSetting | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> OrganismDetailResponse:
    """One organism in depth: its agents, and where its isolates came from.

    The breakdowns are computed for a single agent because a susceptibility rate
    without one is not a statistic. Where the caller names no agent, the one
    with the most interpretable results is used and named in the response, so
    the figures are never attributed to the wrong agent by omission.
    """
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
    organisms, antibiotics = _dictionary_maps(db)
    organism = organisms.get(organism_id)
    if organism is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown organism")

    methodology = methodology_engine.resolve(db, regional_block_id=scope.regional_block_id)
    records = query.load_isolates(db, scope.filters)

    agents = breakdowns.agent_profile_for_organism(
        records, methodology, organism_id=organism_id, verified_only=scope.verified_only
    )

    chosen = antibiotic_id or next(
        (g.key for g in agents if g.state is breakdowns.GroupState.REPORTABLE), None
    )
    chosen_ref = antibiotics.get(chosen) if isinstance(chosen, uuid.UUID) else None

    breakdown_list: list[BreakdownResponse] = []
    if chosen_ref is not None and isinstance(chosen, uuid.UUID):
        breakdown_list = _build_breakdowns(
            db,
            records,
            methodology,
            scope,
            antibiotic_id=chosen,
            organism_id=organism_id,
            include_facility=principal.has(Permission.VIEW_CROSS_FACILITY),
        )

    eligible = [
        r
        for r in records
        if r.organism_id == organism_id and (r.quality_verified or not scope.verified_only)
    ]
    return OrganismDetailResponse(
        organism=_ref(organism),
        organism_kingdom=organism.kingdom,
        isolate_count=sum(1 for r in records if r.organism_id == organism_id),
        antibiogram_eligible_count=len(eligible),
        agents=_labelled(agents, {a.id: a.name for a in antibiotics.values()}),
        breakdown_antibiotic=_ref(chosen_ref) if chosen_ref else None,
        breakdowns=breakdown_list,
        minimum_isolates=methodology.minimum_isolates,
        small_cell_threshold=methodology.small_cell_threshold,
        suppression_applied=scope.apply_suppression,
        freshness=_freshness_response(
            coverage_engine.freshness(
                db,
                regional_block_id=scope.regional_block_id,
                contributing_facility_ids=_contributing_facilities(records, scope.verified_only),
                coverage_start=scope.filters.date_from,
                coverage_end=scope.filters.date_to,
            )
        ),
        methodology=provenance.cite(methodology),
    )


@router.get("/antibiotics/{antibiotic_id}", response_model=AntibioticDetailResponse)
def get_antibiotic_detail(
    db: DbSession,
    principal: CurrentPrincipal,
    antibiotic_id: uuid.UUID,
    district_id: uuid.UUID | None = None,
    facility_id: uuid.UUID | None = None,
    care_setting: CareSetting | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> AntibioticDetailResponse:
    """One agent in depth: which organisms it still works against, and where."""
    scope = resolve(
        db,
        principal,
        district_id=district_id,
        facility_id=facility_id,
        care_setting=care_setting,
        date_from=date_from,
        date_to=date_to,
    )
    organisms, antibiotics = _dictionary_maps(db)
    antibiotic = antibiotics.get(antibiotic_id)
    if antibiotic is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown antibiotic")

    methodology = methodology_engine.resolve(db, regional_block_id=scope.regional_block_id)
    records = query.load_isolates(db, scope.filters)

    organism_groups = breakdowns.organism_profile_for_agent(
        records, methodology, antibiotic_id=antibiotic_id, verified_only=scope.verified_only
    )

    return AntibioticDetailResponse(
        antibiotic=_ref(antibiotic),
        organisms=_labelled(organism_groups, {o.id: o.name for o in organisms.values()}),
        breakdowns=_build_breakdowns(
            db,
            records,
            methodology,
            scope,
            antibiotic_id=antibiotic_id,
            organism_id=None,
            include_facility=principal.has(Permission.VIEW_CROSS_FACILITY),
        ),
        minimum_isolates=methodology.minimum_isolates,
        small_cell_threshold=methodology.small_cell_threshold,
        suppression_applied=scope.apply_suppression,
        freshness=_freshness_response(
            coverage_engine.freshness(
                db,
                regional_block_id=scope.regional_block_id,
                contributing_facility_ids=_contributing_facilities(records, scope.verified_only),
                coverage_start=scope.filters.date_from,
                coverage_end=scope.filters.date_to,
            )
        ),
        methodology=provenance.cite(methodology),
    )


def _build_breakdowns(
    db: Session,
    records: list[Any],
    methodology: Any,
    scope: Any,
    *,
    antibiotic_id: uuid.UUID,
    organism_id: uuid.UUID | None,
    include_facility: bool,
) -> list[BreakdownResponse]:
    """The four dimensions SDD 11.2 asks for, each gated the same way.

    The facility breakdown is omitted entirely for anyone without cross-facility
    permission rather than returned suppressed. A clinician has no business
    seeing which laboratory contributed what, and returning a list of withheld
    facility names still discloses the roster.
    """
    specimens = {s.id: s.name for s in db.scalars(select(CanonicalSpecimenType))}
    districts = {d.id: d.name for d in db.scalars(select(District))}
    facilities = {f.id: f.name for f in db.scalars(select(Facility))}

    def build(
        dimension: str,
        description: str,
        key_of: Any,
        names: dict[Any, str],
        *,
        natural_order: list[Any] | None = None,
    ) -> BreakdownResponse:
        """One dimension, optionally in its own natural order.

        Most breakdowns are best read largest-first, which is what the engine
        returns. Age bands and care settings are not: an age breakdown listed by
        isolate count puts 45-64 above 15-44 for no reason a reader can infer,
        and scanning it becomes an exercise in re-sorting by eye.
        """
        groups = breakdowns.by_dimension(
            records,
            methodology,
            antibiotic_id=antibiotic_id,
            key_of=key_of,
            organism_id=organism_id,
            verified_only=scope.verified_only,
            apply_suppression=scope.apply_suppression,
        )
        if natural_order is not None:
            position = {key: index for index, key in enumerate(natural_order)}
            groups = sorted(groups, key=lambda g: position.get(g.key, len(position)))
        return BreakdownResponse(
            dimension=dimension, description=description, groups=_labelled(groups, names)
        )

    results = [
        build(
            "specimen_type",
            "Where the isolates were taken from. A urinary picture and a bloodstream "
            "picture can differ sharply for the same organism and agent.",
            lambda r: r.specimen_type_id,
            specimens,
        ),
        build(
            "care_setting",
            "Inpatient against outpatient. Hospital-acquired isolates are routinely "
            "less susceptible, and a pooled figure hides which population it describes.",
            lambda r: r.care_setting.value,
            {
                CareSetting.INPATIENT.value: "Inpatient",
                CareSetting.OUTPATIENT.value: "Outpatient",
                CareSetting.UNKNOWN.value: "Setting not recorded",
            },
            natural_order=[s.value for s in CareSetting],
        ),
        build(
            "age_band",
            "Age band at collection, as banded on submission — never an exact age.",
            lambda r: r.age_band.value,
            # The enum values are already the printed labels ("<5", "15-44",
            # "65+"); the declaration order is age order, so it doubles as the
            # display order.
            {
                band.value: ("Age not recorded" if band is AgeBand.UNKNOWN else band.value)
                for band in AgeBand
            },
            natural_order=[band.value for band in AgeBand],
        ),
        build(
            "district",
            "Which districts contributed the isolates behind this figure.",
            lambda r: r.district_id,
            districts,
        ),
    ]
    if include_facility:
        results.append(
            build(
                "facility",
                "Contributing laboratories. Visible only with cross-facility permission, "
                "and never used to rank one laboratory against another.",
                lambda r: r.facility_id,
                facilities,
            )
        )
    return results


# ---- Comparison heat map (SDD 11.2) ----------------------------------------


class MatrixRowResponse(BaseModel):
    key: str
    label: str
    isolate_count: int
    cells: list[BreakdownGroupResponse]


class ComparisonResponse(BaseModel):
    dimension: str
    organism: DictionaryRef | None
    antibiotics: list[DictionaryRef]
    rows: list[MatrixRowResponse]
    minimum_isolates: int
    small_cell_threshold: int
    suppression_applied: bool
    freshness: FreshnessResponse
    methodology: dict[str, Any]
    #: Non-negotiable framing for this view specifically. A grid of facilities
    #: against agents is one design decision away from a league table, and a
    #: laboratory that fears being ranked reports less.
    comparison_caveat: str
    clinical_framing: str = CLINICAL_FRAMING


COMPARISON_CAVEAT = (
    "Differences between geographies reflect the organisms and specimens each one happens to "
    "submit as much as any difference in resistance, and are not a measure of laboratory "
    "performance. Read this as a map of where to look, never as a ranking."
)

#: Geographic rendering — a true choropleth over district boundaries — needs
#: boundary geometry AMRSS does not hold. The matrix carries the same finding
#: (which geography differs, and on what) without inventing coordinates, and a
#: map can be layered on later from the same endpoint.
GEOGRAPHY_NOTE = (
    "Shown as a matrix rather than a map: AMRSS holds no district boundary geometry, and "
    "positioning facilities on an invented map would misrepresent where they are."
)


@router.get("/comparison", response_model=ComparisonResponse)
def get_comparison(
    db: DbSession,
    principal: CurrentPrincipal,
    dimension: str = "district",
    organism_id: uuid.UUID | None = None,
    district_id: uuid.UUID | None = None,
    care_setting: CareSetting | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> ComparisonResponse:
    """Susceptibility across districts or facilities, agent by agent.

    An agent that works regionally but has collapsed in one district is
    invisible in a pooled figure, and finding that is the whole point of the
    view.

    Facility comparison requires cross-facility permission. Without it the
    request is refused rather than silently downgraded to districts: a caller
    who asked for facilities and received districts would misread the result.
    """
    if dimension not in ("district", "facility"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="dimension must be 'district' or 'facility'",
        )
    if dimension == "facility" and not principal.has(Permission.VIEW_CROSS_FACILITY):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Comparing facilities requires cross-facility permission",
        )

    scope = resolve(
        db,
        principal,
        district_id=district_id,
        organism_ids=[organism_id] if organism_id else None,
        care_setting=care_setting,
        date_from=date_from,
        date_to=date_to,
    )
    organisms, antibiotics = _dictionary_maps(db)
    organism = organisms.get(organism_id) if organism_id else None
    if organism_id and organism is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown organism")

    methodology = methodology_engine.resolve(db, regional_block_id=scope.regional_block_id)
    records = query.load_isolates(db, scope.filters)

    names: dict[Any, str]
    if dimension == "facility":
        names = {f.id: f.name for f in db.scalars(select(Facility))}
        key_of: Any = lambda record: record.facility_id  # noqa: E731
    else:
        names = {d.id: d.name for d in db.scalars(select(District))}
        key_of = lambda record: record.district_id  # noqa: E731

    rows, ordered_agents = breakdowns.matrix(
        records,
        methodology,
        key_of=key_of,
        organism_id=organism_id,
        verified_only=scope.verified_only,
        apply_suppression=scope.apply_suppression,
    )

    return ComparisonResponse(
        dimension=dimension,
        organism=_ref(organism) if organism else None,
        antibiotics=[_ref(antibiotics[a]) for a in ordered_agents if a in antibiotics],
        rows=[
            MatrixRowResponse(
                key=str(row.key),
                label=names[row.key],
                isolate_count=row.isolate_count,
                cells=[
                    _group_response(row.cells[a], antibiotics[a].name)
                    for a in ordered_agents
                    if a in antibiotics and a in row.cells
                ],
            )
            for row in rows
            if row.key in names
        ],
        minimum_isolates=methodology.minimum_isolates,
        small_cell_threshold=methodology.small_cell_threshold,
        suppression_applied=scope.apply_suppression,
        freshness=_freshness_response(
            coverage_engine.freshness(
                db,
                regional_block_id=scope.regional_block_id,
                contributing_facility_ids=_contributing_facilities(records, scope.verified_only),
                coverage_start=scope.filters.date_from,
                coverage_end=scope.filters.date_to,
            )
        ),
        methodology=provenance.cite(methodology),
        comparison_caveat=f"{COMPARISON_CAVEAT} {GEOGRAPHY_NOTE}",
    )
