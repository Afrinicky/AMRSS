"""Screening-level phenotype flags (SDD 5.5).

v1 infers phenotypes only where a standard WHONET AST panel supports it, and
labels every result as **observed phenotype (screening-level)**. It never says
"confirmed". Confirmatory mechanism detection needs testing that participating
laboratories cannot yet perform consistently, and a system that blurred screening
into confirmation would put an unearned word in a clinician's hands.

Rules live in the ``phenotype_flags`` methodology version so the supported list is
versioned and auditable rather than compiled in. Rule shape:

    {
      "code": "MRSA_SCREEN",
      "label": "MRSA phenotype (screening-level)",
      "organism_codes": ["SAU"],           # or "organism_selector": "enterobacterales"
      "any_resistant": ["FOX"],            # any listed agent reported R or NS
      "all_tested": ["FOX"],               # every listed agent must have a result
      "basis": "Cefoxitin-resistant Staphylococcus aureus"
    }
"""

import uuid
from dataclasses import dataclass
from typing import Any

from amrss.analytics.records import IsolateRecord
from amrss.models.enums import SirResult

NON_SUSCEPTIBLE_RESULTS = frozenset(
    {SirResult.RESISTANT, SirResult.NON_SUSCEPTIBLE, SirResult.INTERMEDIATE}
)
RESISTANT_RESULTS = frozenset({SirResult.RESISTANT, SirResult.NON_SUSCEPTIBLE})


@dataclass(frozen=True)
class OrganismInfo:
    id: uuid.UUID
    code: str
    is_enterobacterales: bool
    genus: str | None


@dataclass(frozen=True)
class AntibioticInfo:
    id: uuid.UUID
    code: str


@dataclass(frozen=True)
class PhenotypeObservation:
    isolate_id: uuid.UUID
    flag_code: str
    label: str
    basis: str
    #: Always true in v1. Present as data rather than assumed, so that any future
    #: confirmatory pathway must set it explicitly rather than inherit the label
    #: by omission.
    is_screening_level: bool = True


def _organism_matches(rule: dict[str, Any], organism: OrganismInfo) -> bool:
    selector = rule.get("organism_selector")
    if selector == "enterobacterales":
        return organism.is_enterobacterales
    codes = rule.get("organism_codes")
    if codes:
        return organism.code in codes
    genera = rule.get("organism_genera")
    if genera:
        return organism.genus in genera
    return False


def evaluate(
    record: IsolateRecord,
    rules: list[dict[str, Any]],
    organisms: dict[uuid.UUID, OrganismInfo],
    antibiotic_codes: dict[uuid.UUID, str],
) -> list[PhenotypeObservation]:
    """Apply the rule set to one isolate.

    A rule fires only when every agent it names has a result. Treating an untested
    agent as susceptible would silently convert a gap in the panel into a negative
    finding, which is how a laboratory that stopped testing carbapenems would
    appear to have eliminated carbapenem resistance.
    """
    organism = organisms.get(record.organism_id)
    if organism is None:
        return []

    results_by_code: dict[str, SirResult] = {}
    for antibiotic_id, result in record.results.items():
        code = antibiotic_codes.get(antibiotic_id)
        if code is not None:
            results_by_code[code] = result

    observations: list[PhenotypeObservation] = []
    for rule in rules:
        if not _organism_matches(rule, organism):
            continue

        any_resistant = rule.get("any_resistant", [])
        required = rule.get("all_tested") or any_resistant
        if not required:
            continue

        available = {
            code: results_by_code[code]
            for code in required
            if code in results_by_code and results_by_code[code].is_interpretable
        }
        if len(available) < len(required):
            continue

        include_intermediate = bool(rule.get("count_intermediate_as_non_susceptible", False))
        positive_set = NON_SUSCEPTIBLE_RESULTS if include_intermediate else RESISTANT_RESULTS
        if not any(results_by_code.get(code) in positive_set for code in any_resistant):
            continue

        observations.append(
            PhenotypeObservation(
                isolate_id=record.id,
                flag_code=str(rule["code"]),
                label=str(rule.get("label", rule["code"])),
                basis=str(rule.get("basis", "")),
            )
        )
    return observations
