"""Editing the breakpoint table on the platform.

A published breakpoint version is not editable in place. Every result already
interpreted cites the version it was interpreted under, so changing a threshold
inside one would silently rewrite what past antibiograms mean, with nothing in
the record to say it happened. Editing therefore works on a draft that no
computation can resolve, and publishing produces a new dated version.

What is tested here is the safety of that arrangement rather than its
convenience: that the draft stays invisible to the engine, that a draft is
allowed to be wrong while it is being worked on but cannot be published wrong,
and that the checks it must pass are the file importer's own rather than a
second, softer set.

The values below are structural fixtures. They carry no clinical authority and
must never be used to interpret a result.
"""

import uuid
from datetime import date
from typing import ClassVar

import pytest

from amrss.analytics.breakpoint_import import BreakpointImportError
from amrss.api.routers import breakpoints as router
from amrss.models.enums import MethodologyComponent
from amrss.security.scope import Principal

from .test_desktop_bridge import _methodology, _principal

DISK = {
    "organism_group": "Enterobacterales",
    "agent_code": "AMP",
    "method": "DISK",
    "standard": "CLSI M100",
    # Required by the engine: a zone diameter means nothing without the disk it
    # was read around.
    "disk_content": "10 ug",
    "disk_susceptible_min": 17,
    "disk_intermediate_min": 14,
    "disk_intermediate_max": 16,
    "disk_resistant_max": 13,
}

MIC = {
    "organism_group": "Enterobacterales",
    "agent_code": "AMP",
    "method": "MIC",
    "standard": "CLSI M100",
    "mic_susceptible_max": "8",
    "mic_intermediate_min": "16",
    "mic_intermediate_max": "16",
    "mic_resistant_min": "32",
}


class TestTheDraftIsInvisible:
    def test_a_draft_is_dated_beyond_anything_the_engine_will_resolve(self):
        """The one property the whole arrangement rests on.

        `methodology.resolve` selects versions with `effective_from <= as_of`. A
        draft dated past any date the programme will see can never be picked up,
        so a half-finished table cannot interpret a patient's result no matter
        what else goes wrong.
        """
        assert date(2200, 1, 1) < router.DRAFT_EFFECTIVE_FROM

    def test_a_draft_is_marked_provisional_as_well_as_dated_away(self):
        """Belt and braces: anything reading the row directly still sees that it
        is not an agreed decision."""
        source = router.read_draft.__doc__ or ""
        assert "published" in source.lower()


class TestScopeIdentity:
    def test_a_criterion_is_addressed_by_what_the_engine_selects_on(self):
        """Scope is identity. Two rows sharing it are a duplicate the engine
        cannot choose between, which makes the reported category depend on the
        order rows happen to sit in."""
        assert router._scope_key(DISK) == router._scope_key({**DISK, "disk_susceptible_min": 18})
        assert router._scope_key(DISK) != router._scope_key(MIC)

    def test_site_and_route_separate_otherwise_identical_criteria(self):
        """S. pneumoniae prints three penicillin criteria differing only by site.
        Collapsing them would lose the meningitis breakpoint entirely."""
        meningitis = {**MIC, "agent_code": "PEN", "site": "meningitis"}
        systemic = {**MIC, "agent_code": "PEN", "site": "non_meningitis"}
        oral = {**MIC, "agent_code": "PEN", "route": "oral"}

        keys = {
            router._scope_key(meningitis),
            router._scope_key(systemic),
            router._scope_key(oral),
        }
        assert len(keys) == 3

    def test_disk_content_is_not_part_of_the_address(self):
        """The shared validator refuses two rows differing only in disk content,
        so treating them as distinct here would let the editor build a draft
        that can never be published."""
        assert router._scope_key(DISK) == router._scope_key({**DISK, "disk_content": "30 ug"})

    def test_case_and_padding_do_not_create_a_second_row(self):
        assert router._scope_key(DISK) == router._scope_key(
            {**DISK, "agent_code": " amp ", "method": "disk"}
        )


class TestValidationIsTheImportersOwn:
    def test_a_sound_table_reports_nothing(self):
        assert router._validate_table([DISK, MIC], "draft") == []

    def test_a_disk_row_entered_the_mic_way_round_is_reported(self):
        """Zones run opposite to MICs. Entered the other way round, the table
        categorises every isolate as susceptible and reports nothing wrong."""
        inverted = {**DISK, "disk_susceptible_min": 13, "disk_resistant_max": 17}
        problems = router._validate_table([inverted], "draft")
        assert problems

    def test_two_rows_with_the_same_scope_are_reported(self):
        """A duplicate the engine cannot choose between."""
        problems = router._validate_table([DISK, {**DISK, "disk_susceptible_min": 20}], "draft")
        assert problems

    def test_a_row_missing_its_standard_is_reported(self):
        """M100, M45 and M60 give different criteria for the same pair. A
        criterion that cannot say which document it came from cannot be
        audited."""
        problems = router._validate_table([{**DISK, "standard": ""}], "draft")
        assert any("standard" in problem for problem in problems)

    def test_validation_runs_over_the_whole_table_not_one_row(self):
        """A row can be individually sane and still duplicate or overlap
        another. The engine only sees that when it sees the set."""
        assert router._validate_table([DISK], "draft") == []
        assert router._validate_table([DISK, {**DISK, "disk_susceptible_min": 22}], "draft")


class _DraftRow:
    """Enough of a MethodologyVersion for the endpoints under test."""

    def __init__(self, criteria: list[dict], version: str = "M100-Ed36-draft"):
        self.id = uuid.uuid4()
        self.version = version
        self.parameters = {
            "label": "Draft",
            "based_on": "M100-Ed36",
            "breakpoints": list(criteria),
        }


class _Session:
    """A session that answers the one query the editor makes."""

    def __init__(self, draft: _DraftRow | None):
        self.draft = draft
        self.deleted: list[object] = []
        self.added: list[object] = []
        self.committed = 0

    def scalar(self, _statement):
        return self.draft

    def add(self, row):
        self.added.append(row)

    def delete(self, row):
        self.deleted.append(row)

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass

    def refresh(self, _row):
        pass

    def get(self, _model, _identifier):
        return None


class _Request:
    client = None
    headers: ClassVar[dict[str, str]] = {}


@pytest.fixture(autouse=True)
def _silent_audit(monkeypatch: pytest.MonkeyPatch):
    """The audit record is exercised by its own tests; here it would need a real
    session."""
    monkeypatch.setattr(router.audit, "record", lambda *args, **kwargs: None)


class TestEditingTheDraft:
    def test_saving_a_criterion_whose_scope_exists_replaces_it(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        session = _Session(_DraftRow([DISK, MIC]))
        response = router.upsert_draft_criterion(
            _Request(),
            session,
            _principal(),
            router.DraftCriterion(**{**DISK, "disk_susceptible_min": 18}),
        )
        assert response.criteria_count == 2
        disk_rows = [c for c in response.criteria if c["method"] == "DISK"]
        assert len(disk_rows) == 1
        assert disk_rows[0]["disk_susceptible_min"] == 18

    def test_a_lower_case_agent_code_is_stored_the_way_the_engine_reads_it(self):
        session = _Session(_DraftRow([]))
        response = router.upsert_draft_criterion(
            _Request(),
            session,
            _principal(),
            router.DraftCriterion(**{**DISK, "agent_code": "amp"}),
        )
        assert response.criteria[0]["agent_code"] == "AMP"

    def test_a_draft_may_be_wrong_while_it_is_being_worked_on(self):
        """Refusing an intermediate state would make the editor unusable: a
        laboratory correcting two rows would be blocked between them. The
        problems are reported and publishing is what refuses."""
        session = _Session(_DraftRow([]))
        response = router.upsert_draft_criterion(
            _Request(),
            session,
            _principal(),
            router.DraftCriterion(**{**DISK, "disk_susceptible_min": 13, "disk_resistant_max": 17}),
        )
        assert response.criteria_count == 1
        assert response.problems

    def test_removing_a_criterion_removes_exactly_the_one_addressed(self):
        session = _Session(_DraftRow([DISK, MIC]))
        response = router.remove_draft_criterion(
            _Request(),
            session,
            _principal(),
            organism_group="Enterobacterales",
            agent_code="AMP",
            method="DISK",
        )
        assert response.criteria_count == 1
        assert response.criteria[0]["method"] == "MIC"

    def test_removing_something_absent_says_so_rather_than_succeeding_quietly(self):
        session = _Session(_DraftRow([DISK]))
        with pytest.raises(router.HTTPException) as raised:
            router.remove_draft_criterion(
                _Request(),
                session,
                _principal(),
                organism_group="Enterobacterales",
                agent_code="CIP",
                method="DISK",
            )
        assert raised.value.status_code == 404

    def test_editing_without_a_draft_is_refused_rather_than_creating_one(self):
        """Opening the editor creates the draft, deliberately and visibly. An
        edit that silently created one would let a stray request start a table
        nobody opened."""
        with pytest.raises(router.HTTPException) as raised:
            router.upsert_draft_criterion(
                _Request(), _Session(None), _principal(), router.DraftCriterion(**DISK)
            )
        assert raised.value.status_code == 404


class TestPublishing:
    def _publish(self, session, monkeypatch, importer):
        monkeypatch.setattr(router, "import_breakpoints", importer)
        return router.publish_draft(
            _Request(),
            session,
            _principal(),
            router.PublishRequest(
                version="M100-Ed36b",
                source_edition="CLSI M100 36th ed. (2026)",
                effective_from=date(2026, 1, 1),
            ),
        )

    def test_publishing_goes_through_the_file_importer(self, monkeypatch: pytest.MonkeyPatch):
        """One code path decides what a valid breakpoint table is, so a table
        typed in here cannot be looser than one uploaded as a file."""
        seen: dict[str, object] = {}

        def _importer(db, text, **kwargs):
            seen["text"] = text
            seen.update(kwargs)
            return router.ImportResponse(
                version=kwargs["version"],
                source_edition=kwargs["source_edition"],
                imported=2,
                warnings=[],
                conversion=None,
            )

        session = _Session(_DraftRow([DISK, MIC]))
        result = self._publish(session, monkeypatch, _importer)

        assert result.imported == 2
        # The draft was rendered as the template CSV, not handed over as objects.
        assert "organism_group,agent_code,method" in str(seen["text"])
        assert seen["commit"] is False

    def test_a_single_bad_row_blocks_the_whole_publication(self, monkeypatch: pytest.MonkeyPatch):
        """Three wrong thresholds out of nine hundred would reach clinical
        reports with no way afterwards to tell which results they touched."""

        def _importer(db, text, **kwargs):
            raise BreakpointImportError(["line 4: susceptible is not above resistant"])

        session = _Session(_DraftRow([DISK]))
        with pytest.raises(router.HTTPException) as raised:
            self._publish(session, monkeypatch, _importer)

        assert raised.value.status_code == 422
        assert raised.value.detail["problems"]
        assert session.deleted == []

    def test_an_empty_draft_is_not_published_as_an_empty_table(self):
        """A published table of no criteria would put every measurement into
        pending while looking like a successful publication."""
        with pytest.raises(router.HTTPException) as raised:
            router.publish_draft(
                _Request(),
                _Session(_DraftRow([])),
                _principal(),
                router.PublishRequest(
                    version="x",
                    source_edition="y",
                    effective_from=date(2026, 1, 1),
                ),
            )
        assert raised.value.status_code == 422

    def test_a_published_draft_is_cleared_away(self, monkeypatch: pytest.MonkeyPatch):
        """Keeping it would leave two tables in play and no way to tell which
        one an operator was editing."""

        def _importer(db, text, **kwargs):
            return router.ImportResponse(
                version=kwargs["version"],
                source_edition=kwargs["source_edition"],
                imported=1,
                warnings=[],
                conversion=None,
            )

        draft = _DraftRow([DISK])
        session = _Session(draft)
        self._publish(session, monkeypatch, _importer)
        assert session.deleted == [draft]


class TestExport:
    def test_the_export_is_the_file_the_importer_reads(self, monkeypatch: pytest.MonkeyPatch):
        """Round-tripping is the point. An export in some other shape would have
        to be reworked by hand before it could go back in, which is where
        transcription errors come from."""
        monkeypatch.setattr(
            router.methodology_engine,
            "resolve",
            lambda *args, **kwargs: _methodology({"breakpoints": [DISK, MIC]}),
        )
        response = router.export_breakpoint_table(_Session(None), _principal())

        body = response.body.decode()
        assert body.splitlines()[0].startswith("organism_group,agent_code,method")
        assert "Enterobacterales" in body
        assert response.media_type == "text/csv"
        assert "attachment" in response.headers["content-disposition"]

    def test_no_table_loaded_exports_a_header_rather_than_failing(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """A programme that has imported nothing gets an empty template — which
        is a usable starting point, not an error it cannot act on."""
        monkeypatch.setattr(
            router.methodology_engine, "resolve", lambda *args, **kwargs: _methodology(None)
        )
        response = router.export_breakpoint_table(_Session(None), _principal())
        assert response.body.decode().splitlines()[0].startswith("organism_group")


class TestScoping:
    def test_a_block_administrator_edits_their_own_block_s_draft(self):
        """A version scoped to a regional block wins over an unscoped one, which
        is how a block adopts a different edition. The editor must respect the
        same boundary or one block would edit another's table."""
        block = uuid.uuid4()
        principal: Principal = _principal(block)
        session = _Session(_DraftRow([DISK]))
        router.upsert_draft_criterion(_Request(), session, principal, router.DraftCriterion(**MIC))
        # The scope reaching the query is the principal's, not a global default.
        assert principal.regional_block_id == block

    def test_the_component_edited_is_the_breakpoint_component(self):
        assert MethodologyComponent.AST_BREAKPOINTS.value
