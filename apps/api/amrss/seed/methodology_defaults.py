"""Provisional methodology defaults.

Every entry here is marked ``is_provisional=True`` and is a **placeholder pending
SDD 13 sign-off**, not an agreed decision. The engine refuses to compute without a
methodology version, so shipping without these would block all analytics; marking
them provisional means the interface can say so on every statistic they touch,
and no one can mistake a development default for a committee decision.

Replacing a provisional version is an admin action that creates a new, approved
version with a later effective date. The provisional one is never edited in place
— statistics computed under it must remain explicable.
"""

from datetime import date
from typing import Any, TypedDict

from amrss.models.enums import MethodologyComponent

PROVISIONAL_FROM = date(2020, 1, 1)


class MethodologySeed(TypedDict):
    component: MethodologyComponent
    version: str
    description: str
    parameters: dict[str, Any]
    open_question: str | None


DEFAULTS: list[MethodologySeed] = [
    {
        "component": MethodologyComponent.ANTIBIOGRAM,
        "version": "0.1-provisional",
        "description": (
            "CLSI M39-aligned antibiogram computation. Minimum isolate count of 30 "
            "chosen as the more conservative of the two values under consideration; "
            "a lower threshold publishes more combinations but with wider real "
            "uncertainty than the presented figure implies."
        ),
        "parameters": {
            "minimum_isolates": 30,
            "confidence_level": 0.95,
            "modest_n_ceiling": 100,
        },
        "open_question": "SDD 13.1 — confirm minimum isolate threshold (20 or 30)",
    },
    {
        "component": MethodologyComponent.DEDUPLICATION,
        "version": "0.1-provisional",
        "description": (
            "First isolate per patient per organism per rolling 30-day window, scoped "
            "to the contributing facility. The 30-day convention is the common CLSI "
            "M39 implementation."
        ),
        "parameters": {
            "strategy": "first_isolate_per_patient_organism_window",
            "window_days": 30,
            "scope": "facility",
        },
        "open_question": "SDD 13.10 — confirm deduplication window against the chosen standard",
    },
    {
        "component": MethodologyComponent.SUPPRESSION,
        "version": "0.1-provisional",
        "description": (
            "Small-cell suppression at n<5 for any cross-facility, district or "
            "regional breakdown. Applied independently of the antibiogram reporting "
            "threshold. A facility always sees its own data un-suppressed."
        ),
        "parameters": {
            "small_cell_threshold": 5,
            "applies_to": "cross_facility_views",
        },
        "open_question": None,
    },
    {
        "component": MethodologyComponent.EMERGING_SIGNAL_TRIGGER,
        "version": "0.1-provisional",
        "description": (
            "Compares a trailing 12-week baseline against a trailing 4-week current "
            "window, which must not overlap. Each window must independently reach 15 "
            "interpretable isolates before any comparison is made. A fall of 15 "
            "percentage points or more in susceptibility raises a signal for expert "
            "review — never an outbreak determination."
        ),
        "parameters": {
            "baseline_window_days": 84,
            "current_window_days": 28,
            "minimum_n_per_window": 15,
            "change_threshold_percentage_points": 15.0,
            "direction": "decrease_in_susceptibility_only",
        },
        "open_question": (
            "SDD 13.9 — trigger thresholds and window lengths to be set by clinical "
            "and epidemiological leads"
        ),
    },
    {
        "component": MethodologyComponent.AST_BREAKPOINTS,
        "version": "0.1-provisional",
        "description": (
            "Records the AST interpretation standard that contributing laboratories "
            "apply. AMRSS v1 accepts the laboratory's S/I/R interpretation and does "
            "not re-interpret MIC or zone values."
        ),
        "parameters": {
            "label": "CLSI M100 (edition as declared per upload batch)",
            "standard": "CLSI M100",
            "reinterpretation_performed": False,
        },
        "open_question": None,
    },
    {
        "component": MethodologyComponent.PHENOTYPE_FLAGS,
        "version": "0.1-provisional",
        "description": (
            "Screening-level phenotype rules inferable from a standard WHONET AST "
            "panel. Screening only — never confirmation of a resistance mechanism."
        ),
        "parameters": {
            "rules": [
                {
                    "code": "MRSA_SCREEN",
                    "label": "MRSA phenotype (screening-level)",
                    "organism_codes": ["sau"],
                    "all_tested": ["FOX"],
                    "any_resistant": ["FOX"],
                    "basis": (
                        "Cefoxitin-resistant Staphylococcus aureus. Cefoxitin is the "
                        "recommended surrogate for mecA-mediated oxacillin resistance."
                    ),
                },
                {
                    "code": "ESBL_SCREEN",
                    "label": "ESBL phenotype (screening-level)",
                    "organism_selector": "enterobacterales",
                    "all_tested": ["CRO"],
                    "any_resistant": ["CRO", "CTX", "CAZ"],
                    "basis": (
                        "Third-generation cephalosporin-resistant Enterobacterales. "
                        "Screening only: this pattern also arises from AmpC and other "
                        "mechanisms, so it is not ESBL confirmation."
                    ),
                },
                {
                    "code": "CRE_SCREEN",
                    "label": "Carbapenem-resistant Enterobacterales phenotype (screening-level)",
                    "organism_selector": "enterobacterales",
                    "all_tested": ["MEM"],
                    "any_resistant": ["MEM", "IPM", "ETP"],
                    "count_intermediate_as_non_susceptible": True,
                    "basis": (
                        "Carbapenem-non-susceptible Enterobacterales. Screening only; "
                        "carbapenemase production is not confirmed."
                    ),
                },
                {
                    "code": "VRE_SCREEN",
                    "label": "Vancomycin-resistant Enterococcus phenotype (screening-level)",
                    "organism_codes": ["efa", "efm"],
                    "all_tested": ["VAN"],
                    "any_resistant": ["VAN"],
                    "basis": "Vancomycin-resistant Enterococcus species.",
                },
                {
                    "code": "FLUCONAZOLE_NS_YEAST",
                    "label": "Fluconazole-non-susceptible yeast (screening-level)",
                    "organism_codes": ["cal", "cgl", "ctr", "cpa", "cau"],
                    "all_tested": ["FLU"],
                    "any_resistant": ["FLU"],
                    "basis": (
                        "Fluconazole-non-susceptible yeast isolate. Susceptible-dose-"
                        "dependent results are not counted as non-susceptible here."
                    ),
                },
            ]
        },
        "open_question": None,
    },
    {
        "component": MethodologyComponent.QC_RULES,
        "version": "0.1-provisional",
        "description": (
            "Tier-3 automated data QC thresholds applied on ingestion, and the "
            "validity periods after which a QC attestation or EQA record expires."
        ),
        "parameters": {
            "qc_attestation_validity_days": 92,
            "eqa_validity_days": 366,
            "max_duplicate_rate_percent": 5.0,
            "max_missing_ast_rate_percent": 20.0,
            "volume_change_warning_ratio": 3.0,
            "implausible_uniform_result_min_batch_size": 30,
        },
        "open_question": None,
    },
    {
        "component": MethodologyComponent.LINKAGE_HASH,
        "version": "0.1-provisional",
        "description": (
            "Argon2id over the patient identifier with a facility-local salt that is "
            "never transmitted. Parameters are recorded because changing them changes "
            "every subsequently computed key, making it a migration event."
        ),
        "parameters": {
            "algorithm": "argon2id",
            "memory_kib": 65536,
            "iterations": 3,
            "parallelism": 4,
            "hash_length_bytes": 32,
        },
        "open_question": None,
    },
    {
        "component": MethodologyComponent.ANALYTICS_ENGINE,
        "version": "0.1.0",
        "description": "Initial AMRSS analytics engine.",
        "parameters": {"engine_version": "0.1.0"},
        "open_question": None,
    },
]
