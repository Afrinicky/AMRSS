"""Empiric coverage for an infection site.

The per-organism antibiogram answers "if it is *this* bug, what works?" The
clinician treating before a culture is back has the harder question: not knowing
the organism, which single agent gives the best chance of covering whatever the
patient has? That is what this computes.

The method is a weighted-incidence syndromic combination antibiogram (WISCA): an
agent's coverage at a site is each organism's susceptibility to it, weighted by
how often that organism is isolated there.

    coverage(agent) = Σ over organisms  P(organism at site) * P(susceptible | organism)

An organism the agent is not active against — not tested, intrinsically resistant
— contributes nothing, which is correct: a narrow agent covers a smaller share of
a mixed site, and the number should say so. Where an organism's rate is withheld
for being too few to report, it is counted as not covered rather than guessed —
so this is a floor, an estimate that does not over-promise, which is the only
safe direction to err for a prescribing prompt.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class EmpiricRow:
    """One organism at the site: how many were isolated, and its susceptibility
    to each agent as a fraction in [0, 1], or ``None`` where no rate is
    reportable (too few, not tested, suppressed)."""

    organism_id: str
    isolate_count: int
    susceptible_fraction: dict[str, float | None]


@dataclass(frozen=True)
class OrganismShare:
    organism_id: str
    isolate_count: int
    percent_of_site: float


@dataclass(frozen=True)
class AgentCoverage:
    antibiotic_id: str
    #: Estimated share of all isolates at the site this agent would cover.
    coverage_percent: float
    #: Isolates estimated covered (prevalence-weighted), for context on the %.
    isolates_covered: int
    #: How many of the site's organisms had a reportable rate for this agent;
    #: a coverage figure resting on one organism deserves less weight than one
    #: resting on several.
    organisms_contributing: int


@dataclass(frozen=True)
class EmpiricSummary:
    total_isolates: int
    prevalence: list[OrganismShare]
    coverage: list[AgentCoverage]


def summarise(rows: list[EmpiricRow]) -> EmpiricSummary:
    """Prevalence and WISCA coverage for a site's organisms.

    Prevalence is ordered commonest-first; coverage is ordered
    best-first — both the orders a prescriber reads them in.
    """
    total = sum(row.isolate_count for row in rows)

    prevalence = sorted(
        (
            OrganismShare(
                organism_id=row.organism_id,
                isolate_count=row.isolate_count,
                percent_of_site=(row.isolate_count / total * 100) if total else 0.0,
            )
            for row in rows
        ),
        key=lambda share: share.isolate_count,
        reverse=True,
    )

    agent_ids: list[str] = []
    for row in rows:
        for agent_id in row.susceptible_fraction:
            if agent_id not in agent_ids:
                agent_ids.append(agent_id)

    coverage: list[AgentCoverage] = []
    for agent_id in agent_ids:
        weighted_covered = 0.0
        contributing = 0
        for row in rows:
            fraction = row.susceptible_fraction.get(agent_id)
            if fraction is None:
                continue
            weighted_covered += row.isolate_count * fraction
            contributing += 1
        if contributing == 0:
            continue
        coverage.append(
            AgentCoverage(
                antibiotic_id=agent_id,
                coverage_percent=(weighted_covered / total * 100) if total else 0.0,
                isolates_covered=round(weighted_covered),
                organisms_contributing=contributing,
            )
        )

    coverage.sort(key=lambda entry: entry.coverage_percent, reverse=True)
    return EmpiricSummary(total_isolates=total, prevalence=prevalence, coverage=coverage)
