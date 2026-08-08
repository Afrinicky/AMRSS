"""First-isolate-per-patient-period deduplication (CLSI M39, SDD 5.3).

Why this exists: a patient sampled repeatedly during one infection episode — a
bacteraemia followed daily, say — contributes several isolates of the same
organism with near-identical susceptibility. Counting all of them lets a handful
of inpatients dominate a regional percentage. The M39 convention is to count each
patient once per organism per surveillance period.

Deduplication applies to antibiogram calculation only. Raw isolate counts remain
available separately for workload reporting, so "all isolates" and
"antibiogram-eligible isolates" are never conflated (SDD 5.3).
"""

import uuid
from collections import defaultdict
from dataclasses import dataclass

from amrss.analytics.records import IsolateRecord


@dataclass(frozen=True)
class DeduplicationReport:
    total_isolates: int
    retained_isolates: int
    window_days: int
    scope: str

    @property
    def removed_isolates(self) -> int:
        return self.total_isolates - self.retained_isolates

    def describe(self) -> dict[str, object]:
        return {
            "rule": "first isolate per patient per organism per period",
            "window_days": self.window_days,
            "scope": self.scope,
            "isolates_before": self.total_isolates,
            "isolates_after": self.retained_isolates,
            "repeat_isolates_removed": self.removed_isolates,
        }


def deduplicate(
    records: list[IsolateRecord], *, window_days: int, scope: str = "facility"
) -> tuple[list[IsolateRecord], DeduplicationReport]:
    """Retain the first isolate of each organism per patient per rolling window.

    The window rolls from each *retained* isolate, not from a fixed calendar
    boundary. A patient with isolates on days 0, 20 and 40 under a 30-day window
    yields days 0 and 40 — day 20 falls inside the window opened on day 0, and
    day 40 opens a new one. Fixed calendar periods would instead split the same
    episode across a month boundary and double-count it.

    Grouping always includes ``facility_id``. Linkage keys are salted per facility
    (ADR-0004), so the same patient at two facilities produces two unrelated keys;
    a block-scoped grouping would be a claim the data cannot support.
    """
    groups: dict[tuple[uuid.UUID, bytes, uuid.UUID], list[IsolateRecord]] = defaultdict(list)
    for record in records:
        groups[(record.facility_id, record.patient_linkage_key, record.organism_id)].append(record)

    retained: list[IsolateRecord] = []
    for group in groups.values():
        # Ties on date are broken by isolate id so the choice is deterministic;
        # two runs over the same data must produce the same antibiogram.
        group.sort(key=lambda r: (r.specimen_date, r.id))
        window_opened_on = None
        for record in group:
            if (
                window_opened_on is None
                or (record.specimen_date - window_opened_on).days >= window_days
            ):
                retained.append(record)
                window_opened_on = record.specimen_date

    retained.sort(key=lambda r: (r.specimen_date, r.id))
    return retained, DeduplicationReport(
        total_isolates=len(records),
        retained_isolates=len(retained),
        window_days=window_days,
        scope=scope,
    )
