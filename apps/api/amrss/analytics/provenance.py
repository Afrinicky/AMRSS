"""The "How was this calculated?" disclosure (SDD 5.9).

Required on every antibiogram and statistic, not optional documentation. It is
built by projecting the values the engine actually used — the resolved
methodology objects and the computation's own counts — rather than by writing
prose describing what the engine is believed to do. Hand-written descriptions
drift; this cannot, because a change to the rule changes the disclosure in the
same step.
"""

from dataclasses import dataclass
from typing import Any

from amrss.analytics.antibiogram import Antibiogram
from amrss.analytics.methodology import MethodologySet
from amrss.analytics.query import SurveillanceFilter


@dataclass(frozen=True)
class MethodologyCitation:
    component: str
    version: str
    description: str
    is_provisional: bool


def _inclusion_criteria(antibiogram: Antibiogram) -> list[str]:
    criteria = [
        "Isolate belongs to an upload batch in ACCEPTED status",
        "Contributing facility is ACTIVE in the enrollment lifecycle",
    ]
    if antibiogram.verified_only:
        criteria.append("Contributing facility QC attestation and EQA are current and satisfactory")
    else:
        criteria.append(
            "Facility's own view: included regardless of QC/EQA status, so this is not "
            "the verified aggregate"
        )
    return criteria


def describe(
    antibiogram: Antibiogram,
    methodology: MethodologySet,
    filters: SurveillanceFilter,
) -> dict[str, Any]:
    citations = [
        MethodologyCitation(
            component=component.value,
            version=resolved.version,
            description=resolved.description,
            is_provisional=resolved.is_provisional,
        )
        for component, resolved in sorted(
            methodology.components.items(), key=lambda item: item[0].value
        )
    ]

    return {
        "aggregation_level": antibiogram.level.value,
        "surveillance_period": {
            "start": antibiogram.period_start.isoformat() if antibiogram.period_start else None,
            "end": antibiogram.period_end.isoformat() if antibiogram.period_end else None,
        },
        "scope": filters.describe(),
        "participating_facilities": len(antibiogram.contributing_facility_ids),
        "inclusion_criteria": _inclusion_criteria(antibiogram),
        "deduplication": antibiogram.deduplication.describe(),
        "isolate_counts": {
            "all_isolates_in_scope": antibiogram.raw_isolate_count,
            "antibiogram_eligible_after_deduplication": (
                antibiogram.deduplication.retained_isolates
            ),
        },
        "reporting_threshold": {
            "minimum_isolates": antibiogram.minimum_isolates,
            "basis": "CLSI M39 minimum isolate count for antibiogram reporting",
            "applied_at": antibiogram.level.value,
            "note": (
                "Combinations below this count are shown as below-threshold, never as a percentage."
            ),
        },
        "suppression": {
            "applied": antibiogram.suppression_applied,
            "small_cell_threshold": antibiogram.small_cell_threshold,
            "basis": (
                "Cross-facility breakdowns below this count are withheld to prevent "
                "re-identification. A facility always sees its own data un-suppressed."
            ),
        },
        "quality_gating": {
            "facilities_excluded": antibiogram.quality_exclusion.excluded_facility_count,
            "isolates_excluded": antibiogram.quality_exclusion.excluded_isolate_count,
            "basis": (
                "A facility contributes to the verified aggregate only while its QC "
                "attestation and EQA status are both current and satisfactory."
            ),
        },
        "ast_interpretation_standard": methodology.breakpoint_standard,
        "susceptibility_definition": (
            "Percent susceptible counts results reported as S against all interpretable "
            "results. Susceptible-dose-dependent results are interpretable but are not "
            "counted as susceptible, since they do not reflect standard dosing."
        ),
        "methodology_versions": [
            {
                "component": citation.component,
                "version": citation.version,
                "description": citation.description,
                "provisional": citation.is_provisional,
            }
            for citation in citations
        ],
        "provisional_methodology_in_use": any(c.is_provisional for c in citations),
        "limitations": [
            "Susceptibility patterns reflect isolates submitted by participating "
            "laboratories and may not represent facilities that did not report in "
            "this period.",
            "AMRSS reports surveillance intelligence, not treatment recommendations.",
        ],
    }
