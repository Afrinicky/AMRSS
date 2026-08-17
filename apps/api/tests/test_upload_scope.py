"""Who a submitted batch is allowed to land against.

Laboratory staff upload for their own facility and nowhere else; the regional
authority may upload on behalf of any facility in its block, naming it in the
payload. These check the resolver that enforces that, against the real schema so
the facility→block lookup it relies on is exercised.

Skipped without a database, like the other integration checks. Everything runs
in a rolled-back transaction.
"""

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from amrss.api.routers.ingestion import _resolve_upload_facility
from amrss.models import District, Facility, RegionalBlock
from amrss.models.enums import Role
from amrss.security.scope import Principal

DATABASE_URL = os.environ.get("AMRSS_DATABASE_URL")


@pytest.fixture
def db() -> Session:
    if not DATABASE_URL:
        pytest.skip("AMRSS_DATABASE_URL is not set; upload-scope tests need a live database")
    engine = create_engine(DATABASE_URL)
    try:
        connection = engine.connect()
    except OperationalError as exc:  # pragma: no cover - environment-dependent
        pytest.skip(f"database unreachable: {exc}")
    transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


def _facility(db: Session, block_code: str, facility_code: str) -> Facility:
    block = RegionalBlock(
        code=block_code, name=block_code, governing_body="x", status="active"
    )
    db.add(block)
    db.flush()
    district = District(regional_block_id=block.id, name=f"D-{block_code}")
    db.add(district)
    db.flush()
    facility = Facility(district_id=district.id, code=facility_code, name=facility_code)
    db.add(facility)
    db.flush()
    return facility


def _regional_admin(block_id: uuid.UUID) -> Principal:
    return Principal(
        user_id=uuid.uuid4(),
        email="admin@test.example",
        full_name="Regional Admin",
        role=Role.REGIONAL_AMR_ADMINISTRATOR,
        facility_id=None,
        regional_block_id=block_id,
    )


def _lab_staff(facility_id: uuid.UUID) -> Principal:
    return Principal(
        user_id=uuid.uuid4(),
        email="lab@test.example",
        full_name="Lab",
        role=Role.LABORATORY_STAFF,
        facility_id=facility_id,
        regional_block_id=None,
    )


def test_a_regional_admin_uploads_for_any_facility_in_its_block(db: Session) -> None:
    facility = _facility(db, "B1", "F1")
    principal = _regional_admin(facility.regional_block_id)

    resolved = _resolve_upload_facility(db, principal, "F1")

    assert resolved.id == facility.id


def test_a_regional_admin_cannot_upload_outside_its_block(db: Session) -> None:
    _facility(db, "B1", "F1")
    other = _facility(db, "B2", "F2")
    principal = _regional_admin(other.regional_block_id)  # scoped to B2

    with pytest.raises(HTTPException) as caught:
        _resolve_upload_facility(db, principal, "F1")  # asks for B1's facility
    assert caught.value.status_code == 403


def test_lab_staff_must_match_their_own_facility(db: Session) -> None:
    facility = _facility(db, "B1", "F1")
    _facility(db, "B2", "F2")
    principal = _lab_staff(facility.id)

    assert _resolve_upload_facility(db, principal, "F1").id == facility.id
    with pytest.raises(HTTPException) as caught:
        _resolve_upload_facility(db, principal, "F2")
    assert caught.value.status_code == 403


def test_an_unknown_facility_code_is_a_404(db: Session) -> None:
    facility = _facility(db, "B1", "F1")
    principal = _regional_admin(facility.regional_block_id)

    with pytest.raises(HTTPException) as caught:
        _resolve_upload_facility(db, principal, "NOPE")
    assert caught.value.status_code == 404
