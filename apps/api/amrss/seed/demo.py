"""Demo regional block with synthetic surveillance data.

Development and pilot use only. The isolates here are generated, not real: no
patient data of any kind is committed to this repository.

The generator deliberately produces conditions the platform must handle
correctly, rather than a uniformly clean dataset that would let bugs hide:

- a facility whose EQA has lapsed, so quality gating has something to exclude;
- a facility that has never uploaded and one that is overdue, so coverage
  reporting has something to flag;
- organism-antibiotic combinations that fall below the reporting threshold, and
  others below the suppression threshold, so both display states appear;
- repeat isolates from the same patient, so deduplication measurably changes the
  numbers;
- one combination whose susceptibility falls sharply in recent weeks, so signal
  detection has something to find.
"""

import hashlib
import random
import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from amrss.models import (
    AppUser,
    AstResult,
    CanonicalAntibiotic,
    CanonicalOrganism,
    CanonicalSpecimenType,
    District,
    EqaRecord,
    Facility,
    Isolate,
    QcAttestation,
    RegionalBlock,
    UploadBatch,
)
from amrss.models.enums import (
    AgeBand,
    BatchStatus,
    CareSetting,
    EqaStatus,
    FacilityStatus,
    QcStatus,
    Role,
    Sex,
    SirResult,
    UploadSchedule,
)
from amrss.security.passwords import hash_password

BLOCK_CODE = "AHA"
BLOCK_NAME = "Ahafo"
GOVERNING_BODY = "Ahafo Regional AMR Committee"

DISTRICTS = [
    "Asunafo North",
    "Asunafo South",
    "Asutifi North",
    "Asutifi South",
    "Tano North",
    "Tano South",
]

#: (facility code, name, district index, status, qc, eqa, schedule, weeks since last upload)
FACILITIES = [
    ("AHA-001", "Regional Hospital Laboratory", 4, FacilityStatus.ACTIVE, True, True, 0),
    ("AHA-002", "Mission Hospital Laboratory", 0, FacilityStatus.ACTIVE, True, True, 0),
    ("AHA-003", "District Hospital Laboratory A", 1, FacilityStatus.ACTIVE, True, True, 1),
    ("AHA-004", "District Hospital Laboratory B", 2, FacilityStatus.ACTIVE, True, True, 0),
    # EQA lapsed — data continues to arrive but is excluded from the verified aggregate.
    ("AHA-005", "District Hospital Laboratory C", 3, FacilityStatus.ACTIVE, True, False, 1),
    # Overdue: last accepted upload well beyond its weekly schedule.
    ("AHA-006", "District Hospital Laboratory D", 5, FacilityStatus.ACTIVE, True, True, 6),
    # Enrolled but not yet contributing.
    ("AHA-007", "Health Centre Laboratory", 0, FacilityStatus.UNDER_VERIFICATION, False, False, 0),
]

DEMO_PASSWORD = "AmrssDemo!2026"

USERS = [
    ("clinician@amrss.local", "Demo Clinician", Role.CLINICIAN, None),
    (
        "amr.admin@amrss.local",
        "Demo Regional AMR Administrator",
        Role.REGIONAL_AMR_ADMINISTRATOR,
        None,
    ),
    ("steward@amrss.local", "Demo Data Steward", Role.DATA_STEWARD, None),
    ("auditor@amrss.local", "Demo Auditor", Role.AUDITOR, None),
    ("sysadmin@amrss.local", "Demo System Administrator", Role.SYSTEM_ADMINISTRATOR, None),
    ("lab@amrss.local", "Demo Laboratory Scientist", Role.LABORATORY_STAFF, "AHA-001"),
    (
        "facility.admin@amrss.local",
        "Demo Facility Administrator",
        Role.FACILITY_ADMINISTRATOR,
        "AHA-001",
    ),
]

#: Baseline susceptibility by organism and agent, as a probability of S. Chosen to
#: resemble plausible West African surveillance patterns so that the demo exercises
#: realistic display states, not to represent any actual measured resistance.
PROFILES: dict[str, dict[str, float]] = {
    "eco": {
        "AMP": 0.12,
        "AMC": 0.42,
        "TZP": 0.78,
        "CRO": 0.34,
        "CAZ": 0.38,
        "FEP": 0.45,
        "MEM": 0.94,
        "ETP": 0.92,
        "GEN": 0.55,
        "AMK": 0.88,
        "CIP": 0.31,
        "SXT": 0.22,
        "NIT": 0.83,
        "CHL": 0.51,
    },
    "kpn": {
        "AMP": 0.02,
        "AMC": 0.30,
        "TZP": 0.62,
        "CRO": 0.28,
        "CAZ": 0.31,
        "FEP": 0.40,
        "MEM": 0.88,
        "ETP": 0.85,
        "GEN": 0.48,
        "AMK": 0.82,
        "CIP": 0.35,
        "SXT": 0.25,
        "NIT": 0.44,
        "CHL": 0.46,
    },
    "sau": {
        "PEN": 0.08,
        "FOX": 0.68,
        "ERY": 0.55,
        "CLI": 0.66,
        "GEN": 0.74,
        "CIP": 0.63,
        "SXT": 0.79,
        "TCY": 0.61,
        "VAN": 0.99,
        "LNZ": 0.99,
        "CHL": 0.72,
    },
    "pae": {
        "TZP": 0.71,
        "CAZ": 0.68,
        "FEP": 0.70,
        "MEM": 0.76,
        "IPM": 0.74,
        "GEN": 0.62,
        "AMK": 0.81,
        "CIP": 0.64,
        "COL": 0.97,
    },
    "aba": {
        "TZP": 0.34,
        "CAZ": 0.30,
        "FEP": 0.32,
        "MEM": 0.41,
        "IPM": 0.43,
        "GEN": 0.38,
        "AMK": 0.52,
        "CIP": 0.29,
        "SXT": 0.36,
        "COL": 0.95,
    },
    "efa": {
        "AMP": 0.86,
        "PEN": 0.80,
        "GEN": 0.63,
        "CIP": 0.52,
        "VAN": 0.96,
        "LNZ": 0.98,
        "NIT": 0.88,
    },
    "efm": {"AMP": 0.21, "GEN": 0.40, "CIP": 0.24, "VAN": 0.88, "LNZ": 0.97},
    "spn": {"PEN": 0.74, "CRO": 0.88, "ERY": 0.61, "SXT": 0.38, "CHL": 0.83, "LVX": 0.93},
    "pmi": {
        "AMP": 0.44,
        "AMC": 0.62,
        "CRO": 0.58,
        "GEN": 0.66,
        "CIP": 0.49,
        "SXT": 0.35,
        "MEM": 0.95,
    },
    "sal": {"AMP": 0.52, "CRO": 0.86, "CIP": 0.71, "SXT": 0.48, "CHL": 0.69},
    "cal": {"FLU": 0.91, "VOR": 0.95, "CAS": 0.97, "MIF": 0.97, "AMB": 0.99, "FCY": 0.93},
    "cgl": {"FLU": 0.38, "VOR": 0.72, "CAS": 0.93, "MIF": 0.94, "AMB": 0.97, "FCY": 0.90},
    "ctr": {"FLU": 0.76, "VOR": 0.88, "CAS": 0.95, "MIF": 0.95, "AMB": 0.98},
    "cne": {"FLU": 0.89, "VOR": 0.96, "AMB": 0.98, "FCY": 0.91},
}

#: Relative frequency of each organism among isolates.
ORGANISM_WEIGHTS = {
    "eco": 26,
    "kpn": 18,
    "sau": 15,
    "pae": 9,
    "aba": 6,
    "efa": 5,
    "efm": 3,
    "spn": 4,
    "pmi": 4,
    "sal": 3,
    "cal": 4,
    "cgl": 2,
    "ctr": 1,
    "cne": 1,
}

SPECIMEN_WEIGHTS = {
    "ur": 30,
    "bl": 20,
    "ws": 18,
    "pu": 10,
    "sp": 8,
    "st": 5,
    "hv": 4,
    "csf": 2,
    "ti": 2,
    "pf": 1,
}

#: The deliberate emerging signal: susceptibility of this pairing collapses in the
#: most recent weeks so signal detection has a true positive to find.
SIGNAL_ORGANISM = "kpn"
SIGNAL_ANTIBIOTIC = "CRO"
SIGNAL_RECENT_SUSCEPTIBILITY = 0.09
SIGNAL_WINDOW_DAYS = 28


def _weighted_choice(rng: random.Random, weights: dict[str, int]) -> str:
    population = list(weights)
    return rng.choices(population, weights=[weights[key] for key in population], k=1)[0]


def _linkage_key(facility_code: str, patient_number: int) -> bytes:
    """Stand-in for the uploader's Argon2id linkage key.

    The demo uses a fast digest because it generates tens of thousands of records
    and the real KDF is intentionally slow. Production keys are always computed by
    the uploader using the parameters in the linkage_hash methodology version.
    """
    return hashlib.sha256(f"demo:{facility_code}:{patient_number}".encode()).digest()[:32]


def build_demo_block(db: Session) -> None:
    if db.scalar(select(RegionalBlock).where(RegionalBlock.code == BLOCK_CODE)) is not None:
        return

    rng = random.Random(20260808)
    today = date.today()
    now = datetime.now(UTC)

    block = RegionalBlock(
        code=BLOCK_CODE,
        name=BLOCK_NAME,
        governing_body=GOVERNING_BODY,
        status="active",
        activated_at=today - timedelta(days=400),
        whonet_config_standard="2026.1",
    )
    db.add(block)
    db.flush()

    districts = [District(regional_block_id=block.id, name=name) for name in DISTRICTS]
    db.add_all(districts)
    db.flush()

    facilities: dict[str, Facility] = {}
    for code, name, district_index, status, qc_ok, eqa_ok, weeks_since in FACILITIES:
        last_upload = (
            None if status is not FacilityStatus.ACTIVE else now - timedelta(weeks=weeks_since)
        )
        facility = Facility(
            district_id=districts[district_index].id,
            code=code,
            name=name,
            status=status,
            whonet_config_version="2026.1",
            qc_status=QcStatus.SATISFACTORY if qc_ok else QcStatus.NOT_SUBMITTED,
            qc_valid_until=today + timedelta(days=60) if qc_ok else None,
            eqa_status=EqaStatus.SATISFACTORY if eqa_ok else EqaStatus.UNSATISFACTORY,
            eqa_valid_until=today + timedelta(days=200) if eqa_ok else today - timedelta(days=30),
            upload_schedule=UploadSchedule.WEEKLY,
            last_accepted_upload_at=last_upload,
            mou_signed_on=today - timedelta(days=380),
            mou_reference=f"MOU/{code}/2025",
        )
        db.add(facility)
        facilities[code] = facility
    db.flush()

    password_hash = hash_password(DEMO_PASSWORD)
    for email, full_name, role, facility_code in USERS:
        db.add(
            AppUser(
                email=email,
                full_name=full_name,
                password_hash=password_hash,
                role=role,
                facility_id=facilities[facility_code].id if facility_code else None,
                regional_block_id=None if facility_code else block.id,
            )
        )

    organisms = {o.code: o for o in db.scalars(select(CanonicalOrganism)).all()}
    antibiotics = {a.code: a for a in db.scalars(select(CanonicalAntibiotic)).all()}
    specimens = {s.code: s for s in db.scalars(select(CanonicalSpecimenType)).all()}

    signal_cutoff = today - timedelta(days=SIGNAL_WINDOW_DAYS)
    contributing = [
        code for code, _, _, status, _, _, _ in FACILITIES if status is FacilityStatus.ACTIVE
    ]

    for facility_code in contributing:
        facility = facilities[facility_code]
        _generate_facility_data(
            db,
            rng=rng,
            facility=facility,
            organisms=organisms,
            antibiotics=antibiotics,
            specimens=specimens,
            today=today,
            now=now,
            signal_cutoff=signal_cutoff,
        )

        db.add(
            QcAttestation(
                facility_id=facility.id,
                period_start=today - timedelta(days=30),
                period_end=today,
                status=facility.qc_status,
                submitted_at=now - timedelta(days=3),
                notes="Demo attestation.",
            )
        )
        db.add(
            EqaRecord(
                facility_id=facility.id,
                provider="Demo EQA Provider",
                panel="Bacteriology AST Panel 2026-1",
                assessment_date=today - timedelta(days=120),
                valid_until=facility.eqa_valid_until,
                performance=facility.eqa_status,
                result="Demo result",
                expected_result="Demo expected result",
                corrective_action=(
                    None
                    if facility.eqa_status is EqaStatus.SATISFACTORY
                    else "Repeat panel scheduled; retraining in progress."
                ),
            )
        )

    db.commit()


def _generate_facility_data(
    db: Session,
    *,
    rng: random.Random,
    facility: Facility,
    organisms: dict[str, CanonicalOrganism],
    antibiotics: dict[str, CanonicalAntibiotic],
    specimens: dict[str, CanonicalSpecimenType],
    today: date,
    now: datetime,
    signal_cutoff: date,
) -> None:
    """Generate a year of weekly batches for one facility."""
    weeks = 52
    # The regional hospital runs a far larger laboratory than a district one; equal
    # volumes would make every facility look interchangeable.
    weekly_volume = 40 if facility.code == "AHA-001" else rng.randint(8, 18)
    patient_pool = weekly_volume * weeks

    for week_index in range(weeks):
        week_end = today - timedelta(days=7 * (weeks - week_index - 1))
        week_start = week_end - timedelta(days=6)
        if week_start > today:
            continue

        batch = UploadBatch(
            facility_id=facility.id,
            uploaded_at=datetime.combine(week_end, datetime.min.time(), tzinfo=UTC),
            record_count=0,
            checksum=uuid.uuid4().hex + uuid.uuid4().hex[:32],
            payload_bytes=0,
            status=BatchStatus.ACCEPTED,
            uploader_version="0.1.0",
            whonet_config_version="2026.1",
            ast_breakpoint_standard="CLSI M100 2026",
            coverage_start=week_start,
            coverage_end=week_end,
        )
        db.add(batch)
        db.flush()

        count = max(1, int(rng.gauss(weekly_volume, weekly_volume * 0.25)))
        for _ in range(count):
            organism_code = _weighted_choice(rng, ORGANISM_WEIGHTS)
            organism = organisms.get(organism_code)
            if organism is None:
                continue
            specimen = specimens[_weighted_choice(rng, SPECIMEN_WEIGHTS)]

            specimen_date = week_start + timedelta(days=rng.randint(0, 6))
            if specimen_date > today:
                specimen_date = today

            # A tenth of records reuse a recent patient number, producing the repeat
            # isolates deduplication is supposed to collapse.
            patient_number = (
                rng.randint(1, max(1, patient_pool // 10))
                if rng.random() < 0.10
                else rng.randint(1, patient_pool)
            )

            iso_year, iso_week, _ = specimen_date.isocalendar()
            isolate = Isolate(
                facility_id=facility.id,
                upload_batch_id=batch.id,
                specimen_date=specimen_date,
                specimen_iso_year=iso_year,
                specimen_iso_week=iso_week,
                age_band=rng.choice(list(AgeBand)[:-1]),
                sex=rng.choice([Sex.MALE, Sex.FEMALE]),
                care_setting=rng.choices(
                    [CareSetting.INPATIENT, CareSetting.OUTPATIENT], weights=[45, 55]
                )[0],
                canonical_specimen_type_id=specimen.id,
                canonical_organism_id=organism.id,
                organism_kingdom=organism.kingdom,
                patient_linkage_key=_linkage_key(facility.code, patient_number),
                source_record_hash=uuid.uuid4().hex,
            )
            db.add(isolate)
            db.flush()

            profile = PROFILES.get(organism_code, {})
            for antibiotic_code, susceptible_probability in profile.items():
                antibiotic = antibiotics.get(antibiotic_code)
                if antibiotic is None:
                    continue
                # Not every agent is set up on every isolate.
                if rng.random() < 0.12:
                    continue

                probability = susceptible_probability
                if (
                    organism_code == SIGNAL_ORGANISM
                    and antibiotic_code == SIGNAL_ANTIBIOTIC
                    and specimen_date >= signal_cutoff
                ):
                    probability = SIGNAL_RECENT_SUSCEPTIBILITY

                roll = rng.random()
                if roll < 0.02:
                    result = SirResult.NOT_INTERPRETABLE
                elif roll < probability:
                    result = SirResult.SUSCEPTIBLE
                elif roll < probability + 0.06:
                    result = SirResult.INTERMEDIATE
                else:
                    result = SirResult.RESISTANT

                db.add(
                    AstResult(
                        isolate_id=isolate.id,
                        canonical_antibiotic_id=antibiotic.id,
                        result=result,
                        test_method="disk_diffusion",
                    )
                )

            batch.record_count += 1
            batch.accepted_isolate_count += 1
