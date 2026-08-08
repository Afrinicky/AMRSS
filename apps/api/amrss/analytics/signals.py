"""Emerging-resistance signal detection (SDD 5.4).

A defined, versioned trigger — never an ad-hoc rule. Three properties are
load-bearing:

1. **Both windows must independently clear the minimum isolate count** before any
   comparison is made. Comparing a well-powered baseline against four isolates
   produces a large apparent change from nothing at all.
2. **The windows do not overlap.** A trailing baseline that contains the current
   period is partly compared against itself, which damps real changes and makes
   the threshold mean something different than it appears to.
3. **The output is a signal, never a conclusion.** AMRSS does not use the word
   "outbreak". Outbreak determination is an epidemiological judgment made by
   people, and a surveillance system that pre-empts it will eventually be wrong
   in a way that costs its credibility.
"""

import uuid
from dataclasses import dataclass
from datetime import date, timedelta

from amrss.analytics.deduplication import deduplicate
from amrss.analytics.methodology import MethodologySet
from amrss.analytics.records import IsolateRecord
from amrss.analytics.statistics import summarise
from amrss.models.enums import SirResult


@dataclass(frozen=True)
class WindowSummary:
    start: date
    end: date
    susceptible_percent: float
    interpretable: int


@dataclass(frozen=True)
class Signal:
    organism_id: uuid.UUID
    antibiotic_id: uuid.UUID
    baseline: WindowSummary
    current: WindowSummary
    #: Negative means susceptibility fell — the direction of clinical concern.
    change_percentage_points: float
    detected_on: date

    @property
    def status_label(self) -> str:
        return "Signal — requires expert review"


def detect(
    records: list[IsolateRecord],
    methodology: MethodologySet,
    *,
    as_of: date | None = None,
    verified_only: bool = True,
) -> list[Signal]:
    """Scan every organism-antibiotic combination for a triggering change.

    Only decreases in susceptibility are reported. A rise is welcome news, not a
    surveillance alert, and mixing the two would bury genuine deterioration in a
    list dominated by noise in both directions.
    """
    as_of = as_of or date.today()
    baseline_days = methodology.signal_baseline_days
    current_days = methodology.signal_current_days
    minimum_n = methodology.signal_minimum_n
    threshold = methodology.signal_threshold_points

    current_start = as_of - timedelta(days=current_days)
    baseline_end = current_start - timedelta(days=1)
    baseline_start = baseline_end - timedelta(days=baseline_days)

    population = [r for r in records if r.quality_verified or not verified_only]
    retained, _ = deduplicate(
        population,
        window_days=methodology.dedup_window_days,
        scope=methodology.dedup_scope,
    )

    baseline_results: dict[tuple[uuid.UUID, uuid.UUID], list[SirResult]] = {}
    current_results: dict[tuple[uuid.UUID, uuid.UUID], list[SirResult]] = {}

    for record in retained:
        if baseline_start <= record.specimen_date <= baseline_end:
            target = baseline_results
        elif current_start <= record.specimen_date <= as_of:
            target = current_results
        else:
            continue
        for antibiotic_id, result in record.results.items():
            target.setdefault((record.organism_id, antibiotic_id), []).append(result)

    signals: list[Signal] = []
    for key, baseline_list in baseline_results.items():
        current_list = current_results.get(key)
        if current_list is None:
            continue

        baseline_summary = summarise(baseline_list)
        current_summary = summarise(current_list)
        if baseline_summary.interpretable < minimum_n or current_summary.interpretable < minimum_n:
            continue

        baseline_pct = baseline_summary.susceptible_percent
        current_pct = current_summary.susceptible_percent
        if baseline_pct is None or current_pct is None:
            continue

        change = round(current_pct - baseline_pct, 1)
        if change > -threshold:
            continue

        organism_id, antibiotic_id = key
        signals.append(
            Signal(
                organism_id=organism_id,
                antibiotic_id=antibiotic_id,
                baseline=WindowSummary(
                    start=baseline_start,
                    end=baseline_end,
                    susceptible_percent=baseline_pct,
                    interpretable=baseline_summary.interpretable,
                ),
                current=WindowSummary(
                    start=current_start,
                    end=as_of,
                    susceptible_percent=current_pct,
                    interpretable=current_summary.interpretable,
                ),
                change_percentage_points=change,
                detected_on=as_of,
            )
        )

    signals.sort(key=lambda s: s.change_percentage_points)
    return signals
