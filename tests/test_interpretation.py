from __future__ import annotations

import pytest

from amrss.clsi.breakpoints import Category, Method
from amrss.clsi.interpretation import NoInterpretationReason, interpret
from amrss.clsi.mic import MICValue

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
        from amrss.clsi.interpretation import interpret_disk

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
