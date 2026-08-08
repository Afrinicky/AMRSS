from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from amrss.clsi.breakpoints import Method
from amrss.clsi.mic import MICValue
from amrss.clsi.qc import (
    QCFrequency,
    QCOutcome,
    QCRange,
    QCResult,
    evaluate_qc,
    qc_status,
    weekly_conversion_eligible,
)

NOW = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)

MIC_RANGE = QCRange(
    set_version="TEST",
    strain_designation="ATCC 25922",
    agent_code="CIP",
    method=Method.MIC,
    mic_min=Decimal("0.004"),
    mic_max=Decimal("0.016"),
)
ZONE_RANGE = QCRange(
    set_version="TEST",
    strain_designation="ATCC 25922",
    agent_code="AMP",
    method=Method.DISK,
    zone_min_mm=15,
    zone_max_mm=22,
)


def qc(agent="CIP", method=Method.MIC, mic=None, zone=None, at=NOW, outcome=None):
    return QCResult(
        performed_at=at,
        strain_designation="ATCC 25922",
        agent_code=agent,
        method=method,
        mic=MICValue.parse(mic) if mic else None,
        zone_mm=zone,
        outcome=outcome or QCOutcome.IN_RANGE,
    )


class TestEvaluation:
    def test_in_range_mic_passes(self):
        result = evaluate_qc(qc(mic="0.008"), [MIC_RANGE])
        assert result.outcome is QCOutcome.IN_RANGE

    @pytest.mark.parametrize("value", ["0.002", "0.03"])
    def test_out_of_range_mic_fails(self, value):
        assert evaluate_qc(qc(mic=value), [MIC_RANGE]).outcome is QCOutcome.OUT_OF_RANGE

    def test_off_scale_qc_cannot_be_confirmed_in_range(self):
        # "<=0.004" might really be 0.001, which is below the acceptable range.
        assert evaluate_qc(qc(mic="<=0.004"), [MIC_RANGE]).outcome is QCOutcome.OUT_OF_RANGE

    def test_zone_within_range_passes(self):
        result = evaluate_qc(qc(agent="AMP", method=Method.DISK, zone=18), [ZONE_RANGE])
        assert result.outcome is QCOutcome.IN_RANGE

    def test_zone_outside_range_fails(self):
        result = evaluate_qc(qc(agent="AMP", method=Method.DISK, zone=24), [ZONE_RANGE])
        assert result.outcome is QCOutcome.OUT_OF_RANGE
        assert result.expected == "15-22 mm"

    def test_missing_range_is_not_evaluable_rather_than_a_pass(self):
        result = evaluate_qc(qc(agent="MEM", mic="0.06"), [MIC_RANGE])
        assert result.outcome is QCOutcome.NOT_EVALUABLE


class TestQCStatusGate:
    def test_current_in_range_qc_permits_reporting(self):
        status = qc_status(
            agent_code="CIP",
            method=Method.MIC,
            recent_results=[qc(at=NOW - timedelta(hours=3))],
            now=NOW,
        )
        assert status.satisfied

    def test_no_qc_on_record_blocks_reporting(self):
        status = qc_status(agent_code="CIP", method=Method.MIC, recent_results=[], now=NOW)
        assert not status.satisfied
        assert "No QC on record" in status.reason

    def test_stale_qc_blocks_reporting(self):
        status = qc_status(
            agent_code="CIP",
            method=Method.MIC,
            recent_results=[qc(at=NOW - timedelta(days=3))],
            now=NOW,
        )
        assert not status.satisfied
        assert "exceeding the daily requirement" in status.reason

    def test_weekly_frequency_widens_the_window(self):
        status = qc_status(
            agent_code="CIP",
            method=Method.MIC,
            recent_results=[qc(at=NOW - timedelta(days=3))],
            frequency=QCFrequency.WEEKLY,
            now=NOW,
        )
        assert status.satisfied

    def test_most_recent_failure_blocks_even_if_older_runs_passed(self):
        results = [
            qc(at=NOW - timedelta(days=1)),
            qc(at=NOW - timedelta(hours=1), outcome=QCOutcome.OUT_OF_RANGE),
        ]
        status = qc_status(agent_code="CIP", method=Method.MIC, recent_results=results, now=NOW)
        assert not status.satisfied
        assert "corrective action" in status.reason

    def test_gradient_qc_satisfies_mic_testing(self):
        status = qc_status(
            agent_code="CIP",
            method=Method.MIC,
            recent_results=[qc(method=Method.GRADIENT, at=NOW - timedelta(hours=2))],
            now=NOW,
        )
        assert status.satisfied


class TestWeeklyConversion:
    def _run(self, days: int, failures: int = 0, plan: int = 20):
        results = []
        for i in range(days):
            outcome = QCOutcome.OUT_OF_RANGE if i < failures else QCOutcome.IN_RANGE
            results.append(qc(at=NOW - timedelta(days=days - i), outcome=outcome))
        return weekly_conversion_eligible(results, plan_days=plan, today=NOW.date())

    def test_clean_twenty_day_study_qualifies(self):
        eligible, reason = self._run(20)
        assert eligible, reason

    def test_short_study_does_not_qualify(self):
        eligible, reason = self._run(12)
        assert not eligible
        assert "12 of 20" in reason

    def test_any_failure_disqualifies_the_twenty_day_plan(self):
        eligible, _ = self._run(20, failures=1)
        assert not eligible

    def test_thirty_day_plan_tolerates_one_failure(self):
        eligible, reason = self._run(30, failures=1, plan=30)
        assert eligible, reason

    def test_thirty_day_plan_rejects_two_failures(self):
        eligible, _ = self._run(30, failures=2, plan=30)
        assert not eligible

    def test_invalid_plan_length_is_rejected(self):
        with pytest.raises(ValueError):
            weekly_conversion_eligible([], plan_days=25)
