"""Guards on how the analytics engine loads its population.

Two performance changes are protected here, and both are the kind that stay
correct silently and break silently.

The first is that the specimen and organism-by-site explorers are loaded without
AST panels. Fetching them costs about seven times what the isolate rows
themselves cost, and neither explorer reads a susceptibility — but "does not read
a susceptibility" is a property of the code today, not a guarantee. The moment
one of them does, it will read an empty panel and report zeroes rather than
failing, so the equivalence is asserted here instead of trusted.

The second is that a loaded population is reused between requests. That is safe
only while the key distinguishes every scope that would produce a different
population; a filter added to ``SurveillanceFilter`` and forgotten in the key
would serve one region's isolates to another's request.
"""

import uuid
from dataclasses import fields, replace
from datetime import date

from amrss.analytics import profiles as profiles_engine
from amrss.analytics.query import (
    SurveillanceFilter,
    invalidate_record_cache,
    load_isolates,
)
from amrss.models.enums import CareSetting, OrganismKingdom, SirResult
from tests.conftest import (
    DRUG_X,
    DRUG_Y,
    ORGANISM_A,
    ORGANISM_B,
    SPECIMEN_BLOOD,
    SPECIMEN_URINE,
    make_isolate,
)


def _population(with_panels: bool):
    """The same isolates twice, differing only in whether panels were loaded."""
    panel = {DRUG_X: SirResult.SUSCEPTIBLE, DRUG_Y: SirResult.RESISTANT}
    spec = [
        (date(2026, 1, 5), ORGANISM_A, SPECIMEN_URINE, "p1"),
        (date(2026, 1, 6), ORGANISM_A, SPECIMEN_BLOOD, "p2"),
        (date(2026, 2, 9), ORGANISM_B, SPECIMEN_URINE, "p3"),
        (date(2026, 3, 2), ORGANISM_B, SPECIMEN_BLOOD, "p4"),
        (date(2026, 3, 3), ORGANISM_A, SPECIMEN_URINE, "p5"),
    ]
    return [
        make_isolate(
            specimen_date=when,
            organism_id=organism,
            specimen_type_id=specimen,
            patient=patient,
            # A record loaded with `with_panels=False` carries an empty panel;
            # that is exactly the shape being asserted safe.
            results=dict(panel) if with_panels else {},
            isolate_id=uuid.UUID(int=index),
        )
        for index, (when, organism, specimen, patient) in enumerate(spec, start=1)
    ]


class TestExplorersDoNotNeedPanels:
    """The premise behind loading these two endpoints without their AST results."""

    def test_specimen_counts_ignore_the_panel(self, methodology):
        with_panels = profiles_engine.by_specimen(_population(True), methodology)
        without = profiles_engine.by_specimen(_population(False), methodology)
        assert with_panels == without
        # Not vacuously equal: the explorer did report something.
        assert without[1] > 0

    def test_organism_site_counts_ignore_the_panel(self, methodology):
        site_of = {SPECIMEN_URINE: "urinary tract", SPECIMEN_BLOOD: "bloodstream"}
        with_panels = profiles_engine.by_organism_site(_population(True), methodology, site_of)
        without = profiles_engine.by_organism_site(_population(False), methodology, site_of)
        assert with_panels == without
        assert without[1] > 0

    def test_an_explorer_that_did_read_the_panel_would_be_caught(self, methodology):
        """The guard above is only meaningful if reading a panel changes an answer.

        The antibiogram does read one, so it must disagree across the two
        populations — otherwise the equality assertions prove nothing.
        """
        from amrss.analytics import antibiogram

        with_panels = antibiogram.compute(_population(True), methodology)
        without = antibiogram.compute(_population(False), methodology)
        assert with_panels.antibiotic_ids != without.antibiotic_ids
        assert without.antibiotic_ids == []


class TestTheCacheKeyCoversEveryScope:
    """A population may only be reused by a request that would have loaded it."""

    def test_every_filter_field_is_in_the_key(self):
        """Derived from the dataclass rather than a hand-written list, so a new
        filter cannot be added without appearing here."""
        base = SurveillanceFilter()
        distinct = {
            "regional_block_id": uuid.uuid4(),
            "district_ids": [uuid.uuid4()],
            "facility_ids": [uuid.uuid4()],
            "organism_ids": [ORGANISM_A],
            "specimen_type_ids": [SPECIMEN_URINE],
            "care_setting": CareSetting.INPATIENT,
            "organism_kingdom": OrganismKingdom.BACTERIA,
            "age_bands": ["15-44"],
            "date_from": date(2026, 1, 1),
            "date_to": date(2026, 12, 31),
        }
        # Every field of the filter must be exercised, or this test silently
        # stops covering the one that was added.
        assert {f.name for f in fields(SurveillanceFilter)} == set(distinct)

        for name, value in distinct.items():
            narrowed = replace(base, **{name: value})
            assert narrowed.cache_key() != base.cache_key(), (
                f"{name} does not affect the cache key, so a scope narrowed by it "
                f"would be served another scope's isolates"
            )

    def test_the_same_scope_written_differently_shares_an_entry(self):
        """Ordering of a list filter is not a different question."""
        a, b = uuid.uuid4(), uuid.uuid4()
        assert (
            SurveillanceFilter(district_ids=[a, b]).cache_key()
            == SurveillanceFilter(district_ids=[b, a]).cache_key()
        )

    def test_an_empty_scope_differs_from_a_narrowed_one(self):
        assert (
            SurveillanceFilter().cache_key()
            != SurveillanceFilter(organism_ids=[ORGANISM_B]).cache_key()
        )


class _CountingDb:
    """A session that answers nothing and counts how often it was asked."""

    def __init__(self) -> None:
        self.executions = 0

    def execute(self, _statement: object):
        self.executions += 1

        class _Result:
            @staticmethod
            def all() -> list:
                return []

        return _Result()


class TestTheCacheReusesAndReleases:
    """The behaviour the response times depend on, and the correctness it owes."""

    def _enabled(self, monkeypatch, ttl: int = 60) -> None:
        from amrss.config import get_settings

        monkeypatch.setattr(get_settings(), "analytics_cache_ttl_seconds", ttl)
        invalidate_record_cache()

    def test_a_repeated_scope_is_not_reloaded(self, monkeypatch):
        self._enabled(monkeypatch)
        db = _CountingDb()
        load_isolates(db, SurveillanceFilter())  # type: ignore[arg-type]
        after_first = db.executions
        for _ in range(5):
            load_isolates(db, SurveillanceFilter())  # type: ignore[arg-type]
        assert db.executions == after_first, "a cached scope went back to the database"

    def test_a_different_scope_is_loaded_separately(self, monkeypatch):
        self._enabled(monkeypatch)
        db = _CountingDb()
        load_isolates(db, SurveillanceFilter())  # type: ignore[arg-type]
        after_first = db.executions
        load_isolates(db, SurveillanceFilter(organism_ids=[ORGANISM_A]))  # type: ignore[arg-type]
        assert db.executions > after_first

    def test_panelled_and_unpanelled_populations_do_not_share_an_entry(self, monkeypatch):
        """Otherwise an explorer loaded without panels would poison the
        antibiogram, which needs them, with a population that has none."""
        self._enabled(monkeypatch)
        db = _CountingDb()
        load_isolates(db, SurveillanceFilter(), with_panels=False)  # type: ignore[arg-type]
        after_first = db.executions
        load_isolates(db, SurveillanceFilter(), with_panels=True)  # type: ignore[arg-type]
        assert db.executions > after_first

    def test_accepting_data_releases_the_cache(self, monkeypatch):
        """An upload accepted or a batch retracted must be visible at once, not
        whenever the window happens to close."""
        self._enabled(monkeypatch)
        db = _CountingDb()
        load_isolates(db, SurveillanceFilter())  # type: ignore[arg-type]
        after_first = db.executions

        invalidate_record_cache()

        load_isolates(db, SurveillanceFilter())  # type: ignore[arg-type]
        assert db.executions > after_first

    def test_a_zero_ttl_disables_it_entirely(self, monkeypatch):
        """What the test suite itself relies on."""
        self._enabled(monkeypatch, ttl=0)
        db = _CountingDb()
        load_isolates(db, SurveillanceFilter())  # type: ignore[arg-type]
        after_first = db.executions
        load_isolates(db, SurveillanceFilter())  # type: ignore[arg-type]
        assert db.executions > after_first

    def test_it_does_not_grow_without_bound(self, monkeypatch):
        """Each entry holds a whole population; the free tier has 512 MB."""
        from amrss.analytics import query as query_engine
        from amrss.config import get_settings

        self._enabled(monkeypatch)
        monkeypatch.setattr(get_settings(), "analytics_cache_entries", 3)
        db = _CountingDb()
        for _ in range(10):
            load_isolates(db, SurveillanceFilter(organism_ids=[uuid.uuid4()]))  # type: ignore[arg-type]
        assert len(query_engine._records_cache) <= 3
