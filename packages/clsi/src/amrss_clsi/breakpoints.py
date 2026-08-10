"""Breakpoint records and breakpoint-set validation.

IMPORTANT
---------
This module deliberately ships **no breakpoint values**. CLSI M100 tables are
copyrighted, revised annually, and getting a single threshold wrong changes an
S into an R on a real patient's report. The laboratory loads the tables from
its own licensed copy of the current edition (see docs/clsi.md).

What the code *does* provide is the structure CLSI requires around those
numbers: versioned sets, organism-group scoping, method and site/route
qualifiers, SDD support, reporting tiers, and import-time validation that
catches transcription errors before they can interpret a result.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum

from amrss_clsi.mic import is_on_doubling_series

# The disk itself is 6 mm; a zone measurement equal to the disk diameter means
# no inhibition at all.
NO_ZONE_MM = 6
MAX_PLAUSIBLE_ZONE_MM = 60


class Method(StrEnum):
    """Susceptibility testing method."""

    MIC = "MIC"  # broth microdilution / agar dilution (CLSI M07)
    GRADIENT = "GRADIENT"  # gradient diffusion strip, read as an MIC
    DISK = "DISK"  # disk diffusion (CLSI M02)

    @property
    def is_mic_like(self) -> bool:
        return self in (Method.MIC, Method.GRADIENT)


class Category(StrEnum):
    """CLSI interpretive categories."""

    S = "S"  # Susceptible
    SDD = "SDD"  # Susceptible-dose dependent
    I = "I"  # noqa: E741 - Intermediate (CLSI's own single-letter code)
    R = "R"  # Resistant
    NS = "NS"  # Nonsusceptible (used where only a susceptible breakpoint exists)
    NI = "NI"  # No interpretation available


class Tier(StrEnum):
    """CLSI M100 Table 1 reporting tiers (cascade/selective reporting)."""

    TIER_1 = "1"  # primary, report routinely
    TIER_2 = "2"  # primary, report selectively
    TIER_3 = "3"  # report for institutional-resistance or multi-resistant isolates
    TIER_4 = "4"  # report on request / specialised
    UNSPECIFIED = "U"


@dataclass(frozen=True)
class Breakpoint:
    """One interpretive criterion from a versioned breakpoint table.

    MIC fields are µg/mL; disk fields are zone diameters in mm. Only the fields
    matching `method` are populated. `None` for a bound means that category is
    not defined for this organism/agent combination - which is meaningful in
    itself: an agent with only `mic_susceptible_max` reports S or NS, never I.
    """

    set_version: str  # e.g. "CLSI-M100-Ed36"
    standard: str  # "M100", "M45", "M60", "VET01" ...
    table_reference: str | None  # e.g. "Table 2A" - provenance for audit
    organism_group: str  # e.g. "Enterobacterales"
    agent_code: str  # internal antimicrobial code, e.g. "CIP"
    method: Method

    disk_content: str | None = None  # e.g. "5 µg" - required for DISK
    site: str | None = None  # None | "meningitis" | "non_meningitis" | "uti_uncomplicated"
    route: str | None = None  # None | "oral" | "iv"
    dosage_note: str | None = None  # SDD entries are dose-dependent by definition

    mic_susceptible_max: Decimal | None = None
    mic_sdd_min: Decimal | None = None
    mic_sdd_max: Decimal | None = None
    mic_intermediate_min: Decimal | None = None
    mic_intermediate_max: Decimal | None = None
    mic_resistant_min: Decimal | None = None

    disk_susceptible_min: int | None = None
    disk_sdd_min: int | None = None
    disk_sdd_max: int | None = None
    disk_intermediate_min: int | None = None
    disk_intermediate_max: int | None = None
    disk_resistant_max: int | None = None

    tier: Tier = Tier.UNSPECIFIED
    comment: str | None = None

    def specificity(self) -> int:
        """How narrowly this breakpoint is scoped.

        Selection prefers the most specific match, so a meningitis-specific
        criterion beats a generic one for a CSF isolate.
        """
        return (1 if self.site else 0) + (1 if self.route else 0)


@dataclass
class ValidationIssue:
    severity: str  # "error" blocks import; "warning" is recorded and shown
    breakpoint_index: int
    message: str


@dataclass
class BreakpointSet:
    """An immutable, versioned collection of breakpoints."""

    version: str
    source_edition: str  # human-readable, e.g. "CLSI M100 36th ed. (2026)"
    breakpoints: list[Breakpoint] = field(default_factory=list)

    def lookup(
        self,
        *,
        organism_groups: tuple[str, ...],
        agent_code: str,
        method: Method,
        site: str | None = None,
        route: str | None = None,
    ) -> Breakpoint | None:
        """Find the best-matching breakpoint.

        `organism_groups` is ordered most-specific-first (e.g. the organism's
        own group, then its parent groups), mirroring how M100 tables nest
        species inside broader groups.
        """
        # Gradient strips are read as MICs and use the MIC criteria.
        effective = Method.MIC if method.is_mic_like else method

        for rank, group in enumerate(organism_groups):
            candidates = [
                bp
                for bp in self.breakpoints
                if bp.organism_group == group
                and bp.agent_code == agent_code
                and (Method.MIC if bp.method.is_mic_like else bp.method) == effective
                and (bp.site is None or bp.site == site)
                and (bp.route is None or bp.route == route)
            ]
            if candidates:
                # Most specific qualifier wins within the same organism group.
                return max(candidates, key=lambda bp: (bp.specificity(), -rank))
        return None


def validate_breakpoints(breakpoints: list[Breakpoint]) -> list[ValidationIssue]:
    """Check an imported table for the mistakes that transcription introduces.

    Errors block activation. This is the last line of defence between a
    mistyped spreadsheet cell and a clinical report.
    """
    issues: list[ValidationIssue] = []
    seen: set[tuple[str, str, Method, str | None, str | None]] = set()

    for idx, bp in enumerate(breakpoints):

        def err(msg: str, _i: int = idx) -> None:
            issues.append(ValidationIssue("error", _i, msg))

        def warn(msg: str, _i: int = idx) -> None:
            issues.append(ValidationIssue("warning", _i, msg))

        key = (bp.organism_group, bp.agent_code, bp.method, bp.site, bp.route)
        if key in seen:
            err(f"duplicate breakpoint for {bp.organism_group}/{bp.agent_code}/{bp.method}")
        seen.add(key)

        if not bp.organism_group.strip() or not bp.agent_code.strip():
            err("organism_group and agent_code are required")

        if bp.method.is_mic_like:
            _validate_mic_bounds(bp, err, warn)
        else:
            _validate_disk_bounds(bp, err, warn)

        if bp.method == Method.DISK and not bp.disk_content:
            err("disk diffusion breakpoints must record the disk content")

        if (bp.mic_sdd_min is not None or bp.disk_sdd_min is not None) and not bp.dosage_note:
            warn(
                "SDD category without a dosage note: SDD is only interpretable "
                "alongside the dosing regimen it assumes"
            )

    return issues


def _validate_mic_bounds(bp: Breakpoint, err, warn) -> None:  # noqa: ANN001
    s, r = bp.mic_susceptible_max, bp.mic_resistant_min
    if s is None and r is None:
        err("MIC breakpoint defines neither a susceptible nor a resistant bound")

    for name, value in (
        ("mic_susceptible_max", s),
        ("mic_resistant_min", r),
        ("mic_sdd_min", bp.mic_sdd_min),
        ("mic_sdd_max", bp.mic_sdd_max),
        ("mic_intermediate_min", bp.mic_intermediate_min),
        ("mic_intermediate_max", bp.mic_intermediate_max),
    ):
        if value is None:
            continue
        if value <= 0:
            err(f"{name} must be positive")
        elif not is_on_doubling_series(value):
            warn(f"{name}={value} is not on the doubling-dilution series")

    if s is not None and r is not None and s >= r:
        err(f"susceptible bound ({s}) must be below resistant bound ({r})")

    # With no susceptible category at all, the lowest category tabulated has no
    # floor: colistin is intermediate at ≤2 µg/mL and resistant at ≥4, and there
    # is no MIC low enough to be called susceptible.
    open_end = "lower" if s is None else None
    _check_range(bp.mic_sdd_min, bp.mic_sdd_max, "SDD", err, open_end=open_end)
    _check_range(
        bp.mic_intermediate_min, bp.mic_intermediate_max, "intermediate", err, open_end=open_end
    )

    if bp.mic_sdd_max is not None and bp.mic_intermediate_max is not None:
        err("a breakpoint defines both SDD and intermediate ranges; CLSI uses one or the other")

    if s is not None and bp.mic_intermediate_min is not None and bp.mic_intermediate_min <= s:
        err("intermediate range overlaps the susceptible category")
    if r is not None and bp.mic_intermediate_max is not None and bp.mic_intermediate_max >= r:
        err("intermediate range overlaps the resistant category")


def _validate_disk_bounds(bp: Breakpoint, err, warn) -> None:  # noqa: ANN001
    s, r = bp.disk_susceptible_min, bp.disk_resistant_max
    if s is None and r is None:
        err("disk breakpoint defines neither a susceptible nor a resistant bound")

    for name, value in (
        ("disk_susceptible_min", s),
        ("disk_resistant_max", r),
        ("disk_sdd_min", bp.disk_sdd_min),
        ("disk_sdd_max", bp.disk_sdd_max),
        ("disk_intermediate_min", bp.disk_intermediate_min),
        ("disk_intermediate_max", bp.disk_intermediate_max),
    ):
        if value is None:
            continue
        if not (NO_ZONE_MM <= value <= MAX_PLAUSIBLE_ZONE_MM):
            err(
                f"{name}={value} mm is outside the plausible range "
                f"{NO_ZONE_MM}-{MAX_PLAUSIBLE_ZONE_MM} mm"
            )

    # Zone diameters run the opposite way to MICs: bigger zone, more susceptible.
    if s is not None and r is not None and s <= r:
        err(f"susceptible zone bound ({s} mm) must exceed resistant bound ({r} mm)")

    # Zone diameters run the other way round, so the open end of a one-sided
    # zone range is its *upper* bound: "I at 15 mm or more, R at 14 mm or less".
    open_end = "upper" if s is None else None
    _check_range(bp.disk_sdd_min, bp.disk_sdd_max, "SDD", err, open_end=open_end)
    _check_range(
        bp.disk_intermediate_min, bp.disk_intermediate_max, "intermediate", err, open_end=open_end
    )

    if bp.disk_sdd_min is not None and bp.disk_intermediate_min is not None:
        err("a breakpoint defines both SDD and intermediate ranges; CLSI uses one or the other")

    if s is not None and bp.disk_intermediate_max is not None and bp.disk_intermediate_max >= s:
        err("intermediate zone range overlaps the susceptible category")
    if r is not None and bp.disk_intermediate_min is not None and bp.disk_intermediate_min <= r:
        err("intermediate zone range overlaps the resistant category")


def _check_range(lo, hi, label: str, err, *, open_end: str | None = None) -> None:  # noqa: ANN001
    """Check a category range.

    ``open_end`` names the bound that may legitimately be absent — "lower" for
    MICs, "upper" for zone diameters — and is passed only where the criterion
    tabulates no susceptible category. Everywhere else a half-open range means
    a value was lost in transcription, and a half-open range that reached the
    engine would silently swallow every result below it.
    """
    if lo is None and hi is None:
        return
    if (lo is None and open_end != "lower") or (hi is None and open_end != "upper"):
        err(f"{label} range needs both a lower and an upper bound")
    elif lo is not None and hi is not None and lo > hi:
        err(f"{label} range is inverted ({lo} > {hi})")
