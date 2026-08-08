from __future__ import annotations

import os
from decimal import Decimal

import pytest

from amrss.core.crypto import generate_key

# Settings are read at import time by several modules; populate the environment
# before anything imports amrss.config.
os.environ.setdefault("AMRSS_ENVIRONMENT", "test")
os.environ.setdefault("AMRSS_DATABASE_URL", "postgresql+psycopg://amrss:amrss@localhost/amrss_test")
os.environ.setdefault("AMRSS_JWT_SECRET", generate_key())
os.environ.setdefault("AMRSS_FIELD_ENCRYPTION_KEY", generate_key())
os.environ.setdefault("AMRSS_PSEUDONYM_HMAC_KEY", generate_key())

from amrss.clsi.breakpoints import Breakpoint, BreakpointSet, Method, Tier  # noqa: E402

TEST_SET_VERSION = "TEST-SET-v1"


def mic_breakpoint(
    organism_group: str,
    agent_code: str,
    *,
    s_max: str | None = None,
    r_min: str | None = None,
    i_range: tuple[str, str] | None = None,
    sdd_range: tuple[str, str] | None = None,
    site: str | None = None,
    tier: Tier = Tier.UNSPECIFIED,
    dosage_note: str | None = None,
) -> Breakpoint:
    """Build an MIC breakpoint from illustrative, non-CLSI values."""
    return Breakpoint(
        set_version=TEST_SET_VERSION,
        standard="TEST",
        table_reference="Fixture",
        organism_group=organism_group,
        agent_code=agent_code,
        method=Method.MIC,
        site=site,
        dosage_note=dosage_note,
        mic_susceptible_max=Decimal(s_max) if s_max else None,
        mic_resistant_min=Decimal(r_min) if r_min else None,
        mic_intermediate_min=Decimal(i_range[0]) if i_range else None,
        mic_intermediate_max=Decimal(i_range[1]) if i_range else None,
        mic_sdd_min=Decimal(sdd_range[0]) if sdd_range else None,
        mic_sdd_max=Decimal(sdd_range[1]) if sdd_range else None,
        tier=tier,
    )


def disk_breakpoint(
    organism_group: str,
    agent_code: str,
    *,
    s_min: int | None = None,
    r_max: int | None = None,
    i_range: tuple[int, int] | None = None,
    tier: Tier = Tier.UNSPECIFIED,
) -> Breakpoint:
    return Breakpoint(
        set_version=TEST_SET_VERSION,
        standard="TEST",
        table_reference="Fixture",
        organism_group=organism_group,
        agent_code=agent_code,
        method=Method.DISK,
        disk_content="5 µg",
        disk_susceptible_min=s_min,
        disk_resistant_max=r_max,
        disk_intermediate_min=i_range[0] if i_range else None,
        disk_intermediate_max=i_range[1] if i_range else None,
        tier=tier,
    )


@pytest.fixture
def breakpoint_set() -> BreakpointSet:
    """A small fixture set.

    The numbers here are invented for testing the engine's logic. They are not
    CLSI values and must never be used clinically.
    """
    return BreakpointSet(
        version=TEST_SET_VERSION,
        source_edition="Synthetic fixture data - not for clinical use",
        breakpoints=[
            # Classic S / I / R layout with an implied intermediate gap.
            mic_breakpoint("Enterobacterales", "CIP", s_max="0.25", r_min="1", tier=Tier.TIER_1),
            # Explicit intermediate range.
            mic_breakpoint(
                "Enterobacterales",
                "GEN",
                s_max="2",
                i_range=("4", "4"),
                r_min="8",
                tier=Tier.TIER_1,
            ),
            # Susceptible-only criterion -> S or NS, never I.
            mic_breakpoint("Enterobacterales", "TGC", s_max="2", tier=Tier.TIER_3),
            # SDD category.
            mic_breakpoint(
                "Enterobacterales",
                "FEP",
                s_max="2",
                sdd_range=("4", "8"),
                r_min="16",
                dosage_note="1 g q8h or 2 g q12h",
                tier=Tier.TIER_2,
            ),
            # Species-specific criterion that must beat the family-level one.
            mic_breakpoint("Escherichia coli", "CIP", s_max="0.06", r_min="0.5"),
            # Site-specific criterion.
            mic_breakpoint("Streptococcus pneumoniae", "PEN", s_max="2", r_min="8"),
            mic_breakpoint(
                "Streptococcus pneumoniae",
                "PEN",
                s_max="0.06",
                r_min="0.12",
                site="meningitis",
            ),
            # Disk criteria.
            disk_breakpoint("Enterobacterales", "CIP", s_min=26, r_max=21, tier=Tier.TIER_1),
            disk_breakpoint("Enterobacterales", "AMP", s_min=17, r_max=13, tier=Tier.TIER_1),
        ],
    )
