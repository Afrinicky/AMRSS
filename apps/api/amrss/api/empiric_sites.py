"""Infection sites, for the empiric-therapy view.

The question this answers is the clinician's: a urinary tract infection walks in,
no culture yet — what does the regional data say is still working against the
organisms we usually see in urine? The mechanism is simple and reuses everything
else: an infection site maps to a set of specimen types, and the antibiogram
computed over just those specimens is the evidence for that site.

This module is only the site half — the list of sites and the specimen types
under each. The susceptibility itself is the ordinary antibiogram, scoped to
those specimens, so an empiric figure can never diverge from the antibiogram a
clinician would read elsewhere.
"""

import uuid

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from amrss.models import CanonicalSpecimenType

# A clinical reading order rather than alphabetical: the sites a prescriber
# reaches for most often come first. Sites not listed here fall to the end, in
# alphabetical order, so a dictionary addition still appears without a code
# change — it simply is not prioritised until someone decides where it belongs.
CLINICAL_SITE_ORDER = [
    "urinary tract",
    "bloodstream",
    "lower respiratory tract",
    "skin and soft tissue",
    "genital tract",
    "central nervous system",
    "gastrointestinal tract",
    "bone and joint",
    "deep tissue",
    "sterile body fluid",
    "ear or eye",
]


class InfectionSite(BaseModel):
    site: str
    #: True when every specimen type under the site is a normally sterile site —
    #: a growth there carries weight a surface swab does not.
    sterile_site: bool
    #: The specimen types that map to this site, used to scope the antibiogram.
    specimen_type_ids: list[uuid.UUID]


class InfectionSitesResponse(BaseModel):
    sites: list[InfectionSite]


def _order_key(site: str) -> tuple[int, str]:
    try:
        return (CLINICAL_SITE_ORDER.index(site), "")
    except ValueError:
        return (len(CLINICAL_SITE_ORDER), site)


def list_infection_sites(db: Session) -> list[InfectionSite]:
    """Every infection site in the dictionary, in clinical reading order.

    Grouped from the specimen dictionary rather than hard-coded, so a site is
    exactly as available as the specimen types that feed it. A site is treated
    as sterile only when all of its specimen types are — the conservative read,
    since it governs how much weight a growth is given.
    """
    rows = db.execute(
        select(
            CanonicalSpecimenType.infection_site,
            func.bool_and(CanonicalSpecimenType.is_sterile_site),
            func.array_agg(CanonicalSpecimenType.id),
        )
        .where(CanonicalSpecimenType.is_active.is_(True))
        .group_by(CanonicalSpecimenType.infection_site)
    ).all()

    sites = [
        InfectionSite(site=site, sterile_site=bool(sterile), specimen_type_ids=list(ids))
        for site, sterile, ids in rows
    ]
    sites.sort(key=lambda s: _order_key(s.site))
    return sites


def specimen_type_ids_for_site(db: Session, site: str) -> list[uuid.UUID] | None:
    """The specimen types under one site, or ``None`` if the site is unknown.

    ``None`` rather than an empty list on an unknown site, so a caller can tell a
    misspelled site from a real one with no specimens and answer 404 rather than
    silently computing an all-sites antibiogram.
    """
    ids = list(
        db.scalars(
            select(CanonicalSpecimenType.id)
            .where(CanonicalSpecimenType.is_active.is_(True))
            .where(CanonicalSpecimenType.infection_site == site)
        )
    )
    return ids or None
