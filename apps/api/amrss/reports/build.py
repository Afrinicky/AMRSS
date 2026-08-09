"""Assembling a report's content.

Every figure here comes from the same engine that serves the dashboard: the
same antibiogram computation, the same reporting threshold, the same
suppression, the same QC/EQA gating. The alternative — a second query written
for reporting — is how a report ends up disclosing a cell the dashboard hides,
and nobody notices until it has been circulated.

The methodology versions in force are captured alongside, because a report
outlives the rules that produced it. A quarterly report read a year later is a
set of numbers whose thresholds are unknowable without them.
"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from amrss.analytics import antibiogram as antibiogram_engine
from amrss.analytics import coverage as coverage_engine
from amrss.analytics import methodology as methodology_engine
from amrss.analytics import provenance, query, signals
from amrss.analytics.antibiogram import AggregationLevel
from amrss.analytics.query import SurveillanceFilter
from amrss.models import (
    CanonicalAntibiotic,
    CanonicalOrganism,
    District,
    Facility,
    RegionalBlock,
)
from amrss.models.enums import ReportPeriod

CLINICAL_FRAMING = (
    "Susceptibility data reflect regional surveillance patterns and support clinical "
    "decision-making; they do not replace individualized clinical judgment."
)

WITHHELD = "—"


@dataclass(frozen=True)
class ReportCell:
    """One antibiogram cell, already resolved to what may be printed.

    A withheld cell carries no percentage and no counts. The renderer is given
    nothing to accidentally print, rather than being trusted to check a flag.
    """

    display: str
    n_display: str
    reportable: bool


@dataclass(frozen=True)
class ReportRow:
    organism: str
    kingdom: str
    isolate_count: int
    cells: list[ReportCell]


@dataclass
class ReportContent:
    title: str
    scope_label: str
    period: ReportPeriod
    period_start: date
    period_end: date
    generated_at: datetime

    antibiotics: list[str]
    rows: list[ReportRow]

    #: Coverage and freshness exactly as the dashboard states them. A report
    #: without them invites its figures to be read as complete.
    facilities_contributing: int
    facilities_expected: int
    facilities_excluded_by_quality: int
    isolates_excluded_by_quality: int
    completeness_percent: float | None
    data_last_updated: str | None

    raw_isolate_count: int
    eligible_isolate_count: int
    pending_interpretation_count: int
    minimum_isolates: int
    small_cell_threshold: int

    methodology: dict = field(default_factory=dict)
    signals: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    clinical_framing: str = CLINICAL_FRAMING


_ONE_DAY = timedelta(days=1)


def period_bounds(period: ReportPeriod, anchor: date) -> tuple[date, date]:
    """The calendar period containing ``anchor``.

    Whole calendar periods, never a rolling window ending today: a monthly
    report generated on the 12th that silently covered twelve days would be
    compared against last month's full one.
    """
    if period is ReportPeriod.MONTHLY:
        start = anchor.replace(day=1)
        end = (
            start.replace(year=start.year + 1, month=1)
            if start.month == 12
            else start.replace(month=start.month + 1)
        ) - _ONE_DAY
        return start, end
    if period is ReportPeriod.QUARTERLY:
        first_month = 3 * ((anchor.month - 1) // 3) + 1
        start = anchor.replace(month=first_month, day=1)
        end = (
            start.replace(year=start.year + 1, month=1)
            if first_month == 10
            else start.replace(month=first_month + 3)
        ) - _ONE_DAY
        return start, end
    if period is ReportPeriod.ANNUAL:
        return anchor.replace(month=1, day=1), anchor.replace(month=12, day=31)
    raise ValueError("An ad-hoc report must be given explicit bounds")


def _scope_label(
    db: Session,
    *,
    regional_block_id: uuid.UUID | None,
    district_id: uuid.UUID | None,
    facility_id: uuid.UUID | None,
) -> str:
    """Name the population a report describes, most specific first.

    Not decoration. A district antibiogram circulated without its scope on the
    front page is indistinguishable from a regional one, and the two carry very
    different prescribing implications.
    """
    if facility_id is not None:
        facility = db.get(Facility, facility_id)
        if facility is not None:
            return f"{facility.name} ({facility.district.name})"
    if district_id is not None:
        district = db.get(District, district_id)
        if district is not None:
            return f"{district.name} district"
    if regional_block_id is not None:
        block = db.get(RegionalBlock, regional_block_id)
        if block is not None:
            return block.name
    return "All contributing laboratories"


def build(
    db: Session,
    *,
    period: ReportPeriod,
    period_start: date,
    period_end: date,
    regional_block_id: uuid.UUID | None = None,
    district_id: uuid.UUID | None = None,
    facility_id: uuid.UUID | None = None,
    include_signals: bool = True,
) -> ReportContent:
    """Compute a report's content through the dashboard's own engine."""
    methodology = methodology_engine.resolve(db, regional_block_id=regional_block_id)
    filters = SurveillanceFilter(
        regional_block_id=regional_block_id,
        district_ids=[district_id] if district_id else None,
        facility_ids=[facility_id] if facility_id else None,
        date_from=period_start,
        date_to=period_end,
    )
    records = query.load_isolates(db, filters)

    level = (
        AggregationLevel.FACILITY
        if facility_id
        else AggregationLevel.DISTRICT
        if district_id
        else AggregationLevel.REGIONAL
    )
    result = antibiogram_engine.compute(
        records, methodology, level=level, apply_suppression=True, verified_only=True
    )

    organisms = {o.id: o for o in db.scalars(select(CanonicalOrganism))}
    antibiotics = {a.id: a for a in db.scalars(select(CanonicalAntibiotic))}
    ordered = sorted(
        (aid for aid in result.antibiotic_ids if aid in antibiotics),
        key=lambda aid: (antibiotics[aid].display_order, antibiotics[aid].name),
    )

    rows: list[ReportRow] = []
    for row in result.rows:
        organism = organisms.get(row.organism_id)
        if organism is None:
            continue
        cells: list[ReportCell] = []
        for antibiotic_id in ordered:
            cell = row.cells.get(antibiotic_id)
            summary = cell.summary if cell else None
            percent = summary.susceptible_percent if summary else None
            if cell is None or summary is None or percent is None:
                cells.append(ReportCell(display=WITHHELD, n_display="", reportable=False))
            else:
                cells.append(
                    ReportCell(
                        display=f"{percent:.0f}%",
                        n_display=f"n={summary.interpretable}",
                        reportable=True,
                    )
                )
        rows.append(
            ReportRow(
                organism=organism.name,
                kingdom=organism.kingdom.value,
                isolate_count=row.isolate_count,
                cells=cells,
            )
        )

    freshness = coverage_engine.freshness(
        db,
        regional_block_id=regional_block_id,
        contributing_facility_ids=result.contributing_facility_ids,
        coverage_start=result.period_start,
        coverage_end=result.period_end,
    )

    signal_lines: list[str] = []
    if include_signals:
        for signal in signals.detect(records, methodology):
            organism = organisms.get(signal.organism_id)
            antibiotic = antibiotics.get(signal.antibiotic_id)
            if organism is None or antibiotic is None:
                continue
            signal_lines.append(
                f"{organism.name} — {antibiotic.name}: "
                f"{signal.baseline.susceptible_percent:.0f}% (n={signal.baseline.interpretable}) "
                f"to {signal.current.susceptible_percent:.0f}% "
                f"(n={signal.current.interpretable}), "
                f"{signal.change_percentage_points:.0f} percentage points. "
                "Signal — requires expert review."
            )

    notes = [
        f"Combinations with fewer than {methodology.minimum_isolates} antibiogram-eligible "
        f"isolates are not reported as a percentage; they appear as {WITHHELD}.",
        f"Groups smaller than {methodology.small_cell_threshold} isolates are withheld to "
        "prevent re-identification, independently of the reporting threshold.",
        "One isolate per patient per deduplication window is counted, per CLSI M39.",
    ]
    if result.quality_exclusion.excluded_facility_count:
        notes.append(
            f"{result.quality_exclusion.excluded_facility_count} facility/facilities were excluded "
            f"from these figures because QC attestation or EQA was not current and "
            f"satisfactory, removing {result.quality_exclusion.excluded_isolate_count} isolates."
        )
    if result.pending_interpretation_count:
        notes.append(
            f"{result.pending_interpretation_count} recorded measurements are awaiting "
            "breakpoint interpretation and contribute to no percentage in this report."
        )

    return ReportContent(
        title=(
            "Antimicrobial resistance report — " + _period_title(period, period_start, period_end)
        ),
        scope_label=_scope_label(
            db,
            regional_block_id=regional_block_id,
            district_id=district_id,
            facility_id=facility_id,
        ),
        period=period,
        period_start=period_start,
        period_end=period_end,
        generated_at=datetime.now(UTC),
        antibiotics=[antibiotics[aid].name for aid in ordered],
        rows=rows,
        facilities_contributing=freshness.facilities_contributing,
        facilities_expected=freshness.facilities_expected,
        facilities_excluded_by_quality=result.quality_exclusion.excluded_facility_count,
        isolates_excluded_by_quality=result.quality_exclusion.excluded_isolate_count,
        completeness_percent=freshness.completeness_percent,
        data_last_updated=(
            freshness.data_last_updated.isoformat() if freshness.data_last_updated else None
        ),
        raw_isolate_count=result.raw_isolate_count,
        eligible_isolate_count=result.deduplication.retained_isolates,
        pending_interpretation_count=result.pending_interpretation_count,
        minimum_isolates=methodology.minimum_isolates,
        small_cell_threshold=methodology.small_cell_threshold,
        methodology=provenance.describe(result, methodology, filters),
        signals=signal_lines,
        notes=notes,
    )


def _period_title(period: ReportPeriod, start: date, end: date) -> str:
    if period is ReportPeriod.MONTHLY:
        return start.strftime("%B %Y")
    if period is ReportPeriod.QUARTERLY:
        return f"Q{(start.month - 1) // 3 + 1} {start.year}"
    if period is ReportPeriod.ANNUAL:
        return str(start.year)
    return f"{start.isoformat()} to {end.isoformat()}"
