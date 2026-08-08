"""Resolution of versioned methodology parameters (ADR-0003).

No threshold, window length or trigger value appears as a literal anywhere in the
analytics engine. Every one is read from ``methodology_version``, and the version
that supplied it is stamped onto the result so a number computed today remains
explicable after the rule is later tuned.

Parameter shapes are documented here, next to the typed accessors that read them,
rather than in a separate document that would drift.
"""

import uuid
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from amrss.models import MethodologyVersion
from amrss.models.enums import MethodologyComponent


class MethodologyNotConfiguredError(RuntimeError):
    """Raised when a required rule set is absent.

    The engine refuses to compute rather than falling back to a built-in default.
    A silent default is precisely the failure ADR-0003 exists to prevent: it would
    produce a plausible-looking statistic whose provenance is a lie.
    """

    def __init__(self, component: MethodologyComponent, as_of: date) -> None:
        super().__init__(
            f"No {component.value} methodology version is effective on {as_of.isoformat()}. "
            "Seed or approve one before computing statistics."
        )
        self.component = component


@dataclass(frozen=True)
class ResolvedMethodology:
    """One effective rule set, with the identity needed for provenance."""

    id: uuid.UUID
    component: MethodologyComponent
    version: str
    description: str
    is_provisional: bool
    parameters: dict[str, Any]

    def require(self, key: str) -> Any:
        if key not in self.parameters:
            raise MethodologyNotConfiguredError(self.component, date.today())
        return self.parameters[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.parameters.get(key, default)


@dataclass
class MethodologySet:
    """Every rule set applicable to one computation, resolved once.

    Held together rather than resolved per-call so that a single antibiogram
    cannot mix rule versions partway through, and so provenance reflects exactly
    what was applied.
    """

    as_of: date
    regional_block_id: uuid.UUID | None
    _resolved: dict[MethodologyComponent, ResolvedMethodology] = field(default_factory=dict)

    def __getitem__(self, component: MethodologyComponent) -> ResolvedMethodology:
        try:
            return self._resolved[component]
        except KeyError:
            raise MethodologyNotConfiguredError(component, self.as_of) from None

    def get(self, component: MethodologyComponent) -> ResolvedMethodology | None:
        return self._resolved.get(component)

    @property
    def components(self) -> dict[MethodologyComponent, ResolvedMethodology]:
        return dict(self._resolved)

    # ---- Typed accessors -------------------------------------------------
    #
    # Each documents the parameter shape it expects. Callers use these rather
    # than reaching into ``parameters`` so a shape change breaks in one place.

    @property
    def minimum_isolates(self) -> int:
        """CLSI M39 reporting threshold, ``antibiogram.minimum_isolates``.

        The general-antibiogram cut-off below which an organism-antibiotic
        combination is not reported at all (SDD 5.1).
        """
        return int(self[MethodologyComponent.ANTIBIOGRAM].require("minimum_isolates"))

    @property
    def confidence_level(self) -> float:
        """``antibiogram.confidence_level`` — used for the interval shown where n
        clears the threshold but remains modest (SDD 5.7)."""
        return float(self[MethodologyComponent.ANTIBIOGRAM].get("confidence_level", 0.95))

    @property
    def modest_n_ceiling(self) -> int:
        """``antibiogram.modest_n_ceiling`` — at or below this n the interface is
        expected to show an explicit uncertainty cue alongside the percentage."""
        return int(self[MethodologyComponent.ANTIBIOGRAM].get("modest_n_ceiling", 100))

    @property
    def dedup_window_days(self) -> int:
        """``deduplication.window_days`` — the first-isolate window (SDD 5.3)."""
        return int(self[MethodologyComponent.DEDUPLICATION].require("window_days"))

    @property
    def dedup_scope(self) -> str:
        """``deduplication.scope`` — ``facility`` or ``block``.

        Only ``facility`` is meaningful while linkage keys are salted per
        facility (ADR-0004): the same patient at two facilities produces two
        unrelated keys, so block-scoped deduplication cannot in fact link them.
        """
        return str(self[MethodologyComponent.DEDUPLICATION].get("scope", "facility"))

    @property
    def small_cell_threshold(self) -> int:
        """``suppression.small_cell_threshold`` — the n below which any
        cross-facility breakdown displays as "insufficient data", independent of
        the antibiogram reporting threshold (SDD 3.2)."""
        return int(self[MethodologyComponent.SUPPRESSION].require("small_cell_threshold"))

    @property
    def signal_baseline_days(self) -> int:
        return int(
            self[MethodologyComponent.EMERGING_SIGNAL_TRIGGER].require("baseline_window_days")
        )

    @property
    def signal_current_days(self) -> int:
        return int(
            self[MethodologyComponent.EMERGING_SIGNAL_TRIGGER].require("current_window_days")
        )

    @property
    def signal_minimum_n(self) -> int:
        """Each window must independently clear this n before any comparison is
        made at all (SDD 5.4)."""
        return int(
            self[MethodologyComponent.EMERGING_SIGNAL_TRIGGER].require("minimum_n_per_window")
        )

    @property
    def signal_threshold_points(self) -> float:
        return float(
            self[MethodologyComponent.EMERGING_SIGNAL_TRIGGER].require(
                "change_threshold_percentage_points"
            )
        )

    @property
    def phenotype_rules(self) -> list[dict[str, Any]]:
        """``phenotype_flags.rules`` — see amrss.analytics.phenotype for shape."""
        component = self.get(MethodologyComponent.PHENOTYPE_FLAGS)
        if component is None:
            return []
        return list(component.get("rules", []))

    @property
    def breakpoint_standard(self) -> str:
        component = self.get(MethodologyComponent.AST_BREAKPOINTS)
        if component is None:
            return "not recorded"
        return str(component.get("label", component.version))


def resolve(
    db: Session,
    *,
    as_of: date | None = None,
    regional_block_id: uuid.UUID | None = None,
    components: list[MethodologyComponent] | None = None,
) -> MethodologySet:
    """Load the rule sets effective on ``as_of``.

    A version scoped to a regional block wins over an unscoped one, which lets a
    block adopt a different threshold or WHONET standard without forking the
    platform. Among equally-scoped candidates the latest effective date wins.
    """
    as_of = as_of or date.today()
    wanted = components or list(MethodologyComponent)

    rows = db.scalars(
        select(MethodologyVersion)
        .where(
            MethodologyVersion.component.in_(wanted),
            MethodologyVersion.effective_from <= as_of,
            or_(
                MethodologyVersion.effective_until.is_(None),
                MethodologyVersion.effective_until >= as_of,
            ),
            or_(
                MethodologyVersion.regional_block_id.is_(None),
                MethodologyVersion.regional_block_id == regional_block_id,
            ),
        )
        .order_by(
            MethodologyVersion.component,
            # Block-specific before global, then most recently effective.
            MethodologyVersion.regional_block_id.is_(None),
            MethodologyVersion.effective_from.desc(),
        )
    ).all()

    result = MethodologySet(as_of=as_of, regional_block_id=regional_block_id)
    for row in rows:
        if row.component in result._resolved:
            continue
        result._resolved[row.component] = ResolvedMethodology(
            id=row.id,
            component=row.component,
            version=row.version,
            description=row.description,
            is_provisional=row.is_provisional,
            parameters=dict(row.parameters),
        )
    return result
