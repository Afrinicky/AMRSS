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


def test_regional_administrator_is_the_single_overall_authority():
    """The regional AMR administrator absorbed the former system administrator:
    one role now holds both regional surveillance oversight and platform-wide
    account and system administration."""
    admin = principal(Role.REGIONAL_AMR_ADMINISTRATOR)

    # Regional oversight.
    assert admin.has(Permission.VIEW_REGIONAL)
    assert admin.has(Permission.ENROLL_FACILITY)
    assert admin.has(Permission.MANAGE_METHODOLOGY)
    # Acts on the ground too: uploads, QC attestation and data stewardship, so
    # one authority covers the whole pipeline (it can perform every operational
    # role, not only oversee them).
    assert admin.has(Permission.UPLOAD_SUBMIT)
    assert admin.has(Permission.QC_ATTEST)
    assert admin.has(Permission.REVIEW_MAPPING)
    assert admin.has(Permission.MANAGE_DICTIONARY)
    # Platform administration, formerly the system administrator's.
    assert admin.has(Permission.MANAGE_USERS)
    assert admin.has(Permission.SYSTEM_ADMIN)
    # The one irreversible authority: clearing data to begin a new cycle.
    assert admin.has(Permission.PURGE_DATA)


def test_purge_data_is_held_only_by_the_overall_authorities():
    """Deleting facilities or wiping the dataset is irreversible, so no other
    role — not even a data steward who retracts batches — can reach it.

    Two roles hold it, at two levels: the regional administrator inside its own
    block, and the national superadmin everywhere. Scope, not this permission,
    is what keeps the first from reaching the second's range.
    """
    holders = {role for role in Role if Permission.PURGE_DATA in permissions_for(role)}

    assert holders == {Role.REGIONAL_AMR_ADMINISTRATOR, Role.SUPERADMIN}


def test_the_auditor_holds_the_audit_trail_and_nothing_else():
    """The separation that matters is the auditor's, and it runs one way.

    The auditor must hold *no* operational permission, so the account examining
    the administration cannot also perform it. It was never the converse — that
    nobody else may read the trail — and asserting that would have made the
    national authority the one role unable to review its own programme. Reading
    is not tampering: the trail is append-only and hash-chained at the database,
    so a superadmin who reads it still cannot alter it (see test_audit_chain).
    """
    assert permissions_for(Role.AUDITOR) == frozenset({Permission.READ_AUDIT})

    readers = {role for role in Role if Permission.READ_AUDIT in permissions_for(role)}
    assert readers == {Role.AUDITOR, Role.SUPERADMIN}


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
