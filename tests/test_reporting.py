from __future__ import annotations

from datetime import UTC, datetime, timedelta

from amrss.clsi.breakpoints import Category, Method, Tier
from amrss.clsi.qc import QCOutcome, QCResult
from amrss.clsi.reporting import (
    apply_cascade,
    is_multidrug_resistant,
    release_decision,
)
from amrss.clsi.rules import ResultEntry

NOW = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)


def results(**pairs: Category) -> dict[str, ResultEntry]:
    return {code: ResultEntry(code, cat, Method.MIC) for code, cat in pairs.items()}


def good_qc(*agents: str) -> list[QCResult]:
    return [
        QCResult(
            performed_at=NOW - timedelta(hours=2),
            strain_designation="ATCC 25922",
            agent_code=agent,
            method=Method.MIC,
            outcome=QCOutcome.IN_RANGE,
        )
        for agent in agents
    ]


class TestCascadeReporting:
    def test_tier_one_always_reported(self):
        decisions = apply_cascade(
            results(AMP=Category.S, CIP=Category.R),
            {"AMP": Tier.TIER_1, "CIP": Tier.TIER_1},
        )
        assert all(d.reportable for d in decisions)

    def test_higher_tier_suppressed_when_lower_tier_works(self):
        decisions = apply_cascade(
            results(AMP=Category.S, MEM=Category.S),
            {"AMP": Tier.TIER_1, "MEM": Tier.TIER_3},
        )
        by_agent = {d.agent_code: d for d in decisions}
        # Reporting a carbapenem alongside a working ampicillin drives
        # unnecessary broad-spectrum use.
        assert by_agent["AMP"].reportable
        assert not by_agent["MEM"].reportable

    def test_higher_tier_released_when_lower_tiers_all_resistant(self):
        decisions = apply_cascade(
            results(AMP=Category.R, CIP=Category.R, MEM=Category.S),
            {"AMP": Tier.TIER_1, "CIP": Tier.TIER_2, "MEM": Tier.TIER_3},
        )
        by_agent = {d.agent_code: d for d in decisions}
        assert by_agent["MEM"].reportable

    def test_sdd_counts_as_an_effective_lower_tier_option(self):
        decisions = apply_cascade(
            results(FEP=Category.SDD, MEM=Category.S),
            {"FEP": Tier.TIER_1, "MEM": Tier.TIER_3},
        )
        assert not {d.agent_code: d for d in decisions}["MEM"].reportable

    def test_untiered_agents_are_always_released(self):
        decisions = apply_cascade(results(NIT=Category.S), {})
        # Failing open is correct: withholding a needed result is worse.
        assert decisions[0].reportable

    def test_cascade_can_be_disabled(self):
        decisions = apply_cascade(
            results(AMP=Category.S, MEM=Category.S),
            {"AMP": Tier.TIER_1, "MEM": Tier.TIER_3},
            enabled=False,
        )
        assert all(d.reportable for d in decisions)


class TestReleaseGate:
    def test_clean_results_with_current_qc_are_releasable(self):
        decision = release_decision(
            results=results(CIP=Category.S), qc_results=good_qc("CIP"), now=NOW
        )
        assert decision.allowed

    def test_uninterpretable_result_blocks_release(self):
        decision = release_decision(
            results=results(CIP=Category.NI), qc_results=good_qc("CIP"), now=NOW
        )
        assert not decision.allowed
        assert any(b.code == "uninterpretable_result" for b in decision.blockers)

    def test_missing_qc_blocks_release(self):
        decision = release_decision(results=results(CIP=Category.S), qc_results=[], now=NOW)
        assert not decision.allowed
        assert any(b.code == "qc_not_satisfied" for b in decision.blockers)

    def test_qc_gate_can_be_disabled_for_non_production_use(self):
        decision = release_decision(
            results=results(CIP=Category.S), qc_results=[], enforce_qc=False, now=NOW
        )
        assert decision.allowed

    def test_unresolved_rule_flag_blocks_release(self):
        decision = release_decision(
            results=results(CLI=Category.S),
            qc_results=good_qc("CLI"),
            unresolved_flags={"CLI": "D-zone test pending"},
            now=NOW,
        )
        assert not decision.allowed
        assert "D-zone test pending" in decision.blocker_summary()

    def test_every_blocker_is_reported_not_just_the_first(self):
        decision = release_decision(
            results=results(CIP=Category.NI, GEN=Category.S), qc_results=[], now=NOW
        )
        codes = {b.code for b in decision.blockers}
        assert {"uninterpretable_result", "qc_not_satisfied"} <= codes


class TestMultidrugResistance:
    CLASSES = {
        "AMP": "penicillins",
        "CZO": "cephalosporins",
        "CIP": "fluoroquinolones",
        "LVX": "fluoroquinolones",
        "GEN": "aminoglycosides",
    }

    def test_three_nonsusceptible_classes_is_mdr(self):
        mdr, classes = is_multidrug_resistant(
            results(AMP=Category.R, CZO=Category.R, CIP=Category.R), self.CLASSES
        )
        assert mdr
        assert len(classes) == 3

    def test_multiple_agents_in_one_class_count_once(self):
        # Two fluoroquinolones are one class, not two - this is the mistake the
        # class-based definition exists to prevent.
        mdr, classes = is_multidrug_resistant(
            results(CIP=Category.R, LVX=Category.R, AMP=Category.R), self.CLASSES
        )
        assert not mdr
        assert classes == ["fluoroquinolones", "penicillins"]

    def test_intermediate_counts_as_nonsusceptible(self):
        mdr, _ = is_multidrug_resistant(
            results(AMP=Category.I, CZO=Category.R, GEN=Category.NS), self.CLASSES
        )
        assert mdr

    def test_susceptible_isolate_is_not_mdr(self):
        mdr, classes = is_multidrug_resistant(
            results(AMP=Category.S, CZO=Category.S, CIP=Category.S), self.CLASSES
        )
        assert not mdr
        assert classes == []
