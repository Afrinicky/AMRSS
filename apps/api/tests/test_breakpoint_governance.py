"""Who sets the thresholds, and who may depart from them.

One programme, one definition of resistance. A susceptible result at one
laboratory has to mean what it means at every other, or the national antibiogram
is an average of several different questions. So the breakpoint table is
national by default, and a facility that needs to depart from it needs a
documented exception rather than a quiet local edit.

Three things have to line up before a local edit is allowed, and each test here
removes exactly one of them.
"""

import uuid

import pytest
from fastapi import HTTPException

from amrss.api.routers import breakpoints as router
from amrss.models.enums import Role
from amrss.security import breakpoint_scope
from amrss.security.permissions import Permission, permissions_for
from amrss.security.scope import Principal

FACILITY = uuid.UUID("00000000-0000-0000-0000-0000000000c1")
OTHER_FACILITY = uuid.UUID("00000000-0000-0000-0000-0000000000c2")
BLOCK = uuid.UUID("00000000-0000-0000-0000-0000000000f0")
OTHER_BLOCK = uuid.UUID("00000000-0000-0000-0000-0000000000f1")


class _Facility:
    def __init__(self, granted: bool) -> None:
        self.breakpoint_override_granted = granted


class _Db:
    """Answers one question: does this facility hold an override?"""

    def __init__(self, granted: dict[uuid.UUID, bool] | None = None) -> None:
        self.granted = granted or {}

    def get(self, _model, identifier):
        if identifier not in self.granted:
            return None
        return _Facility(self.granted[identifier])


def principal(role: Role, *, facility_id=None, block_id=None) -> Principal:
    return Principal(
        user_id=uuid.uuid4(),
        email="someone@example.test",
        full_name="Someone",
        role=role,
        facility_id=facility_id,
        regional_block_id=block_id,
    )


class TestNationalAuthorityIsExclusive:
    """The three national permissions, and the fact that only one role holds
    them. Each would let a second authority define resistance differently."""

    @pytest.mark.parametrize(
        "permission",
        [
            Permission.CREATE_BLOCK,
            Permission.PUBLISH_NATIONAL_BREAKPOINTS,
            Permission.GRANT_BREAKPOINT_OVERRIDE,
        ],
    )
    def test_only_the_superadmin_holds_it(self, permission):
        holders = {role for role in Role if permission in permissions_for(role)}
        assert holders == {Role.SUPERADMIN}

    def test_regional_authority_is_bounded_rather_than_reduced(self):
        """The point of the split.

        A regional administrator did not lose its powers; it gained an edge. The
        three national permissions are the only *operational* ones it lacks —
        the other two gaps are structural rather than a demotion:

        - ``READ_AUDIT`` is the auditor's, held by nobody operational except the
          national authority (see test_access_control);
        - ``MANAGE_FACILITY_USERS`` is the facility administrator's narrower
          form of ``MANAGE_USERS``, which the regional role already holds.
        """
        regional = permissions_for(Role.REGIONAL_AMR_ADMINISTRATOR)
        missing = permissions_for(Role.SUPERADMIN) - regional

        assert missing == {
            Permission.CREATE_BLOCK,
            Permission.PUBLISH_NATIONAL_BREAKPOINTS,
            Permission.GRANT_BREAKPOINT_OVERRIDE,
            Permission.READ_AUDIT,
            Permission.MANAGE_FACILITY_USERS,
        }
        assert Permission.MANAGE_USERS in regional


class TestLocalEditingNeedsAllThree:
    def test_a_granted_facility_administrator_may_edit(self):
        resolved = breakpoint_scope.authority(
            _Db({FACILITY: True}),
            principal(Role.FACILITY_ADMINISTRATOR, facility_id=FACILITY),
        )
        assert resolved.may_edit_locally
        assert resolved.refusal == ""

    def test_without_the_grant_the_facility_reads_the_national_table(self):
        """The default, and the case that matters most: the permission is held,
        the scope is right, and the answer is still no."""
        resolved = breakpoint_scope.authority(
            _Db({FACILITY: False}),
            principal(Role.FACILITY_ADMINISTRATOR, facility_id=FACILITY),
        )
        assert not resolved.may_edit_locally
        assert "set nationally" in resolved.refusal

    def test_without_the_permission_the_grant_is_not_enough(self):
        """A grant is given to a facility, not to everyone who works there.
        Laboratory staff enter results; they do not redefine what an S is."""
        resolved = breakpoint_scope.authority(
            _Db({FACILITY: True}),
            principal(Role.LABORATORY_STAFF, facility_id=FACILITY),
        )
        assert not resolved.may_edit_locally
        assert "does not edit breakpoint tables" in resolved.refusal

    def test_without_the_scope_another_facilitys_grant_is_not_usable(self):
        """One facility's exception must not become another administrator's
        editing rights."""
        resolved = breakpoint_scope.authority(
            _Db({FACILITY: True, OTHER_FACILITY: True}),
            principal(Role.FACILITY_ADMINISTRATOR, facility_id=FACILITY),
            facility_id=OTHER_FACILITY,
        )
        assert not resolved.may_edit_locally
        assert resolved.refusal == "Unknown facility."

    def test_the_national_authority_needs_no_grant(self):
        """It is the authority that issues them, and it defines the table the
        grant is an exception to."""
        resolved = breakpoint_scope.authority(
            _Db({FACILITY: False}), principal(Role.SUPERADMIN), facility_id=FACILITY
        )
        assert resolved.may_edit_locally
        assert resolved.may_publish_national
        assert resolved.may_grant_override


class TestPublicationScope:
    """``None`` means the national table. Reaching it by omitting a parameter is
    the mistake this guard exists to catch."""

    def test_the_national_authority_publishes_nationally(self):
        assert router._publication_scope(_Db(), principal(Role.SUPERADMIN), None) is None

    def test_a_regional_administrator_cannot_publish_nationally(self):
        """It has no block of its own here, so the scope would resolve to None —
        the national table — from a request that named nothing at all."""
        with pytest.raises(HTTPException) as caught:
            router._publication_scope(_Db(), principal(Role.REGIONAL_AMR_ADMINISTRATOR), None)
        assert caught.value.status_code == 403
        assert "superadmin authority" in caught.value.detail

    def test_a_regional_administrator_publishes_to_its_own_block(self):
        actor = principal(Role.REGIONAL_AMR_ADMINISTRATOR, block_id=BLOCK)
        assert router._publication_scope(_Db(), actor, None) == BLOCK
        assert router._publication_scope(_Db(), actor, BLOCK) == BLOCK

    def test_it_cannot_publish_into_another_region(self):
        actor = principal(Role.REGIONAL_AMR_ADMINISTRATOR, block_id=BLOCK)
        with pytest.raises(HTTPException) as caught:
            router._publication_scope(_Db(), actor, OTHER_BLOCK)
        # 404, not 403: another region's existence is not this caller's business.
        assert caught.value.status_code == 404

    def test_the_national_authority_may_publish_into_any_block(self):
        actor = principal(Role.SUPERADMIN)
        assert router._publication_scope(_Db(), actor, OTHER_BLOCK) == OTHER_BLOCK
