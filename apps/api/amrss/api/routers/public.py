"""The public, unauthenticated surveillance API.

This is the half of the platform anyone may read: the regional aggregate that a
national AMR report publishes anyway — percent-susceptible by organism and
agent, with small numbers suppressed and only quality-verified laboratories
counted. It exists so the public dashboard can be served from the edge without
waiting on a signed-in request, which is what lets that dashboard be fast.

Two things make it safe to leave open, and both are structural rather than
promised:

* Every endpoint builds its scope with ``public_regional_scope``, which takes no
  facility or district parameter. There is no query string that makes a public
  request return one laboratory's numbers — the shape of the call forbids it.
* Each endpoint calls the very same response builder the signed-in regional view
  uses. The public figure is not a re-implementation that might round or suppress
  differently; it is the authenticated regional aggregate, reached by a caller
  who was never granted anything finer.

Anything that identifies a facility — the coverage roster, facility comparison,
a single laboratory's unsuppressed data — is deliberately absent here and lives
only behind the console's login.
"""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Response, status

from amrss.analytics import trends
from amrss.api.deps import DbSession
from amrss.api.empiric_sites import (
    InfectionSitesResponse,
    list_infection_sites,
    resolve_site,
)
from amrss.api.routers.surveillance import (
    AntibiogramResponse,
    AntibioticExplorerResponse,
    EmpiricResponse,
    OrganismExplorerResponse,
    ReferenceResponse,
    SpecimenExplorerResponse,
    TrendResponse,
    antibiogram_response,
    antibiotic_explorer_response,
    empiric_response,
    organism_explorer_response,
    reference_response,
    specimen_explorer_response,
    trend_response,
)
from amrss.api.scope_resolution import public_regional_scope
from amrss.models.enums import CareSetting, OrganismKingdom


def _cacheable(response: Response) -> None:
    """Let anything between here and the reader hold on to a public response.

    Safe on this router and only on this router: every endpoint below is the
    regional aggregate served to an anonymous caller, identical for everyone, with
    no cookie and no token in the request. The signed-in console must never get
    these headers — its answers are scoped to the caller — which is why this is
    attached to the public router rather than applied globally.

    The three directives do different jobs. ``max-age`` is for a browser or the
    dashboard's own fetch cache. ``s-maxage`` is for a shared cache and is longer,
    matching the ten-minute window the public pages already revalidate on.
    ``stale-while-revalidate`` is the one that matters most on a free tier: it
    lets a cache serve the previous answer instantly and refresh behind the
    reader, so a visitor arriving while the API is waking gets last hour's figures
    at once rather than watching a cold start.
    """
    response.headers["Cache-Control"] = (
        "public, max-age=60, s-maxage=600, stale-while-revalidate=3600"
    )


router = APIRouter(prefix="/public", tags=["public"], dependencies=[Depends(_cacheable)])


@router.get("/antibiogram", response_model=AntibiogramResponse)
def public_antibiogram(
    db: DbSession,
    care_setting: CareSetting | None = None,
    organism_kingdom: OrganismKingdom | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> AntibiogramResponse:
    scope = public_regional_scope(
        db,
        care_setting=care_setting,
        organism_kingdom=organism_kingdom,
        date_from=date_from,
        date_to=date_to,
    )
    return antibiogram_response(db, scope)


@router.get("/antibiotics", response_model=AntibioticExplorerResponse)
def public_antibiotics(
    db: DbSession,
    care_setting: CareSetting | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> AntibioticExplorerResponse:
    scope = public_regional_scope(
        db, care_setting=care_setting, date_from=date_from, date_to=date_to
    )
    return antibiotic_explorer_response(db, scope)


@router.get("/organisms", response_model=OrganismExplorerResponse)
def public_organisms(
    db: DbSession,
    care_setting: CareSetting | None = None,
    organism_kingdom: OrganismKingdom | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> OrganismExplorerResponse:
    scope = public_regional_scope(
        db,
        care_setting=care_setting,
        organism_kingdom=organism_kingdom,
        date_from=date_from,
        date_to=date_to,
    )
    return organism_explorer_response(db, scope)


@router.get("/specimens", response_model=SpecimenExplorerResponse)
def public_specimens(
    db: DbSession,
    care_setting: CareSetting | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> SpecimenExplorerResponse:
    scope = public_regional_scope(
        db, care_setting=care_setting, date_from=date_from, date_to=date_to
    )
    return specimen_explorer_response(db, scope)


@router.get("/trend", response_model=TrendResponse)
def public_trend(
    db: DbSession,
    organism_id: uuid.UUID,
    antibiotic_id: uuid.UUID,
    bucket: trends.TimeBucket = trends.TimeBucket.MONTH,
    care_setting: CareSetting | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> TrendResponse:
    scope = public_regional_scope(
        db,
        care_setting=care_setting,
        organism_ids=[organism_id],
        date_from=date_from,
        date_to=date_to,
    )
    return trend_response(
        db, scope, organism_id=organism_id, antibiotic_id=antibiotic_id, bucket=bucket
    )


@router.get("/reference", response_model=ReferenceResponse)
def public_reference(db: DbSession) -> ReferenceResponse:
    return reference_response(db)


@router.get("/empiric/sites", response_model=InfectionSitesResponse)
def public_empiric_sites(db: DbSession) -> InfectionSitesResponse:
    return InfectionSitesResponse(sites=list_infection_sites(db))


@router.get("/empiric", response_model=EmpiricResponse)
def public_empiric(
    db: DbSession,
    site: str,
    care_setting: CareSetting | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> EmpiricResponse:
    # The empiric evidence for a site is the regional antibiogram over that
    # site's specimens — no facility scope, suppression on, as everywhere public.
    resolved = resolve_site(db, site)
    if resolved is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown infection site")
    scope = public_regional_scope(
        db,
        specimen_type_ids=resolved.specimen_type_ids,
        care_setting=care_setting,
        date_from=date_from,
        date_to=date_to,
    )
    return empiric_response(db, scope, site=resolved.site, sterile_site=resolved.sterile_site)
