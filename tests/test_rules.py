from __future__ import annotations

from amrss_clsi.breakpoints import Category, Method
from amrss_clsi.rules import (
    IntrinsicResistance,
    IsolateResults,
    ResultEntry,
    RuleAction,
    apply_expert_rules,
    check_intrinsic_resistance,
    resolve,
)


def entry(agent: str, category: Category) -> ResultEntry:
    return ResultEntry(agent_code=agent, category=category, method=Method.MIC)


def isolate(organism: str, groups: tuple[str, ...], **results: Category) -> IsolateResults:
    return IsolateResults(
        organism_code=organism,
        organism_groups=groups,
        results={code: entry(code, cat) for code, cat in results.items()},
    )


class TestIntrinsicResistance:
    def test_susceptible_result_for_intrinsic_agent_is_forced_to_resistant(self):
        iso = isolate("KPN", ("Klebsiella pneumoniae", "Klebsiella spp."), AMP=Category.S)
        outcomes = check_intrinsic_resistance(iso)
        assert len(outcomes) == 1
        assert outcomes[0].action is RuleAction.OVERRIDE_CATEGORY
        assert outcomes[0].new_category is Category.R
        # The discrepancy must be visible - it usually means a misidentification.
        assert "verify organism identification" in outcomes[0].comment

    def test_resistant_result_for_intrinsic_agent_is_suppressed(self):
        iso = isolate("KPN", ("Klebsiella spp.",), AMP=Category.R)
        outcomes = check_intrinsic_resistance(iso)
        assert outcomes[0].action is RuleAction.SUPPRESS

    def test_untested_intrinsic_agent_produces_nothing(self):
        iso = isolate("KPN", ("Klebsiella spp.",), CIP=Category.S)
        assert check_intrinsic_resistance(iso) == []

    def test_unrelated_organism_is_unaffected(self):
        iso = isolate("ECO", ("Escherichia coli", "Enterobacterales"), AMP=Category.S)
        assert check_intrinsic_resistance(iso) == []

    def test_table_is_extensible_without_code_changes(self):
        custom = (IntrinsicResistance("Acinetobacter baumannii complex", "ERT", "no activity"),)
        iso = isolate("ABA", ("Acinetobacter baumannii complex",), ERT=Category.S)
        outcomes = check_intrinsic_resistance(iso, table=custom)
        assert outcomes[0].new_category is Category.R


class TestStaphylococcalBetaLactamRule:
    def test_cefoxitin_resistance_forces_beta_lactams_resistant(self):
        iso = isolate(
            "SAU",
            ("Staphylococcus aureus", "Staphylococcus spp."),
            FOX=Category.R,
            CZO=Category.S,
            AMP=Category.S,
            CIP=Category.S,
        )
        outcomes = apply_expert_rules(iso)
        overridden = {o.agent_code for o in outcomes if o.action is RuleAction.OVERRIDE_CATEGORY}
        assert {"CZO", "AMP"} <= overridden
        # Non-beta-lactams are untouched.
        assert "CIP" not in overridden

    def test_anti_mrsa_cephalosporin_stays_reportable(self):
        iso = isolate("SAU", ("Staphylococcus spp.",), FOX=Category.R, CPT=Category.S)
        outcomes = apply_expert_rules(iso)
        assert all(o.agent_code != "CPT" for o in outcomes)

    def test_susceptible_surrogate_leaves_results_alone(self):
        iso = isolate("SAU", ("Staphylococcus spp.",), FOX=Category.S, CZO=Category.S)
        assert apply_expert_rules(iso) == []

    def test_oxacillin_works_as_the_surrogate_too(self):
        iso = isolate("SAU", ("Staphylococcus spp.",), OXA=Category.R, CZO=Category.S)
        outcomes = apply_expert_rules(iso)
        assert any(o.agent_code == "CZO" for o in outcomes)


class TestInducibleClindamycin:
    def test_erythromycin_r_clindamycin_s_flags_d_test(self):
        iso = isolate("SAU", ("Staphylococcus spp.",), ERY=Category.R, CLI=Category.S)
        outcomes = apply_expert_rules(iso)
        flag = next(o for o in outcomes if o.agent_code == "CLI")
        assert flag.action is RuleAction.FLAG_CONFIRMATION
        assert "D-zone" in flag.comment

    def test_no_flag_when_clindamycin_already_resistant(self):
        iso = isolate("SAU", ("Staphylococcus spp.",), ERY=Category.R, CLI=Category.R)
        assert [o for o in apply_expert_rules(iso) if o.agent_code == "CLI"] == []


class TestEnterococcalAndCarbapenemRules:
    def test_ampicillin_resistance_predicts_penicillin_resistance(self):
        iso = isolate(
            "EFA",
            ("Enterococcus faecalis", "Enterococcus spp."),
            AMP=Category.R,
            PEN=Category.S,
        )
        outcomes = apply_expert_rules(iso)
        pen = next(o for o in outcomes if o.agent_code == "PEN")
        assert pen.new_category is Category.R

    def test_carbapenem_nonsusceptibility_flags_for_confirmation(self):
        iso = isolate("KPN", ("Klebsiella pneumoniae", "Enterobacterales"), MEM=Category.R)
        outcomes = apply_expert_rules(iso)
        flag = next(o for o in outcomes if o.agent_code == "MEM")
        assert flag.action is RuleAction.FLAG_CONFIRMATION
        assert "infection prevention" in flag.comment

    def test_carbapenem_susceptible_isolate_is_not_flagged(self):
        iso = isolate("KPN", ("Enterobacterales",), MEM=Category.S)
        assert apply_expert_rules(iso) == []


class TestResolve:
    def test_overrides_replace_categories_and_keep_measurements(self):
        iso = IsolateResults(
            organism_code="SAU",
            organism_groups=("Staphylococcus spp.",),
            results={
                "FOX": ResultEntry("FOX", Category.R, Method.DISK, zone_mm=15),
                "CZO": ResultEntry("CZO", Category.S, Method.DISK, zone_mm=25),
            },
        )
        final = resolve(iso, apply_expert_rules(iso))
        assert final["CZO"].category is Category.R
        # The raw measurement is a fact and must survive the override.
        assert final["CZO"].zone_mm == 25

    def test_suppression_removes_the_agent(self):
        iso = isolate("KPN", ("Klebsiella spp.",), AMP=Category.R, CIP=Category.S)
        final = resolve(iso, check_intrinsic_resistance(iso))
        assert "AMP" not in final
        assert "CIP" in final
