"""Tier-3 automated data QC (SDD 6.4).

Runs on every upload, independently of whatever the uploader checked, because a
compromised or outdated client is exactly the case the server-side pass exists to
catch. Findings are recorded whatever their severity, so a batch that is accepted
still leaves a quality record behind.

Severity governs the batch lifecycle:

- ``ERROR``   — the batch cannot be trusted at all; it is rejected.
- ``WARNING`` — the batch is held for Data Steward review rather than accepted or
  discarded. Nothing is ever silently dropped or silently accepted (SDD 9.4).
- ``INFO``    — recorded on the facility's quality profile; does not block.

Every check states what it looks for and why that pattern matters, because a
finding a steward cannot interpret is a finding they will learn to ignore.
"""

from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from amrss.ingestion.payload import UploadPayload
from amrss.models.enums import OrganismKingdom, QcFindingSeverity, SirResult


@dataclass
class Finding:
    code: str
    severity: QcFindingSeverity
    message: str
    affected_record_count: int = 0
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass
class QcOutcome:
    findings: list[Finding]

    @property
    def has_error(self) -> bool:
        return any(f.severity is QcFindingSeverity.ERROR for f in self.findings)

    @property
    def has_warning(self) -> bool:
        return any(f.severity is QcFindingSeverity.WARNING for f in self.findings)


@dataclass(frozen=True)
class QcContext:
    """What the checks need to know beyond the payload itself."""

    known_organism_codes: set[str]
    known_antibiotic_codes: set[str]
    known_specimen_codes: set[str]
    #: Which kingdom each canonical agent is tested against, for the consistency
    #: check below.
    antibiotic_kingdoms: dict[str, OrganismKingdom]
    #: Source record hashes already accepted from this facility.
    existing_record_hashes: set[str]
    expected_whonet_config: str | None
    #: Mean accepted isolate count over this facility's recent batches, for the
    #: volume-change check. None when the facility has no history yet.
    recent_mean_isolate_count: float | None
    rules: dict[str, Any]
    today: date


def run(payload: UploadPayload, context: QcContext) -> QcOutcome:
    findings: list[Finding] = []
    isolates = payload.isolates

    if not isolates:
        return QcOutcome(
            [
                Finding(
                    code="EMPTY_BATCH",
                    severity=QcFindingSeverity.ERROR,
                    message="The batch contains no isolates.",
                )
            ]
        )

    findings.extend(_check_unmapped_codes(payload, context))
    findings.extend(_check_dates(payload, context))
    findings.extend(_check_duplicates(payload, context))
    findings.extend(_check_missing_ast(payload, context))
    findings.extend(_check_result_distribution(payload, context))
    findings.extend(_check_kingdom_consistency(payload, context))
    findings.extend(_check_whonet_config(payload, context))
    findings.extend(_check_volume_change(payload, context))

    return QcOutcome(findings)


#: Above this share of a batch, unmapped codes mean the facility's whole mapping
#: is wrong (a misconfigured export, the wrong column profile) and the batch is
#: held for review. At or below it they are a stray local code — a single agent
#: column, an unusual specimen — that must not freeze an otherwise good upload.
#: The affected rows are skipped and recorded, not silently accepted as success.
UNMAPPED_HOLD_FRACTION = 0.25


def _check_unmapped_codes(payload: UploadPayload, context: QcContext) -> list[Finding]:
    """Codes with no canonical mapping.

    An unmapped code is usually a legitimate new test or organism a Data Steward
    should map (SDD 3.4), not corrupt data — and its rows cannot enter an
    aggregate until it is mapped, because the alternative is silently combining
    incompatible codes. So its rows are always skipped, never guessed.

    What differs is whether the batch is *held*. Holding every batch that carries
    one stray local code makes routine uploading a chore, which is its own failure
    mode: people stop uploading. So the finding is proportionate — a wholesale
    mismatch (the wrong file, an unconfigured facility) still holds for review,
    but a small fraction flows through as INFO with the known data accepted and
    the unmapped codes recorded for mapping at leisure.
    """
    total_isolates = len(payload.isolates)
    total_results = sum(len(isolate.ast_results) for isolate in payload.isolates)

    unknown_organisms = Counter(
        isolate.organism_code
        for isolate in payload.isolates
        if isolate.organism_code not in context.known_organism_codes
    )
    unknown_specimens = Counter(
        isolate.specimen_type_code
        for isolate in payload.isolates
        if isolate.specimen_type_code not in context.known_specimen_codes
    )
    unknown_antibiotics = Counter(
        result.antibiotic_code
        for isolate in payload.isolates
        for result in isolate.ast_results
        if result.antibiotic_code not in context.known_antibiotic_codes
    )

    findings = []
    for code, unknown, label, denominator in (
        ("UNMAPPED_ORGANISM", unknown_organisms, "organism", total_isolates),
        ("UNMAPPED_SPECIMEN_TYPE", unknown_specimens, "specimen type", total_isolates),
        ("UNMAPPED_ANTIBIOTIC", unknown_antibiotics, "antibiotic", total_results),
    ):
        if not unknown:
            continue
        affected = sum(unknown.values())
        share = affected / denominator if denominator else 0.0
        holds = share > UNMAPPED_HOLD_FRACTION
        if holds:
            message = (
                f"{len(unknown)} {label} code(s), covering {affected} of {denominator} "
                "records, have no canonical mapping — too many to be a stray code. "
                "Check the WHONET column profile and map the codes before this data "
                "can contribute to any aggregate."
            )
        else:
            message = (
                f"{len(unknown)} {label} code(s) have no canonical mapping and were "
                "skipped; the rest of the batch was accepted. Map them in "
                "Administration to include them next time."
            )
        findings.append(
            Finding(
                code=code,
                severity=QcFindingSeverity.WARNING if holds else QcFindingSeverity.INFO,
                message=message,
                affected_record_count=affected,
                detail={"codes": dict(unknown.most_common(25))},
            )
        )
    return findings


def _check_dates(payload: UploadPayload, context: QcContext) -> list[Finding]:
    findings = []

    future = [i for i in payload.isolates if i.specimen_date > context.today]
    if future:
        findings.append(
            Finding(
                code="FUTURE_SPECIMEN_DATE",
                severity=QcFindingSeverity.ERROR,
                message="Specimen dates in the future indicate a clock or data-entry fault.",
                affected_record_count=len(future),
                detail={"latest": max(i.specimen_date for i in future).isoformat()},
            )
        )

    outside = [
        i
        for i in payload.isolates
        if not (payload.coverage_start <= i.specimen_date <= payload.coverage_end)
    ]
    if outside:
        findings.append(
            Finding(
                code="SPECIMEN_DATE_OUTSIDE_COVERAGE",
                severity=QcFindingSeverity.WARNING,
                message=(
                    "Isolates fall outside the coverage period the batch declares. The "
                    "declared period drives freshness and coverage reporting, so a "
                    "mismatch misstates what the data represents."
                ),
                affected_record_count=len(outside),
            )
        )
    return findings


def _check_duplicates(payload: UploadPayload, context: QcContext) -> list[Finding]:
    """Upload-level duplicate detection.

    Distinct from the antibiogram deduplication in SDD 5.3: this is the same
    source record arriving twice, not the same patient sampled twice.
    """
    findings = []

    within_batch = [
        hash_value
        for hash_value, count in Counter(i.source_record_hash for i in payload.isolates).items()
        if count > 1
    ]
    if within_batch:
        findings.append(
            Finding(
                code="DUPLICATE_RECORD_IN_BATCH",
                severity=QcFindingSeverity.WARNING,
                message="The same source record appears more than once in this batch.",
                affected_record_count=len(within_batch),
            )
        )

    repeated = [
        i for i in payload.isolates if i.source_record_hash in context.existing_record_hashes
    ]
    if repeated:
        rate = 100.0 * len(repeated) / len(payload.isolates)
        threshold = float(context.rules.get("max_duplicate_rate_percent", 5.0))
        findings.append(
            Finding(
                code="RECORD_ALREADY_ACCEPTED",
                severity=(
                    QcFindingSeverity.WARNING if rate > threshold else QcFindingSeverity.INFO
                ),
                message=(
                    f"{len(repeated)} record(s) ({rate:.1f}%) were already accepted from "
                    "this facility. Incremental sync should send only new records; a high "
                    "rate suggests the uploader's last-sync marker is wrong."
                ),
                affected_record_count=len(repeated),
                detail={"duplicate_rate_percent": round(rate, 1)},
            )
        )
    return findings


def _check_missing_ast(payload: UploadPayload, context: QcContext) -> list[Finding]:
    without_results = [i for i in payload.isolates if not i.ast_results]
    if not without_results:
        return []

    rate = 100.0 * len(without_results) / len(payload.isolates)
    threshold = float(context.rules.get("max_missing_ast_rate_percent", 20.0))
    return [
        Finding(
            code="ISOLATE_WITHOUT_AST",
            severity=QcFindingSeverity.WARNING if rate > threshold else QcFindingSeverity.INFO,
            message=(
                f"{len(without_results)} isolate(s) ({rate:.1f}%) carry no AST result. "
                "They count toward workload but contribute nothing to any antibiogram."
            ),
            affected_record_count=len(without_results),
            detail={"missing_ast_rate_percent": round(rate, 1)},
        )
    ]


def _check_result_distribution(payload: UploadPayload, context: QcContext) -> list[Finding]:
    """Statistically implausible uniformity.

    A large batch in which every result is susceptible, or every result is
    resistant, is far more often a data-mapping or export fault than a real
    finding — and if it is real, it is worth a human looking at it either way.
    """
    results = [
        r.result for i in payload.isolates for r in i.ast_results if r.result.is_interpretable
    ]
    minimum = int(context.rules.get("implausible_uniform_result_min_batch_size", 30))
    if len(results) < minimum:
        return []

    counts = Counter(results)
    dominant, dominant_count = counts.most_common(1)[0]
    if dominant_count != len(results) or dominant is SirResult.INTERMEDIATE:
        return []

    return [
        Finding(
            code="UNIFORM_RESULT_DISTRIBUTION",
            severity=QcFindingSeverity.WARNING,
            message=(
                f"All {len(results)} interpretable results in this batch are '{dominant.value}'. "
                "This is more often a mapping or export fault than a true finding."
            ),
            affected_record_count=len(results),
            detail={"uniform_result": dominant.value},
        )
    ]


def _check_kingdom_consistency(payload: UploadPayload, context: QcContext) -> list[Finding]:
    """An organism declared as one kingdom but carrying the other's agents.

    Antifungals reported against a bacterium, or antibacterials against a yeast,
    almost always mean the organism code was mapped wrongly — and the resulting
    figure would appear in an antibiogram that a clinician reads.
    """
    mismatched: Counter[str] = Counter()
    for isolate in payload.isolates:
        for result in isolate.ast_results:
            target = context.antibiotic_kingdoms.get(result.antibiotic_code)
            # Unmapped agents are reported by their own check, not twice here.
            if target is not None and target is not isolate.organism_kingdom:
                mismatched[f"{isolate.organism_code}/{result.antibiotic_code}"] += 1

    if not mismatched:
        return []

    return [
        Finding(
            code="ORGANISM_ANTIBIOTIC_KINGDOM_MISMATCH",
            severity=QcFindingSeverity.WARNING,
            message=(
                f"{sum(mismatched.values())} result(s) pair an organism with an agent "
                "intended for the other kingdom. This usually means an organism or "
                "antibiotic code is mapped wrongly."
            ),
            affected_record_count=sum(mismatched.values()),
            detail={"combinations": dict(mismatched.most_common(25))},
        )
    ]


def _check_whonet_config(payload: UploadPayload, context: QcContext) -> list[Finding]:
    expected = context.expected_whonet_config
    if expected is None or payload.whonet_config_version == expected:
        return []
    return [
        Finding(
            code="WHONET_CONFIG_MISMATCH",
            severity=QcFindingSeverity.WARNING,
            message=(
                f"The batch declares WHONET configuration "
                f"'{payload.whonet_config_version}' but the regional block's standard is "
                f"'{expected}'. Flagged for Data Steward resolution rather than accepted "
                "or rejected outright (SDD 3.5)."
            ),
            detail={"declared": payload.whonet_config_version, "expected": expected},
        )
    ]


def _check_volume_change(payload: UploadPayload, context: QcContext) -> list[Finding]:
    baseline = context.recent_mean_isolate_count
    if baseline is None or baseline < 1:
        return []

    ratio = len(payload.isolates) / baseline
    threshold = float(context.rules.get("volume_change_warning_ratio", 3.0))
    if 1 / threshold <= ratio <= threshold:
        return []

    return [
        Finding(
            code="UNUSUAL_BATCH_VOLUME",
            severity=QcFindingSeverity.WARNING,
            message=(
                f"This batch contains {len(payload.isolates)} isolates against a recent "
                f"average of {baseline:.0f}. Flagged for review, not corrected."
            ),
            affected_record_count=len(payload.isolates),
            detail={"ratio": round(ratio, 2), "recent_mean": round(baseline, 1)},
        )
    ]
