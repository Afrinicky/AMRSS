"""The three report aggregations behind the explorer pages.

Agent S/I/R patterns, organisms by site of infection, and specimen types. All
three publish counts a reader will treat as fact, so the properties tested here
are the ones that would make a published figure wrong rather than merely ugly:
thresholds actually applied, withheld data accounted for in the denominator, and
no deduplication where a provenance count is being reported.
"""

from datetime import date, timedelta

from amrss.analytics.profiles import by_antibiotic, by_organism_site, by_specimen
from amrss.models.enums import SirResult
from tests.conftest import (
    DRUG_X,
    DRUG_Y,
    ORGANISM_A,
    ORGANISM_B,
    SPECIMEN_BLOOD,
    SPECIMEN_CSF,
    SPECIMEN_URINE,
    make_isolate,
    make_methodology,
)

DAY_ZERO = date(2026, 1, 1)
SITE_OF = {
    SPECIMEN_URINE: "urinary_tract",
    SPECIMEN_BLOOD: "bloodstream",
    SPECIMEN_CSF: "central_nervous_system",
}


#: Advanced by every ``spread`` call so that two batches in one test never share
#: a patient key or a date. Without this, deduplication silently removes the
#: second batch and a test of a threshold quietly becomes a test of the dedup
#: window instead.
_next_patient = 0


def spread(count: int, **kwargs):
    """``count`` isolates, each from a distinct patient on a distinct day."""
    global _next_patient
    first = _next_patient
    _next_patient += count
    return [
        make_isolate(
            specimen_date=DAY_ZERO + timedelta(days=index),
            patient=f"patient-{index}",
            **kwargs,
        )
        for index in range(first, first + count)
    ]


# ---- by_antibiotic ---------------------------------------------------------


def test_agent_below_the_reporting_threshold_is_not_charted():
    """A thin bar reads as a solid fact, so it is omitted rather than drawn."""
    methodology = make_methodology(antibiogram={"minimum_isolates": 30})
    records = spread(29, results={DRUG_X: SirResult.RESISTANT})

    assert by_antibiotic(records, methodology) == []


def test_agents_are_ordered_least_susceptible_first():
    """The agents that have stopped working are the finding, so they lead."""
    methodology = make_methodology(antibiogram={"minimum_isolates": 5})
    records = [
        *spread(10, results={DRUG_X: SirResult.SUSCEPTIBLE, DRUG_Y: SirResult.RESISTANT}),
    ]

    profiles = by_antibiotic(records, methodology)

    assert [p.antibiotic_id for p in profiles] == [DRUG_Y, DRUG_X]
    assert profiles[0].susceptible_percent == 0
    assert profiles[1].susceptible_percent == 100


def test_uninterpretable_results_do_not_count_toward_the_percentage():
    """Zone diameters awaiting a breakpoint are data, not a susceptibility."""
    methodology = make_methodology(antibiogram={"minimum_isolates": 5})
    records = [
        *spread(6, results={DRUG_X: SirResult.SUSCEPTIBLE}),
        *spread(4, results={DRUG_X: SirResult.PENDING_INTERPRETATION}),
    ]

    profiles = by_antibiotic(records, methodology)

    assert profiles[0].summary.interpretable == 6
    assert profiles[0].susceptible_percent == 100


def test_organism_count_exposes_how_pooled_a_bar_is():
    methodology = make_methodology(antibiogram={"minimum_isolates": 5})
    records = [
        *spread(5, organism_id=ORGANISM_A, results={DRUG_X: SirResult.SUSCEPTIBLE}),
        *spread(5, organism_id=ORGANISM_B, results={DRUG_X: SirResult.RESISTANT}),
    ]

    profiles = by_antibiotic(records, methodology)

    assert profiles[0].organism_count == 2


def test_unverified_facilities_are_excluded_by_default():
    methodology = make_methodology(antibiogram={"minimum_isolates": 5})
    records = [
        *spread(5, results={DRUG_X: SirResult.SUSCEPTIBLE}),
        *spread(5, results={DRUG_X: SirResult.RESISTANT}, quality_verified=False),
    ]

    assert by_antibiotic(records, methodology)[0].susceptible_percent == 100
    assert by_antibiotic(records, methodology, verified_only=False)[0].susceptible_percent == 50


# ---- by_organism_site ------------------------------------------------------


def test_organisms_carry_their_sites_of_infection():
    methodology = make_methodology(suppression={"small_cell_threshold": 1})
    records = [
        *spread(7, organism_id=ORGANISM_A, specimen_type_id=SPECIMEN_URINE, results={}),
        *spread(3, organism_id=ORGANISM_A, specimen_type_id=SPECIMEN_BLOOD, results={}),
        *spread(4, organism_id=ORGANISM_B, specimen_type_id=SPECIMEN_BLOOD, results={}),
    ]

    profiles, total = by_organism_site(records, methodology, SITE_OF)

    assert total == 14
    assert [p.organism_id for p in profiles] == [ORGANISM_A, ORGANISM_B]
    assert profiles[0].isolate_count == 10
    assert [(s.infection_site, s.isolate_count) for s in profiles[0].sites] == [
        ("urinary_tract", 7),
        ("bloodstream", 3),
    ]
    assert profiles[0].principal_site == "urinary_tract"


def test_repeat_isolates_from_one_patient_are_all_counted():
    """This figure is provenance, not a rate.

    Deduplicating would understate what the laboratories actually processed,
    which is the one thing this chart exists to report.
    """
    methodology = make_methodology(suppression={"small_cell_threshold": 1})
    records = [
        make_isolate(
            specimen_date=DAY_ZERO + timedelta(days=day),
            patient="patient-1",
            specimen_type_id=SPECIMEN_URINE,
            results={},
        )
        for day in (0, 1, 2)
    ]

    profiles, total = by_organism_site(records, methodology, SITE_OF)

    assert total == 3
    assert profiles[0].isolate_count == 3


def test_a_site_below_the_suppression_threshold_is_withheld_not_dropped():
    """One isolate from CSF in a named district is close to naming a patient.

    It is withheld from the site breakdown, but it still counts toward the
    organism's total — and the shortfall is published, so a reader can see that
    the listed sites do not add up by design rather than by error.
    """
    methodology = make_methodology(suppression={"small_cell_threshold": 5})
    records = [
        *spread(10, organism_id=ORGANISM_A, specimen_type_id=SPECIMEN_URINE, results={}),
        *spread(2, organism_id=ORGANISM_A, specimen_type_id=SPECIMEN_CSF, results={}),
    ]

    profiles, _ = by_organism_site(records, methodology, SITE_OF)

    assert profiles[0].isolate_count == 12
    assert [s.infection_site for s in profiles[0].sites] == ["urinary_tract"]
    assert profiles[0].withheld_count == 2


def test_an_organism_below_the_suppression_threshold_is_omitted_entirely():
    methodology = make_methodology(suppression={"small_cell_threshold": 5})
    records = [
        *spread(10, organism_id=ORGANISM_A, specimen_type_id=SPECIMEN_URINE, results={}),
        *spread(2, organism_id=ORGANISM_B, specimen_type_id=SPECIMEN_URINE, results={}),
    ]

    profiles, total = by_organism_site(records, methodology, SITE_OF)

    assert [p.organism_id for p in profiles] == [ORGANISM_A]
    # The suppressed organism still counts in the denominator: hiding it from the
    # denominator too would inflate every published percentage.
    assert total == 12
    assert profiles[0].percent_of_total == 83


def test_suppression_can_be_lifted_for_privileged_scopes():
    methodology = make_methodology(suppression={"small_cell_threshold": 5})
    records = spread(2, organism_id=ORGANISM_B, specimen_type_id=SPECIMEN_CSF, results={})

    assert by_organism_site(records, methodology, SITE_OF)[0] == []
    lifted, _ = by_organism_site(records, methodology, SITE_OF, apply_suppression=False)
    assert lifted[0].sites[0].infection_site == "central_nervous_system"


def test_an_unmapped_specimen_type_is_labelled_rather_than_discarded():
    """A facility's local specimen code that maps to nothing must not vanish.

    Silently dropping it would make the site breakdown disagree with the isolate
    count, which is exactly the kind of quiet inconsistency this system exists
    to avoid.
    """
    methodology = make_methodology(suppression={"small_cell_threshold": 1})
    records = spread(3, organism_id=ORGANISM_A, specimen_type_id=SPECIMEN_BLOOD, results={})

    profiles, total = by_organism_site(records, methodology, {})

    assert total == 3
    assert profiles[0].sites[0].infection_site == "unspecified"


def test_no_records_yields_no_figure():
    methodology = make_methodology()

    assert by_organism_site([], methodology, SITE_OF) == ([], 0)


# ---- by_specimen -----------------------------------------------------------


def test_specimen_types_are_counted_and_ordered_by_volume():
    methodology = make_methodology(suppression={"small_cell_threshold": 1})
    records = [
        *spread(30, specimen_type_id=SPECIMEN_URINE, results={}),
        *spread(20, specimen_type_id=SPECIMEN_BLOOD, results={}),
    ]

    counts, total = by_specimen(records, methodology)

    assert total == 50
    assert [c.specimen_type_id for c in counts] == [SPECIMEN_URINE, SPECIMEN_BLOOD]
    assert [c.isolate_count for c in counts] == [30, 20]
    assert [c.percent_of_total for c in counts] == [60, 40]


def test_specimen_counts_are_not_deduplicated():
    """Laboratory workload, not a rate: every specimen processed counts."""
    methodology = make_methodology(suppression={"small_cell_threshold": 1})
    records = [
        make_isolate(
            specimen_date=DAY_ZERO + timedelta(days=day),
            patient="patient-1",
            specimen_type_id=SPECIMEN_URINE,
            results={},
        )
        for day in (0, 1, 2)
    ]

    assert by_specimen(records, methodology)[1] == 3


def test_a_small_specimen_type_is_withheld_but_still_counted_in_the_total():
    """Two isolates of one specimen type in a named district is a
    re-identification route, so the row is withheld. It stays in the total, so
    the listed rows can be seen not to sum to it rather than the denominator
    quietly shrinking and inflating every published percentage."""
    methodology = make_methodology(suppression={"small_cell_threshold": 5})
    records = [
        *spread(20, specimen_type_id=SPECIMEN_URINE, results={}),
        *spread(2, specimen_type_id=SPECIMEN_CSF, results={}),
    ]

    counts, total = by_specimen(records, methodology)

    assert [c.specimen_type_id for c in counts] == [SPECIMEN_URINE]
    assert total == 22
    assert counts[0].percent_of_total == 91


def test_specimen_suppression_can_be_lifted_for_privileged_scopes():
    methodology = make_methodology(suppression={"small_cell_threshold": 5})
    records = spread(2, specimen_type_id=SPECIMEN_CSF, results={})

    assert by_specimen(records, methodology)[0] == []
    assert by_specimen(records, methodology, apply_suppression=False)[0][0].isolate_count == 2


def test_unverified_facilities_are_excluded_from_specimen_counts_by_default():
    methodology = make_methodology(suppression={"small_cell_threshold": 1})
    records = [
        *spread(5, specimen_type_id=SPECIMEN_URINE, results={}),
        *spread(5, specimen_type_id=SPECIMEN_BLOOD, results={}, quality_verified=False),
    ]

    assert by_specimen(records, methodology)[1] == 5
    assert by_specimen(records, methodology, verified_only=False)[1] == 10


def test_no_records_yields_no_specimen_figure():
    assert by_specimen([], make_methodology()) == ([], 0)
