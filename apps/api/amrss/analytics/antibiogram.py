"""Antibiogram computation.

The pipeline, in order, with each stage independently testable:

    eligible isolates  →  quality gating  →  deduplication  →  aggregation
      →  reporting threshold  →  small-cell suppression  →  provenance

Order matters and is not interchangeable. Deduplication must precede aggregation
or repeat isolates inflate the counts the threshold is then applied to. The
reporting threshold and small-cell suppression are separate gates with different
purposes — the first is about statistical reliability, the second about
re-identification risk — and SDD 3.2 requires them applied independently.
"""

import uuid
from dataclasses import dataclass, field
from datetime import date
from enum import StrEnum

from amrss.analytics.deduplication import DeduplicationReport, deduplicate
from amrss.analytics.methodology import MethodologySet
from amrss.analytics.records import IsolateRecord
from amrss.analytics.statistics import (
    ConfidenceInterval,
    SusceptibilitySummary,
    summarise,
)
from amrss.models.enums import OrganismKingdom, SirResult


class AggregationLevel(StrEnum):
    """Thresholds apply independently at each level (SDD 5.1).

    A combination that clears the minimum regionally will often fail it at a
    single facility, and reporting the regional figure under a facility heading
    would misattribute it.
    """

    REGIONAL = "regional"
    DISTRICT = "district"
    FACILITY = "facility"


class CellState(StrEnum):
    REPORTABLE = "reportable"
    #: Tested, but fewer isolates than the reporting threshold requires.
    BELOW_THRESHOLD = "below_threshold"
    #: Withheld to prevent re-identification in a cross-facility view.
    SUPPRESSED = "suppressed"
    #: The agent was not tested against this organism in this population.
    NOT_TESTED = "not_tested"


@dataclass(frozen=True)
class AntibiogramCell:
    antibiotic_id: uuid.UUID
    state: CellState
    #: Populated only when state is REPORTABLE. Withholding the counts alongside
    #: the percentage is what makes suppression meaningful — releasing "n=3" while
    #: hiding the percentage would leak the same small cell.
    summary: SusceptibilitySummary | None = None
    confidence_interval: ConfidenceInterval | None = None
    #: True when n clears the threshold but remains modest, so the interface knows
    #: to show an uncertainty cue (SDD 5.7).
    uncertainty_cue: bool = False

    @property
    def susceptible_percent(self) -> float | None:
        return self.summary.susceptible_percent if self.summary else None


@dataclass(frozen=True)
class AntibiogramRow:
    organism_id: uuid.UUID
    organism_kingdom: OrganismKingdom
    #: Deduplicated isolates of this organism in scope — the row's denominator
    #: before per-agent testing is considered.
    isolate_count: int
    cells: dict[uuid.UUID, AntibiogramCell]

    @property
    def has_reportable_cell(self) -> bool:
        return any(cell.state is CellState.REPORTABLE for cell in self.cells.values())


@dataclass
class QualityExclusion:
    """What the QC/EQA gate held out, so the view can say so (SDD 6.6)."""

    excluded_facility_ids: set[uuid.UUID] = field(default_factory=set)
    excluded_isolate_count: int = 0

    @property
    def excluded_facility_count(self) -> int:
        return len(self.excluded_facility_ids)


@dataclass
class Antibiogram:
    level: AggregationLevel
    rows: list[AntibiogramRow]
    #: Agents appearing in at least one row, in dictionary display order.
    antibiotic_ids: list[uuid.UUID]
    deduplication: DeduplicationReport
    quality_exclusion: QualityExclusion
    #: Isolates before deduplication, for workload reporting. Kept distinct from
    #: the antibiogram denominator so the two are never conflated (SDD 5.3).
    raw_isolate_count: int
    contributing_facility_ids: set[uuid.UUID]
    period_start: date | None
    period_end: date | None
    suppression_applied: bool
    verified_only: bool
    minimum_isolates: int
    small_cell_threshold: int


def compute(
    records: list[IsolateRecord],
    methodology: MethodologySet,
    *,
    level: AggregationLevel = AggregationLevel.REGIONAL,
    apply_suppression: bool = True,
    verified_only: bool = True,
) -> Antibiogram:
    """Build an antibiogram from eligible isolates.

    ``verified_only`` implements the gating rule: the verified regional and
    district antibiogram includes only facilities whose QC attestation and EQA are
    both current and satisfactory. A facility viewing its own data passes False,
    since a facility always sees its own data regardless of quality status.

    ``apply_suppression`` is False only when the viewer owns every facility in
    scope. Small-cell suppression protects against inferring an individual from a
    thin cross-facility cell; it is not a secret kept from the laboratory that
    holds the source record.
    """
    raw_count = len(records)

    exclusion = QualityExclusion()
    if verified_only:
        eligible = []
        for record in records:
            if record.quality_verified:
                eligible.append(record)
            else:
                exclusion.excluded_facility_ids.add(record.facility_id)
                exclusion.excluded_isolate_count += 1
    else:
        eligible = list(records)

    retained, dedup_report = deduplicate(
        eligible,
        window_days=methodology.dedup_window_days,
        scope=methodology.dedup_scope,
    )

    minimum_isolates = methodology.minimum_isolates
    small_cell = methodology.small_cell_threshold
    confidence_level = methodology.confidence_level
    modest_ceiling = methodology.modest_n_ceiling

    by_organism: dict[uuid.UUID, list[IsolateRecord]] = {}
    for record in retained:
        by_organism.setdefault(record.organism_id, []).append(record)

    rows: list[AntibiogramRow] = []
    seen_antibiotics: set[uuid.UUID] = set()

    for organism_id, organism_records in by_organism.items():
        panel: dict[uuid.UUID, list[SirResult]] = {}
        for record in organism_records:
            for antibiotic_id, result in record.results.items():
                panel.setdefault(antibiotic_id, []).append(result)

        cells: dict[uuid.UUID, AntibiogramCell] = {}
        for antibiotic_id, results in panel.items():
            seen_antibiotics.add(antibiotic_id)
            cells[antibiotic_id] = _build_cell(
                antibiotic_id,
                summarise(results),
                minimum_isolates=minimum_isolates,
                small_cell=small_cell if apply_suppression else 0,
                confidence_level=confidence_level,
                modest_ceiling=modest_ceiling,
            )

        rows.append(
            AntibiogramRow(
                organism_id=organism_id,
                organism_kingdom=organism_records[0].organism_kingdom,
                isolate_count=len(organism_records),
                cells=cells,
            )
        )

    rows.sort(key=lambda row: (row.organism_kingdom.value, -row.isolate_count))

    dates = [record.specimen_date for record in retained]
    return Antibiogram(
        level=level,
        rows=rows,
        antibiotic_ids=sorted(seen_antibiotics, key=str),
        deduplication=dedup_report,
        quality_exclusion=exclusion,
        raw_isolate_count=raw_count,
        contributing_facility_ids={record.facility_id for record in retained},
        period_start=min(dates) if dates else None,
        period_end=max(dates) if dates else None,
        suppression_applied=apply_suppression,
        verified_only=verified_only,
        minimum_isolates=minimum_isolates,
        small_cell_threshold=small_cell if apply_suppression else 0,
    )


def _build_cell(
    antibiotic_id: uuid.UUID,
    summary: SusceptibilitySummary,
    *,
    minimum_isolates: int,
    small_cell: int,
    confidence_level: float,
    modest_ceiling: int,
) -> AntibiogramCell:
    if summary.tested == 0:
        return AntibiogramCell(antibiotic_id=antibiotic_id, state=CellState.NOT_TESTED)

    # Suppression is checked first and reported as its own state: a viewer must
    # be able to tell "too few to publish safely" from "too few to be reliable",
    # because only the latter resolves as more data accumulates from any facility.
    if small_cell > 0 and summary.interpretable < small_cell:
        return AntibiogramCell(antibiotic_id=antibiotic_id, state=CellState.SUPPRESSED)

    if summary.interpretable < minimum_isolates:
        return AntibiogramCell(antibiotic_id=antibiotic_id, state=CellState.BELOW_THRESHOLD)

    return AntibiogramCell(
        antibiotic_id=antibiotic_id,
        state=CellState.REPORTABLE,
        summary=summary,
        confidence_interval=summary.confidence_interval(confidence_level),
        uncertainty_cue=summary.interpretable <= modest_ceiling,
    )
