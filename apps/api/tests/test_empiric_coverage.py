"""The empiric coverage maths — a WISCA weighted by local prevalence.

This is the number a clinician reads as "start this and you probably cover the
patient", so the weighting has to be exactly right and has to err low, never
high.
"""

from amrss.analytics.empiric import EmpiricRow, summarise


def test_coverage_weights_each_organisms_susceptibility_by_its_prevalence():
    rows = [
        # 80 of 100 isolates are E. coli, 90% susceptible to X.
        EmpiricRow("ecoli", 80, {"X": 0.90}),
        # 20 are Klebsiella, 50% susceptible to X.
        EmpiricRow("kleb", 20, {"X": 0.50}),
    ]
    summary = summarise(rows)

    (x,) = summary.coverage
    assert x.antibiotic_id == "X"
    # 0.8 * 90% + 0.2 * 50% = 82%.
    assert round(x.coverage_percent, 1) == 82.0
    assert x.isolates_covered == 82  # 80*0.9 + 20*0.5
    assert x.organisms_contributing == 2


def test_an_agent_active_against_only_the_common_organism_covers_less_than_its_rate():
    rows = [
        EmpiricRow("ecoli", 80, {"NARROW": 0.95}),
        # Not tested / not active against Klebsiella — contributes nothing, but
        # its isolates are still in the denominator.
        EmpiricRow("kleb", 20, {"NARROW": None}),
    ]
    (narrow,) = summarise(rows).coverage
    # 0.8 * 95% = 76%, not 95%: the drug cannot cover the 20% it does not touch.
    assert round(narrow.coverage_percent, 1) == 76.0
    assert narrow.organisms_contributing == 1


def test_coverage_is_ranked_best_first():
    rows = [
        EmpiricRow("ecoli", 100, {"LOW": 0.40, "HIGH": 0.95, "MID": 0.70}),
    ]
    order = [entry.antibiotic_id for entry in summarise(rows).coverage]
    assert order == ["HIGH", "MID", "LOW"]


def test_prevalence_is_ranked_commonest_first_with_shares():
    rows = [
        EmpiricRow("kleb", 20, {}),
        EmpiricRow("ecoli", 80, {}),
    ]
    prevalence = summarise(rows).prevalence
    assert [p.organism_id for p in prevalence] == ["ecoli", "kleb"]
    assert round(prevalence[0].percent_of_site, 0) == 80
    assert round(prevalence[1].percent_of_site, 0) == 20


def test_an_agent_no_organism_can_report_is_omitted_not_shown_as_zero():
    rows = [EmpiricRow("ecoli", 10, {"UNKNOWN": None})]
    assert summarise(rows).coverage == []


def test_an_empty_site_is_empty_not_an_error():
    summary = summarise([])
    assert summary.total_isolates == 0
    assert summary.prevalence == []
    assert summary.coverage == []
