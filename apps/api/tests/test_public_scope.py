"""The one guarantee the public API rests on: it can only ever be regional.

The public endpoints are unauthenticated, so nothing downstream re-checks who is
asking. Their safety is entirely that the scope they build carries no facility
and no district and always suppresses — a property of ``public_regional_scope``,
checked here so a later edit that loosens it fails loudly rather than quietly
publishing a single laboratory's numbers.
"""

import uuid

from amrss.analytics.antibiogram import AggregationLevel
from amrss.api.scope_resolution import public_regional_scope


class _StubDb:
    """A session stand-in that answers the one query the helper makes — the id of
    the block to speak for — without a database."""

    def __init__(self, block_id: uuid.UUID | None) -> None:
        self._block_id = block_id

    def scalar(self, _statement: object) -> uuid.UUID | None:
        return self._block_id


def test_the_public_scope_is_regional_and_nothing_finer():
    block = uuid.uuid4()
    scope = public_regional_scope(_StubDb(block))  # type: ignore[arg-type]

    assert scope.level is AggregationLevel.REGIONAL
    assert scope.regional_block_id == block
    # No facility and no district can ride in — the property the whole public
    # surface depends on.
    assert scope.filters.facility_ids is None
    assert scope.filters.district_ids is None


def test_the_public_scope_always_suppresses_and_counts_only_verified():
    scope = public_regional_scope(_StubDb(uuid.uuid4()))  # type: ignore[arg-type]
    # These are what make an aggregate publishable: small cells hidden, and only
    # quality-verified laboratories contributing. A public view must never lift
    # either, whatever an authenticated facility view may do for its own data.
    assert scope.apply_suppression is True
    assert scope.verified_only is True


def test_the_public_scope_survives_an_empty_deployment():
    """No active block yet is an empty picture, not a crash — the public page
    must render on a brand-new deployment."""
    scope = public_regional_scope(_StubDb(None))  # type: ignore[arg-type]
    assert scope.regional_block_id is None
    assert scope.level is AggregationLevel.REGIONAL
