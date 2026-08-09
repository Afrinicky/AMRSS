from __future__ import annotations

from decimal import Decimal

import pytest

from amrss_clsi.mic import MICOperator, MICValue, doubling_series, is_on_doubling_series


class TestParsing:
    @pytest.mark.parametrize(
        ("raw", "operator", "value"),
        [
            ("2", MICOperator.EQ, "2"),
            ("=2", MICOperator.EQ, "2"),
            ("<=0.25", MICOperator.LTE, "0.25"),
            ("≤0.25", MICOperator.LTE, "0.25"),
            ("=<0.25", MICOperator.LTE, "0.25"),
            (">=64", MICOperator.GTE, "64"),
            ("≥ 64", MICOperator.GTE, "64"),
            (">32", MICOperator.GT, "32"),
            ("  <0.5 ", MICOperator.LT, "0.5"),
        ],
    )
    def test_accepts_conventional_notations(self, raw, operator, value):
        mic = MICValue.parse(raw)
        assert mic.operator is operator
        assert mic.value == Decimal(value)

    def test_panel_labels_map_to_exact_concentrations(self):
        # Panels print 0.06 and 0.12; the true concentrations are 1/16 and 1/8.
        assert MICValue.parse("0.06").value == Decimal("0.0625")
        assert MICValue.parse("0.12").value == Decimal("0.125")

    def test_round_trips_through_str(self):
        assert str(MICValue.parse("<=0.06")) == "<=0.06"
        assert str(MICValue.parse("16")) == "16"

    @pytest.mark.parametrize("raw", ["", "abc", "<=", ">= ", "2 mg", "-4", "1..2", "0"])
    def test_rejects_malformed_input(self, raw):
        with pytest.raises(ValueError):
            MICValue.parse(raw)


class TestOffScaleComparisons:
    """The core safety property: an ambiguous result never resolves."""

    def test_exact_value_compares_normally(self):
        mic = MICValue.parse("4")
        assert mic.definitely_at_most(Decimal("4"))
        assert mic.definitely_at_least(Decimal("4"))
        assert not mic.definitely_at_most(Decimal("2"))

    def test_off_scale_low_below_breakpoint_is_certain(self):
        # "<=0.25" against a susceptible bound of 2: certainly susceptible.
        assert MICValue.parse("<=0.25").definitely_at_most(Decimal("2"))

    def test_off_scale_low_above_breakpoint_is_uncertain(self):
        # "<=4" against a susceptible bound of 2: could be 4, could be 0.5.
        assert not MICValue.parse("<=4").definitely_at_most(Decimal("2"))
        assert not MICValue.parse("<=4").definitely_at_least(Decimal("4"))

    def test_off_scale_high_above_breakpoint_is_certain(self):
        assert MICValue.parse(">=64").definitely_at_least(Decimal("8"))

    def test_off_scale_high_below_breakpoint_is_uncertain(self):
        # ">=4" against a resistant bound of 8: could be 4 (I) or 32 (R).
        assert not MICValue.parse(">=4").definitely_at_least(Decimal("8"))
        assert not MICValue.parse(">=4").definitely_at_most(Decimal("4"))


class TestDilutionSeries:
    def test_generates_doubling_steps(self):
        series = doubling_series(Decimal("0.25"), Decimal("4"))
        assert series == [Decimal("0.25"), Decimal("0.5"), Decimal("1"), Decimal("2"), Decimal("4")]

    @pytest.mark.parametrize("value", ["0.0625", "0.5", "1", "2", "128"])
    def test_recognises_on_series_values(self, value):
        assert is_on_doubling_series(Decimal(value))

    @pytest.mark.parametrize("value", ["3", "5", "1.5", "0.3", "10"])
    def test_flags_off_series_values(self, value):
        # These are the shape of a transcription error in an imported table.
        assert not is_on_doubling_series(Decimal(value))
