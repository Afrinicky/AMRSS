"""Susceptibility broken down by district, specimen, care setting or organism.

The failure this module guards against is subtle and easy to ship: a total that
legitimately passed the reporting threshold is split into four strata, each of
which is too small to publish on its own, and the breakdown reports all four
anyway. Every fragment then looks like a figure that cleared the bar, and none
of them did.
"""

import uuid
from datetime import date, timedelta

from amrss.analytics.breakdowns import (
    GroupState,
    agent_profile_for_organism,
    by_dimension,
    organism_profile_for_agent,
)
from amrss.models.enums import SirResult
from tests.conftest import (
    DISTRICT_1,
    DRUG_X,
    DRUG_Y,
    FACILITY_1,
    FACILITY_2,
    ORGANISM_A,
    ORGANISM_B,
    SPECIMEN_BLOOD,
    SPECIMEN_URINE,
    make_isolate,
    make_methodology,
)

DAY_ZERO = date(2026, 1, 1)
_next = 0


def spread(count: int, **kwargs):
    """Distinct patients on distinct days, so deduplication removes nothing."""
    global _next
    first, _next = _next, _next + count
    return [
        make_isolate(specimen_date=DAY_ZERO + timedelta(days=i), patient=f"patient-{i}", **kwargs)
        for i in range(first, first + count)
    ]


def facility_of(record):
    return record.facility_id


# ---- The two gates ---------------------------------------------------------


def test_a_stratum_below_the_reporting_threshold_carries_no_percentage():
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 30}, suppression={"small_cell_threshold": 5}
    )
    records = [
        *spread(40, facility_id=FACILITY_1, results={DRUG_X: SirResult.SUSCEPTIBLE}),
        *spread(10, facility_id=FACILITY_2, results={DRUG_X: SirResult.RESISTANT}),
    ]

    groups = by_dimension(records, methodology, antibiotic_id=DRUG_X, key_of=facility_of)
    by_key = {g.key: g for g in groups}

    assert by_key[FACILITY_1].state is GroupState.REPORTABLE
    assert by_key[FACILITY_2].state is GroupState.BELOW_THRESHOLD
    assert by_key[FACILITY_2].susceptible_percent is None


def test_a_withheld_stratum_is_returned_rather_than_omitted():
    """A reader must be able to see that a stratum exists and was withheld.
    Dropping it silently makes an incomplete breakdown look complete."""
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 30}, suppression={"small_cell_threshold": 5}
    )
    records = [
        *spread(40, facility_id=FACILITY_1, results={DRUG_X: SirResult.SUSCEPTIBLE}),
        *spread(3, facility_id=FACILITY_2, results={DRUG_X: SirResult.RESISTANT}),
    ]

    groups = by_dimension(records, methodology, antibiotic_id=DRUG_X, key_of=facility_of)

    assert len(groups) == 2
    assert {g.state for g in groups} == {GroupState.REPORTABLE, GroupState.SUPPRESSED}


def test_a_suppressed_stratum_releases_neither_percentage_nor_counts():
    """Releasing n while hiding the percentage leaks the same small cell."""
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 1}, suppression={"small_cell_threshold": 5}
    )
    records = spread(3, facility_id=FACILITY_2, results={DRUG_X: SirResult.RESISTANT})

    group = by_dimension(records, methodology, antibiotic_id=DRUG_X, key_of=facility_of)[0]

    assert group.state is GroupState.SUPPRESSED
    assert group.summary is None
    assert group.interpretable is None


def test_suppression_wins_over_a_cleared_reporting_threshold():
    """The two thresholds answer different questions — re-identification risk
    against statistical stability — and the privacy one is not negotiable
    against the statistical one."""
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 2}, suppression={"small_cell_threshold": 10}
    )
    records = spread(4, facility_id=FACILITY_1, results={DRUG_X: SirResult.SUSCEPTIBLE})

    group = by_dimension(records, methodology, antibiotic_id=DRUG_X, key_of=facility_of)[0]

    assert group.state is GroupState.SUPPRESSED


def test_suppression_can_be_lifted_for_a_privileged_scope():
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 2}, suppression={"small_cell_threshold": 10}
    )
    records = spread(4, facility_id=FACILITY_1, results={DRUG_X: SirResult.SUSCEPTIBLE})

    group = by_dimension(
        records, methodology, antibiotic_id=DRUG_X, key_of=facility_of, apply_suppression=False
    )[0]

    assert group.state is GroupState.REPORTABLE
    assert group.susceptible_percent == 100.0


# ---- Consistency with the antibiogram --------------------------------------


def test_a_breakdown_is_deduplicated_like_the_antibiogram():
    """This is a susceptibility rate, so the first-isolate-per-patient rule
    applies. A breakdown computed on raw isolates would disagree with the table
    it sits beside, and a reader would have no way to tell which was right."""
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 1},
        suppression={"small_cell_threshold": 1},
        deduplication={"window_days": 30, "scope": "facility"},
    )
    records = [
        make_isolate(
            specimen_date=DAY_ZERO + timedelta(days=day),
            patient="one-patient",
            facility_id=FACILITY_1,
            results={DRUG_X: SirResult.RESISTANT},
        )
        for day in (0, 3, 6)
    ]

    group = by_dimension(records, methodology, antibiotic_id=DRUG_X, key_of=facility_of)[0]

    assert group.isolate_count == 1


def test_unverified_facilities_are_excluded_by_default():
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 1}, suppression={"small_cell_threshold": 1}
    )
    records = [
        *spread(5, facility_id=FACILITY_1, results={DRUG_X: SirResult.SUSCEPTIBLE}),
        *spread(
            5, facility_id=FACILITY_2, results={DRUG_X: SirResult.RESISTANT}, quality_verified=False
        ),
    ]

    assert len(by_dimension(records, methodology, antibiotic_id=DRUG_X, key_of=facility_of)) == 1
    assert (
        len(
            by_dimension(
                records,
                methodology,
                antibiotic_id=DRUG_X,
                key_of=facility_of,
                verified_only=False,
            )
        )
        == 2
    )


def test_a_record_with_no_key_is_dropped_not_bucketed_as_unknown():
    """A stratum labelled "unknown" invites it to be read as a real one."""
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 1}, suppression={"small_cell_threshold": 1}
    )
    records = spread(5, facility_id=FACILITY_1, results={DRUG_X: SirResult.SUSCEPTIBLE})

    groups = by_dimension(records, methodology, antibiotic_id=DRUG_X, key_of=lambda r: None)

    assert groups == []


def test_reportable_strata_are_listed_before_withheld_ones():
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 30}, suppression={"small_cell_threshold": 5}
    )
    records = [
        *spread(4, facility_id=FACILITY_2, results={DRUG_X: SirResult.RESISTANT}),
        *spread(40, facility_id=FACILITY_1, results={DRUG_X: SirResult.SUSCEPTIBLE}),
    ]

    groups = by_dimension(records, methodology, antibiotic_id=DRUG_X, key_of=facility_of)

    assert groups[0].state is GroupState.REPORTABLE


# ---- Drill-down profiles ---------------------------------------------------


def test_the_organism_profile_covers_every_agent_tested_against_it():
    methodology = make_methodology(antibiogram={"minimum_isolates": 5})
    records = spread(
        10,
        organism_id=ORGANISM_A,
        results={DRUG_X: SirResult.SUSCEPTIBLE, DRUG_Y: SirResult.RESISTANT},
    )

    groups = agent_profile_for_organism(records, methodology, organism_id=ORGANISM_A)

    assert {g.key for g in groups} == {DRUG_X, DRUG_Y}
    assert all(g.state is GroupState.REPORTABLE for g in groups)


def test_the_organism_profile_ignores_other_organisms():
    methodology = make_methodology(antibiogram={"minimum_isolates": 5})
    records = [
        *spread(10, organism_id=ORGANISM_A, results={DRUG_X: SirResult.SUSCEPTIBLE}),
        *spread(10, organism_id=ORGANISM_B, results={DRUG_X: SirResult.RESISTANT}),
    ]

    group = agent_profile_for_organism(records, methodology, organism_id=ORGANISM_A)[0]

    assert group.susceptible_percent == 100.0


def test_the_agent_profile_shows_which_organisms_make_up_a_pooled_figure():
    """A pooled agent figure only becomes interpretable once it is clear which
    organisms compose it."""
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 5}, suppression={"small_cell_threshold": 1}
    )
    records = [
        *spread(10, organism_id=ORGANISM_A, results={DRUG_X: SirResult.SUSCEPTIBLE}),
        *spread(10, organism_id=ORGANISM_B, results={DRUG_X: SirResult.RESISTANT}),
    ]

    groups = organism_profile_for_agent(records, methodology, antibiotic_id=DRUG_X)
    by_key = {g.key: g for g in groups}

    assert by_key[ORGANISM_A].susceptible_percent == 100.0
    assert by_key[ORGANISM_B].susceptible_percent == 0.0


def test_a_specimen_breakdown_separates_urine_from_blood():
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 5}, suppression={"small_cell_threshold": 1}
    )
    records = [
        *spread(
            8,
            specimen_type_id=SPECIMEN_URINE,
            results={DRUG_X: SirResult.SUSCEPTIBLE},
        ),
        *spread(
            8,
            specimen_type_id=SPECIMEN_BLOOD,
            results={DRUG_X: SirResult.RESISTANT},
        ),
    ]

    groups = by_dimension(
        records,
        methodology,
        antibiotic_id=DRUG_X,
        key_of=lambda record: record.specimen_type_id,
    )
    by_key = {g.key: g for g in groups}

    assert by_key[SPECIMEN_URINE].susceptible_percent == 100.0
    assert by_key[SPECIMEN_BLOOD].susceptible_percent == 0.0


def test_an_agent_not_tested_in_a_stratum_reports_below_threshold_not_zero():
    """Zero percent susceptible and "never tested" are opposite findings. A
    breakdown that renders an untested stratum as 0% invents total resistance."""
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 1}, suppression={"small_cell_threshold": 1}
    )
    records = [
        *spread(5, facility_id=FACILITY_1, results={DRUG_X: SirResult.SUSCEPTIBLE}),
        *spread(5, facility_id=FACILITY_2, results={DRUG_Y: SirResult.SUSCEPTIBLE}),
    ]

    groups = by_dimension(records, methodology, antibiotic_id=DRUG_X, key_of=facility_of)
    by_key = {g.key: g for g in groups}

    assert by_key[FACILITY_2].state is GroupState.BELOW_THRESHOLD
    assert by_key[FACILITY_2].susceptible_percent is None
    # The isolates are still counted: the stratum exists, the agent was not used.
    assert by_key[FACILITY_2].isolate_count == 5


def test_a_district_breakdown_uses_the_records_district():
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 1}, suppression={"small_cell_threshold": 1}
    )
    records = spread(5, results={DRUG_X: SirResult.SUSCEPTIBLE})

    groups = by_dimension(
        records, methodology, antibiotic_id=DRUG_X, key_of=lambda record: record.district_id
    )

    assert [g.key for g in groups] == [DISTRICT_1]


def test_no_records_yields_no_groups():
    assert (
        by_dimension([], make_methodology(), antibiotic_id=uuid.uuid4(), key_of=facility_of) == []
    )
