from amrss.analytics.statistics import summarise
from amrss.models.enums import SirResult

S = SirResult.SUSCEPTIBLE
I = SirResult.INTERMEDIATE  # noqa: E741 — the clinical abbreviation is the clearest name here
R = SirResult.RESISTANT
SDD = SirResult.SUSCEPTIBLE_DOSE_DEPENDENT
NS = SirResult.NON_SUSCEPTIBLE
NI = SirResult.NOT_INTERPRETABLE


def test_percent_susceptible_counts_only_s():
    summary = summarise([S, S, I, R])

    assert summary.susceptible_percent == 50.0


def test_dose_dependent_is_interpretable_but_not_susceptible():
    """SDD means susceptible at increased exposure. Counting it as susceptible
    would overstate the coverage a standard regimen provides."""
    summary = summarise([S, SDD, SDD, SDD])

    assert summary.interpretable == 4
    assert summary.susceptible_percent == 25.0


def test_non_interpretable_results_leave_the_denominator_but_stay_in_tested():
    summary = summarise([S, S, R, NI, NI])

    assert summary.tested == 5
    assert summary.interpretable == 3
    assert summary.not_interpretable == 2
    assert summary.susceptible_percent == 66.7


def test_non_susceptible_counts_toward_resistance_not_susceptibility():
    summary = summarise([S, NS, NS, R])

    assert summary.susceptible_percent == 25.0
    assert summary.resistant_percent == 75.0


def test_percentages_are_none_when_nothing_is_interpretable():
    summary = summarise([NI, NI])

    assert summary.susceptible_percent is None
    assert summary.resistant_percent is None
    assert summary.confidence_interval() is None


def test_confidence_interval_stays_within_zero_and_one_hundred():
    """The reason for using Wilson rather than the normal approximation: at
    extreme proportions the textbook interval runs past the ends of the scale."""
    all_susceptible = summarise([S] * 20)
    none_susceptible = summarise([R] * 20)

    upper = all_susceptible.confidence_interval()
    lower = none_susceptible.confidence_interval()

    assert upper is not None and lower is not None
    assert upper.upper <= 100.0
    assert upper.lower >= 0.0
    assert lower.lower >= 0.0
    assert lower.upper <= 100.0


def test_interval_narrows_as_isolate_count_grows():
    narrow = summarise([S] * 200 + [R] * 200).confidence_interval()
    wide = summarise([S] * 20 + [R] * 20).confidence_interval()

    assert narrow is not None and wide is not None
    assert narrow.width < wide.width
