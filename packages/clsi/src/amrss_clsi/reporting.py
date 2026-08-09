"""Selective (cascade) reporting and the result-release gate.

CLSI M100 Table 1 groups agents into tiers. Tier 1 is reported routinely;
higher tiers are reported selectively, typically only when the isolate is
resistant to the lower tiers. Reporting every tested agent encourages use of
broader-spectrum drugs than the isolate requires, which is exactly what an AMR
programme exists to prevent.

`release_decision` is the single place that decides whether results may leave
the laboratory. It refuses on out-of-range QC, unresolved interpretations, and
unreviewed rule flags.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from amrss_clsi.breakpoints import Category, Method, Tier
from amrss_clsi.qc import QCFrequency, QCResult, qc_status
from amrss_clsi.rules import ResultEntry

# Categories that mean "this agent is an option for the patient".
_EFFECTIVE = frozenset({Category.S, Category.SDD})


@dataclass
class CascadeDecision:
    agent_code: str
    reportable: bool
    tier: Tier
    reason: str


def apply_cascade(
    results: dict[str, ResultEntry],
    tiers: dict[str, Tier],
    *,
    enabled: bool = True,
) -> list[CascadeDecision]:
    """Decide which agents appear on the clinician-facing report.

    Rule: a tier is released only when no lower tier offers an effective agent.
    Agents whose tier is unspecified are always released - failing open here is
    correct, because withholding a result the clinician needs is the worse
    error.
    """
    decisions: list[CascadeDecision] = []
    if not enabled:
        return [
            CascadeDecision(code, True, tiers.get(code, Tier.UNSPECIFIED), "cascade disabled")
            for code in results
        ]

    ordered_tiers = [Tier.TIER_1, Tier.TIER_2, Tier.TIER_3, Tier.TIER_4]
    lower_tier_covered = False

    for code in results:
        if tiers.get(code, Tier.UNSPECIFIED) is Tier.UNSPECIFIED:
            decisions.append(
                CascadeDecision(code, True, Tier.UNSPECIFIED, "no tier assigned; reported")
            )

    for tier in ordered_tiers:
        agents_in_tier = [c for c in results if tiers.get(c) is tier]
        if not agents_in_tier:
            continue

        if tier is Tier.TIER_1 or not lower_tier_covered:
            for code in agents_in_tier:
                decisions.append(
                    CascadeDecision(
                        code,
                        True,
                        tier,
                        "primary tier"
                        if tier is Tier.TIER_1
                        else "no effective agent in a lower tier",
                    )
                )
        else:
            for code in agents_in_tier:
                decisions.append(
                    CascadeDecision(
                        code,
                        False,
                        tier,
                        "suppressed: an effective lower-tier agent is available",
                    )
                )

        if any(results[c].category in _EFFECTIVE for c in agents_in_tier):
            lower_tier_covered = True

    return decisions


@dataclass
class ReleaseBlocker:
    code: str
    message: str
    agent_code: str | None = None


@dataclass
class ReleaseDecision:
    allowed: bool
    blockers: list[ReleaseBlocker] = field(default_factory=list)

    def blocker_summary(self) -> str:
        return "; ".join(b.message for b in self.blockers)


def release_decision(
    *,
    results: dict[str, ResultEntry],
    qc_results: list[QCResult],
    unresolved_flags: dict[str, str] | None = None,
    enforce_qc: bool = True,
    qc_frequency: QCFrequency = QCFrequency.DAILY,
    now: datetime | None = None,
) -> ReleaseDecision:
    """Whether this isolate's results may be released to the clinician."""
    blockers: list[ReleaseBlocker] = []
    unresolved_flags = unresolved_flags or {}

    for code, entry in results.items():
        if entry.category is Category.NI:
            blockers.append(
                ReleaseBlocker(
                    "uninterpretable_result",
                    f"{code}: result has no interpretation and needs resolution",
                    code,
                )
            )

    for code, note in unresolved_flags.items():
        blockers.append(ReleaseBlocker("unresolved_rule_flag", f"{code}: {note}", code))

    if enforce_qc:
        for code, entry in results.items():
            status = qc_status(
                agent_code=code,
                method=entry.method,
                recent_results=qc_results,
                frequency=qc_frequency,
                now=now,
            )
            if not status.satisfied:
                blockers.append(
                    ReleaseBlocker("qc_not_satisfied", f"{code}: {status.reason}", code)
                )

    return ReleaseDecision(allowed=not blockers, blockers=blockers)


def is_multidrug_resistant(
    results: dict[str, ResultEntry],
    agent_classes: dict[str, str],
    *,
    threshold: int = 3,
) -> tuple[bool, list[str]]:
    """MDR screen: nonsusceptible to >= `threshold` antimicrobial classes.

    Follows the Magiorakos et al. definition used by ECDC/CDC, which counts
    *classes* rather than agents - three fluoroquinolones is one class, not
    three.
    """
    nonsusceptible_classes: set[str] = set()
    for code, entry in results.items():
        if entry.category in (Category.R, Category.I, Category.NS):
            cls = agent_classes.get(code)
            if cls:
                nonsusceptible_classes.add(cls)
    return len(nonsusceptible_classes) >= threshold, sorted(nonsusceptible_classes)


def method_label(method: Method) -> str:
    return {
        Method.MIC: "Broth microdilution (MIC)",
        Method.GRADIENT: "Gradient diffusion (MIC)",
        Method.DISK: "Disk diffusion",
    }[method]
