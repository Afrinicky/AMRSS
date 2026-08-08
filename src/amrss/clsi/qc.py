"""Quality control for antimicrobial susceptibility testing.

CLSI (M02/M07/M100) requires that AST results only be reported when quality
control with reference strains is in range and current. This module holds the
acceptable-range records, evaluates individual QC results, and answers the one
question the result-release path actually needs: *is QC satisfied for this
agent/method right now?*

QC ranges, like breakpoints, are versioned table data loaded from the
laboratory's licensed edition - none are hardcoded here.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from enum import StrEnum

from amrss.clsi.breakpoints import Method
from amrss.clsi.mic import MICValue


class QCFrequency(StrEnum):
    """Testing frequency permitted for a given agent/method combination."""

    DAILY = "daily"
    WEEKLY = "weekly"  # earned via a successful 20- or 30-day conversion study


class QCOutcome(StrEnum):
    IN_RANGE = "in_range"
    OUT_OF_RANGE = "out_of_range"
    NOT_EVALUABLE = "not_evaluable"  # no range defined for this combination


# Reference strains named in CLSI QC tables. The ATCC designation is the
# identity of the control - recording it makes a QC result auditable.
@dataclass(frozen=True)
class QCStrain:
    code: str  # internal code
    designation: str  # e.g. "ATCC 25922"
    organism_name: str


@dataclass(frozen=True)
class QCRange:
    """Acceptable QC result range for one strain/agent/method."""

    set_version: str
    strain_designation: str
    agent_code: str
    method: Method
    # MIC ranges are inclusive, in µg/mL.
    mic_min: Decimal | None = None
    mic_max: Decimal | None = None
    # Zone ranges are inclusive, in mm.
    zone_min_mm: int | None = None
    zone_max_mm: int | None = None
    disk_content: str | None = None

    def covers(self, agent_code: str, method: Method, strain_designation: str) -> bool:
        same_method = (Method.MIC if method.is_mic_like else method) == (
            Method.MIC if self.method.is_mic_like else self.method
        )
        return (
            self.agent_code == agent_code
            and same_method
            and self.strain_designation == strain_designation
        )


@dataclass
class QCResult:
    performed_at: datetime
    strain_designation: str
    agent_code: str
    method: Method
    mic: MICValue | None = None
    zone_mm: int | None = None
    outcome: QCOutcome = QCOutcome.NOT_EVALUABLE
    note: str | None = None


@dataclass
class QCEvaluation:
    outcome: QCOutcome
    expected: str | None = None
    observed: str | None = None
    message: str | None = None


def evaluate_qc(result: QCResult, ranges: list[QCRange]) -> QCEvaluation:
    """Compare a QC result against the acceptable range."""
    match = next(
        (
            r
            for r in ranges
            if r.covers(result.agent_code, result.method, result.strain_designation)
        ),
        None,
    )
    if match is None:
        return QCEvaluation(
            outcome=QCOutcome.NOT_EVALUABLE,
            message=(
                f"No QC range defined for {result.strain_designation} / "
                f"{result.agent_code} / {result.method}"
            ),
        )

    if result.method.is_mic_like:
        if result.mic is None or match.mic_min is None or match.mic_max is None:
            return QCEvaluation(
                outcome=QCOutcome.NOT_EVALUABLE,
                message="MIC QC requires an MIC result and an MIC range",
            )
        # An off-scale QC reading cannot be confirmed in range: "<=0.25" against
        # a range of 0.25-1 might really be 0.06.
        in_range = result.mic.definitely_at_least(match.mic_min) and (
            result.mic.definitely_at_most(match.mic_max)
        )
        return QCEvaluation(
            outcome=QCOutcome.IN_RANGE if in_range else QCOutcome.OUT_OF_RANGE,
            expected=f"{match.mic_min}-{match.mic_max} µg/mL",
            observed=str(result.mic),
            message=None if in_range else "QC MIC outside the acceptable range",
        )

    if result.zone_mm is None or match.zone_min_mm is None or match.zone_max_mm is None:
        return QCEvaluation(
            outcome=QCOutcome.NOT_EVALUABLE,
            message="Disk QC requires a zone measurement and a zone range",
        )
    in_range = match.zone_min_mm <= result.zone_mm <= match.zone_max_mm
    return QCEvaluation(
        outcome=QCOutcome.IN_RANGE if in_range else QCOutcome.OUT_OF_RANGE,
        expected=f"{match.zone_min_mm}-{match.zone_max_mm} mm",
        observed=f"{result.zone_mm} mm",
        message=None if in_range else "QC zone outside the acceptable range",
    )


@dataclass
class QCStatus:
    satisfied: bool
    reason: str
    last_result_at: datetime | None = None


def qc_status(
    *,
    agent_code: str,
    method: Method,
    recent_results: list[QCResult],
    frequency: QCFrequency = QCFrequency.DAILY,
    now: datetime | None = None,
) -> QCStatus:
    """Whether QC currently permits reporting patient results for this agent.

    Daily QC must be in range within the last 24 hours; weekly QC within the
    last 7 days. An out-of-range most-recent result blocks reporting regardless
    of age - corrective action and repeat QC are required first.
    """
    now = now or datetime.now(UTC)
    window = timedelta(days=1) if frequency is QCFrequency.DAILY else timedelta(days=7)

    relevant = sorted(
        (
            r
            for r in recent_results
            if r.agent_code == agent_code
            and (Method.MIC if r.method.is_mic_like else r.method)
            == (Method.MIC if method.is_mic_like else method)
        ),
        key=lambda r: r.performed_at,
        reverse=True,
    )
    if not relevant:
        return QCStatus(False, f"No QC on record for {agent_code} ({method})")

    latest = relevant[0]
    if latest.outcome is QCOutcome.OUT_OF_RANGE:
        return QCStatus(
            False,
            "Most recent QC is out of range; perform corrective action and repeat QC "
            "before reporting patient results.",
            latest.performed_at,
        )
    if latest.outcome is QCOutcome.NOT_EVALUABLE:
        return QCStatus(False, "Most recent QC could not be evaluated.", latest.performed_at)

    age = now - latest.performed_at
    if age > window:
        return QCStatus(
            False,
            f"Last in-range QC was {age.days} day(s) ago, exceeding the "
            f"{frequency.value} requirement.",
            latest.performed_at,
        )
    return QCStatus(True, "QC in range and current.", latest.performed_at)


def weekly_conversion_eligible(
    results: list[QCResult],
    *,
    plan_days: int = 20,
    today: date | None = None,
) -> tuple[bool, str]:
    """Whether daily QC may be relaxed to weekly.

    CLSI permits converting to weekly QC after a documented study of 20 or 30
    consecutive test days with no more than one out-of-range result (none, for
    the 20-day plan).
    """
    if plan_days not in (20, 30):
        raise ValueError("plan_days must be 20 or 30")
    today = today or datetime.now(UTC).date()

    by_day: dict[date, list[QCResult]] = {}
    for r in results:
        by_day.setdefault(r.performed_at.astimezone(UTC).date(), []).append(r)

    days = sorted(by_day)[-plan_days:]
    if len(days) < plan_days:
        return False, f"Only {len(days)} of {plan_days} required test days documented."

    out_of_range_days = sum(
        1 for d in days if any(r.outcome is QCOutcome.OUT_OF_RANGE for r in by_day[d])
    )
    allowed = 0 if plan_days == 20 else 1
    if out_of_range_days > allowed:
        return False, (
            f"{out_of_range_days} out-of-range day(s) in the {plan_days}-day study; "
            f"at most {allowed} permitted."
        )
    if (today - days[-1]).days > 7:
        return False, "Conversion study is stale; the most recent QC is over a week old."
    return True, f"{plan_days}-day conversion study satisfied."
