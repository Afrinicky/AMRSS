from __future__ import annotations

from decimal import Decimal

import pytest

from amrss_clsi.breakpoints import (
    Breakpoint,
    BreakpointSet,
    Category,
    Method,
    validate_breakpoints,
)
from amrss_clsi.interpretation import NoInterpretationReason, interpret, interpret_disk
from amrss_clsi.mic import MICValue
from tests.conftest import TEST_SET_VERSION

ENTERO = ("Escherichia coli", "Enterobacterales")


def interpret_mic(bp_set, agent, mic, groups=("Klebsiella pneumoniae", "Enterobacterales"), **kw):
    return interpret(
        breakpoint_set=bp_set,
        organism_groups=groups,
        agent_code=agent,
        method=Method.MIC,
        mic=MICValue.parse(mic),
        **kw,
    )


class TestMICCategories:
    @pytest.mark.parametrize(
        ("mic", "expected"),
        [
            ("<=0.06", Category.S),
            ("0.25", Category.S),
            ("0.5", Category.I),  # in the gap between S (0.25) and R (1)
            ("1", Category.R),
            (">=4", Category.R),
        ],
    )
    def test_implied_intermediate_gap(self, breakpoint_set, mic, expected):
        assert interpret_mic(breakpoint_set, "CIP", mic).category is expected

    @pytest.mark.parametrize(
        ("mic", "expected"),
        [("1", Category.S), ("2", Category.S), ("4", Category.I), ("8", Category.R)],
    )
    def test_explicit_intermediate_range(self, breakpoint_set, mic, expected):
        assert interpret_mic(breakpoint_set, "GEN", mic).category is expected

    @pytest.mark.parametrize(
        ("mic", "expected"),
        [("2", Category.S), ("4", Category.SDD), ("8", Category.SDD), ("16", Category.R)],
    )
    def test_sdd_category(self, breakpoint_set, mic, expected):
        assert interpret_mic(breakpoint_set, "FEP", mic).category is expected

    def test_sdd_carries_the_dosing_regimen(self, breakpoint_set):
        result = interpret_mic(breakpoint_set, "FEP", "4")
        assert result.category is Category.SDD
        # SDD is meaningless without the dose it assumes.
        assert any("1 g q8h" in c for c in result.comments)

    def test_susceptible_only_criterion_yields_nonsusceptible(self, breakpoint_set):
        assert interpret_mic(breakpoint_set, "TGC", "2").category is Category.S
        result = interpret_mic(breakpoint_set, "TGC", "8")
        assert result.category is Category.NS
        assert any("nonsusceptible" in c for c in result.comments)


class TestAmbiguityHandling:
    """Off-scale results that straddle a boundary must not be guessed."""

    def test_low_off_scale_above_susceptible_bound_is_not_interpreted(self, breakpoint_set):
        # S <= 2, I = 4, R >= 8. "<=4" could be 4 (I) or 1 (S).
        result = interpret_mic(breakpoint_set, "GEN", "<=4")
        assert result.category is Category.NI
        assert result.reason == NoInterpretationReason.OFF_SCALE_AMBIGUOUS
        assert result.requires_review

    def test_high_off_scale_below_resistant_bound_is_not_interpreted(self, breakpoint_set):
        # ">=4" could be 4 (I) or 64 (R).
        result = interpret_mic(breakpoint_set, "GEN", ">=4")
        assert result.category is Category.NI
        assert result.requires_review

    def test_missing_breakpoint_is_reported_as_such(self, breakpoint_set):
        result = interpret_mic(breakpoint_set, "XYZ", "1")
        assert result.category is Category.NI
        assert result.reason == NoInterpretationReason.NO_BREAKPOINT
        assert result.requires_review


class TestBreakpointSelection:
    def test_species_criterion_beats_family_criterion(self, breakpoint_set):
        # E. coli CIP: S <= 0.06, R >= 0.5. Family-level would call 0.25 susceptible.
        result = interpret_mic(breakpoint_set, "CIP", "0.25", groups=ENTERO)
        assert result.organism_group == "Escherichia coli"
        assert result.category is Category.I

    def test_family_criterion_used_when_no_species_entry(self, breakpoint_set):
        result = interpret_mic(breakpoint_set, "CIP", "0.25")
        assert result.organism_group == "Enterobacterales"
        assert result.category is Category.S

    def test_site_specific_criterion_applies_for_that_site(self, breakpoint_set):
        groups = ("Streptococcus pneumoniae",)
        systemic = interpret_mic(breakpoint_set, "PEN", "1", groups=groups)
        meningitis = interpret_mic(breakpoint_set, "PEN", "1", groups=groups, site="meningitis")
        # Same MIC, different clinical context, legitimately different category.
        assert systemic.category is Category.S
        assert meningitis.category is Category.R

    def test_generic_criterion_used_when_site_has_no_entry(self, breakpoint_set):
        result = interpret_mic(
            breakpoint_set, "PEN", "1", groups=("Streptococcus pneumoniae",), site="pneumonia"
        )
        assert result.category is Category.S


class TestDiskDiffusion:
    @pytest.mark.parametrize(
        ("zone", "expected"),
        [(30, Category.S), (26, Category.S), (23, Category.I), (21, Category.R), (6, Category.R)],
    )
    def test_zone_categories_run_opposite_to_mic(self, breakpoint_set, zone, expected):
        result = interpret(
            breakpoint_set=breakpoint_set,
            organism_groups=("Klebsiella pneumoniae", "Enterobacterales"),
            agent_code="CIP",
            method=Method.DISK,
            zone_mm=zone,
        )
        assert result.category is expected

    def test_implausible_zone_is_rejected_not_interpreted(self, breakpoint_set):
        bp = breakpoint_set.lookup(
            organism_groups=("Enterobacterales",), agent_code="CIP", method=Method.DISK
        )
        result = interpret_disk(3, bp)
        assert result.category is Category.NI
        assert result.reason == NoInterpretationReason.IMPLAUSIBLE_MEASUREMENT


class TestProvenance:
    def test_result_records_the_set_that_produced_it(self, breakpoint_set):
        result = interpret_mic(breakpoint_set, "CIP", "0.25")
        # Without this, a category cannot be explained after an edition change.
        assert result.set_version == breakpoint_set.version
        assert result.table_reference == "Fixture"

    def test_gradient_method_uses_mic_criteria(self, breakpoint_set):
        result = interpret(
            breakpoint_set=breakpoint_set,
            organism_groups=("Enterobacterales",),
            agent_code="CIP",
            method=Method.GRADIENT,
            mic=MICValue.parse("0.25"),
        )
        assert result.category is Category.S


class TestCriteriaWithNoSusceptibleCategory:
    """Agents CLSI tabulates as intermediate-or-resistant only.

    Colistin is the case that matters here: M100 defines no susceptible
    category for it at all, so its intermediate range has no floor. A system
    that cannot represent that shape cannot report colistin — and colistin
    resistance in carbapenem-resistant Gram-negatives is precisely what a
    surveillance programme exists to see.
    """

    @staticmethod
    def _colistin_set() -> BreakpointSet:
        return BreakpointSet(
            version=TEST_SET_VERSION,
            source_edition="Synthetic fixture data - not for clinical use",
            breakpoints=[
                Breakpoint(
                    set_version=TEST_SET_VERSION,
                    standard="TEST",
                    table_reference="Fixture",
                    organism_group="Pseudomonas aeruginosa",
                    agent_code="COL",
                    method=Method.MIC,
                    mic_intermediate_max=Decimal("2"),
                    mic_resistant_min=Decimal("4"),
                )
            ],
        )

    @pytest.mark.parametrize(
        ("mic", "expected"),
        [("<=0.5", Category.I), ("1", Category.I), ("2", Category.I), ("4", Category.R)],
    )
    def test_open_ended_intermediate_range_has_no_floor(self, mic, expected):
        result = interpret(
            breakpoint_set=self._colistin_set(),
            organism_groups=("Pseudomonas aeruginosa",),
            agent_code="COL",
            method=Method.MIC,
            mic=MICValue.parse(mic),
        )
        assert result.category is expected

    def test_the_table_validates(self):
        assert validate_breakpoints(self._colistin_set().breakpoints) == []

    def test_an_open_range_is_refused_where_a_susceptible_category_exists(self):
        """The guard that makes the open range safe.

        Without a susceptible bound the range has nothing to swallow. With one,
        an absent floor would quietly reclassify every susceptible result as
        intermediate, so a half-open range there is a transcription error.
        """
        issues = validate_breakpoints(
            [
                Breakpoint(
                    set_version=TEST_SET_VERSION,
                    standard="TEST",
                    table_reference="Fixture",
                    organism_group="Enterobacterales",
                    agent_code="GEN",
                    method=Method.MIC,
                    mic_susceptible_max=Decimal("2"),
                    mic_intermediate_max=Decimal("4"),
                    mic_resistant_min=Decimal("8"),
                )
            ]
        )
        assert [i.severity for i in issues] == ["error"]
        assert "lower and an upper bound" in issues[0].message

    def test_zone_criteria_open_at_the_other_end(self):
        """Zone diameters mirror MICs, so their open end is the upper one."""
        criterion = Breakpoint(
            set_version=TEST_SET_VERSION,
            standard="TEST",
            table_reference="Fixture",
            organism_group="Pseudomonas aeruginosa",
            agent_code="COL",
            method=Method.DISK,
            disk_content="10 µg",
            disk_intermediate_min=11,
            disk_resistant_max=10,
        )
        assert validate_breakpoints([criterion]) == []
        assert interpret_disk(30, criterion).category is Category.I
        assert interpret_disk(10, criterion).category is Category.R
