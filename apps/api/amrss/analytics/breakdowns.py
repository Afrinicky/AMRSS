"""Susceptibility broken down by a dimension other than organism-antibiotic.

The antibiogram answers "how susceptible is this organism to this agent". The
drill-down views ask the follow-up question: *where* — which districts, which
specimen types, inpatients or outpatients (SDD 11.2). Same statistic, different
grouping.

One rule governs every function here, and it is the reason they are not written
inline at each call site: **the reporting threshold and the suppression
threshold are independent gates, and both apply to every stratum.** Splitting a
reportable total into four groups produces four smaller numbers, and at least
one of them is usually too small to publish. A breakdown that silently reports
those anyway takes a figure that passed the threshold once and republishes its
fragments as though each had passed on its own.

Groups that fail either gate are returned with a state and no percentage rather
than omitted, so a reader can see that a stratum exists and was withheld — the
same discipline the antibiogram cell states enforce.
"""

import uuid
from collections.abc import Callable, Hashable
from dataclasses import dataclass
from enum import StrEnum
from typing import TypeVar

from amrss.analytics.deduplication import deduplicate
from amrss.analytics.methodology import MethodologySet
from amrss.analytics.records import IsolateRecord
from amrss.analytics.statistics import SusceptibilitySummary, summarise
from amrss.models.enums import SirResult

K = TypeVar("K", bound=Hashable)


class GroupState(StrEnum):
    """Why a stratum does or does not carry a percentage.

    Mirrors the antibiogram cell states deliberately: a reader who has learned
    what "below threshold" means in the table should not have to learn a second
    vocabulary in the breakdown beside it.
    """

    REPORTABLE = "reportable"
    BELOW_THRESHOLD = "below_threshold"
    SUPPRESSED = "suppressed"


@dataclass(frozen=True)
class Group:
    """One stratum of a breakdown."""

    key: Hashable
    state: GroupState
    #: Present only when the state is reportable. Withholding the counts too is
    #: deliberate for a suppressed group: releasing n while hiding the
    #: percentage leaks the same small cell.
    summary: SusceptibilitySummary | None = None
    confidence_lower: float | None = None
    confidence_upper: float | None = None
    #: Always present. How many isolates fell in this stratum is not itself a
    #: susceptibility rate, and hiding it would leave a reader unable to tell an
    #: empty stratum from a withheld one.
    isolate_count: int = 0

    @property
    def susceptible_percent(self) -> float | None:
        return self.summary.susceptible_percent if self.summary else None

    @property
    def interpretable(self) -> int | None:
        return self.summary.interpretable if self.summary else None


def _grade(
    values: list[SirResult],
    isolate_count: int,
    methodology: MethodologySet,
    *,
    apply_suppression: bool,
) -> tuple[GroupState, SusceptibilitySummary | None]:
    """Apply both gates in the order that makes the state honest.

    Suppression is checked first. A stratum small enough to identify someone
    must not be reported even if it happens to clear the reporting threshold —
    the two thresholds answer different questions (re-identification risk versus
    statistical stability) and the privacy one is not negotiable against the
    statistical one.
    """
    if apply_suppression and isolate_count < methodology.small_cell_threshold:
        return GroupState.SUPPRESSED, None

    summary = summarise(values)
    if summary.interpretable < methodology.minimum_isolates:
        return GroupState.BELOW_THRESHOLD, None
    return GroupState.REPORTABLE, summary


def by_dimension(
    records: list[IsolateRecord],
    methodology: MethodologySet,
    *,
    antibiotic_id: uuid.UUID,
    key_of: Callable[[IsolateRecord], K | None],
    organism_id: uuid.UUID | None = None,
    verified_only: bool = True,
    apply_suppression: bool = True,
) -> list[Group]:
    """Susceptibility to one agent, grouped by whatever ``key_of`` returns.

    Deduplicated, unlike the provenance figures: this *is* a susceptibility
    rate, so the first-isolate-per-patient rule applies exactly as it does in
    the antibiogram. A breakdown computed on raw isolates would disagree with
    the table it sits beside, and the reader would have no way to tell which was
    right.

    Records whose key is ``None`` are dropped rather than bucketed as "unknown":
    a stratum labelled unknown invites it to be read as a real one.
    """
    population = [
        record
        for record in records
        if (record.quality_verified or not verified_only)
        and (organism_id is None or record.organism_id == organism_id)
    ]
    retained, _ = deduplicate(
        population,
        window_days=methodology.dedup_window_days,
        scope=methodology.dedup_scope,
    )

    values: dict[K, list[SirResult]] = {}
    isolates: dict[K, int] = {}
    for record in retained:
        key = key_of(record)
        if key is None:
            continue
        isolates[key] = isolates.get(key, 0) + 1
        result = record.results.get(antibiotic_id)
        if result is not None:
            values.setdefault(key, []).append(result)

    groups: list[Group] = []
    for key, isolate_count in isolates.items():
        state, summary = _grade(
            values.get(key, []),
            isolate_count,
            methodology,
            apply_suppression=apply_suppression,
        )
        interval = summary.confidence_interval(methodology.confidence_level) if summary else None
        groups.append(
            Group(
                key=key,
                state=state,
                summary=summary,
                confidence_lower=interval.lower if interval else None,
                confidence_upper=interval.upper if interval else None,
                isolate_count=isolate_count,
            )
        )

    # Reportable strata first, then by size. A reader scanning the list should
    # meet the groups that carry a figure before the ones that do not.
    groups.sort(key=lambda group: (group.state is not GroupState.REPORTABLE, -group.isolate_count))
    return groups


def agent_profile_for_organism(
    records: list[IsolateRecord],
    methodology: MethodologySet,
    *,
    organism_id: uuid.UUID,
    verified_only: bool = True,
) -> list[Group]:
    """Every agent tested against one organism, keyed by antibiotic id.

    The organism's own row of the antibiogram, computed on its own so the
    drill-down cannot drift from the table: same deduplication, same thresholds,
    same states.
    """
    population = [
        record
        for record in records
        if record.organism_id == organism_id and (record.quality_verified or not verified_only)
    ]
    retained, _ = deduplicate(
        population,
        window_days=methodology.dedup_window_days,
        scope=methodology.dedup_scope,
    )

    values: dict[uuid.UUID, list[SirResult]] = {}
    for record in retained:
        for antibiotic_id, result in record.results.items():
            values.setdefault(antibiotic_id, []).append(result)

    groups: list[Group] = []
    for antibiotic_id, results in values.items():
        # Suppression does not apply to an organism-agent pair within a single
        # aggregate: that is the antibiogram cell itself, governed by the
        # reporting threshold. The suppression gate exists for cross-facility
        # *breakdowns*, which this is not.
        state, summary = _grade(results, len(retained), methodology, apply_suppression=False)
        interval = summary.confidence_interval(methodology.confidence_level) if summary else None
        groups.append(
            Group(
                key=antibiotic_id,
                state=state,
                summary=summary,
                confidence_lower=interval.lower if interval else None,
                confidence_upper=interval.upper if interval else None,
                isolate_count=len(results),
            )
        )

    groups.sort(key=lambda group: (group.state is not GroupState.REPORTABLE, group.key.__str__()))
    return groups


def organism_profile_for_agent(
    records: list[IsolateRecord],
    methodology: MethodologySet,
    *,
    antibiotic_id: uuid.UUID,
    verified_only: bool = True,
) -> list[Group]:
    """Every organism tested against one agent, keyed by organism id.

    The agent's column of the antibiogram. This is the view that makes a pooled
    agent figure interpretable: ampicillin at 30% susceptible across everything
    means something quite different once it is clear which organisms make up the
    30%.
    """
    return by_dimension(
        records,
        methodology,
        antibiotic_id=antibiotic_id,
        key_of=lambda record: record.organism_id,
        verified_only=verified_only,
        apply_suppression=False,
    )
