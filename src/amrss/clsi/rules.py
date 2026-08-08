"""Intrinsic resistance and expert rules.

Two families of post-interpretation logic, both required by CLSI M100 before a
susceptibility report reaches a clinician:

* **Intrinsic resistance** (M100 Appendix B) - organism/agent combinations that
  are resistant by nature. A susceptible result here means the test or the
  identification is wrong, not that the drug will work.
* **Expert rules** - inferences and suppressions driven by a resistance
  mechanism, e.g. an oxacillin-resistant *S. aureus* must be reported resistant
  to essentially all beta-lactams regardless of what each individual well says.

The rules below are the well-established, textbook subset, seeded so the system
is useful on day one. **Every one carries `requires_local_verification=True`
and must be checked against your licensed M100 edition before clinical use** -
Appendix B and the expert-rule tables change between editions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from amrss.clsi.breakpoints import Category, Method
from amrss.clsi.mic import MICValue


class RuleAction(StrEnum):
    OVERRIDE_CATEGORY = "override_category"  # force a category
    SUPPRESS = "suppress"  # do not report this agent at all
    ADD_COMMENT = "add_comment"  # report as-is, with a note
    FLAG_CONFIRMATION = "flag_confirmation"  # hold for confirmatory testing


@dataclass(frozen=True)
class ResultEntry:
    agent_code: str
    category: Category
    method: Method
    mic: MICValue | None = None
    zone_mm: int | None = None


@dataclass
class IsolateResults:
    organism_code: str
    organism_groups: tuple[str, ...]
    results: dict[str, ResultEntry] = field(default_factory=dict)

    def category_of(self, agent_code: str) -> Category | None:
        entry = self.results.get(agent_code)
        return entry.category if entry else None

    def in_group(self, group: str) -> bool:
        return group in self.organism_groups


@dataclass
class RuleOutcome:
    rule_id: str
    agent_code: str
    action: RuleAction
    new_category: Category | None = None
    comment: str | None = None
    requires_local_verification: bool = True


@dataclass(frozen=True)
class IntrinsicResistance:
    """An organism group that is inherently resistant to an agent."""

    organism_group: str
    agent_code: str
    note: str | None = None
    source: str = "CLSI M100 Appendix B (verify against your edition)"


# Beta-lactam classes affected by mecA/mecC-mediated oxacillin resistance in
# staphylococci. Agent codes are internal; map them in the antimicrobial table.
STAPH_BETA_LACTAMS = frozenset(
    {
        "PEN",
        "AMP",
        "AMC",
        "AMS",
        "OXA",
        "FOX",
        "PIP",
        "TZP",
        "CZO",
        "CXM",
        "CRO",
        "CTX",
        "CAZ",
        "FEP",
        "ETP",
        "IPM",
        "MEM",
        "DOR",
    }
)
# Anti-MRSA agents that stay individually reportable despite the rule above.
ANTI_MRSA_BETA_LACTAMS = frozenset({"CPT", "CFD"})  # ceftaroline, ceftobiprole


# --- Seed intrinsic-resistance table -------------------------------------
# Deliberately small and uncontroversial. Extend it from Appendix B during
# deployment; the loader accepts additional rows without a code change.
SEED_INTRINSIC_RESISTANCE: tuple[IntrinsicResistance, ...] = (
    IntrinsicResistance("Klebsiella spp.", "AMP", "Chromosomal SHV beta-lactamase"),
    IntrinsicResistance("Klebsiella spp.", "AMX"),
    IntrinsicResistance("Proteus mirabilis", "COL", "Intrinsically colistin resistant"),
    IntrinsicResistance("Proteus mirabilis", "TGC"),
    IntrinsicResistance("Proteus mirabilis", "NIT"),
    IntrinsicResistance("Serratia marcescens", "COL"),
    IntrinsicResistance("Serratia marcescens", "NIT"),
    IntrinsicResistance("Morganella morganii", "COL"),
    IntrinsicResistance("Enterobacter cloacae complex", "AMP", "Inducible AmpC"),
    IntrinsicResistance("Enterobacter cloacae complex", "AMC"),
    IntrinsicResistance("Enterobacter cloacae complex", "CZO"),
    IntrinsicResistance("Citrobacter freundii complex", "AMP", "Inducible AmpC"),
    IntrinsicResistance("Citrobacter freundii complex", "CZO"),
    IntrinsicResistance("Pseudomonas aeruginosa", "AMP"),
    IntrinsicResistance("Pseudomonas aeruginosa", "AMC"),
    IntrinsicResistance("Pseudomonas aeruginosa", "CRO"),
    IntrinsicResistance("Pseudomonas aeruginosa", "SXT"),
    IntrinsicResistance("Pseudomonas aeruginosa", "TGC"),
    IntrinsicResistance("Stenotrophomonas maltophilia", "IPM", "Metallo-beta-lactamase L1"),
    IntrinsicResistance("Stenotrophomonas maltophilia", "MEM"),
    IntrinsicResistance("Acinetobacter baumannii complex", "AMP"),
    IntrinsicResistance("Acinetobacter baumannii complex", "ATM"),
    IntrinsicResistance(
        "Enterococcus spp.", "CZO", "Enterococci are resistant to all cephalosporins"
    ),
    IntrinsicResistance("Enterococcus spp.", "CRO"),
    IntrinsicResistance(
        "Enterococcus spp.",
        "SXT",
        "May test susceptible in vitro but is not effective in vivo",
    ),
    IntrinsicResistance("Enterococcus spp.", "CLI"),
    IntrinsicResistance("Enterococcus faecalis", "QDA"),
    IntrinsicResistance("Listeria monocytogenes", "CRO"),
    IntrinsicResistance("Anaerobes - gram negative", "AMK"),
)


def check_intrinsic_resistance(
    isolate: IsolateResults,
    table: tuple[IntrinsicResistance, ...] = SEED_INTRINSIC_RESISTANCE,
) -> list[RuleOutcome]:
    """Force R (and flag) where an organism is intrinsically resistant."""
    outcomes: list[RuleOutcome] = []
    for entry in table:
        if not (
            isolate.in_group(entry.organism_group) or isolate.organism_code == entry.organism_group
        ):
            continue
        result = isolate.results.get(entry.agent_code)
        if result is None:
            continue
        comment = entry.note or "Intrinsically resistant"
        if result.category in (Category.S, Category.SDD, Category.I):
            outcomes.append(
                RuleOutcome(
                    rule_id=f"intrinsic:{entry.organism_group}:{entry.agent_code}",
                    agent_code=entry.agent_code,
                    action=RuleAction.OVERRIDE_CATEGORY,
                    new_category=Category.R,
                    comment=(
                        f"{comment}. Reported susceptible in vitro - verify organism "
                        f"identification and test performance. ({entry.source})"
                    ),
                )
            )
        else:
            outcomes.append(
                RuleOutcome(
                    rule_id=f"intrinsic:{entry.organism_group}:{entry.agent_code}",
                    agent_code=entry.agent_code,
                    action=RuleAction.SUPPRESS,
                    comment=f"{comment}; not reported.",
                )
            )
    return outcomes


def apply_expert_rules(isolate: IsolateResults) -> list[RuleOutcome]:
    """Apply mechanism-driven inference rules."""
    outcomes: list[RuleOutcome] = []
    outcomes += _staphylococcal_beta_lactam_rule(isolate)
    outcomes += _inducible_clindamycin_rule(isolate)
    outcomes += _enterococcal_ampicillin_rule(isolate)
    outcomes += _carbapenem_confirmation_rule(isolate)
    return outcomes


def _staphylococcal_beta_lactam_rule(isolate: IsolateResults) -> list[RuleOutcome]:
    """Oxacillin/cefoxitin-resistant staphylococci are resistant to beta-lactams.

    mecA-mediated resistance is not reliably detected agent-by-agent, so an
    individually susceptible cephalosporin result must not be reported.
    """
    if not isolate.in_group("Staphylococcus spp."):
        return []
    surrogate = isolate.category_of("FOX") or isolate.category_of("OXA")
    if surrogate is not Category.R:
        return []

    outcomes = []
    for agent_code in isolate.results:
        if agent_code in ANTI_MRSA_BETA_LACTAMS or agent_code not in STAPH_BETA_LACTAMS:
            continue
        if isolate.results[agent_code].category is Category.R:
            continue
        outcomes.append(
            RuleOutcome(
                rule_id="expert:staph_mrsa_beta_lactam",
                agent_code=agent_code,
                action=RuleAction.OVERRIDE_CATEGORY,
                new_category=Category.R,
                comment=(
                    "Oxacillin/cefoxitin resistant (mec-mediated): report resistant to "
                    "all penicillins, beta-lactam combinations, cephems (except "
                    "anti-MRSA cephalosporins) and carbapenems."
                ),
            )
        )
    return outcomes


def _inducible_clindamycin_rule(isolate: IsolateResults) -> list[RuleOutcome]:
    """Erythromycin-R with clindamycin-S needs a D-zone/induction test."""
    if not (isolate.in_group("Staphylococcus spp.") or isolate.in_group("Streptococcus spp.")):
        return []
    if isolate.category_of("ERY") is not Category.R:
        return []
    if isolate.category_of("CLI") not in (Category.S, Category.SDD, Category.I):
        return []
    return [
        RuleOutcome(
            rule_id="expert:inducible_clindamycin",
            agent_code="CLI",
            action=RuleAction.FLAG_CONFIRMATION,
            comment=(
                "Erythromycin-resistant, clindamycin-susceptible: perform a D-zone "
                "(inducible clindamycin resistance) test. If positive, report "
                "clindamycin resistant."
            ),
        )
    ]


def _enterococcal_ampicillin_rule(isolate: IsolateResults) -> list[RuleOutcome]:
    """Ampicillin resistance in enterococci predicts penicillin resistance."""
    if not isolate.in_group("Enterococcus spp."):
        return []
    if isolate.category_of("AMP") is not Category.R:
        return []
    if isolate.category_of("PEN") in (None, Category.R):
        return []
    return [
        RuleOutcome(
            rule_id="expert:enterococcus_amp_predicts_pen",
            agent_code="PEN",
            action=RuleAction.OVERRIDE_CATEGORY,
            new_category=Category.R,
            comment="Ampicillin-resistant enterococci are also penicillin resistant.",
        )
    ]


def _carbapenem_confirmation_rule(isolate: IsolateResults) -> list[RuleOutcome]:
    """Carbapenem-nonsusceptible Enterobacterales warrant mechanism testing.

    The result is still reported as measured - this flags the isolate for
    carbapenemase confirmation and infection-control notification, which is the
    surveillance-critical action.
    """
    if not isolate.in_group("Enterobacterales"):
        return []
    nonsusceptible = [
        code
        for code in ("ETP", "IPM", "MEM", "DOR")
        if isolate.category_of(code) in (Category.I, Category.R, Category.NS)
    ]
    if not nonsusceptible:
        return []
    return [
        RuleOutcome(
            rule_id="expert:cre_confirmation",
            agent_code=code,
            action=RuleAction.FLAG_CONFIRMATION,
            comment=(
                "Carbapenem-nonsusceptible Enterobacterales: perform carbapenemase "
                "detection and notify infection prevention."
            ),
        )
        for code in nonsusceptible
    ]


def resolve(
    isolate: IsolateResults,
    outcomes: list[RuleOutcome],
) -> dict[str, ResultEntry]:
    """Fold rule outcomes into the final reportable result set.

    Suppressed agents are dropped; overrides replace the category. Comments and
    confirmation flags are the caller's to record - they do not change values.
    """
    final = dict(isolate.results)
    for outcome in outcomes:
        if outcome.action is RuleAction.SUPPRESS:
            final.pop(outcome.agent_code, None)
        elif outcome.action is RuleAction.OVERRIDE_CATEGORY and outcome.new_category:
            existing = final.get(outcome.agent_code)
            if existing is not None:
                final[outcome.agent_code] = ResultEntry(
                    agent_code=existing.agent_code,
                    category=outcome.new_category,
                    method=existing.method,
                    mic=existing.mic,
                    zone_mm=existing.zone_mm,
                )
    return final
