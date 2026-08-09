"""Summary aggregations that answer different questions from the antibiogram.

Two views, deliberately kept apart because they belong on different pages and
answer to different readers:

- **By antibiotic** (:func:`by_antibiotic`) — the S/I/R split for each agent
  across every isolate tested against it. A stewardship and formulary question:
  which agents still work at all.
- **By organism and site** (:func:`by_organism_site`) — which organisms were
  recovered and from where in the body. A provenance question: whether a pattern
  is a urinary-tract picture or a bloodstream one.

The first carries a caveat in its response rather than leaving it to the reader:
pooling one agent across every organism mixes populations with genuinely
different intrinsic susceptibility. Ampicillin against *E. coli* and against
*S. aureus* are not the same question, and a pooled figure is shaped partly by
which organisms happened to be isolated. It is a legitimate and widely-published
summary, but it is a summary — the antibiogram remains the organism-specific
answer.

The second carries no susceptibility figure at all. It describes the specimen
mix behind every other number in the system, and mixing a rate into it would
invite the two to be read as one statement.
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


@dataclass(frozen=True)
class SiteCount:
    """Isolates of one organism recovered from one site of infection."""

    infection_site: str
    isolate_count: int
    percent_of_organism: float


@dataclass(frozen=True)
class OrganismSiteProfile:
    """One organism and where in the body it was recovered from."""

    organism_id: uuid.UUID
    isolate_count: int
    percent_of_total: float
    sites: list[SiteCount]

    @property
    def principal_site(self) -> str | None:
        """The site contributing most of this organism's isolates.

        Useful as a one-line summary, but never as the whole story: an organism
        found overwhelmingly in urine and occasionally in blood is a different
        clinical problem from one evenly split, and the full breakdown says so.
        """
        return self.sites[0].infection_site if self.sites else None

    @property
    def withheld_count(self) -> int:
        """Isolates of this organism whose site fell below the suppression threshold.

        Reported rather than absorbed silently. Without it the listed sites would
        not add up to the organism's total, and a reader would have no way to
        tell a rounding artefact from data deliberately withheld — nor would a
        chart be able to draw the difference honestly.
        """
        return self.isolate_count - sum(site.isolate_count for site in self.sites)


def by_organism_site(
    records: list[IsolateRecord],
    methodology: MethodologySet,
    site_of: dict[uuid.UUID, str],
    *,
    verified_only: bool = True,
    apply_suppression: bool = True,
) -> tuple[list[OrganismSiteProfile], int]:
    """Which organisms were isolated, and from where.

    Site of infection is derived from specimen type rather than collected
    separately (SDD 3.1), so the two can never disagree.

    Counts isolates rather than deduplicating to patients: this describes what
    the laboratories recovered and from which sites, which is a statement about
    the specimen mix behind the antibiogram, not a rate. Deduplicating would
    understate the workload actually processed.

    Small sites are withheld under the suppression threshold. "One isolate of
    this organism from cerebrospinal fluid in this district" is close to naming
    a patient.
    """
    population = [r for r in records if r.quality_verified or not verified_only]
    threshold = methodology.small_cell_threshold if apply_suppression else 0

    by_organism: dict[uuid.UUID, dict[str, int]] = {}
    for record in population:
        site = site_of.get(record.specimen_type_id, "unspecified")
        by_organism.setdefault(record.organism_id, {})
        by_organism[record.organism_id][site] = by_organism[record.organism_id].get(site, 0) + 1

    total = sum(sum(sites.values()) for sites in by_organism.values())
    if total == 0:
        return [], 0

    profiles: list[OrganismSiteProfile] = []
    for organism_id, sites in by_organism.items():
        organism_total = sum(sites.values())
        if organism_total < threshold:
            continue
        listed = [
            SiteCount(
                infection_site=site,
                isolate_count=count,
                percent_of_organism=round(100.0 * count / organism_total, 0),
            )
            for site, count in sites.items()
            if count >= threshold
        ]
        listed.sort(key=lambda entry: -entry.isolate_count)
        profiles.append(
            OrganismSiteProfile(
                organism_id=organism_id,
                isolate_count=organism_total,
                percent_of_total=round(100.0 * organism_total / total, 0),
                sites=listed,
            )
        )

    profiles.sort(key=lambda profile: -profile.isolate_count)
    return profiles, total
