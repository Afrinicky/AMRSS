import uuid

import pytest

from amrss.models.enums import Role
from amrss.security.permissions import ROLE_PERMISSIONS, Permission, permissions_for
from amrss.security.scope import Principal

FACILITY_A = uuid.UUID("00000000-0000-0000-0000-0000000000c1")
FACILITY_B = uuid.UUID("00000000-0000-0000-0000-0000000000c2")
BLOCK = uuid.UUID("00000000-0000-0000-0000-0000000000f0")


def principal(role: Role, *, facility_id=None, regional_block_id=None) -> Principal:
    return Principal(
        user_id=uuid.uuid4(),
        email="user@example.test",
        full_name="Test User",
        role=role,
        facility_id=facility_id,
        regional_block_id=regional_block_id,
    )


def test_every_role_has_an_explicit_permission_set():
    """A role missing from the map would silently receive no permissions, which
    reads as a working deny but is actually an unreviewed omission."""
    assert set(ROLE_PERMISSIONS) == set(Role)


@pytest.mark.parametrize(
    "forbidden",
    [
        Permission.UPLOAD_SUBMIT,
        Permission.RETRACT_BATCH,
        Permission.MANAGE_DICTIONARY,
        Permission.MANAGE_QC_GATING,
        Permission.ENROLL_FACILITY,
        Permission.MANAGE_USERS,
    ],
)
def test_clinician_is_read_only(forbidden: Permission):
    """SDD 7: a clinician cannot upload, edit, modify QC, or administer anything."""
    assert not principal(Role.CLINICIAN).has(forbidden)


def test_clinician_can_view_regional_surveillance():
    assert principal(Role.CLINICIAN).has(Permission.VIEW_REGIONAL)


def test_auditor_reads_the_trail_and_holds_no_operational_permission():
    """Accountability has to be independent of the administration it examines."""
    auditor = permissions_for(Role.AUDITOR)

    assert auditor == frozenset({Permission.READ_AUDIT})


def test_system_administrator_has_no_surveillance_access():
    """Technical and clinical authority are deliberately separate."""
    sysadmin = principal(Role.SYSTEM_ADMINISTRATOR)

    assert not sysadmin.has(Permission.VIEW_REGIONAL)
    assert not sysadmin.has(Permission.VIEW_CROSS_FACILITY)
    assert not sysadmin.has(Permission.VIEW_OWN_FACILITY)


def test_only_the_auditor_reads_the_audit_trail():
    holders = {role for role in Role if Permission.READ_AUDIT in permissions_for(role)}

    assert holders == {Role.AUDITOR}


def test_facility_administrator_cannot_upload_or_edit_surveillance_data():
    facility_admin = principal(Role.FACILITY_ADMINISTRATOR, facility_id=FACILITY_A)

    assert not facility_admin.has(Permission.UPLOAD_SUBMIT)
    assert not facility_admin.has(Permission.RETRACT_BATCH)
    assert facility_admin.has(Permission.MANAGE_FACILITY_USERS)


def test_facility_scoped_user_cannot_read_another_facility():
    lab = principal(Role.LABORATORY_STAFF, facility_id=FACILITY_A)

    assert lab.may_read_facility(FACILITY_A)
    assert not lab.may_read_facility(FACILITY_B)


def test_only_the_owning_facility_sees_unsuppressed_cells():
    lab = principal(Role.LABORATORY_STAFF, facility_id=FACILITY_A)
    regional = principal(Role.REGIONAL_AMR_ADMINISTRATOR, regional_block_id=BLOCK)

    assert lab.sees_unsuppressed(FACILITY_A)
    assert not lab.sees_unsuppressed(FACILITY_B)
    # A regional administrator has the broadest view and still gets suppression:
    # breadth of access is what makes small-cell inference possible.
    assert not regional.sees_unsuppressed(FACILITY_A)


def test_regional_roles_may_read_across_facilities():
    steward = principal(Role.DATA_STEWARD, regional_block_id=BLOCK)

    assert steward.may_read_facility(FACILITY_A)
    assert steward.may_read_facility(FACILITY_B)
