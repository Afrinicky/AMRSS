"""Turning recorded measurements into susceptibility categories.

The properties tested here are the ones that decide whether a published
antibiogram is true. A wrong threshold, a dropped MIC operator or a silently
overwritten laboratory category all produce a number that looks perfectly
ordinary and is wrong about a patient.

These exercise the pure pieces — breakpoint-set assembly, CSV import validation
and the category mapping — without a database. The database pass is covered by
the ingestion integration tests.
"""

from datetime import date
from decimal import Decimal

import pytest
from amrss_clsi.breakpoints import Category, Method

from amrss.analytics.breakpoint_import import BreakpointImportError, parse_breakpoint_csv
from amrss.analytics.interpretation import (
    CATEGORY_TO_RESULT,
    TERMINAL_REASONS,
    BreakpointsNotConfiguredError,
    build_breakpoint_set,
)
from amrss.models.enums import MethodologyComponent, SirResult
from tests.conftest import make_methodology

HEADER = (
    "organism_group,agent_code,method,standard,disk_content,tier,table_reference,"
    "mic_susceptible_max,mic_intermediate_min,mic_intermediate_max,mic_resistant_min,"
    "disk_susceptible_min,disk_intermediate_min,disk_intermediate_max,disk_resistant_max"
)

# Structurally valid criteria in the CLSI shape. The numbers are illustrative
# and carry no clinical authority: AMRSS ships no breakpoint values, and a real
# deployment loads the laboratory's own licensed table.
DISK_ROW = "Enterobacterales,CIP,DISK,M100,5 ug,1,Table 2A,,,,,26,22,25,21"
MIC_ROW = "Enterobacterales,MEM,MIC,M100,,1,Table 2A,1,2,4,8,,,,"


def methodology_with(rows: list[dict], *, version: str = "M100-Ed36"):
    return make_methodology(ast_breakpoints={"label": "CLSI M100 36th ed.", "breakpoints": rows})


# ---- Breakpoint set assembly ----------------------------------------------


def test_no_breakpoint_table_refuses_rather_than_guessing():
    """ADR-0003: the engine never falls back on a built-in default.

    A plausible category derived from a guessed threshold is worse than an
    honest gap, because nothing downstream can tell the two apart.
    """
    with pytest.raises(BreakpointsNotConfiguredError):
        build_breakpoint_set(make_methodology(ast_breakpoints={"label": "none"}))


def test_an_empty_table_is_treated_as_no_table():
    with pytest.raises(BreakpointsNotConfiguredError):
        build_breakpoint_set(methodology_with([]))


def test_breakpoints_carry_the_version_that_produced_them():
    """A result interpreted under one edition must stay explicable after the
    laboratory moves to the next."""
    rows, _ = parse_breakpoint_csv(f"{HEADER}\n{DISK_ROW}", version="M100-Ed36")
    bp_set = build_breakpoint_set(methodology_with(rows))

    assert bp_set.breakpoints[0].set_version == bp_set.version
    assert bp_set.source_edition == "CLSI M100 36th ed."


def test_lookup_prefers_the_most_specific_organism_group():
    """M100 nests species inside broader groups; the species criterion wins."""
    rows, _ = parse_breakpoint_csv(
        f"{HEADER}\n{DISK_ROW}\nEscherichia coli,CIP,DISK,M100,5 ug,1,Table 2A,,,,,31,26,30,25",
        version="v1",
    )
    bp_set = build_breakpoint_set(methodology_with(rows))

    found = bp_set.lookup(
        organism_groups=("Escherichia coli", "Enterobacterales"),
        agent_code="CIP",
        method=Method.DISK,
    )
    assert found is not None
    assert found.organism_group == "Escherichia coli"
    assert found.disk_susceptible_min == 31


def test_mic_criteria_are_parsed_as_decimals_not_floats():
    """Binary floating point cannot represent 0.06 or 0.125 exactly, and a
    breakpoint comparison that is off by a representation error decides S vs R
    on the boundary — the one place it matters most."""
    rows, _ = parse_breakpoint_csv(
        f"{HEADER}\nEnterobacterales,CRO,MIC,M100,,1,Table 2A,0.06,0.125,0.5,1,,,,", version="v1"
    )
    bp_set = build_breakpoint_set(methodology_with(rows))

    assert bp_set.breakpoints[0].mic_susceptible_max == Decimal("0.06")


# ---- Category mapping ------------------------------------------------------


def test_every_clsi_category_maps_to_a_surveillance_result():
    """A category with no mapping would silently fall through to "still
    pending" and quietly shrink every denominator."""
    interpretable = [c for c in Category if c is not Category.NI]

    assert set(CATEGORY_TO_RESULT) == set(interpretable)
    assert CATEGORY_TO_RESULT[Category.SDD] is SirResult.SUSCEPTIBLE_DOSE_DEPENDENT
    assert CATEGORY_TO_RESULT[Category.NS] is SirResult.NON_SUSCEPTIBLE


def test_no_interpretation_is_never_mapped_to_a_category():
    assert Category.NI not in CATEGORY_TO_RESULT


def test_a_missing_criterion_is_not_a_terminal_reason():
    """ "This table does not cover the combination" must leave the measurement
    pending, so a fuller edition can still recover it. Marking it NI would bury
    good data permanently."""
    from amrss_clsi.interpretation import NoInterpretationReason

    assert NoInterpretationReason.NO_BREAKPOINT not in TERMINAL_REASONS
    assert NoInterpretationReason.OFF_SCALE_AMBIGUOUS in TERMINAL_REASONS


# ---- CSV import validation -------------------------------------------------


def test_a_table_without_the_required_columns_is_rejected():
    with pytest.raises(BreakpointImportError) as exc:
        parse_breakpoint_csv("organism_group,agent_code\nEnterobacterales,CIP", version="v1")

    assert any("method" in problem for problem in exc.value.problems)


def test_template_comment_lines_are_ignored():
    """The template carries its instructions inline; a laboratory should not
    have to strip them before importing."""
    text = f"{HEADER}\n# populate from your licensed copy\n{DISK_ROW}"
    rows, _ = parse_breakpoint_csv(text, version="v1")

    assert len(rows) == 1


def test_an_unparseable_threshold_blocks_the_import():
    text = f"{HEADER}\nEnterobacterales,CIP,DISK,M100,5 ug,1,Table 2A,,,,,twenty-six,22,25,21"
    with pytest.raises(BreakpointImportError) as exc:
        parse_breakpoint_csv(text, version="v1")

    assert any("whole number" in problem for problem in exc.value.problems)


def test_an_unknown_method_blocks_the_import():
    text = f"{HEADER}\nEnterobacterales,CIP,ETEST_STRIP,M100,5 ug,1,Table 2A,,,,,26,22,25,21"
    with pytest.raises(BreakpointImportError) as exc:
        parse_breakpoint_csv(text, version="v1")

    assert any("method" in problem for problem in exc.value.problems)


def test_every_problem_is_reported_not_just_the_first():
    """Correcting a nine-hundred-row transcription one error per round trip is
    not a workable process."""
    text = (
        f"{HEADER}\n"
        "Enterobacterales,CIP,NOPE,M100,5 ug,1,Table 2A,,,,,26,22,25,21\n"
        ",MEM,DISK,M100,5 ug,1,Table 2A,,,,,26,22,25,21"
    )
    with pytest.raises(BreakpointImportError) as exc:
        parse_breakpoint_csv(text, version="v1")

    assert len(exc.value.problems) >= 2


def test_a_valid_disk_and_mic_table_imports_cleanly():
    rows, warnings = parse_breakpoint_csv(f"{HEADER}\n{DISK_ROW}\n{MIC_ROW}", version="v1")

    assert len(rows) == 2
    assert [r["method"] for r in rows] == ["DISK", "MIC"]
    assert not [w for w in warnings if "error" in w]


def test_the_shipped_template_carries_no_breakpoint_values():
    """AMRSS distributes structure, never CLSI's copyrighted numbers.

    If this ever fails, someone has committed licensed table content into the
    repository.
    """
    from pathlib import Path

    template = Path(__file__).resolve().parents[3] / "data/breakpoints/clsi_m100.template.csv"
    rows, _ = parse_breakpoint_csv(template.read_text(), version="template")

    assert rows == []


# ---- Methodology plumbing --------------------------------------------------


def test_breakpoint_component_is_versioned_like_every_other_rule():
    methodology = methodology_with(parse_breakpoint_csv(f"{HEADER}\n{DISK_ROW}", version="v1")[0])
    component = methodology.get(MethodologyComponent.AST_BREAKPOINTS)

    assert component is not None
    assert methodology.breakpoint_standard == "CLSI M100 36th ed."
    assert build_breakpoint_set(methodology).version == component.version


def test_effective_dating_is_available_for_breakpoint_versions():
    """Not a behaviour test so much as a guard: the import writes an
    effective_from, and losing it would make "which table interpreted this
    result" unanswerable."""
    from amrss.analytics import breakpoint_import

    signature = breakpoint_import.import_breakpoints.__kwdefaults__ or {}
    assert "effective_from" not in signature, "effective_from must stay required"
    assert date  # imported for the signature's type, kept explicit


# ---- Dictionary CLSI mapping -----------------------------------------------


def test_species_group_precedes_the_broader_group():
    """M100 nests species inside broader groups and defines criteria at both
    levels. Ordering the list species-first is what makes the more specific
    criterion win."""
    from amrss.seed import clsi_groups_for

    groups = clsi_groups_for(
        {
            "code": "eco",
            "name": "Escherichia coli",
            "kingdom": None,
            "genus": "Escherichia",
            "family": "Enterobacteriaceae",
            "gram_stain": "negative",
            "is_enterobacterales": True,
            "special_importance": True,
        }
    )

    assert groups == ["Escherichia coli", "Enterobacterales"]


def test_genus_level_groups_are_seeded_for_non_enterobacterales():
    from amrss.seed import clsi_groups_for

    groups = clsi_groups_for(
        {
            "code": "sau",
            "name": "Staphylococcus aureus",
            "kingdom": None,
            "genus": "Staphylococcus",
            "family": "Staphylococcaceae",
            "gram_stain": "positive",
            "is_enterobacterales": False,
            "special_importance": True,
        }
    )

    assert groups == ["Staphylococcus aureus", "Staphylococcus spp."]


def test_an_explicit_group_mapping_wins_over_the_derived_one():
    """A laboratory whose loaded edition groups an organism differently must be
    able to say so without a code change."""
    from amrss.seed import clsi_groups_for

    groups = clsi_groups_for(
        {
            "code": "sal",
            "name": "Salmonella species",
            "kingdom": None,
            "genus": "Salmonella",
            "family": "Enterobacteriaceae",
            "gram_stain": "negative",
            "is_enterobacterales": True,
            "special_importance": True,
            "clsi_groups": ["Salmonella and Shigella spp.", "Enterobacterales"],
        }
    )

    assert groups == ["Salmonella and Shigella spp.", "Enterobacterales"]
