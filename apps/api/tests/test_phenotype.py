import uuid
from datetime import date

from amrss.analytics.phenotype import OrganismInfo, evaluate
from amrss.models.enums import SirResult
from tests.conftest import ORGANISM_A, ORGANISM_B, make_isolate

FOX = uuid.UUID("00000000-0000-0000-0000-0000000000f1")
CRO = uuid.UUID("00000000-0000-0000-0000-0000000000f2")
MEM = uuid.UUID("00000000-0000-0000-0000-0000000000f3")

ANTIBIOTIC_CODES = {FOX: "FOX", CRO: "CRO", MEM: "MEM"}

STAPH = OrganismInfo(id=ORGANISM_A, code="sau", is_enterobacterales=False, genus="Staphylococcus")
KLEBSIELLA = OrganismInfo(id=ORGANISM_B, code="kpn", is_enterobacterales=True, genus="Klebsiella")
ORGANISMS = {ORGANISM_A: STAPH, ORGANISM_B: KLEBSIELLA}

MRSA_RULE = {
    "code": "MRSA_SCREEN",
    "label": "MRSA phenotype (screening-level)",
    "organism_codes": ["sau"],
    "all_tested": ["FOX"],
    "any_resistant": ["FOX"],
    "basis": "Cefoxitin-resistant Staphylococcus aureus",
}
CRE_RULE = {
    "code": "CRE_SCREEN",
    "label": "Carbapenem-resistant Enterobacterales phenotype (screening-level)",
    "organism_selector": "enterobacterales",
    "all_tested": ["MEM"],
    "any_resistant": ["MEM"],
    "count_intermediate_as_non_susceptible": True,
    "basis": "Carbapenem-non-susceptible Enterobacterales",
}

TODAY = date(2026, 8, 8)


def test_rule_fires_on_the_matching_organism_and_result():
    record = make_isolate(
        specimen_date=TODAY, results={FOX: SirResult.RESISTANT}, organism_id=ORGANISM_A
    )

    observations = evaluate(record, [MRSA_RULE], ORGANISMS, ANTIBIOTIC_CODES)

    assert len(observations) == 1
    assert observations[0].flag_code == "MRSA_SCREEN"
    assert observations[0].is_screening_level is True
    assert "screening-level" in observations[0].label


def test_rule_does_not_fire_on_a_susceptible_result():
    record = make_isolate(
        specimen_date=TODAY, results={FOX: SirResult.SUSCEPTIBLE}, organism_id=ORGANISM_A
    )

    assert evaluate(record, [MRSA_RULE], ORGANISMS, ANTIBIOTIC_CODES) == []


def test_untested_agent_is_not_treated_as_susceptible():
    """A laboratory that stopped testing an agent must not appear to have
    eliminated resistance to it."""
    record = make_isolate(specimen_date=TODAY, results={CRO: SirResult.RESISTANT})

    assert evaluate(record, [MRSA_RULE], ORGANISMS, ANTIBIOTIC_CODES) == []


def test_non_interpretable_result_does_not_satisfy_the_tested_requirement():
    record = make_isolate(
        specimen_date=TODAY,
        results={FOX: SirResult.NOT_INTERPRETABLE},
        organism_id=ORGANISM_A,
    )

    assert evaluate(record, [MRSA_RULE], ORGANISMS, ANTIBIOTIC_CODES) == []


def test_organism_selector_matches_by_family_membership():
    record = make_isolate(
        specimen_date=TODAY, results={MEM: SirResult.RESISTANT}, organism_id=ORGANISM_B
    )

    observations = evaluate(record, [CRE_RULE], ORGANISMS, ANTIBIOTIC_CODES)

    assert [o.flag_code for o in observations] == ["CRE_SCREEN"]


def test_selector_does_not_match_an_organism_outside_the_group():
    record = make_isolate(
        specimen_date=TODAY, results={MEM: SirResult.RESISTANT}, organism_id=ORGANISM_A
    )

    assert evaluate(record, [CRE_RULE], ORGANISMS, ANTIBIOTIC_CODES) == []


def test_intermediate_counts_as_non_susceptible_only_when_the_rule_says_so():
    intermediate = make_isolate(
        specimen_date=TODAY, results={MEM: SirResult.INTERMEDIATE}, organism_id=ORGANISM_B
    )

    with_intermediate = evaluate(intermediate, [CRE_RULE], ORGANISMS, ANTIBIOTIC_CODES)
    strict_rule = {**CRE_RULE, "count_intermediate_as_non_susceptible": False}
    without_intermediate = evaluate(intermediate, [strict_rule], ORGANISMS, ANTIBIOTIC_CODES)

    assert len(with_intermediate) == 1
    assert without_intermediate == []


def test_no_flag_claims_confirmation():
    """v1 supports screening only. A label that read "confirmed" would put an
    unearned word in a clinician's hands."""
    record = make_isolate(
        specimen_date=TODAY, results={FOX: SirResult.RESISTANT}, organism_id=ORGANISM_A
    )

    for observation in evaluate(record, [MRSA_RULE, CRE_RULE], ORGANISMS, ANTIBIOTIC_CODES):
        assert "confirmed" not in observation.label.lower()
        assert observation.is_screening_level
