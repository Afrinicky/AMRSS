from datetime import date, timedelta

from amrss.analytics.deduplication import deduplicate
from amrss.models.enums import SirResult
from tests.conftest import (
    DRUG_X,
    FACILITY_1,
    FACILITY_2,
    ORGANISM_A,
    ORGANISM_B,
    make_isolate,
)

DAY_ZERO = date(2026, 1, 1)
SUSCEPTIBLE = {DRUG_X: SirResult.SUSCEPTIBLE}


def test_repeat_isolate_inside_window_is_removed():
    records = [
        make_isolate(specimen_date=DAY_ZERO, results=SUSCEPTIBLE, patient="p1"),
        make_isolate(specimen_date=DAY_ZERO + timedelta(days=5), results=SUSCEPTIBLE, patient="p1"),
    ]
    retained, report = deduplicate(records, window_days=30)

    assert len(retained) == 1
    assert retained[0].specimen_date == DAY_ZERO
    assert report.removed_isolates == 1


def test_isolate_beyond_window_opens_a_new_period():
    records = [
        make_isolate(specimen_date=DAY_ZERO, results=SUSCEPTIBLE, patient="p1"),
        make_isolate(
            specimen_date=DAY_ZERO + timedelta(days=30), results=SUSCEPTIBLE, patient="p1"
        ),
    ]
    retained, _ = deduplicate(records, window_days=30)

    assert len(retained) == 2


def test_window_rolls_from_the_retained_isolate_not_the_calendar():
    """Days 0, 20, 40 under a 30-day window keep days 0 and 40.

    Day 20 falls inside the window opened on day 0. Day 40 is more than 30 days
    after day 0, so it opens a new window — even though it is only 20 days after
    the isolate that was dropped.
    """
    records = [
        make_isolate(
            specimen_date=DAY_ZERO + timedelta(days=offset), results=SUSCEPTIBLE, patient="p1"
        )
        for offset in (0, 20, 40)
    ]
    retained, _ = deduplicate(records, window_days=30)

    assert [r.specimen_date for r in retained] == [DAY_ZERO, DAY_ZERO + timedelta(days=40)]


def test_different_organisms_from_one_patient_are_both_retained():
    records = [
        make_isolate(
            specimen_date=DAY_ZERO, results=SUSCEPTIBLE, patient="p1", organism_id=ORGANISM_A
        ),
        make_isolate(
            specimen_date=DAY_ZERO + timedelta(days=1),
            results=SUSCEPTIBLE,
            patient="p1",
            organism_id=ORGANISM_B,
        ),
    ]
    retained, _ = deduplicate(records, window_days=30)

    assert len(retained) == 2


def test_same_linkage_key_at_different_facilities_is_not_linked():
    """Linkage keys are salted per facility (ADR-0004), so an identical key at two
    facilities is a collision of test fixtures, not the same patient. Grouping
    must include the facility or the engine would claim a link the data cannot
    support."""
    records = [
        make_isolate(
            specimen_date=DAY_ZERO, results=SUSCEPTIBLE, patient="p1", facility_id=FACILITY_1
        ),
        make_isolate(
            specimen_date=DAY_ZERO + timedelta(days=1),
            results=SUSCEPTIBLE,
            patient="p1",
            facility_id=FACILITY_2,
        ),
    ]
    retained, _ = deduplicate(records, window_days=30)

    assert len(retained) == 2


def test_deduplication_is_deterministic_regardless_of_input_order():
    records = [
        make_isolate(
            specimen_date=DAY_ZERO + timedelta(days=offset), results=SUSCEPTIBLE, patient="p1"
        )
        for offset in (0, 40, 80)
    ]
    forward, _ = deduplicate(records, window_days=30)
    backward, _ = deduplicate(list(reversed(records)), window_days=30)

    assert [r.id for r in forward] == [r.id for r in backward]


def test_report_distinguishes_raw_from_eligible_counts():
    records = [
        make_isolate(specimen_date=DAY_ZERO, results=SUSCEPTIBLE, patient="p1"),
        make_isolate(specimen_date=DAY_ZERO + timedelta(days=2), results=SUSCEPTIBLE, patient="p1"),
        make_isolate(specimen_date=DAY_ZERO, results=SUSCEPTIBLE, patient="p2"),
    ]
    _, report = deduplicate(records, window_days=30)

    assert report.total_isolates == 3
    assert report.retained_isolates == 2
    assert report.describe()["repeat_isolates_removed"] == 1
