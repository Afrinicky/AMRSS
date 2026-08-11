"""The infection-site list behind the empiric-therapy view.

The susceptibility on that page is the ordinary antibiogram, tested elsewhere;
what is specific here is which sites appear and in what order — a clinical
reading order, not alphabetical — and that a site is called sterile only when
every specimen under it is.
"""

import uuid

from amrss.api.empiric_sites import list_infection_sites, specimen_type_ids_for_site


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _StubDb:
    """Answers the two queries the module makes without a database."""

    def __init__(self, *, grouped=None, ids=None):
        self._grouped = grouped or []
        self._ids = ids or []

    def execute(self, _statement):
        return _Result(self._grouped)

    def scalars(self, _statement):
        return self._ids


def test_sites_are_returned_in_clinical_order_not_alphabetical():
    # Deliberately supplied out of order and not alphabetical.
    grouped = [
        ("skin and soft tissue", False, [uuid.uuid4()]),
        ("urinary tract", False, [uuid.uuid4()]),
        ("bloodstream", True, [uuid.uuid4()]),
    ]
    sites = list_infection_sites(_StubDb(grouped=grouped))  # type: ignore[arg-type]
    assert [s.site for s in sites] == ["urinary tract", "bloodstream", "skin and soft tissue"]


def test_an_unlisted_site_sorts_after_the_clinical_ones():
    grouped = [
        ("umbilical stump", False, [uuid.uuid4()]),
        ("urinary tract", False, [uuid.uuid4()]),
    ]
    sites = list_infection_sites(_StubDb(grouped=grouped))  # type: ignore[arg-type]
    assert [s.site for s in sites] == ["urinary tract", "umbilical stump"]


def test_a_site_is_sterile_only_when_all_its_specimens_are():
    # bool_and over the site's specimen types is what the query computes; a mixed
    # site is not sterile.
    grouped = [("bloodstream", True, [uuid.uuid4()]), ("deep tissue", False, [uuid.uuid4()])]
    sites = {s.site: s.sterile_site for s in list_infection_sites(_StubDb(grouped=grouped))}  # type: ignore[arg-type]
    assert sites["bloodstream"] is True
    assert sites["deep tissue"] is False


def test_an_unknown_site_yields_none_not_an_empty_filter():
    """None, so a caller answers 404 rather than computing an all-sites antibiogram
    that silently ignores the (misspelled) site."""
    assert specimen_type_ids_for_site(_StubDb(ids=[]), "not a site") is None  # type: ignore[arg-type]


def test_a_known_site_yields_its_specimen_ids():
    ids = [uuid.uuid4(), uuid.uuid4()]
    assert specimen_type_ids_for_site(_StubDb(ids=ids), "urinary tract") == ids  # type: ignore[arg-type]
