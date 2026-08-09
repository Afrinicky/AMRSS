"""Turning recorded measurements into susceptibility categories.

Real WHONET exports frequently carry only zone diameters or MIC values with no
S/I/R letter attached — in the two exports validated against, *every* AST value
was a millimetre reading. Those arrive as ``PENDING_INTERPRETATION``: good data
that cannot yet enter a denominator. This module is what converts them, using
the shared CLSI engine in ``amrss_clsi`` rather than a second implementation
living here. Two implementations of "is this isolate resistant" is not a
code-duplication problem, it is a patient-safety problem.

Three rules govern the conversion, and each exists to prevent a specific way of
publishing a number that is not true:

1. **No breakpoint table, no interpretation.** The engine refuses rather than
   falling back on a built-in default, exactly as the methodology resolver does
   (ADR-0003). A plausible-looking category derived from a guessed threshold is
   worse than an honest gap.
2. **"No breakpoint for this combination" leaves the result pending, not
   uninterpretable.** The measurement is still good; the table simply does not
   cover it yet. Loading a fuller edition later must be able to recover it, and
   marking it NI would bury it permanently.
3. **Nothing is overwritten.** Only results still awaiting interpretation are
   touched. A category the laboratory itself reported is theirs, and AMRSS does
   not silently re-decide it — if the two disagree, that is a finding for the
   data steward, not something to paper over.
"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from amrss_clsi.breakpoints import Breakpoint, BreakpointSet, Category, Method, Tier
from amrss_clsi.interpretation import NoInterpretationReason, interpret
from amrss_clsi.mic import MICValue
from sqlalchemy import select
from sqlalchemy.orm import Session

from amrss.analytics.methodology import MethodologySet
from amrss.models import AstResult, CanonicalAntibiotic, CanonicalOrganism, Isolate
from amrss.models.enums import MethodologyComponent, SirResult

#: CLSI category to the surveillance vocabulary. Deliberately explicit rather
#: than a name-based lookup: the two enums agreeing today is not a reason to let
#: a future rename silently reclassify results.
CATEGORY_TO_RESULT = {
    Category.S: SirResult.SUSCEPTIBLE,
    Category.SDD: SirResult.SUSCEPTIBLE_DOSE_DEPENDENT,
    Category.I: SirResult.INTERMEDIATE,
    Category.R: SirResult.RESISTANT,
    Category.NS: SirResult.NON_SUSCEPTIBLE,
}

#: Reasons that describe the measurement itself and will never resolve, however
#: complete a future breakpoint table is. Everything else stays pending.
TERMINAL_REASONS = frozenset(
    {
        NoInterpretationReason.OFF_SCALE_AMBIGUOUS,
        NoInterpretationReason.IMPLAUSIBLE_MEASUREMENT,
        NoInterpretationReason.GAP_IN_CRITERIA,
    }
)


class BreakpointsNotConfiguredError(RuntimeError):
    """Raised when no AST breakpoint table has been loaded.

    The engine refuses to compute rather than inventing thresholds. A laboratory
    that has not yet loaded its licensed CLSI tables gets a clear message and an
    unchanged pending count, not an antibiogram built on guesses.
    """

    def __init__(self) -> None:
        super().__init__(
            "No AST breakpoint table is loaded. Import the laboratory's licensed CLSI "
            "M100 (or M45/M60) tables before interpreting measurements; see "
            "data/breakpoints/clsi_m100.template.csv."
        )


@dataclass
class InterpretationReport:
    """What a pass over the pending results actually did.

    Reported in full rather than summarised to a success count: "1,200 pending,
    40 interpreted" is a different situation from "1,200 pending, 1,180
    interpreted", and only the breakdown distinguishes an incomplete breakpoint
    table from a mismatched agent-code mapping.
    """

    examined: int = 0
    interpreted: int = 0
    still_pending: int = 0
    not_interpretable: int = 0
    #: Combinations the loaded table does not cover, counted so a steward can see
    #: which agents to prioritise in the next import.
    uncovered: dict[str, int] = field(default_factory=dict)
    breakpoint_set_version: str | None = None
    interpreted_at: datetime | None = None

    @property
    def coverage_percent(self) -> float:
        if self.examined == 0:
            return 0.0
        return round(100.0 * self.interpreted / self.examined, 1)


def _decimal(value: Any) -> Decimal | None:
    return None if value is None else Decimal(str(value))


def build_breakpoint_set(methodology: MethodologySet) -> BreakpointSet:
    """Assemble the engine's breakpoint set from the versioned methodology.

    The table lives in ``methodology_version`` like every other rule (ADR-0003),
    so a result interpreted today stays explicable after the laboratory moves to
    the next CLSI edition: the version that produced it is recorded alongside it.
    """
    component = methodology.get(MethodologyComponent.AST_BREAKPOINTS)
    if component is None:
        raise BreakpointsNotConfiguredError()

    rows = component.get("breakpoints") or []
    if not rows:
        raise BreakpointsNotConfiguredError()

    breakpoints = [
        Breakpoint(
            organism_group=row["organism_group"],
            agent_code=row["agent_code"],
            method=Method(row["method"]),
            standard=row["standard"],
            set_version=component.version,
            table_reference=row.get("table_reference"),
            tier=Tier(row["tier"]) if row.get("tier") else Tier.UNSPECIFIED,
            site=row.get("site"),
            route=row.get("route"),
            disk_content=row.get("disk_content"),
            mic_susceptible_max=_decimal(row.get("mic_susceptible_max")),
            mic_sdd_min=_decimal(row.get("mic_sdd_min")),
            mic_sdd_max=_decimal(row.get("mic_sdd_max")),
            mic_intermediate_min=_decimal(row.get("mic_intermediate_min")),
            mic_intermediate_max=_decimal(row.get("mic_intermediate_max")),
            mic_resistant_min=_decimal(row.get("mic_resistant_min")),
            disk_susceptible_min=row.get("disk_susceptible_min"),
            disk_sdd_min=row.get("disk_sdd_min"),
            disk_sdd_max=row.get("disk_sdd_max"),
            disk_intermediate_min=row.get("disk_intermediate_min"),
            disk_intermediate_max=row.get("disk_intermediate_max"),
            disk_resistant_max=row.get("disk_resistant_max"),
            comment=row.get("comment"),
        )
        for row in rows
    ]

    return BreakpointSet(
        version=component.version,
        source_edition=str(component.get("label", component.version)),
        breakpoints=breakpoints,
    )


def _method_for(result: AstResult) -> Method | None:
    """Which CLSI method this measurement was produced by.

    Taken from the recorded method where the laboratory stated one, and
    otherwise inferred from which measurement is present — a zone diameter can
    only have come from disk diffusion. Where neither is available the result is
    left alone rather than assumed.
    """
    declared = (result.test_method or "").strip().upper()
    if declared in {"DISK", "DISC", "DIFFUSION", "DD"}:
        return Method.DISK
    if declared in {"MIC", "BMD", "AGAR"}:
        return Method.MIC
    if declared in {"GRADIENT", "ETEST", "E-TEST", "MTS"}:
        return Method.GRADIENT

    if result.zone_diameter_mm is not None:
        return Method.DISK
    if result.mic_value is not None:
        return Method.MIC
    return None


def _mic_of(result: AstResult) -> MICValue | None:
    """Rebuild the MIC as the engine expects it, operator included.

    The operator is not decoration: ``>64`` and ``64`` interpret differently
    against a resistant breakpoint of 64, and dropping it would turn an
    off-scale reading into a false exact one.
    """
    if result.mic_value is None:
        return None
    operator = result.mic_operator or "="
    prefix = "" if operator == "=" else operator
    return MICValue.parse(f"{prefix}{result.mic_value}")


def interpret_pending(
    db: Session,
    methodology: MethodologySet,
    *,
    facility_id: uuid.UUID | None = None,
    commit: bool = True,
) -> InterpretationReport:
    """Interpret every measurement still awaiting a category.

    Scoped to one facility when given, so a laboratory can be reprocessed after
    its agent-code mappings are corrected without touching anyone else's data.
    """
    breakpoint_set = build_breakpoint_set(methodology)
    report = InterpretationReport(
        breakpoint_set_version=breakpoint_set.version,
        interpreted_at=datetime.now(UTC),
    )

    organisms = {o.id: o for o in db.scalars(select(CanonicalOrganism))}
    antibiotics = {a.id: a for a in db.scalars(select(CanonicalAntibiotic))}

    query = (
        select(AstResult)
        .join(Isolate, AstResult.isolate_id == Isolate.id)
        .where(AstResult.result == SirResult.PENDING_INTERPRETATION)
    )
    if facility_id is not None:
        query = query.where(Isolate.facility_id == facility_id)

    for ast in db.scalars(query):
        report.examined += 1

        organism = organisms.get(ast.isolate.canonical_organism_id)
        antibiotic = antibiotics.get(ast.canonical_antibiotic_id)
        method = _method_for(ast)
        if organism is None or antibiotic is None or method is None:
            report.still_pending += 1
            continue

        groups = tuple(organism.clsi_organism_groups or ()) or (organism.name,)
        agent_code = antibiotic.clsi_agent_code or antibiotic.code

        interpretation = interpret(
            breakpoint_set=breakpoint_set,
            organism_groups=groups,
            agent_code=agent_code,
            method=method,
            mic=_mic_of(ast) if method.is_mic_like else None,
            zone_mm=ast.zone_diameter_mm if method is Method.DISK else None,
        )

        mapped = CATEGORY_TO_RESULT.get(interpretation.category)
        if mapped is not None:
            ast.result = mapped
            report.interpreted += 1
            continue

        if interpretation.reason in TERMINAL_REASONS:
            ast.result = SirResult.NOT_INTERPRETABLE
            report.not_interpretable += 1
            continue

        # No criterion for this organism/agent/method in the loaded table. The
        # measurement stays pending so a fuller edition can still recover it.
        report.still_pending += 1
        key = f"{groups[0]}/{agent_code}/{method.value}"
        report.uncovered[key] = report.uncovered.get(key, 0) + 1

    if commit:
        db.commit()
    return report
