"""Susceptibility trends over time (SDD 5.7).

The threshold rule applies **per time bucket**, not once across the whole series.
A bucket that fails it renders as an explicit gap rather than a plotted point.
Drawing a line through thin buckets produces a confident-looking trajectory built
from noise, which is the most persuasive way a surveillance system can mislead.
"""

import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from enum import StrEnum

from amrss.analytics.deduplication import deduplicate
from amrss.analytics.methodology import MethodologySet
from amrss.analytics.records import IsolateRecord
from amrss.analytics.statistics import ConfidenceInterval, SusceptibilitySummary, summarise
from amrss.models.enums import SirResult


class TimeBucket(StrEnum):
    WEEK = "week"
    MONTH = "month"
    QUARTER = "quarter"


@dataclass(frozen=True)
class TrendPoint:
    bucket_start: date
    bucket_end: date
    label: str
    #: None when the bucket did not meet the minimum isolate count. The point is
    #: still returned so the gap is visible in the series rather than closing
    #: silently as if the period had never existed.
    summary: SusceptibilitySummary | None
    confidence_interval: ConfidenceInterval | None
    isolate_count: int
    sufficient: bool


@dataclass(frozen=True)
class TrendSeries:
    organism_id: uuid.UUID
    antibiotic_id: uuid.UUID
    bucket: TimeBucket
    points: list[TrendPoint]
    minimum_isolates: int

    @property
    def has_sufficient_data(self) -> bool:
        return any(point.sufficient for point in self.points)


def _bucket_bounds(day: date, bucket: TimeBucket) -> tuple[date, date, str]:
    if bucket is TimeBucket.WEEK:
        start = day - timedelta(days=day.weekday())
        iso_year, iso_week, _ = start.isocalendar()
        return start, start + timedelta(days=6), f"{iso_year}-W{iso_week:02d}"
    if bucket is TimeBucket.MONTH:
        start = day.replace(day=1)
        next_month = (start + timedelta(days=32)).replace(day=1)
        return start, next_month - timedelta(days=1), start.strftime("%b %Y")
    quarter = (day.month - 1) // 3
    start = date(day.year, quarter * 3 + 1, 1)
    next_quarter_month = start.month + 3
    end = (
        date(start.year + 1, 1, 1)
        if next_quarter_month > 12
        else date(start.year, next_quarter_month, 1)
    ) - timedelta(days=1)
    return start, end, f"{start.year} Q{quarter + 1}"


def compute_series(
    records: list[IsolateRecord],
    methodology: MethodologySet,
    *,
    organism_id: uuid.UUID,
    antibiotic_id: uuid.UUID,
    bucket: TimeBucket = TimeBucket.MONTH,
    verified_only: bool = True,
) -> TrendSeries:
    """Build one organism-antibiotic series.

    Deduplication runs once over the whole population before bucketing, not
    per bucket. Deduplicating within buckets would let the same patient reappear
    in adjacent buckets whenever their repeat isolate happened to cross a
    boundary, reintroducing exactly the bias the rule removes.
    """
    population = [
        record
        for record in records
        if record.organism_id == organism_id and (record.quality_verified or not verified_only)
    ]
    retained, _ = deduplicate(
        population,
        window_days=methodology.dedup_window_days,
        scope=methodology.dedup_scope,
    )

    minimum = methodology.minimum_isolates
    confidence_level = methodology.confidence_level

    buckets: dict[date, tuple[date, str, list[SirResult]]] = {}
    for record in retained:
        result = record.results.get(antibiotic_id)
        if result is None:
            continue
        start, end, label = _bucket_bounds(record.specimen_date, bucket)
        buckets.setdefault(start, (end, label, []))[2].append(result)

    points: list[TrendPoint] = []
    for start in sorted(buckets):
        end, label, results = buckets[start]
        summary = summarise(results)
        sufficient = summary.interpretable >= minimum
        points.append(
            TrendPoint(
                bucket_start=start,
                bucket_end=end,
                label=label,
                summary=summary if sufficient else None,
                confidence_interval=(
                    summary.confidence_interval(confidence_level) if sufficient else None
                ),
                isolate_count=summary.interpretable,
                sufficient=sufficient,
            )
        )

    return TrendSeries(
        organism_id=organism_id,
        antibiotic_id=antibiotic_id,
        bucket=bucket,
        points=points,
        minimum_isolates=minimum,
    )
