"""What the desktop uploader depends on the API for.

Two additions, both narrow, both worth their own tests because both are places
where a mistake hands out authority or a wrong number:

- **Handoff codes**, which let the uploader open the web console as the person
  already signed into it. A code is a credential that travels through a URL, so
  the tests here are about what it *cannot* do.
- **The active breakpoint table**, which the uploader interprets against so a
  laboratory sees S/I/R before it uploads. The rows must reach it exactly as
  they are stored: a reshaping step here would be a second chance to transpose a
  threshold.
"""

import uuid
from datetime import date, timedelta

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from amrss.analytics.methodology import MethodologySet, ResolvedMethodology
from amrss.api.routers import breakpoints as breakpoints_router
from amrss.models.enums import MethodologyComponent, Role
from amrss.security.scope import Principal
from amrss.security.tokens import (
    HANDOFF_TTL,
    TokenError,
    create_access_token,
    create_handoff_token,
    create_refresh_token,
    decode_token,
)


class TestHandoffCodes:
    def test_a_handoff_code_names_the_person_who_asked_for_it(self):
        user_id = uuid.uuid4()
        assert decode_token(create_handoff_token(user_id), "handoff") == user_id

    def test_a_handoff_code_is_not_an_access_token(self):
        """The code travels in a URL — through the OS's open-this-link plumbing
        and into browser history. If it were interchangeable with an access
        token, that would be an API credential sitting in a history file."""
        code = create_handoff_token(uuid.uuid4())
        with pytest.raises(TokenError):
            decode_token(code, "access")
        with pytest.raises(TokenError):
            decode_token(code, "refresh")

    def test_an_access_token_cannot_be_exchanged_as_a_handoff_code(self):
        token = create_access_token(uuid.uuid4())
        with pytest.raises(TokenError):
            decode_token(token, "handoff")

    def test_a_refresh_token_cannot_be_exchanged_as_a_handoff_code(self):
        with pytest.raises(TokenError):
            decode_token(create_refresh_token(uuid.uuid4()), "handoff")

    def test_the_window_is_short_enough_to_be_the_control(self):
        """A JWT cannot be revoked after issue, so the lifetime is what limits
        the damage. Ninety seconds is long enough for a browser to start."""
        assert timedelta(minutes=2) >= HANDOFF_TTL


class _FakeSession:
    """Enough of a session for the endpoint: it only reads the row back to
    report the edition's effective date."""

    def __init__(self, row=None):
        self._row = row

    def get(self, _model, _identifier):
        return self._row


class _Row:
    def __init__(self, effective_from: date):
        self.effective_from = effective_from


def _principal(
    regional_block_id: uuid.UUID | None = None, role: Role = Role.SUPERADMIN
) -> Principal:
    """A caller for the router-level tests.

    Superadmin by default because most of what these tests exercise is the
    national table — the one published with no block, which now needs national
    authority to reach. Tests about a regional administrator's confinement pass
    the role explicitly.
    """
    return Principal(
        user_id=uuid.uuid4(),
        email="lab@example.test",
        full_name="A Scientist",
        role=role,
        facility_id=None,
        regional_block_id=regional_block_id,
    )


def _methodology(parameters: dict | None) -> MethodologySet:
    resolved = {}
    if parameters is not None:
        resolved[MethodologyComponent.AST_BREAKPOINTS] = ResolvedMethodology(
            id=uuid.uuid4(),
            component=MethodologyComponent.AST_BREAKPOINTS,
            version="CLSI-M100-Ed36",
            description="",
            is_provisional=False,
            parameters=parameters,
        )
    return MethodologySet(as_of=date.today(), regional_block_id=None, _resolved=resolved)


class TestActiveBreakpoints:
    def test_criteria_are_passed_through_unchanged(self, monkeypatch: pytest.MonkeyPatch):
        criteria = [
            {
                "organism_group": "Enterobacterales",
                "agent_code": "CIP",
                "method": "DISK",
                "standard": "CLSI M100 Ed36",
                "disk_susceptible_min": 26,
                "disk_resistant_max": 21,
            }
        ]
        monkeypatch.setattr(
            breakpoints_router.methodology_engine,
            "resolve",
            lambda *_args, **_kwargs: _methodology(
                {"label": "M100 36th ed.", "breakpoints": criteria}
            ),
        )

        response = breakpoints_router.active_breakpoints(
            _FakeSession(_Row(date(2026, 1, 1))), _principal()
        )

        assert response.version == "CLSI-M100-Ed36"
        assert response.label == "M100 36th ed."
        assert response.effective_from == date(2026, 1, 1)
        # Identical objects, not a reshaped copy: the offline client interprets
        # against the same numbers under the same column names as the server.
        assert response.criteria == criteria

    def test_no_table_loaded_is_an_empty_answer_rather_than_an_error(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """A laboratory that has not imported its licensed tables yet gets
        measurements marked pending — the honest answer — not a failed sync it
        cannot act on."""
        monkeypatch.setattr(
            breakpoints_router.methodology_engine,
            "resolve",
            lambda *_args, **_kwargs: _methodology(None),
        )

        response = breakpoints_router.active_breakpoints(_FakeSession(), _principal())

        assert response.criteria == []
        assert response.version is None

    def test_the_caller_s_own_block_scopes_the_table_by_default(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """A block that has adopted a different edition must not have another
        block's thresholds handed to its laboratories.

        Read with a regional account: a national one resolves to the national
        table by design, which is a different question and is asserted below.
        """
        seen: dict[str, object] = {}

        def _resolve(_db, **kwargs):
            seen.update(kwargs)
            return _methodology({"breakpoints": []})

        monkeypatch.setattr(breakpoints_router.methodology_engine, "resolve", _resolve)

        block = uuid.uuid4()
        breakpoints_router.active_breakpoints(
            _FakeSession(), _principal(block, role=Role.REGIONAL_AMR_ADMINISTRATOR)
        )

        assert seen["regional_block_id"] == block

    def test_a_national_account_reads_the_national_table(self, monkeypatch: pytest.MonkeyPatch):
        """A superadmin may be recorded in a block — many are seconded from one —
        and still reads the table it publishes for the whole programme, not that
        block's local variant."""
        seen: dict[str, object] = {}

        def _resolve(_db, **kwargs):
            seen.update(kwargs)
            return _methodology({"breakpoints": []})

        monkeypatch.setattr(breakpoints_router.methodology_engine, "resolve", _resolve)

        breakpoints_router.active_breakpoints(_FakeSession(), _principal(uuid.uuid4()))

        assert seen["regional_block_id"] is None

    def test_a_laboratory_cannot_read_another_blocks_table_by_asking(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The block parameter exists for a national account switching between
        regions. A regional one naming somebody else's block falls back to its
        own rather than being handed the other's thresholds."""
        seen: dict[str, object] = {}

        def _resolve(_db, **kwargs):
            seen.update(kwargs)
            return _methodology({"breakpoints": []})

        monkeypatch.setattr(breakpoints_router.methodology_engine, "resolve", _resolve)

        mine, theirs = uuid.uuid4(), uuid.uuid4()
        breakpoints_router.active_breakpoints(
            _FakeSession(),
            _principal(mine, role=Role.REGIONAL_AMR_ADMINISTRATOR),
            regional_block_id=theirs,
        )

        assert seen["regional_block_id"] == mine

    def test_an_endpoint_caller_may_not_be_anonymous(self):
        """The signature requires a principal; FastAPI resolves it from the
        bearer token, and an unauthenticated request never reaches the body."""
        with pytest.raises(TypeError):
            breakpoints_router.active_breakpoints(_FakeSession())  # type: ignore[call-arg]


def test_the_login_endpoint_still_accepts_the_key_the_uploader_sends():
    """The uploader posts `identifier`; an older build posted `email`. Both are
    accepted, and breaking either would strand laboratories mid-upgrade."""
    from amrss.api.routers.auth import LoginRequest

    assert LoginRequest(identifier="lab@example.test", password="x").identifier == (
        "lab@example.test"
    )
    assert LoginRequest(email="lab@example.test", password="x").identifier == "lab@example.test"

    with pytest.raises(ValidationError):
        LoginRequest(password="x")


def test_an_expired_handoff_code_is_refused_with_a_message_a_person_can_act_on(
    monkeypatch: pytest.MonkeyPatch,
):
    from amrss.api.routers import auth as auth_router

    def _decode(_token, _type):
        raise TokenError("token is invalid or expired")

    monkeypatch.setattr(auth_router, "decode_token", _decode)

    with pytest.raises(HTTPException) as raised:
        auth_router.exchange_handoff(
            auth_router.HandoffExchangeRequest(code="stale"), None, (None, None)
        )

    assert raised.value.status_code == 401
    assert "uploader" in raised.value.detail
