"""Summary figures for reports: the whole-panel views an AMR report opens with.

Two aggregations that answer different questions from the antibiogram:

- **By antibiotic** — the S/I/R split for each agent across the isolates tested
  against it, which is how a stewardship committee sees which agents still work
  at all.
- **By specimen type** — where the isolates came from, which is how a reader
  judges whether a pattern is a urinary-tract picture or a bloodstream one.

A caveat carried in the response rather than left to the reader: pooling one
agent across every organism mixes populations with genuinely different intrinsic
susceptibility. Ampicillin against *E. coli* and against *S. aureus* are not the
same question, and a pooled figure is shaped partly by which organisms happened
to be isolated. It is a legitimate and widely-published summary, but it is a
summary — the antibiogram remains the organism-specific answer, and these
figures say so.
"""

import uuid
from dataclasses import dataclass

from amrss.analytics.deduplication import deduplicate
from amrss.analytics.methodology import MethodologySet
from amrss.analytics.records import IsolateRecord
from amrss.analytics.statistics import SusceptibilitySummary, summarise
from amrss.models.enums import SirResult


@dataclass(frozen=True)
class AntibioticProfile:
    """One horizontal bar: the S/I/R split for a single agent."""

    antibiotic_id: uuid.UUID
    summary: SusceptibilitySummary
    #: Distinct organisms contributing, so a reader can see how pooled the figure
    #: is. One organism is a clean statistic; twelve is a mixed population.
    organism_count: int

    @property
    def susceptible_percent(self) -> float:
        return round(100.0 * self.summary.susceptible / self.summary.interpretable, 0)

    @property
    def intermediate_percent(self) -> float:
        return round(100.0 * self.summary.intermediate / self.summary.interpretable, 0)

    @property
    def resistant_percent(self) -> float:
        resistant = self.summary.resistant + self.summary.non_susceptible
        return round(100.0 * resistant / self.summary.interpretable, 0)


@dataclass(frozen=True)
class SpecimenCount:
    specimen_type_id: uuid.UUID
    isolate_count: int
    percent_of_total: float


def by_antibiotic(
    records: list[IsolateRecord],
    methodology: MethodologySet,
    *,
    verified_only: bool = True,
) -> list[AntibioticProfile]:
    """S/I/R split per agent, ordered least-susceptible first.

    Ordering is deliberate: the agents that have stopped working are the finding,
    and putting them at the top means the chart is read correctly even by someone
    who only looks at the first few rows.

    The reporting threshold still applies. An agent tested on too few isolates is
    omitted rather than drawn as a bar, because a full-width stacked bar reads as
    a solid fact regardless of how thin the n behind it is.
    """
    population = [r for r in records if r.quality_verified or not verified_only]
    retained, _ = deduplicate(
        population,
        window_days=methodology.dedup_window_days,
        scope=methodology.dedup_scope,
    )

    results: dict[uuid.UUID, list[SirResult]] = {}
    organisms: dict[uuid.UUID, set[uuid.UUID]] = {}
    for record in retained:
        for antibiotic_id, result in record.results.items():
            results.setdefault(antibiotic_id, []).append(result)
            organisms.setdefault(antibiotic_id, set()).add(record.organism_id)

    minimum = methodology.minimum_isolates
    profiles: list[AntibioticProfile] = []
    for antibiotic_id, values in results.items():
        summary = summarise(values)
        if summary.interpretable < minimum:
            continue
        profiles.append(
            AntibioticProfile(
                antibiotic_id=antibiotic_id,
                summary=summary,
                organism_count=len(organisms[antibiotic_id]),
            )
        )

    profiles.sort(key=lambda profile: (profile.susceptible_percent, -profile.summary.interpretable))
    return profiles


def by_specimen(
    records: list[IsolateRecord],
    methodology: MethodologySet,
    *,
    verified_only: bool = True,
    small_cell_threshold: int | None = None,
) -> tuple[list[SpecimenCount], int]:
    """Isolate counts per specimen type, with the total.

    Counts isolates rather than patients: this describes the laboratory's
    workload and the provenance of the pattern, not a rate, so deduplication
    would understate what was actually processed.

    Specimen types below the suppression threshold are folded into a single
    "other" bucket rather than listed. A specimen type with two isolates in a
    named district is a re-identification route, and it is also noise on a chart.
    """
    population = [r for r in records if r.quality_verified or not verified_only]
    threshold = (
        small_cell_threshold
        if small_cell_threshold is not None
        else methodology.small_cell_threshold
    )

    counts: dict[uuid.UUID, int] = {}
    for record in population:
        counts[record.specimen_type_id] = counts.get(record.specimen_type_id, 0) + 1

    total = sum(counts.values())
    if total == 0:
        return [], 0

    listed = [
        SpecimenCount(
            specimen_type_id=specimen_id,
            isolate_count=count,
            percent_of_total=round(100.0 * count / total, 0),
        )
        for specimen_id, count in counts.items()
        if count >= threshold
    ]
    listed.sort(key=lambda entry: -entry.isolate_count)
    return listed, total
