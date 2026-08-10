"""The rules that stop account administration becoming privilege escalation.

Every test here describes a way an account could gain authority nobody granted
it, or a way the platform could end up with nobody able to administer it. These
are pure checks over the rule functions; the database round trip is covered by
the integration pass.
"""

import uuid

import pytest
from fastapi import HTTPException

from amrss.api.routers import users as user_admin
from amrss.models import AppUser
from amrss.models.enums import Role
from amrss.security.permissions import Permission, permissions_for
from amrss.security.scope import Principal

FACILITY_A = uuid.UUID("00000000-0000-0000-0000-0000000000c1")
FACILITY_B = uuid.UUID("00000000-0000-0000-0000-0000000000c2")


def principal(role: Role, *, facility_id=None, user_id=None) -> Principal:
    return Principal(
        user_id=user_id or uuid.uuid4(),
        email="admin@example.test",
        full_name="Test Administrator",
        role=role,
        facility_id=facility_id,
        regional_block_id=None,
    )


def account(role: Role, *, facility_id=None, user_id=None) -> AppUser:
    user = AppUser(
        email="user@example.test",
        full_name="Test User",
        password_hash="x",
        role=role,
        facility_id=facility_id,
        is_active=True,
    )
    user.id = user_id or uuid.uuid4()
    return user


SYSTEM_ADMIN = Role.SYSTEM_ADMINISTRATOR
FACILITY_ADMIN = Role.FACILITY_ADMINISTRATOR


class TestWhoMayAdministerAccounts:
    def test_only_two_roles_can_reach_this_router(self):
        """Widening this is how account creation quietly leaks into a clinical
        role. SDD 7 keeps technical and clinical authority apart."""
        able = {
            role
            for role in Role
            if any(p in permissions_for(role) for p in user_admin.USER_ADMIN_PERMISSIONS)
        }
        assert able == {SYSTEM_ADMIN, FACILITY_ADMIN}

    def test_a_regional_administrator_cannot_manage_accounts(self):
        with pytest.raises(HTTPException) as caught:
            user_admin.manages_users(principal(Role.REGIONAL_AMR_ADMINISTRATOR))
        assert caught.value.status_code == 403

    def test_a_system_administrator_holds_no_surveillance_permission(self):
        """The other half of the same separation: managing accounts must not be
        a route to reading patient-derived data."""
        held = permissions_for(SYSTEM_ADMIN)
        assert Permission.VIEW_REGIONAL not in held
        assert Permission.VIEW_CROSS_FACILITY not in held
        assert Permission.VIEW_OWN_FACILITY not in held


class TestFacilityAdministratorsAreContained:
    """Rule 1. The smallest administrative role must not be able to mint a
    larger one, nor reach across facilities."""

    def test_they_reach_their_own_facility(self):
        admin = principal(FACILITY_ADMIN, facility_id=FACILITY_A)
        assert user_admin._may_manage(admin, account(Role.LABORATORY_STAFF, facility_id=FACILITY_A))

    def test_they_do_not_reach_another_facility(self):
        admin = principal(FACILITY_ADMIN, facility_id=FACILITY_A)
        other = account(Role.LABORATORY_STAFF, facility_id=FACILITY_B)
        assert not user_admin._may_manage(admin, other)
        with pytest.raises(HTTPException) as caught:
            user_admin._assert_may_manage(admin, other)
        # 404, not 403: confirming the account exists is itself a disclosure.
        assert caught.value.status_code == 404

    def test_they_do_not_reach_an_unscoped_account(self):
        """A regional or system account has no facility, so a facility
        administrator must never match one by both sides being None."""
        admin = principal(FACILITY_ADMIN, facility_id=FACILITY_A)
        assert not user_admin._may_manage(admin, account(SYSTEM_ADMIN))
        assert not user_admin._may_manage(admin, account(Role.CLINICIAN))

    @pytest.mark.parametrize("role", [Role.LABORATORY_STAFF, Role.FACILITY_ADMINISTRATOR])
    def test_they_may_grant_facility_roles(self, role):
        user_admin._assert_may_grant(principal(FACILITY_ADMIN, facility_id=FACILITY_A), role)

    @pytest.mark.parametrize(
        "role",
        [
            Role.SYSTEM_ADMINISTRATOR,
            Role.REGIONAL_AMR_ADMINISTRATOR,
            Role.DATA_STEWARD,
            Role.CLINICIAN,
            Role.AUDITOR,
        ],
    )
    def test_they_may_not_grant_anything_wider(self, role):
        with pytest.raises(HTTPException) as caught:
            user_admin._assert_may_grant(principal(FACILITY_ADMIN, facility_id=FACILITY_A), role)
        assert caught.value.status_code == 403

    def test_a_system_administrator_may_grant_every_role(self):
        for role in Role:
            user_admin._assert_may_grant(principal(SYSTEM_ADMIN), role)


class TestNobodyEditsThemselves:
    """Rule 2. A privilege change with nobody else in the loop is a privilege
    change nobody reviewed."""

    def test_changing_your_own_role_is_refused(self):
        me = uuid.uuid4()
        with pytest.raises(HTTPException) as caught:
            user_admin._assert_not_self(
                principal(SYSTEM_ADMIN, user_id=me), account(SYSTEM_ADMIN, user_id=me), "demote"
            )
        assert caught.value.status_code == 409

    def test_changing_someone_else_is_allowed(self):
        user_admin._assert_not_self(principal(SYSTEM_ADMIN), account(Role.CLINICIAN), "demote")


class TestScopeMatchesRole:
    def test_a_facility_role_needs_a_facility(self):
        with pytest.raises(HTTPException) as caught:
            user_admin._resolve_scope(
                None, principal(SYSTEM_ADMIN), Role.LABORATORY_STAFF, None, None
            )
        assert caught.value.status_code == 422

    def test_a_regional_role_needs_a_block(self):
        with pytest.raises(HTTPException) as caught:
            user_admin._resolve_scope(None, principal(SYSTEM_ADMIN), Role.CLINICIAN, None, None)
        assert caught.value.status_code == 422

    def test_a_system_administrator_carries_neither(self):
        facility, block = user_admin._resolve_scope(
            None, principal(SYSTEM_ADMIN), SYSTEM_ADMIN, FACILITY_A, uuid.uuid4()
        )
        assert (facility, block) == (None, None)

    def test_a_facility_administrators_users_land_at_their_own_facility(self, monkeypatch):
        """Whatever the request said. Trusting the submitted facility would let
        a facility administrator place a user at a neighbouring laboratory."""

        class _Db:
            def get(self, *_args):
                return object()

        facility, block = user_admin._resolve_scope(
            _Db(),
            principal(FACILITY_ADMIN, facility_id=FACILITY_A),
            Role.LABORATORY_STAFF,
            FACILITY_B,
            None,
        )
        assert facility == FACILITY_A
        assert block is None


class TestTheLastAdministratorSurvives:
    """Rule 3. Reaching zero here means the platform can only be administered
    from a database shell, which is a recovery procedure and not an operating
    model."""

    class _Db:
        def __init__(self, remaining: int) -> None:
            self.remaining = remaining

        def scalar(self, *_args):
            return self.remaining

    def test_deactivating_the_last_one_is_refused(self):
        with pytest.raises(HTTPException) as caught:
            user_admin._assert_not_last_user_admin(
                self._Db(0), account(SYSTEM_ADMIN), deactivating=True
            )
        assert caught.value.status_code == 409

    def test_demoting_the_last_one_is_refused(self):
        with pytest.raises(HTTPException) as caught:
            user_admin._assert_not_last_user_admin(
                self._Db(0), account(SYSTEM_ADMIN), becoming=Role.CLINICIAN
            )
        assert caught.value.status_code == 409

    def test_deactivating_one_of_several_is_allowed(self):
        user_admin._assert_not_last_user_admin(
            self._Db(1), account(SYSTEM_ADMIN), deactivating=True
        )

    def test_a_role_change_that_keeps_the_authority_is_allowed(self):
        """Moving the last system administrator to facility administrator keeps
        someone able to manage users, so it is not a lockout."""
        user_admin._assert_not_last_user_admin(
            self._Db(0), account(SYSTEM_ADMIN), becoming=FACILITY_ADMIN
        )

    def test_an_account_without_the_authority_is_unaffected(self):
        user_admin._assert_not_last_user_admin(
            self._Db(0), account(Role.CLINICIAN), deactivating=True
        )


def test_the_password_floor_is_shared_with_the_login_path():
    """Two different minimums would mean a password an administrator can set
    but its owner cannot replace."""
    from amrss.api.routers import auth

    assert auth.MIN_PASSWORD_LENGTH == user_admin.MIN_PASSWORD_LENGTH
