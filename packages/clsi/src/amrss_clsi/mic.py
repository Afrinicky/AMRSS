"""MIC values and the doubling-dilution series.

An MIC is not a plain number. Broth dilution only brackets the true value, so
results at the ends of the tested range are reported off-scale as "<= lowest
concentration tested" or "> highest concentration tested". Storing an MIC as a
float loses that distinction, and the distinction changes the interpretation:
"<=4" against a susceptible breakpoint of 2 is *not* susceptible, it is
uninterpretable, because the true MIC could be 4.

`MICValue` therefore keeps the operator and the concentration together, and
`Decimal` is used throughout so 0.12 and 0.06 compare exactly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import StrEnum


class MICOperator(StrEnum):
    EQ = "="
    LTE = "<="
    LT = "<"
    GTE = ">="
    GT = ">"


# CLSI reports these labels on panels even though the true concentrations are
# 0.0625 / 0.125; the label is what appears on the report, the value is what we
# compare with. Mapping both ways keeps imported panel data faithful.
_DILUTION_LABELS: dict[str, str] = {
    "0.06": "0.0625",
    "0.12": "0.125",
    "0.03": "0.03125",
    "0.015": "0.015625",
    "0.008": "0.0078125",
    "0.004": "0.00390625",
    "0.002": "0.001953125",
}

_MIC_PATTERN = re.compile(r"^\s*(?P<op><=|>=|=<|=>|<|>|=|≤|≥)?\s*(?P<value>\d+(?:\.\d+)?)\s*$")

_OPERATOR_ALIASES = {
    "≤": MICOperator.LTE,
    "=<": MICOperator.LTE,
    "<=": MICOperator.LTE,
    "≥": MICOperator.GTE,
    "=>": MICOperator.GTE,
    ">=": MICOperator.GTE,
    "<": MICOperator.LT,
    ">": MICOperator.GT,
    "=": MICOperator.EQ,
}


@dataclass(frozen=True, order=False)
class MICValue:
    """A reported MIC in µg/mL."""

    operator: MICOperator
    value: Decimal

    def __post_init__(self) -> None:
        if self.value <= 0:
            raise ValueError("MIC concentration must be positive")

    @classmethod
    def parse(cls, raw: str) -> MICValue:
        """Parse '<=0.25', '≥ 64', '2', '0.06' into an MICValue."""
        if not isinstance(raw, str):
            raise ValueError("MIC must be a string")
        match = _MIC_PATTERN.match(raw)
        if not match:
            raise ValueError(f"unparseable MIC: {raw!r}")
        op_text = match.group("op") or "="
        digits = match.group("value")
        try:
            value = Decimal(_DILUTION_LABELS.get(digits, digits))
        except InvalidOperation as exc:  # pragma: no cover - regex guards this
            raise ValueError(f"unparseable MIC concentration: {raw!r}") from exc
        return cls(operator=_OPERATOR_ALIASES[op_text], value=value)

    @property
    def is_off_scale_low(self) -> bool:
        return self.operator in (MICOperator.LTE, MICOperator.LT)

    @property
    def is_off_scale_high(self) -> bool:
        return self.operator in (MICOperator.GTE, MICOperator.GT)

    # --- Comparisons that respect off-scale semantics --------------------
    #
    # Each returns True only when the relationship holds for *every* true MIC
    # consistent with the reported value. When it cannot be decided, the
    # interpretation engine reports "indeterminate" rather than guessing.

    def definitely_at_most(self, threshold: Decimal) -> bool:
        """True if the real MIC is certainly <= threshold."""
        if self.operator in (MICOperator.EQ, MICOperator.LTE):
            return self.value <= threshold
        if self.operator == MICOperator.LT:
            # "<X" means the MIC is below X; certain only if X-1 dilution <= t,
            # which we approximate conservatively as value <= threshold.
            return self.value <= threshold
        return False  # >= or > can always exceed the threshold

    def definitely_at_least(self, threshold: Decimal) -> bool:
        """True if the real MIC is certainly >= threshold."""
        if self.operator in (MICOperator.EQ, MICOperator.GTE):
            return self.value >= threshold
        if self.operator == MICOperator.GT:
            return self.value >= threshold
        return False

    def definitely_below(self, threshold: Decimal) -> bool:
        """True if the real MIC is certainly < threshold."""
        if self.operator in (MICOperator.EQ, MICOperator.LTE, MICOperator.LT):
            return self.value < threshold
        return False

    def definitely_above(self, threshold: Decimal) -> bool:
        if self.operator in (MICOperator.EQ, MICOperator.GTE, MICOperator.GT):
            return self.value > threshold
        return False

    def __str__(self) -> str:
        op = "" if self.operator == MICOperator.EQ else str(self.operator)
        return f"{op}{_format_decimal(self.value)}"


def _format_decimal(value: Decimal) -> str:
    normalised = value.normalize()
    text = format(normalised, "f")
    # Re-apply the conventional panel labels on output.
    for label, exact in _DILUTION_LABELS.items():
        if Decimal(exact) == normalised:
            return label
    return text


def doubling_series(low: Decimal, high: Decimal) -> list[Decimal]:
    """Doubling-dilution concentrations from `low` to `high` inclusive."""
    if low <= 0 or high < low:
        raise ValueError("invalid dilution range")
    series: list[Decimal] = []
    current = low
    while current <= high:
        series.append(current)
        current = current * 2
    return series


def is_on_doubling_series(value: Decimal, *, reference: Decimal = Decimal("1")) -> bool:
    """Whether a concentration lies on the doubling series through `reference`.

    Used to sanity-check imported breakpoint tables: a susceptible breakpoint of
    "3 µg/mL" is almost always a transcription error.
    """
    if value <= 0:
        return False
    ratio = value / reference
    while ratio < 1:
        ratio *= 2
    while ratio > 1:
        if ratio % 2 != 0:
            return False
        ratio /= 2
    return ratio == 1
