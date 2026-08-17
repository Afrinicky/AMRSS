"""Deleting data actually deletes it, in the right order, and nothing else.

The purge routines run bulk deletes across a foreign-key graph that is not
declared ``ON DELETE CASCADE``, so a wrong order raises rather than orphans —
which is the safe failure, but still a failure. These tests exercise the real
graph against PostgreSQL: they build a small block, purge it, and check both
that the data is gone and that the things a purge must preserve — user accounts,
the dictionary, regional blocks, and above all the append-only audit trail —
survive.

A minimal hand-built graph rather than the demonstration seed: the seed
generates tens of thousands of isolates, and the ordering these tests guard does
not need volume to be exercised. Skipped without a database, like the other
integration checks; CI runs against Postgres. Everything runs inside a
transaction that is rolled back, so the shared CI database is left untouched.
"""

import os
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from amrss import audit
from amrss.admin import purge
from amrss.audit import AuditAction
from amrss.models import (
    AppUser,
    AstResult,
    AuditLog,
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
    AntimicrobialClass,
    EqaStatus,
    OrganismKingdom,
    QcStatus,
    Role,
    SirResult,
)
from amrss.security.passwords import hash_password

DATABASE_URL = os.environ.get("AMRSS_DATABASE_URL")


def _build_block(db: Session) -> tuple[Facility, AppUser, AppUser]:
    """A single facility with two isolates, an attached lab user, a regional
    administrator, quality records and an audit entry. Enough to exercise every
    branch of the delete graph without seeding a full demonstration block."""
    block = RegionalBlock(code="TST", name="Test Block", governing_body="Test", status="active")
    db.add(block)
    db.flush()
    district = District(regional_block_id=block.id, name="Test District")
    db.add(district)
    db.flush()
    facility = Facility(district_id=district.id, code="F1", name="Test Lab")
    db.add(facility)

    organism = CanonicalOrganism(code="eco", name="E. coli", kingdom=OrganismKingdom.BACTERIA)
    antibiotic = CanonicalAntibiotic(
        code="AMP",
        name="Ampicillin",
        antimicrobial_class=AntimicrobialClass.PENICILLIN,
        target_kingdom=OrganismKingdom.BACTERIA,
    )
    specimen = CanonicalSpecimenType(code="ur", name="Urine", infection_site="urine")
    db.add_all([organism, antibiotic, specimen])
    db.flush()

    lab_user = AppUser(
        email="lab@test.example",
        full_name="Lab User",
        password_hash=hash_password("x" * 12),
        role=Role.LABORATORY_STAFF,
        facility_id=facility.id,
    )
    regional_admin = AppUser(
        email="admin@test.example",
        full_name="Regional Admin",
        password_hash=hash_password("x" * 12),
        role=Role.REGIONAL_AMR_ADMINISTRATOR,
        regional_block_id=block.id,
    )
    db.add_all([lab_user, regional_admin])

    batch = UploadBatch(
        facility_id=facility.id,
        uploaded_at=datetime.now(UTC),
        checksum="0" * 64,
        uploader_version="0.1.0",
    )
    db.add(batch)
    db.flush()

    for index in range(2):
        isolate = Isolate(
            facility_id=facility.id,
            upload_batch_id=batch.id,
            specimen_date=date(2026, 1, 1),
            specimen_iso_year=2026,
            specimen_iso_week=1,
            canonical_specimen_type_id=specimen.id,
            canonical_organism_id=organism.id,
            organism_kingdom=OrganismKingdom.BACTERIA,
            patient_linkage_key=bytes(32),
            source_record_hash=f"hash{index}",
        )
        db.add(isolate)
        db.flush()
        db.add(
            AstResult(
                isolate_id=isolate.id,
                canonical_antibiotic_id=antibiotic.id,
                result=SirResult.SUSCEPTIBLE,
            )
        )

    db.add(
        QcAttestation(
            facility_id=facility.id,
            period_start=date(2026, 1, 1),
            period_end=date(2026, 1, 31),
            status=QcStatus.SATISFACTORY,
            submitted_at=datetime.now(UTC),
        )
    )
    db.add(
        EqaRecord(
            facility_id=facility.id,
            provider="Test",
            panel="Bacteriology",
            assessment_date=date(2026, 1, 1),
            performance=EqaStatus.SATISFACTORY,
        )
    )
    audit.record(
        db,
        action=AuditAction.FACILITY_ENROLLED,
        entity="facility",
        entity_id=facility.id,
        actor_label="test",
        after={"code": "F1"},
    )
    db.flush()
    return facility, lab_user, regional_admin


@pytest.fixture
def db() -> Session:
    if not DATABASE_URL:
        pytest.skip("AMRSS_DATABASE_URL is not set; purge tests need a live database")
    engine = create_engine(DATABASE_URL)
    try:
        connection = engine.connect()
    except OperationalError as exc:  # pragma: no cover - environment-dependent
        pytest.skip(f"database unreachable: {exc}")
    # Bind to an outer transaction rolled back at teardown so nothing persists;
    # create_savepoint keeps the purge routines' own commit() calls inside it.
    transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


def test_deleting_a_facility_removes_its_data_and_detaches_its_users(db: Session) -> None:
    facility, lab_user, _ = _build_block(db)

    counts = purge.delete_facility(db, facility)

    assert counts["facilities"] == 1
    assert counts["isolates"] == 2
    assert counts["ast_results"] == 2
    assert counts["accounts_detached"] == 1
    assert db.get(Facility, facility.id) is None
    assert db.scalar(select(func.count(Isolate.id)).where(Isolate.facility_id == facility.id)) == 0
    assert (
        db.scalar(select(func.count(UploadBatch.id)).where(UploadBatch.facility_id == facility.id))
        == 0
    )
    # The account remains — attributable — but detached and unable to sign in.
    db.refresh(lab_user)
    assert lab_user.facility_id is None
    assert lab_user.is_active is False


def test_reset_surveillance_keeps_the_roster_but_clears_the_data(db: Session) -> None:
    facility, _, _ = _build_block(db)

    counts = purge.reset_surveillance(db, include_facilities=False)

    assert counts["isolates"] == 2
    assert db.scalar(select(func.count(Isolate.id))) == 0
    assert db.scalar(select(func.count(UploadBatch.id))) == 0
    # The facility remains, reset to a pre-upload state.
    db.refresh(facility)
    assert db.get(Facility, facility.id) is not None
    assert facility.last_accepted_upload_at is None
    assert facility.qc_status is QcStatus.NOT_SUBMITTED


def test_reset_everything_removes_facilities_but_preserves_configuration(db: Session) -> None:
    _build_block(db)
    users_before = db.scalar(select(func.count(AppUser.id)))
    organisms_before = db.scalar(select(func.count(CanonicalOrganism.id)))
    blocks_before = db.scalar(select(func.count(RegionalBlock.id)))

    counts = purge.reset_surveillance(db, include_facilities=True)

    assert counts["facilities"] == 1
    assert counts["districts"] == 1
    assert db.scalar(select(func.count(Facility.id))) == 0
    assert db.scalar(select(func.count(District.id))) == 0
    # Configuration and identities the next cycle is built on are untouched.
    assert db.scalar(select(func.count(AppUser.id))) == users_before
    assert db.scalar(select(func.count(CanonicalOrganism.id))) == organisms_before
    assert db.scalar(select(func.count(RegionalBlock.id))) == blocks_before


def test_a_purge_never_touches_the_audit_trail(db: Session) -> None:
    """The record of what happened outlives the data it describes."""
    _build_block(db)
    audit_before = db.scalar(select(func.count(AuditLog.id)))
    assert audit_before > 0

    purge.reset_surveillance(db, include_facilities=True)

    assert db.scalar(select(func.count(AuditLog.id))) == audit_before


def test_deleting_a_user_keeps_the_audit_trail_and_reattributes_by_label(db: Session) -> None:
    """A deleted account leaves the trail intact: the row survives, its actor_id
    is cleared by the cascade, and the actor stays named in actor_label."""
    from amrss import audit as audit_mod
    from amrss.audit import AuditAction
    from amrss.security.scope import principal_from_user

    _, _, regional_admin = _build_block(db)
    # A second admin so the deleted one is not the last user-admin.
    keeper = AppUser(
        email="keeper@test.example",
        full_name="Keeper",
        password_hash=hash_password("x" * 12),
        role=Role.REGIONAL_AMR_ADMINISTRATOR,
    )
    db.add(keeper)
    db.flush()
    audit_mod.record(
        db,
        action=AuditAction.LOGIN_SUCCEEDED,
        entity="app_user",
        entity_id=regional_admin.id,
        principal=principal_from_user(regional_admin),
    )
    db.flush()
    entry_id = db.scalar(select(AuditLog.id).where(AuditLog.actor_id == regional_admin.id))
    label_before = db.scalar(select(AuditLog.actor_label).where(AuditLog.id == entry_id))
    audit_total = db.scalar(select(func.count(AuditLog.id)))

    counts = purge.delete_user(db, regional_admin)

    assert counts["users"] == 1
    assert db.get(AppUser, regional_admin.id) is None
    # The audit entry is untouched except that its FK pointer is cleared.
    assert db.scalar(select(func.count(AuditLog.id))) == audit_total
    row = db.get(AuditLog, entry_id)
    assert row.actor_id is None
    assert row.actor_label == label_before


def test_deleting_an_empty_district_and_block(db: Session) -> None:
    block = RegionalBlock(code="EMP", name="Empty Block", governing_body="x", status="active")
    db.add(block)
    db.flush()
    district = District(regional_block_id=block.id, name="Empty District")
    db.add(district)
    db.flush()

    assert purge.delete_district(db, district)["districts"] == 1
    assert db.get(District, district.id) is None
    assert purge.delete_region(db, block)["regional_blocks"] == 1
    assert db.get(RegionalBlock, block.id) is None
