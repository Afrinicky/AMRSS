"""The interpretive-category engine.

Converts a measured MIC or zone diameter into a CLSI category, and records
exactly which breakpoint set produced it. Two properties matter more than
anything else here:

1. **Never guess.** Off-scale MICs that straddle a breakpoint, missing
   criteria, and implausible measurements all produce `Category.NI` with a
   stated reason - not a plausible-looking S or R.
2. **Stay reproducible.** The result carries the breakpoint set version and
   table reference, so a result interpreted under M100-Ed36 can still be
   explained after the lab moves to Ed37.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from amrss_clsi.breakpoints import (
    MAX_PLAUSIBLE_ZONE_MM,
    NO_ZONE_MM,
    Breakpoint,
    BreakpointSet,
    Category,
    Method,
    Tier,
)
from amrss_clsi.mic import MICValue


class NoInterpretationReason:
    NO_BREAKPOINT = "no_breakpoint_for_organism_agent_method"
    OFF_SCALE_AMBIGUOUS = "off_scale_result_straddles_breakpoint"
    IMPLAUSIBLE_MEASUREMENT = "measurement_outside_plausible_range"
    INTRINSIC_RESISTANCE = "intrinsic_resistance_rule"
    GAP_IN_CRITERIA = "value_falls_in_undefined_gap"


@dataclass
class Interpretation:
    category: Category
    method: Method
    set_version: str | None = None
    table_reference: str | None = None
    organism_group: str | None = None
    tier: Tier = Tier.UNSPECIFIED
    reason: str | None = None
    comments: list[str] = field(default_factory=list)
    applied_rules: list[str] = field(default_factory=list)
    # True when a human must resolve the result before it can be released.
    requires_review: bool = False

    @property
    def is_interpretable(self) -> bool:
        return self.category is not Category.NI


def interpret_mic(
    mic: MICValue,
    criterion: Breakpoint | None,
    *,
    method: Method = Method.MIC,
) -> Interpretation:
    """Interpret an MIC against a single criterion."""
    if criterion is None:
        return Interpretation(
            category=Category.NI,
            method=method,
            reason=NoInterpretationReason.NO_BREAKPOINT,
            requires_review=True,
        )

    base = Interpretation(
        category=Category.NI,
        method=method,
        set_version=criterion.set_version,
        table_reference=criterion.table_reference,
        organism_group=criterion.organism_group,
        tier=criterion.tier,
        comments=[criterion.comment] if criterion.comment else [],
    )

    s_max = criterion.mic_susceptible_max
    r_min = criterion.mic_resistant_min

    # Resistant is checked first: when a result is certainly at or above the
    # resistant bound nothing else can apply.
    if r_min is not None and mic.definitely_at_least(r_min):
        base.category = Category.R
        return base

    if s_max is not None and mic.definitely_at_most(s_max):
        base.category = Category.S
        return base

    if _definitely_within(mic, criterion.mic_sdd_min, criterion.mic_sdd_max):
        base.category = Category.SDD
        if criterion.dosage_note:
            base.comments.append(f"SDD applies only with: {criterion.dosage_note}")
        return base

    if _definitely_within(mic, criterion.mic_intermediate_min, criterion.mic_intermediate_max):
        base.category = Category.I
        return base

    # Intermediate implied by the gap between S and R when no explicit
    # intermediate range is tabulated.
    if (
        s_max is not None
        and r_min is not None
        and criterion.mic_intermediate_min is None
        and criterion.mic_sdd_min is None
        and mic.definitely_above(s_max)
        and mic.definitely_below(r_min)
    ):
        base.category = Category.I
        return base

    # Susceptible-only criteria (no I or R defined): everything above the
    # susceptible bound is reported nonsusceptible, per CLSI's definition.
    if s_max is not None and r_min is None and mic.definitely_above(s_max):
        base.category = Category.NS
        base.comments.append("Only a susceptible breakpoint is defined; reported as nonsusceptible")
        return base

    # Anything left is an off-scale value that spans a category boundary.
    base.category = Category.NI
    base.requires_review = True
    base.reason = (
        NoInterpretationReason.OFF_SCALE_AMBIGUOUS
        if (mic.is_off_scale_low or mic.is_off_scale_high)
        else NoInterpretationReason.GAP_IN_CRITERIA
    )
    base.comments.append(
        "Result cannot be assigned a category without ambiguity; repeat with an "
        "extended dilution range or confirm by an alternative method."
    )
    return base


def interpret_disk(zone_mm: int, criterion: Breakpoint | None) -> Interpretation:
    """Interpret a disk-diffusion zone diameter (mm)."""
    if criterion is None:
        return Interpretation(
            category=Category.NI,
            method=Method.DISK,
            reason=NoInterpretationReason.NO_BREAKPOINT,
            requires_review=True,
        )

    base = Interpretation(
        category=Category.NI,
        method=Method.DISK,
        set_version=criterion.set_version,
        table_reference=criterion.table_reference,
        organism_group=criterion.organism_group,
        tier=criterion.tier,
        comments=[criterion.comment] if criterion.comment else [],
    )

    if not (NO_ZONE_MM <= zone_mm <= MAX_PLAUSIBLE_ZONE_MM):
        base.reason = NoInterpretationReason.IMPLAUSIBLE_MEASUREMENT
        base.requires_review = True
        base.comments.append(
            f"Zone of {zone_mm} mm is outside the measurable range "
            f"({NO_ZONE_MM}-{MAX_PLAUSIBLE_ZONE_MM} mm); check the reading."
        )
        return base

    s_min = criterion.disk_susceptible_min
    r_max = criterion.disk_resistant_max

    if r_max is not None and zone_mm <= r_max:
        base.category = Category.R
        return base

    if s_min is not None and zone_mm >= s_min:
        base.category = Category.S
        return base

    if _zone_within(zone_mm, criterion.disk_sdd_min, criterion.disk_sdd_max):
        base.category = Category.SDD
        if criterion.dosage_note:
            base.comments.append(f"SDD applies only with: {criterion.dosage_note}")
        return base

    if _zone_within(zone_mm, criterion.disk_intermediate_min, criterion.disk_intermediate_max):
        base.category = Category.I
        return base

    if (
        s_min is not None
        and r_max is not None
        and criterion.disk_intermediate_min is None
        and criterion.disk_sdd_min is None
        and r_max < zone_mm < s_min
    ):
        base.category = Category.I
        return base

    if s_min is not None and r_max is None and zone_mm < s_min:
        base.category = Category.NS
        base.comments.append("Only a susceptible breakpoint is defined; reported as nonsusceptible")
        return base

    base.reason = NoInterpretationReason.GAP_IN_CRITERIA
    base.requires_review = True
    return base


def interpret(
    *,
    breakpoint_set: BreakpointSet,
    organism_groups: tuple[str, ...],
    agent_code: str,
    method: Method,
    mic: MICValue | None = None,
    zone_mm: int | None = None,
    site: str | None = None,
    route: str | None = None,
) -> Interpretation:
    """Look up the applicable breakpoint and interpret the measurement."""
    if method.is_mic_like and mic is None:
        raise ValueError("an MIC value is required for MIC/gradient methods")
    if method is Method.DISK and zone_mm is None:
        raise ValueError("a zone diameter is required for disk diffusion")

    bp = breakpoint_set.lookup(
        organism_groups=organism_groups,
        agent_code=agent_code,
        method=method,
        site=site,
        route=route,
    )
    if method is Method.DISK:
        return interpret_disk(zone_mm, bp)  # type: ignore[arg-type]
    return interpret_mic(mic, bp, method=method)  # type: ignore[arg-type]


def _definitely_within(mic: MICValue, lo: Decimal | None, hi: Decimal | None) -> bool:
    """Whether the MIC certainly falls in this range.

    A missing lower bound means the range is open below — the criterion defines
    no susceptible category, as with colistin, so there is no floor to clear.
    Import-time validation permits that only where no susceptible bound exists,
    which is what keeps an open range from swallowing susceptible results.
    A missing upper bound is not a range at all and matches nothing.
    """
    if hi is None:
        return False
    if lo is not None and not mic.definitely_at_least(lo):
        return False
    return mic.definitely_at_most(hi)


def _zone_within(zone_mm: int, lo: int | None, hi: int | None) -> bool:
    """The zone-diameter mirror: here it is the *upper* bound that may be open,
    because a larger zone means a more susceptible isolate."""
    if lo is None:
        return False
    return lo <= zone_mm and (hi is None or zone_mm <= hi)
