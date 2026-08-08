from datetime import date, timedelta

from amrss.analytics.signals import detect
from amrss.models.enums import SirResult
from tests.conftest import DRUG_X, make_isolate, make_methodology

AS_OF = date(2026, 8, 8)


def window_records(
    *, start_offset: int, span_days: int, count: int, susceptible: int, prefix: str
) -> list:
    records = []
    for index in range(count):
        result = SirResult.SUSCEPTIBLE if index < susceptible else SirResult.RESISTANT
        day = AS_OF - timedelta(days=start_offset - (index % span_days))
        records.append(
            make_isolate(
                specimen_date=day,
                results={DRUG_X: result},
                patient=f"{prefix}-{index}",
            )
        )
    return records


def test_sharp_fall_in_susceptibility_raises_a_signal():
    methodology = make_methodology()
    records = window_records(
        start_offset=100, span_days=50, count=40, susceptible=28, prefix="baseline"
    ) + window_records(start_offset=20, span_days=19, count=20, susceptible=4, prefix="current")

    signals = detect(records, methodology, as_of=AS_OF)

    assert len(signals) == 1
    signal = signals[0]
    assert signal.change_percentage_points <= -15.0
    assert signal.status_label == "Signal — requires expert review"


def test_no_signal_when_the_current_window_is_underpowered():
    """Both windows must independently clear the minimum. Comparing a solid
    baseline against a handful of isolates manufactures a change from nothing."""
    methodology = make_methodology(emerging_signal_trigger={"minimum_n_per_window": 15})
    records = window_records(
        start_offset=100, span_days=50, count=40, susceptible=28, prefix="baseline"
    ) + window_records(start_offset=20, span_days=19, count=5, susceptible=0, prefix="current")

    assert detect(records, methodology, as_of=AS_OF) == []


def test_no_signal_when_the_baseline_is_underpowered():
    methodology = make_methodology(emerging_signal_trigger={"minimum_n_per_window": 15})
    records = window_records(
        start_offset=100, span_days=50, count=6, susceptible=5, prefix="baseline"
    ) + window_records(start_offset=20, span_days=19, count=30, susceptible=2, prefix="current")

    assert detect(records, methodology, as_of=AS_OF) == []


def test_change_below_the_threshold_does_not_signal():
    methodology = make_methodology(
        emerging_signal_trigger={"change_threshold_percentage_points": 15.0}
    )
    records = window_records(
        start_offset=100, span_days=50, count=40, susceptible=28, prefix="baseline"
    ) + window_records(start_offset=20, span_days=19, count=20, susceptible=12, prefix="current")

    assert detect(records, methodology, as_of=AS_OF) == []


def test_improvement_in_susceptibility_is_not_reported_as_a_signal():
    """A rise is welcome news. Reporting both directions would bury genuine
    deterioration in a list dominated by noise."""
    methodology = make_methodology()
    records = window_records(
        start_offset=100, span_days=50, count=40, susceptible=8, prefix="baseline"
    ) + window_records(start_offset=20, span_days=19, count=20, susceptible=18, prefix="current")

    assert detect(records, methodology, as_of=AS_OF) == []


def test_windows_do_not_overlap():
    """An isolate cannot contribute to both windows; a trailing baseline that
    contained the current period would be partly compared against itself."""
    methodology = make_methodology(
        emerging_signal_trigger={
            "baseline_window_days": 84,
            "current_window_days": 28,
            "minimum_n_per_window": 15,
            "change_threshold_percentage_points": 15.0,
        }
    )
    records = window_records(
        start_offset=100, span_days=50, count=40, susceptible=28, prefix="baseline"
    ) + window_records(start_offset=20, span_days=19, count=20, susceptible=2, prefix="current")

    signal = detect(records, methodology, as_of=AS_OF)[0]

    assert signal.baseline.end < signal.current.start
