from datetime import date, timedelta

from amrss.analytics.antibiogram import CellState, compute
from amrss.models.enums import OrganismKingdom, SirResult
from tests.conftest import (
    DRUG_X,
    FACILITY_1,
    FACILITY_2,
    ORGANISM_A,
    YEAST,
    make_isolate,
    make_methodology,
)

DAY_ZERO = date(2026, 1, 1)


def population(count: int, *, susceptible: int, **kwargs) -> list:
    """Distinct patients, spaced a day apart, so deduplication never interferes
    with a test that is about thresholds rather than about deduplication."""
    records = []
    for index in range(count):
        result = SirResult.SUSCEPTIBLE if index < susceptible else SirResult.RESISTANT
        records.append(
            make_isolate(
                specimen_date=DAY_ZERO + timedelta(days=index),
                results={DRUG_X: result},
                patient=f"patient-{index}",
                **kwargs,
            )
        )
    return records


def cell_for(antibiogram, organism_id=ORGANISM_A, antibiotic_id=DRUG_X):
    row = next(row for row in antibiogram.rows if row.organism_id == organism_id)
    return row.cells[antibiotic_id]


def test_combination_at_the_threshold_is_reportable():
    methodology = make_methodology(antibiogram={"minimum_isolates": 30})
    result = compute(population(30, susceptible=15), methodology)

    cell = cell_for(result)
    assert cell.state is CellState.REPORTABLE
    assert cell.susceptible_percent == 50.0
    assert cell.summary.interpretable == 30


def test_combination_below_the_threshold_is_not_given_a_percentage():
    methodology = make_methodology(antibiogram={"minimum_isolates": 30})
    result = compute(population(20, susceptible=10), methodology)

    cell = cell_for(result)
    assert cell.state is CellState.BELOW_THRESHOLD
    assert cell.susceptible_percent is None
    assert cell.summary is None


def test_small_cells_are_suppressed_and_withhold_their_counts():
    """Releasing n while hiding the percentage would leak the same small cell,
    so a suppressed cell carries no summary at all."""
    methodology = make_methodology(suppression={"small_cell_threshold": 5})
    result = compute(population(3, susceptible=2), methodology)

    cell = cell_for(result)
    assert cell.state is CellState.SUPPRESSED
    assert cell.summary is None


def test_a_facility_viewing_its_own_data_sees_small_cells_unsuppressed():
    methodology = make_methodology(suppression={"small_cell_threshold": 5})
    result = compute(population(3, susceptible=2), methodology, apply_suppression=False)

    # Still below the reporting threshold — but shown as below-threshold rather
    # than withheld, because suppression protects against cross-facility
    # re-identification, not against the facility that holds the source record.
    assert cell_for(result).state is CellState.BELOW_THRESHOLD


def test_suppression_and_reporting_threshold_are_independent_gates():
    """n=10 clears suppression at 5 but not the reporting threshold at 30."""
    methodology = make_methodology(
        antibiogram={"minimum_isolates": 30}, suppression={"small_cell_threshold": 5}
    )
    result = compute(population(10, susceptible=5), methodology)

    assert cell_for(result).state is CellState.BELOW_THRESHOLD


def test_quality_gating_excludes_unverified_facilities_and_says_so():
    methodology = make_methodology()
    verified = population(30, susceptible=30, facility_id=FACILITY_1)
    unverified = population(30, susceptible=0, facility_id=FACILITY_2, quality_verified=False)

    result = compute(verified + unverified, methodology)

    assert cell_for(result).susceptible_percent == 100.0
    assert result.quality_exclusion.excluded_facility_count == 1
    assert result.quality_exclusion.excluded_isolate_count == 30
    assert FACILITY_2 in result.quality_exclusion.excluded_facility_ids


def test_facility_own_view_includes_its_data_regardless_of_quality_status():
    methodology = make_methodology()
    records = population(30, susceptible=15, facility_id=FACILITY_1, quality_verified=False)

    result = compute(records, methodology, verified_only=False)

    assert cell_for(result).state is CellState.REPORTABLE
    assert result.quality_exclusion.excluded_facility_count == 0


def test_deduplication_runs_before_the_threshold_is_applied():
    """Thirty-five isolates from five patients is five antibiogram-eligible
    isolates, not thirty-five. Applying the threshold first would publish a
    percentage built from repeat sampling of a handful of inpatients."""
    methodology = make_methodology(antibiogram={"minimum_isolates": 30})
    records = [
        make_isolate(
            specimen_date=DAY_ZERO + timedelta(days=day),
            results={DRUG_X: SirResult.RESISTANT},
            patient=f"patient-{patient}",
        )
        for patient in range(5)
        for day in range(7)
    ]

    result = compute(records, methodology)

    assert result.raw_isolate_count == 35
    assert result.deduplication.retained_isolates == 5
    # Thirty-five would have cleared the threshold of 30; five does not.
    assert cell_for(result).state is CellState.BELOW_THRESHOLD


def test_raw_and_eligible_counts_are_reported_separately():
    methodology = make_methodology()
    repeat = make_isolate(
        specimen_date=DAY_ZERO + timedelta(days=1),
        results={DRUG_X: SirResult.SUSCEPTIBLE},
        patient="patient-0",
    )
    records = [*population(40, susceptible=20), repeat]

    result = compute(records, methodology)

    assert result.raw_isolate_count == 41
    assert result.deduplication.retained_isolates == 40


def test_fungal_isolates_produce_rows_alongside_bacterial_ones():
    methodology = make_methodology()
    records = population(30, susceptible=15) + population(
        30, susceptible=25, organism_id=YEAST, kingdom=OrganismKingdom.FUNGI
    )

    result = compute(records, methodology)

    kingdoms = {row.organism_kingdom for row in result.rows}
    assert kingdoms == {OrganismKingdom.BACTERIA, OrganismKingdom.FUNGI}
    yeast_row = next(row for row in result.rows if row.organism_id == YEAST)
    assert yeast_row.cells[DRUG_X].state is CellState.REPORTABLE


def test_untested_agents_do_not_appear_as_zero_percent():
    methodology = make_methodology()
    result = compute(population(30, susceptible=15), methodology)

    row = next(row for row in result.rows if row.organism_id == ORGANISM_A)
    assert set(row.cells) == {DRUG_X}


def test_uncertainty_cue_is_set_for_modest_counts_only():
    methodology = make_methodology(antibiogram={"minimum_isolates": 30, "modest_n_ceiling": 100})

    modest = compute(population(50, susceptible=25), methodology)
    ample = compute(population(150, susceptible=75), methodology)

    assert cell_for(modest).uncertainty_cue is True
    assert cell_for(ample).uncertainty_cue is False
