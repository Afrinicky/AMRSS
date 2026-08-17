import gzip
import hashlib
import json
from datetime import UTC, date, datetime, timedelta

import pytest

from amrss.ingestion import qc, service
from amrss.ingestion.payload import UploadPayload
from amrss.models.enums import OrganismKingdom, QcFindingSeverity

TODAY = date(2026, 8, 8)


def isolate(
    index: int,
    *,
    organism: str = "eco",
    kingdom: OrganismKingdom = OrganismKingdom.BACTERIA,
    specimen: str = "ur",
    day_offset: int = 0,
    agents: list[tuple[str, str]] | None = None,
) -> dict:
    return {
        "source_record_hash": hashlib.sha256(f"record-{index}".encode()).hexdigest(),
        "patient_linkage_key": hashlib.sha256(f"patient-{index}".encode()).hexdigest(),
        "specimen_date": (TODAY - timedelta(days=day_offset)).isoformat(),
        "age_band": "15-44",
        "sex": "female",
        "care_setting": "OPD",
        "organism_code": organism,
        "organism_kingdom": kingdom.value,
        "specimen_type_code": specimen,
        "ast_results": [
            {"antibiotic_code": code, "result": result}
            for code, result in (agents or [("CIP", "R"), ("SXT", "S")])
        ],
    }


def payload(isolates: list[dict], **overrides) -> UploadPayload:
    document = {
        "payload_version": "1.0",
        "uploader_version": "0.1.0",
        "facility_code": "TEST-001",
        "whonet_config_version": "2026.1",
        "generated_at": datetime.now(UTC).isoformat(),
        "coverage_start": (TODAY - timedelta(days=7)).isoformat(),
        "coverage_end": TODAY.isoformat(),
        "isolates": isolates,
    }
    document.update(overrides)
    return UploadPayload.model_validate(document)


def context(**overrides) -> qc.QcContext:
    defaults = {
        "known_organism_codes": {"eco", "kpn", "cal"},
        "known_antibiotic_codes": {"CIP", "SXT", "MEM", "FLU"},
        "known_specimen_codes": {"ur", "bl"},
        "antibiotic_kingdoms": {
            "CIP": OrganismKingdom.BACTERIA,
            "SXT": OrganismKingdom.BACTERIA,
            "MEM": OrganismKingdom.BACTERIA,
            "FLU": OrganismKingdom.FUNGI,
        },
        "existing_record_hashes": set(),
        "expected_whonet_config": "2026.1",
        "recent_mean_isolate_count": None,
        "rules": {},
        "today": TODAY,
    }
    defaults.update(overrides)
    return qc.QcContext(**defaults)


def codes(outcome: qc.QcOutcome) -> set[str]:
    return {finding.code for finding in outcome.findings}


def test_clean_batch_raises_nothing():
    outcome = qc.run(payload([isolate(i, day_offset=i % 7) for i in range(20)]), context())

    assert outcome.findings == []
    assert not outcome.has_error
    assert not outcome.has_warning


def test_empty_batch_is_an_error():
    outcome = qc.run(payload([]), context())

    assert "EMPTY_BATCH" in codes(outcome)
    assert outcome.has_error


def test_future_specimen_date_is_an_error():
    """A clock or data-entry fault, not a finding worth reviewing."""
    future = isolate(1)
    future["specimen_date"] = (TODAY + timedelta(days=3)).isoformat()

    outcome = qc.run(payload([future]), context())

    assert "FUTURE_SPECIMEN_DATE" in codes(outcome)
    assert outcome.has_error


def test_wholesale_unmapped_organisms_hold_the_batch():
    """When most of a batch fails to map — the wrong file, an unconfigured
    facility — it is held for review rather than quietly accepted near-empty."""
    outcome = qc.run(payload([isolate(i, organism="unknown_code") for i in range(4)]), context())

    assert "UNMAPPED_ORGANISM" in codes(outcome)
    assert outcome.has_warning
    assert not outcome.has_error


def test_a_stray_unmapped_code_does_not_hold_the_batch():
    """One unusual code among many good isolates flows through as INFO, its rows
    skipped, so routine uploading is not a chore that stops people uploading."""
    isolates = [isolate(i, day_offset=i % 7) for i in range(20)]
    isolates.append(isolate(99, organism="unknown_code"))

    outcome = qc.run(payload(isolates), context())

    assert "UNMAPPED_ORGANISM" in codes(outcome)
    assert not outcome.has_warning  # INFO, not WARNING — the batch is accepted
    assert not outcome.has_error
    finding = next(f for f in outcome.findings if f.code == "UNMAPPED_ORGANISM")
    assert finding.severity is QcFindingSeverity.INFO


def test_approved_facility_mapping_stops_a_local_code_being_flagged():
    outcome = qc.run(
        payload([isolate(1, organism="LOCAL_ECOLI")]),
        context(known_organism_codes={"eco", "LOCAL_ECOLI"}),
    )

    assert "UNMAPPED_ORGANISM" not in codes(outcome)


def test_antifungal_against_a_bacterium_is_flagged():
    outcome = qc.run(
        payload([isolate(1, organism="eco", agents=[("FLU", "S")])]),
        context(),
    )

    assert "ORGANISM_ANTIBIOTIC_KINGDOM_MISMATCH" in codes(outcome)


def test_already_accepted_records_are_reported():
    existing = {hashlib.sha256(b"record-0").hexdigest()}
    outcome = qc.run(
        payload([isolate(i) for i in range(4)]), context(existing_record_hashes=existing)
    )

    assert "RECORD_ALREADY_ACCEPTED" in codes(outcome)


def test_duplicate_within_a_batch_is_flagged():
    entry = isolate(1)
    outcome = qc.run(payload([entry, dict(entry)]), context())

    assert "DUPLICATE_RECORD_IN_BATCH" in codes(outcome)


def test_uniformly_susceptible_large_batch_is_flagged_as_implausible():
    outcome = qc.run(
        payload(
            [isolate(i, day_offset=i % 7, agents=[("CIP", "S"), ("SXT", "S")]) for i in range(40)]
        ),
        context(rules={"implausible_uniform_result_min_batch_size": 30}),
    )

    assert "UNIFORM_RESULT_DISTRIBUTION" in codes(outcome)


def test_mixed_results_are_not_flagged_as_implausible():
    outcome = qc.run(
        payload([isolate(i, day_offset=i % 7) for i in range(40)]),
        context(rules={"implausible_uniform_result_min_batch_size": 30}),
    )

    assert "UNIFORM_RESULT_DISTRIBUTION" not in codes(outcome)


def test_whonet_config_mismatch_is_flagged_not_rejected():
    """SDD 3.5: flag non-conforming uploads rather than silently accepting or
    rejecting them."""
    outcome = qc.run(
        payload([isolate(1)], whonet_config_version="2024.2"),
        context(expected_whonet_config="2026.1"),
    )

    assert "WHONET_CONFIG_MISMATCH" in codes(outcome)
    assert not outcome.has_error


def test_sudden_volume_change_is_flagged_for_review():
    outcome = qc.run(
        payload([isolate(i, day_offset=i % 7) for i in range(60)]),
        context(recent_mean_isolate_count=10.0, rules={"volume_change_warning_ratio": 3.0}),
    )

    finding = next(f for f in outcome.findings if f.code == "UNUSUAL_BATCH_VOLUME")
    assert finding.severity is QcFindingSeverity.WARNING


def test_payload_rejects_a_direct_patient_identifier():
    """The schema is the security boundary: an unexpected key is refused, not
    quietly ignored. Silently dropping it would let a defective client transmit a
    patient name and receive a success response."""
    document = isolate(1)
    document["patient_name"] = "Test Patient"

    with pytest.raises(ValueError, match="patient_name"):
        payload([document])


def test_payload_rejects_the_same_agent_twice_on_one_isolate():
    with pytest.raises(ValueError, match="more than once"):
        payload([isolate(1, agents=[("CIP", "S"), ("CIP", "R")])])


def test_envelope_rejects_a_checksum_mismatch():
    body = gzip.compress(json.dumps({"payload_version": "1.0"}).encode())

    with pytest.raises(service.IngestionError, match="Checksum mismatch"):
        service.decode_envelope(body, "0" * 64, max_bytes=10_000_000)


def test_envelope_rejects_an_oversized_payload():
    body = gzip.compress(b"{}")

    with pytest.raises(service.IngestionError, match="maximum accepted size"):
        service.decode_envelope(body, hashlib.sha256(body).hexdigest(), max_bytes=1)


@pytest.mark.parametrize(
    ("declared", "minimum", "accepted"),
    [
        ("0.1.0", "0.1.0", True),
        ("0.2.0", "0.1.0", True),
        ("1.0.0", "0.9.9", True),
        ("0.0.9", "0.1.0", False),
        ("0.1.0", "0.2.0", False),
    ],
)
def test_uploader_version_gate(declared: str, minimum: str, accepted: bool):
    """SDD 8.4: an outdated client may carry de-identification logic a later
    release corrected, so its data would import the defect the fix addressed."""
    if accepted:
        service.check_uploader_version(declared, minimum)
    else:
        with pytest.raises(service.IngestionError, match="below the minimum"):
            service.check_uploader_version(declared, minimum)
