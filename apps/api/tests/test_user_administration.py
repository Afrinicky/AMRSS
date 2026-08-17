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
BLOCK = uuid.UUID("00000000-0000-0000-0000-0000000000f0")


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


#: The single overall authority, which holds MANAGE_USERS platform-wide. It
#: absorbed the former system administrator, so these tests exercise it in that
#: role.
REGIONAL_ADMIN = Role.REGIONAL_AMR_ADMINISTRATOR
FACILITY_ADMIN = Role.FACILITY_ADMINISTRATOR


class TestWhoMayAdministerAccounts:
    def test_only_two_roles_can_reach_this_router(self):
        """Widening this is how account creation quietly leaks into a role that
        should not hand out logins. Only the overall authority and a facility
        administrator manage accounts."""
        able = {
            role
            for role in Role
            if any(p in permissions_for(role) for p in user_admin.USER_ADMIN_PERMISSIONS)
        }
        assert able == {REGIONAL_ADMIN, FACILITY_ADMIN}

    def test_the_regional_administrator_may_manage_accounts(self):
        """The merged authority manages every account; the guard lets it in."""
        assert user_admin.manages_users(principal(REGIONAL_ADMIN)) is not None

    def test_a_data_steward_cannot_manage_accounts(self):
        with pytest.raises(HTTPException) as caught:
            user_admin.manages_users(principal(Role.DATA_STEWARD))
        assert caught.value.status_code == 403

    def test_the_overall_authority_holds_surveillance_and_account_management(self):
        """The whole point of the merge: one role holds both regional oversight
        and platform administration, rather than the two being split across
        accounts."""
        held = permissions_for(REGIONAL_ADMIN)
        assert Permission.VIEW_REGIONAL in held
        assert Permission.MANAGE_USERS in held
        assert Permission.SYSTEM_ADMIN in held
        assert Permission.PURGE_DATA in held


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
        """A regional account has no facility, so a facility administrator must
        never match one by both sides being None."""
        admin = principal(FACILITY_ADMIN, facility_id=FACILITY_A)
        assert not user_admin._may_manage(admin, account(REGIONAL_ADMIN))
        assert not user_admin._may_manage(admin, account(Role.CLINICIAN))

    @pytest.mark.parametrize("role", [Role.LABORATORY_STAFF, Role.FACILITY_ADMINISTRATOR])
    def test_they_may_grant_facility_roles(self, role):
        user_admin._assert_may_grant(principal(FACILITY_ADMIN, facility_id=FACILITY_A), role)

    @pytest.mark.parametrize(
        "role",
        [
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

    def test_the_overall_authority_may_grant_every_role(self):
        for role in Role:
            user_admin._assert_may_grant(principal(REGIONAL_ADMIN), role)


class TestNobodyEditsThemselves:
    """Rule 2. A privilege change with nobody else in the loop is a privilege
    change nobody reviewed."""

    def test_changing_your_own_role_is_refused(self):
        me = uuid.uuid4()
        with pytest.raises(HTTPException) as caught:
            user_admin._assert_not_self(
                principal(REGIONAL_ADMIN, user_id=me),
                account(REGIONAL_ADMIN, user_id=me),
                "demote",
            )
        assert caught.value.status_code == 409

    def test_changing_someone_else_is_allowed(self):
        user_admin._assert_not_self(principal(REGIONAL_ADMIN), account(Role.CLINICIAN), "demote")


class TestScopeMatchesRole:
    def test_a_facility_role_needs_a_facility(self):
        with pytest.raises(HTTPException) as caught:
            user_admin._resolve_scope(
                None, principal(REGIONAL_ADMIN), Role.LABORATORY_STAFF, None, None
            )
        assert caught.value.status_code == 422

    def test_a_regional_role_needs_a_block(self):
        with pytest.raises(HTTPException) as caught:
            user_admin._resolve_scope(None, principal(REGIONAL_ADMIN), Role.CLINICIAN, None, None)
        assert caught.value.status_code == 422

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
                self._Db(0), account(REGIONAL_ADMIN), deactivating=True
            )
        assert caught.value.status_code == 409

    def test_demoting_the_last_one_is_refused(self):
        with pytest.raises(HTTPException) as caught:
            user_admin._assert_not_last_user_admin(
                self._Db(0), account(REGIONAL_ADMIN), becoming=Role.CLINICIAN
            )
        assert caught.value.status_code == 409

    def test_deactivating_one_of_several_is_allowed(self):
        user_admin._assert_not_last_user_admin(
            self._Db(1), account(REGIONAL_ADMIN), deactivating=True
        )

    def test_a_role_change_that_keeps_the_authority_is_allowed(self):
        """Moving the last overall administrator to facility administrator keeps
        someone able to manage users, so it is not a lockout."""
        user_admin._assert_not_last_user_admin(
            self._Db(0), account(REGIONAL_ADMIN), becoming=FACILITY_ADMIN
        )

    def test_an_account_without_the_authority_is_unaffected(self):
        user_admin._assert_not_last_user_admin(
            self._Db(0), account(Role.CLINICIAN), deactivating=True
        )


class TestUsernameValidation:
    """Usernames are normalised and bounded so a login handle cannot collide by
    case or be mistaken for an email address."""

    def test_blank_username_is_treated_as_absent(self):
        assert user_admin._normalise_username("   ") is None
        assert user_admin._normalise_username(None) is None

    def test_a_username_is_lower_cased(self):
        assert user_admin._normalise_username("J.Mensah") == "j.mensah"

    @pytest.mark.parametrize("handle", ["kwame", "j.mensah", "lab_01", "ward-3a"])
    def test_accepted_handles(self, handle):
        import re

        assert re.match(user_admin.USERNAME_PATTERN, handle)

    @pytest.mark.parametrize("handle", [".leading", "trailing.", "has space", "e@mail", ""])
    def test_rejected_handles(self, handle):
        import re

        assert not re.match(user_admin.USERNAME_PATTERN, handle)


def test_the_password_floor_is_shared_with_the_login_path():
    """Two different minimums would mean a password an administrator can set
    but its owner cannot replace."""
    from amrss.api.routers import auth

    assert auth.MIN_PASSWORD_LENGTH == user_admin.MIN_PASSWORD_LENGTH
