from datetime import date, timedelta

from amrss.analytics.alerts import detect as detect_alerts
from amrss.analytics.trends import TimeBucket, compute_series
from amrss.models.enums import SirResult
from tests.conftest import DRUG_X, ORGANISM_A, make_isolate, make_methodology

JANUARY = date(2026, 1, 5)


def monthly_records(month_counts: dict[int, tuple[int, int]]) -> list:
    """{month: (total, susceptible)} → isolates from distinct patients."""
    records = []
    for month, (total, susceptible) in month_counts.items():
        for index in range(total):
            result = SirResult.SUSCEPTIBLE if index < susceptible else SirResult.RESISTANT
            records.append(
                make_isolate(
                    specimen_date=date(2026, month, 1 + (index % 27)),
                    results={DRUG_X: result},
                    patient=f"m{month}-p{index}",
                )
            )
    return records


def test_thin_bucket_renders_as_a_gap_rather_than_a_plotted_point():
    methodology = make_methodology(antibiogram={"minimum_isolates": 30})
    records = monthly_records({1: (40, 20), 2: (5, 1), 3: (40, 30)})

    series = compute_series(
        records,
        methodology,
        organism_id=ORGANISM_A,
        antibiotic_id=DRUG_X,
        bucket=TimeBucket.MONTH,
    )

    february = next(point for point in series.points if point.bucket_start.month == 2)
    assert february.sufficient is False
    assert february.summary is None
    # The point is still present, so the gap is visible in the series.
    assert february.isolate_count == 5
    assert len(series.points) == 3


def test_every_sufficient_point_carries_its_isolate_count():
    methodology = make_methodology(antibiogram={"minimum_isolates": 30})
    series = compute_series(
        monthly_records({1: (40, 20)}),
        methodology,
        organism_id=ORGANISM_A,
        antibiotic_id=DRUG_X,
        bucket=TimeBucket.MONTH,
    )

    point = series.points[0]
    assert point.sufficient
    assert point.isolate_count == 40
    assert point.summary.susceptible_percent == 50.0
    assert point.confidence_interval is not None


def test_deduplication_spans_the_whole_series_not_each_bucket():
    """A patient sampled either side of a month boundary must not reappear in the
    next bucket; deduplicating per bucket would let them."""
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 1}, deduplication={"window_days": 30}
    )
    records = [
        make_isolate(
            specimen_date=date(2026, 1, 28), results={DRUG_X: SirResult.RESISTANT}, patient="p1"
        ),
        make_isolate(
            specimen_date=date(2026, 2, 2), results={DRUG_X: SirResult.SUSCEPTIBLE}, patient="p1"
        ),
    ]

    series = compute_series(
        records,
        methodology,
        organism_id=ORGANISM_A,
        antibiotic_id=DRUG_X,
        bucket=TimeBucket.MONTH,
    )

    assert len(series.points) == 1
    assert series.points[0].bucket_start.month == 1


def test_quarter_bucketing_labels_and_bounds():
    methodology = make_methodology(antibiogram={"minimum_isolates": 1})
    series = compute_series(
        monthly_records({2: (3, 1), 5: (3, 2)}),
        methodology,
        organism_id=ORGANISM_A,
        antibiotic_id=DRUG_X,
        bucket=TimeBucket.QUARTER,
    )

    labels = [point.label for point in series.points]
    assert labels == ["2026 Q1", "2026 Q2"]
    assert series.points[0].bucket_start == date(2026, 1, 1)
    assert series.points[0].bucket_end == date(2026, 3, 31)


def test_alert_surfaces_a_watched_organism_below_the_reporting_threshold():
    methodology = make_methodology(antibiogram={"minimum_isolates": 30})
    records = [
        make_isolate(
            specimen_date=JANUARY + timedelta(days=index),
            results={DRUG_X: SirResult.RESISTANT},
            patient=f"p{index}",
        )
        for index in range(3)
    ]

    alerts = detect_alerts(records, methodology, {ORGANISM_A})

    assert len(alerts) == 1
    assert alerts[0].non_susceptible_count == 3
    assert alerts[0].below_reporting_threshold
    assert "below the reporting threshold" in alerts[0].caveat


def test_alert_is_not_raised_once_the_combination_qualifies_for_the_antibiogram():
    methodology = make_methodology(antibiogram={"minimum_isolates": 5})
    records = [
        make_isolate(
            specimen_date=JANUARY + timedelta(days=index),
            results={DRUG_X: SirResult.RESISTANT},
            patient=f"p{index}",
        )
        for index in range(10)
    ]

    assert detect_alerts(records, methodology, {ORGANISM_A}) == []


def test_alert_ignores_organisms_not_on_the_watch_list():
    methodology = make_methodology(antibiogram={"minimum_isolates": 30})
    records = [
        make_isolate(specimen_date=JANUARY, results={DRUG_X: SirResult.RESISTANT}, patient="p1")
    ]

    assert detect_alerts(records, methodology, set()) == []


def test_alert_does_not_deduplicate_repeat_detections():
    """The antibiogram counts patients because it estimates a rate; an alert
    counts detections because the question is whether the organism is present."""
    methodology = make_methodology(antibiogram={"minimum_isolates": 30})
    records = [
        make_isolate(
            specimen_date=JANUARY + timedelta(days=day),
            results={DRUG_X: SirResult.RESISTANT},
            patient="same-patient",
        )
        for day in range(4)
    ]

    alerts = detect_alerts(records, methodology, {ORGANISM_A})

    assert alerts[0].summary.interpretable == 4
