"""Enforcement of ADR-0002: region is configuration, not identity.

The predecessor draft was named and architected around a single region. This test
is what stops that happening again by accident — a developer reaching for a
convenient special case fails the build rather than quietly re-introducing the
coupling that the whole multi-region design exists to avoid.

Region names are permitted in seed data, tests, and documentation. They are not
permitted in application source.
"""

import re
from datetime import date
from pathlib import Path

import pytest

from amrss.analytics import methodology
from amrss.models.enums import MethodologyComponent

APPLICATION_ROOT = Path(__file__).resolve().parent.parent / "amrss"

#: Region and district names that must not appear in application source. Seed data
#: legitimately contains them, so that package is excluded below.
REGION_NAMES = [
    "ahafo",
    "ashanti",
    "greater accra",
    "asunafo",
    "asutifi",
    "tano north",
    "tano south",
    "sech",
    "sjog",
]

#: Directories whose contents may name a region.
EXEMPT = {"seed"}


def application_source_files() -> list[Path]:
    return [
        path
        for path in APPLICATION_ROOT.rglob("*.py")
        if not any(part in EXEMPT for part in path.relative_to(APPLICATION_ROOT).parts)
    ]


@pytest.mark.parametrize("region_name", REGION_NAMES)
def test_no_region_name_appears_in_application_source(region_name: str):
    pattern = re.compile(re.escape(region_name), re.IGNORECASE)
    offenders = [
        str(path.relative_to(APPLICATION_ROOT))
        for path in application_source_files()
        if pattern.search(path.read_text(encoding="utf-8"))
    ]

    assert offenders == [], (
        f"'{region_name}' appears in application source: {offenders}. "
        "Region is a configuration entity (ADR-0002); move this to seed data."
    )


def test_analytics_engine_contains_no_hardcoded_thresholds():
    """ADR-0003: a literal threshold in engine code would produce a statistic
    whose recorded provenance does not match how it was actually computed."""
    engine_root = APPLICATION_ROOT / "analytics"
    suspicious = re.compile(
        r"(minimum_isolates|small_cell_threshold|window_days|"
        r"change_threshold_percentage_points)\s*=\s*\d+"
    )

    offenders = [
        str(path.relative_to(engine_root))
        for path in engine_root.rglob("*.py")
        if suspicious.search(path.read_text(encoding="utf-8"))
    ]

    assert offenders == [], (
        f"Hardcoded methodology values found in {offenders}. "
        "These belong in methodology_version (ADR-0003)."
    )


def test_engine_refuses_to_compute_without_a_methodology_version():
    """Falling back to a built-in default is exactly the failure ADR-0003 exists
    to prevent: a plausible-looking number whose provenance is a lie."""
    empty = methodology.MethodologySet(as_of=date(2026, 8, 8), regional_block_id=None)

    with pytest.raises(methodology.MethodologyNotConfiguredError):
        _ = empty[MethodologyComponent.ANTIBIOGRAM]
