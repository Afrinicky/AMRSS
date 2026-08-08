"""Below-threshold alerts for organisms of special importance (SDD 5.2).

The general antibiogram threshold exists so no unreliable percentage is presented
as reportable. But a single carbapenem-resistant isolate is worth knowing about
even though one isolate supports no percentage at all. This module surfaces those
observations in a channel that is *structurally* separate from the antibiogram —
different endpoint, different type, different section of the interface — so
small-number findings can never migrate into a table that implies they were
statistically qualified.

The organism list is configuration held on ``canonical_organism``, maintained by
the regional AMR team. Nothing here names an organism.
"""

import uuid
from dataclasses import dataclass
from datetime import date

from amrss.analytics.methodology import MethodologySet
from amrss.analytics.records import IsolateRecord
from amrss.analytics.statistics import SusceptibilitySummary, summarise
from amrss.models.enums import SirResult


@dataclass(frozen=True)
class BelowThresholdAlert:
    organism_id: uuid.UUID
    antibiotic_id: uuid.UUID
    summary: SusceptibilitySummary
    first_seen: date
    last_seen: date
    facility_count: int
    #: Below the reporting threshold that would qualify this for the antibiogram.
    #: Always true here — the type exists for observations the antibiogram
    #: deliberately excludes.
    below_reporting_threshold: bool = True

    @property
    def non_susceptible_count(self) -> int:
        return self.summary.resistant + self.summary.non_susceptible

    @property
    def caveat(self) -> str:
        return (
            f"Based on {self.summary.interpretable} isolate(s) — below the reporting "
            "threshold. For situational awareness only; not a susceptibility rate."
        )


def detect(
    records: list[IsolateRecord],
    methodology: MethodologySet,
    organism_ids_of_interest: set[uuid.UUID],
    *,
    verified_only: bool = True,
) -> list[BelowThresholdAlert]:
    """Find non-susceptible results in watched organisms that the antibiogram omits.

    Deduplication is deliberately *not* applied. The antibiogram counts patients
    because it estimates a rate; an alert counts detections because the question
    is whether the organism is present at all. Suppressing a repeat isolate here
    would hide a persistent colonisation that is exactly what warrants review.
    """
    minimum = methodology.minimum_isolates

    grouped: dict[tuple[uuid.UUID, uuid.UUID], list[tuple[SirResult, date, uuid.UUID]]] = {}
    for record in records:
        if record.organism_id not in organism_ids_of_interest:
            continue
        if verified_only and not record.quality_verified:
            continue
        for antibiotic_id, result in record.results.items():
            grouped.setdefault((record.organism_id, antibiotic_id), []).append(
                (result, record.specimen_date, record.facility_id)
            )

    alerts: list[BelowThresholdAlert] = []
    for (organism_id, antibiotic_id), entries in grouped.items():
        summary = summarise([entry[0] for entry in entries])
        if summary.interpretable >= minimum:
            continue  # Qualified for the antibiogram; it belongs there, not here.
        non_susceptible = summary.resistant + summary.non_susceptible
        if non_susceptible == 0:
            continue

        dates = [entry[1] for entry in entries]
        alerts.append(
            BelowThresholdAlert(
                organism_id=organism_id,
                antibiotic_id=antibiotic_id,
                summary=summary,
                first_seen=min(dates),
                last_seen=max(dates),
                facility_count=len({entry[2] for entry in entries}),
            )
        )

    alerts.sort(key=lambda alert: (-alert.non_susceptible_count, alert.last_seen))
    return alerts
