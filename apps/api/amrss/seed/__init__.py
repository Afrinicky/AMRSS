"""Seeding.

Two distinct jobs, deliberately separated:

``seed_reference_data`` loads the canonical dictionary and methodology versions.
These are required for the system to function at all — the analytics engine
refuses to compute without a methodology version — so this runs in every
environment including production.

``seed_demo_block`` creates a regional block with districts, facilities and
users. This is development and pilot data only and refuses to run against a
production environment.

Region names appear in this package because ADR-0002 permits them in seed data.
They may not appear in application source.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from amrss.config import get_settings
from amrss.models import (
    CanonicalAntibiotic,
    CanonicalOrganism,
    CanonicalSpecimenType,
    MethodologyVersion,
)
from amrss.seed.dictionary_data import (
    ANTIBIOTICS,
    ENTEROBACTERALES_GROUP,
    GENUS_CLSI_GROUPS,
    ORGANISMS,
    SPECIMEN_TYPES,
    OrganismSeed,
)
from amrss.seed.methodology_defaults import DEFAULTS, PROVISIONAL_FROM


def seed_reference_data(db: Session) -> dict[str, int]:
    """Load the canonical dictionary and methodology defaults.

    Idempotent by code. Existing entries are updated rather than duplicated, so
    running this after a dictionary addition is safe.
    """
    counts = {"organisms": 0, "antibiotics": 0, "specimen_types": 0, "methodology": 0}

    for entry in ORGANISMS:
        organism = db.scalar(
            select(CanonicalOrganism).where(CanonicalOrganism.code == entry["code"])
        )
        is_new = organism is None
        if organism is None:
            organism = CanonicalOrganism(code=entry["code"])
            db.add(organism)
            counts["organisms"] += 1
        organism.name = entry["name"]
        organism.kingdom = entry["kingdom"]
        organism.genus = entry["genus"]
        organism.family = entry["family"]
        organism.gram_stain = entry["gram_stain"]
        organism.is_enterobacterales = entry["is_enterobacterales"]
        # Seeded as a starting point only. Once an administrator edits the alert
        # list (SDD 5.2, 13.5) their choice is the operational one, so re-seeding
        # must not silently revert it.
        if is_new:
            organism.is_organism_of_special_importance = entry["special_importance"]
            # Same rule as the alert list: seeded once, then owned by the
            # administrator. Re-seeding must not overwrite a group mapping a
            # laboratory corrected to match its own loaded CLSI edition.
            organism.clsi_organism_groups = clsi_groups_for(entry)

    for antibiotic_entry in ANTIBIOTICS:
        antibiotic = db.scalar(
            select(CanonicalAntibiotic).where(CanonicalAntibiotic.code == antibiotic_entry["code"])
        )
        if antibiotic is None:
            antibiotic = CanonicalAntibiotic(code=antibiotic_entry["code"])
            db.add(antibiotic)
            counts["antibiotics"] += 1
        antibiotic.name = antibiotic_entry["name"]
        antibiotic.clsi_agent_code = antibiotic_entry.get("clsi_agent_code")
        antibiotic.antimicrobial_class = antibiotic_entry["antimicrobial_class"]
        antibiotic.target_kingdom = antibiotic_entry["target_kingdom"]
        antibiotic.who_aware_category = antibiotic_entry["who_aware_category"]
        antibiotic.display_order = antibiotic_entry["display_order"]

    for specimen_entry in SPECIMEN_TYPES:
        specimen = db.scalar(
            select(CanonicalSpecimenType).where(
                CanonicalSpecimenType.code == specimen_entry["code"]
            )
        )
        if specimen is None:
            specimen = CanonicalSpecimenType(code=specimen_entry["code"])
            db.add(specimen)
            counts["specimen_types"] += 1
        specimen.name = specimen_entry["name"]
        specimen.infection_site = specimen_entry["infection_site"]
        specimen.is_sterile_site = specimen_entry["is_sterile_site"]

    for method in DEFAULTS:
        existing = db.scalar(
            select(MethodologyVersion).where(
                MethodologyVersion.component == method["component"],
                MethodologyVersion.version == method["version"],
            )
        )
        if existing is not None:
            continue
        is_provisional = method["version"].endswith("-provisional")
        description = method["description"]
        if method["open_question"]:
            description = f"{description} PROVISIONAL — {method['open_question']}."
        db.add(
            MethodologyVersion(
                component=method["component"],
                version=method["version"],
                effective_from=PROVISIONAL_FROM,
                description=description,
                parameters=method["parameters"],
                is_provisional=is_provisional,
            )
        )
        counts["methodology"] += 1

    db.commit()
    return counts


def seed_demo_block(db: Session) -> None:
    """Create a demo regional block with facilities and users.

    Refuses to run in production: it creates accounts with known passwords.
    """
    if get_settings().is_production:
        raise RuntimeError("Demo seed data must never be loaded into production")

    from amrss.seed.demo import build_demo_block

    build_demo_block(db)


def main() -> None:
    from amrss.db import SessionLocal

    settings = get_settings()
    with SessionLocal() as db:
        counts = seed_reference_data(db)
        print(
            "Reference data loaded: "
            f"{counts['organisms']} organisms, {counts['antibiotics']} antibiotics, "
            f"{counts['specimen_types']} specimen types, "
            f"{counts['methodology']} methodology versions."
        )
        if not settings.is_production:
            seed_demo_block(db)
            print("Demo regional block loaded.")


if __name__ == "__main__":
    main()


def clsi_groups_for(entry: OrganismSeed) -> list[str]:
    """CLSI organism groups for one seeded organism, most specific first.

    The species name leads, then its genus-level group, then Enterobacterales
    where applicable — mirroring how M100 nests species inside broader groups, so
    a species-specific criterion wins over the general one when both exist.

    Derived here at seed time rather than in the interpretation engine. The
    result is stored on the row and edited by administrators from then on; the
    engine only ever reads what the dictionary says (ADR-0002).
    """
    if entry.get("clsi_groups"):
        return list(entry["clsi_groups"])

    groups = [entry["name"]]
    for group in GENUS_CLSI_GROUPS.get(entry["genus"] or "", []):
        if group not in groups:
            groups.append(group)
    if entry["is_enterobacterales"] and ENTEROBACTERALES_GROUP not in groups:
        groups.append(ENTEROBACTERALES_GROUP)
    return groups
