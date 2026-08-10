"""Reading a laboratory's M100 workbook.

The workbook a laboratory actually holds is an extraction of a printed
document, and extractions of printed documents are lossy in specific,
repeatable ways: a row label wraps onto two lines, a footnote is promoted to an
agent name, the disk-content column bleeds into its neighbour, two sub-tables
are flattened into one.

What is tested here is not that the reader is clever about that damage. It is
that the reader is *conservative* about it — that every one of those failures
produces a named drop rather than a plausible-looking criterion. A breakpoint
this module invents is a breakpoint that reaches a patient.

The values below are structural fixtures. They carry no clinical authority and
must never be used to interpret a result.
"""

import io

import pytest
from openpyxl import Workbook

from amrss.analytics.m100_workbook import (
    WorkbookFormatError,
    convert_workbook,
    resolve_agent,
    to_template_csv,
)

AGENTS = {
    "ciprofloxacin": "CIP",
    "meropenem": "MEM",
    "cefepime": "FEP",
    "colistin": "COL",
    "trimethoprim-sulfamethoxazole": "SXT",
    "amoxicillin": "AMX",
    "amoxicillin-clavulanate": "AMC",
}

HEADER = ("Table", "Organism", "Drug Class", "Antimicrobial Agent", "Disk Content")
SUBHEADER = (None, None, None, None, None, "S", "SDD", "I", "R", "S", "SDD", "I", "R", None)


def build(rows: list[tuple], *, subheader: bool = True, sheet: str = "Combined (Zone + MIC)"):
    """A workbook in the shape the extraction produces.

    Columns: table, organism, class, agent, disk content, then the zone quartet
    S/SDD/I/R, then the MIC quartet, then comments.
    """
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = sheet
    method_band = ["Zone Diameter Breakpoints (mm)", None, None, None, "MIC", None, None, None]
    worksheet.append([*HEADER, *method_band, "Comments"])
    if subheader:
        worksheet.append(list(SUBHEADER))
    for row in rows:
        worksheet.append(list(row))
    buffer = io.BytesIO()
    workbook.save(buffer)
    buffer.seek(0)
    return buffer


def row(
    agent,
    *,
    organism="Enterobacterales",
    disk="5 µg",
    zone=("≥26", "–", "22-25", "≤21"),
    mic=("≤1", "–", "2", "≥4"),
    table="2A-1",
    comment=None,
):
    return ("Table " + table, organism, "QUINOLONES", agent, disk, *zone, *mic, comment)


def convert(rows, **kwargs):
    return convert_workbook(build(rows, **kwargs), agents=AGENTS)


class TestAgentIdentification:
    def test_an_exact_name_matches(self):
        assert resolve_agent("Ciprofloxacin", AGENTS).code == "CIP"

    def test_status_markers_are_not_part_of_the_name(self):
        assert resolve_agent("Ciprofloxacin* (U)a", AGENTS).code == "CIP"

    def test_a_truncated_name_resolves_when_only_one_agent_can_complete_it(self):
        match = resolve_agent("Trimethoprim-", AGENTS)
        assert match.code == "SXT"
        assert match.rule == "truncated agent name"

    def test_an_ambiguous_truncation_resolves_to_nothing(self):
        """`Amoxicillin-` could complete to either amoxicillin-clavulanate or
        nothing at all. Picking the first candidate would be a coin toss."""
        assert resolve_agent("Amoxicillin-", {**AGENTS, "amoxicillin-sulbactam": "AMS"}) is None

    def test_the_longest_agent_name_wins(self):
        """Otherwise `Amoxicillin-clavulanate 20/10` reads as plain amoxicillin,
        whose breakpoints are different."""
        assert resolve_agent("Amoxicillin-clavulanate All isolates", AGENTS).code == "AMC"

    def test_a_footnote_fragment_matches_nothing(self):
        assert resolve_agent("(9) For surveillance purposes,", AGENTS) is None
        assert resolve_agent("Symbol: *, designation for “Other”", AGENTS) is None


class TestQualifiers:
    def test_a_site_qualifier_becomes_a_scoped_criterion(self):
        conversion = convert(
            [
                row(
                    "Cefepime (meningitis)",
                    mic=("≤0.5", "–", "1", "≥2"),
                    disk="–",
                    zone=("–", "–", "–", "–"),
                ),
                row(
                    "Cefepime (nonmeningitis)",
                    mic=("≤1", "–", "2", "≥4"),
                    disk="–",
                    zone=("–", "–", "–", "–"),
                ),
            ]
        )
        # Two criteria for the same agent, kept apart by site rather than
        # colliding — which is what M100 intends and what the extraction lost.
        assert [r["site"] for r in conversion.rows] == ["meningitis", "non_meningitis"]

    def test_a_route_qualifier_becomes_a_scoped_criterion(self):
        conversion = convert([row("Amoxicillin (oral)", disk="–", zone=("–", "–", "–", "–"))])
        assert conversion.rows[0]["route"] == "oral"

    def test_a_qualifier_restating_the_group_is_kept(self):
        conversion = convert([row("Ciprofloxacin All isolates")])
        assert [r["agent_code"] for r in conversion.rows] == ["CIP", "CIP"]

    def test_a_qualifier_narrower_than_the_group_is_dropped(self):
        """The oxacillin case. This criterion belongs to one species inside the
        group and the extraction lost which; widening it to the whole group
        would call resistant isolates susceptible."""
        conversion = convert([row("Ciprofloxacin S. epidermidis", organism="Staphylococcus spp.")])
        assert conversion.rows == []
        assert "narrower than its organism group" in conversion.dropped[0].reason

    def test_a_numeric_qualifier_is_treated_as_column_bleed(self):
        """`Gentamicin 10` is a disk content that escaped its column. Read as a
        scope it would silently merge the 10 µg and 120 µg criteria, which are
        different tests with different meanings."""
        conversion = convert([row("Ciprofloxacin 10")])
        assert conversion.rows == []
        assert "fragment of a neighbouring column" in conversion.dropped[0].reason

    def test_a_leading_or_is_line_furniture(self):
        """M100 prints alternatives on consecutive lines: `Cefotaxime or` above
        `ceftriaxone`. The agent named on this line owns this line's numbers."""
        conversion = convert([row("Ciprofloxacin or")])
        assert [r["agent_code"] for r in conversion.rows] == ["CIP", "CIP"]


class TestValueParsing:
    def test_both_methods_are_emitted_from_one_source_row(self):
        conversion = convert([row("Ciprofloxacin")])
        assert [r["method"] for r in conversion.rows] == ["MIC", "DISK"]

    def test_mic_bounds_carry_their_comparators(self):
        mic = convert([row("Ciprofloxacin")]).rows[0]
        assert (mic["mic_susceptible_max"], mic["mic_resistant_min"]) == (1, 4)
        assert (mic["mic_intermediate_min"], mic["mic_intermediate_max"]) == (2, 2)

    def test_zone_bounds_run_opposite_to_mic_bounds(self):
        disk = convert([row("Ciprofloxacin")]).rows[1]
        assert disk["disk_susceptible_min"] > disk["disk_resistant_max"]
        assert (disk["disk_intermediate_min"], disk["disk_intermediate_max"]) == (22, 25)

    def test_a_combination_value_reads_the_active_agent_not_its_partner(self):
        """`≤8/4` is 8 µg/mL of the agent with the inhibitor fixed at 4. Reading
        the 4 as a threshold would call resistant isolates susceptible."""
        conversion = convert(
            [
                row(
                    "Amoxicillin-clavulanate",
                    mic=("≤8/4", "–", "16/8", "≥32/16"),
                    disk="20/10 µg",
                    zone=("≥18", "–", "14-17", "≤13"),
                )
            ]
        )
        assert conversion.rows[0]["mic_susceptible_max"] == 8
        assert conversion.rows[0]["mic_resistant_min"] == 32

    def test_a_bound_missing_its_comparator_is_refused(self):
        """A bare `8` in the susceptible column could be a ceiling or a floor.
        There is no safe reading, so there is no reading."""
        conversion = convert([row("Ciprofloxacin", mic=("8", "–", "–", "≥32"))])
        assert [r["method"] for r in conversion.rows] == ["DISK"]
        assert any("missing its ≤ comparator" in d.reason for d in conversion.dropped)

    def test_footnote_markers_do_not_block_a_value(self):
        conversion = convert([row("Ciprofloxacin", mic=("≤1", "–", "2^", "≥4"))])
        assert conversion.rows[0]["mic_intermediate_max"] == 2

    def test_a_dash_means_the_table_defines_no_criterion(self):
        conversion = convert([row("Ciprofloxacin", zone=("–", "–", "–", "–"), disk="–")])
        assert [r["method"] for r in conversion.rows] == ["MIC"]
        # Absent is not an error: plenty of agents have MIC criteria and no
        # disk correlate.
        assert conversion.dropped == []

    def test_an_agent_with_no_susceptible_category_keeps_its_open_range(self):
        """Colistin. The intermediate range has no floor because CLSI defines
        no susceptible category for it."""
        conversion = convert(
            [row("Colistin", mic=("–", "–", "≤2", "≥4"), disk="–", zone=("–", "–", "–", "–"))]
        )
        assert conversion.rows[0]["mic_susceptible_max"] is None
        assert conversion.rows[0]["mic_intermediate_min"] is None
        assert conversion.rows[0]["mic_intermediate_max"] == 2


class TestDiskContent:
    def test_zone_criteria_without_a_readable_disk_content_are_dropped(self):
        """A zone diameter means nothing without the disk that produced it: the
        same 17 mm is susceptible against one content and resistant against
        another."""
        conversion = convert([row("Ciprofloxacin", disk="1.25/")])
        assert [r["method"] for r in conversion.rows] == ["MIC"]
        assert any("disk content" in d.reason for d in conversion.dropped)

    @pytest.mark.parametrize("content", ["10 µg", "10 μg", "20/10 µg", "10 units", "23.75 µg"])
    def test_the_disk_contents_m100_prints_are_all_read(self, content):
        conversion = convert([row("Ciprofloxacin", disk=content)])
        assert any(r["method"] == "DISK" for r in conversion.rows)


class TestConflicts:
    def test_colliding_criteria_withdraw_each_other(self):
        """Salmonella beside Shigella, meningitis beside non-meningitis: where
        the extraction flattened two sub-tables, keeping either candidate would
        be a guess about which patients it applies to, and keeping the last
        would make the answer depend on row order."""
        conversion = convert(
            [
                row(
                    "Ciprofloxacin",
                    mic=("≤0.06", "–", "0.12-0.5", "≥1"),
                    disk="–",
                    zone=("–", "–", "–", "–"),
                ),
                row(
                    "Ciprofloxacin",
                    mic=("≤0.25", "–", "0.5", "≥1"),
                    disk="–",
                    zone=("–", "–", "–", "–"),
                ),
            ]
        )
        assert conversion.rows == []
        assert any("conflicting MIC criteria" in d.reason for d in conversion.dropped)

    def test_the_same_agent_under_different_groups_does_not_collide(self):
        conversion = convert(
            [
                row("Ciprofloxacin", organism="Enterobacterales"),
                row("Ciprofloxacin", organism="Pseudomonas aeruginosa"),
            ]
        )
        assert len(conversion.rows) == 4


class TestReporting:
    def test_an_agent_outside_the_dictionary_is_named_not_silently_skipped(self):
        """A laboratory that cannot see what was left out will believe its
        table is complete."""
        conversion = convert([row("Ceftobiprole")])
        assert conversion.rows == []
        assert conversion.dropped[0].agent_label == "Ceftobiprole"
        assert conversion.dropped[0].sheet_row == 3

    def test_every_repaired_label_is_offered_for_review(self):
        conversion = convert([row("Trimethoprim-")])
        assert [(r.agent_code, r.rule) for r in conversion.repairs] == [
            ("SXT", "truncated agent name")
        ]

    def test_the_output_is_the_reviewable_template_csv(self):
        csv_text = to_template_csv(convert([row("Ciprofloxacin")]).rows)
        header, *lines = csv_text.strip().splitlines()
        assert header.startswith("organism_group,agent_code,method")
        assert len(lines) == 2

    def test_a_workbook_of_the_wrong_shape_says_so(self):
        with pytest.raises(WorkbookFormatError, match="no combined breakpoint sheet"):
            convert_workbook(build([], sheet="Sheet1"), agents=AGENTS)

    def test_a_workbook_without_a_subheader_keeps_its_first_criterion(self):
        conversion = convert([row("Ciprofloxacin")], subheader=False)
        assert len(conversion.rows) == 2
