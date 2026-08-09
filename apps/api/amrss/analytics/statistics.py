"""Susceptibility statistics and their uncertainty.

Every value produced here is reported with the counts behind it. A percentage
without its n is not a statistic, it is a rumour — SDD 4.2 makes that a display
requirement, and this module makes it structurally difficult to violate by never
producing a bare number in the first place.
"""

import math
from dataclasses import dataclass

from amrss.models.enums import SirResult


@dataclass(frozen=True, slots=True)
class ConfidenceInterval:
    lower: float
    upper: float
    level: float

    @property
    def width(self) -> float:
        return self.upper - self.lower


@dataclass(frozen=True, slots=True)
class SusceptibilitySummary:
    """Counts and derived rates for one organism-antibiotic combination."""

    tested: int
    interpretable: int
    susceptible: int
    intermediate: int
    resistant: int
    susceptible_dose_dependent: int
    non_susceptible: int
    #: Measurements recorded without an interpretation — zone diameters or MICs
    #: awaiting breakpoints. Counted separately from not-interpretable, because
    #: this is recoverable data, not a failed test.
    pending_interpretation: int = 0

    @property
    def not_interpretable(self) -> int:
        return self.tested - self.interpretable - self.pending_interpretation

    @property
    def susceptible_percent(self) -> float | None:
        if self.interpretable == 0:
            return None
        return round(100.0 * self.susceptible / self.interpretable, 1)

    @property
    def resistant_percent(self) -> float | None:
        """Resistant plus results reported only as non-susceptible.

        NS cannot be resolved to I or R, but it is certainly not susceptible.
        Excluding it from the resistant rate would understate resistance, which is
        the more dangerous direction to err in.
        """
        if self.interpretable == 0:
            return None
        return round(100.0 * (self.resistant + self.non_susceptible) / self.interpretable, 1)

    def confidence_interval(self, level: float = 0.95) -> ConfidenceInterval | None:
        """Wilson score interval for the susceptible proportion.

        Wilson rather than the textbook normal approximation: at the isolate
        counts routine surveillance actually produces, and at proportions near 0
        or 1, the normal approximation yields intervals that extend past 0% or
        100%. An antibiogram that reports "102% susceptible (95% CI)" destroys
        confidence in every other number on the page.
        """
        if self.interpretable == 0:
            return None
        z = _z_for(level)
        n = self.interpretable
        p = self.susceptible / n
        denominator = 1 + z**2 / n
        centre = (p + z**2 / (2 * n)) / denominator
        margin = (z * math.sqrt(p * (1 - p) / n + z**2 / (4 * n**2))) / denominator
        return ConfidenceInterval(
            lower=round(max(0.0, centre - margin) * 100, 1),
            upper=round(min(1.0, centre + margin) * 100, 1),
            level=level,
        )


def _z_for(level: float) -> float:
    """Two-sided normal quantile for the levels an antibiogram actually uses."""
    table = {0.90: 1.6449, 0.95: 1.9600, 0.99: 2.5758}
    return table.get(round(level, 2), 1.9600)


def summarise(results: list[SirResult]) -> SusceptibilitySummary:
    counts: dict[SirResult, int] = dict.fromkeys(SirResult, 0)
    for result in results:
        counts[result] += 1
    interpretable = sum(count for value, count in counts.items() if value.is_interpretable)
    return SusceptibilitySummary(
        tested=len(results),
        interpretable=interpretable,
        susceptible=counts[SirResult.SUSCEPTIBLE],
        intermediate=counts[SirResult.INTERMEDIATE],
        resistant=counts[SirResult.RESISTANT],
        susceptible_dose_dependent=counts[SirResult.SUSCEPTIBLE_DOSE_DEPENDENT],
        non_susceptible=counts[SirResult.NON_SUSCEPTIBLE],
        pending_interpretation=counts[SirResult.PENDING_INTERPRETATION],
    )
