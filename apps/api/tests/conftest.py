import uuid
from datetime import date

import pytest

from amrss.analytics.methodology import MethodologySet, ResolvedMethodology
from amrss.analytics.records import IsolateRecord
from amrss.models.enums import (
    AgeBand,
    CareSetting,
    MethodologyComponent,
    OrganismKingdom,
    Sex,
    SirResult,
)

ORGANISM_A = uuid.UUID("00000000-0000-0000-0000-0000000000a1")
ORGANISM_B = uuid.UUID("00000000-0000-0000-0000-0000000000a2")
YEAST = uuid.UUID("00000000-0000-0000-0000-0000000000a3")
DRUG_X = uuid.UUID("00000000-0000-0000-0000-0000000000b1")
DRUG_Y = uuid.UUID("00000000-0000-0000-0000-0000000000b2")
FACILITY_1 = uuid.UUID("00000000-0000-0000-0000-0000000000c1")
FACILITY_2 = uuid.UUID("00000000-0000-0000-0000-0000000000c2")
DISTRICT_1 = uuid.UUID("00000000-0000-0000-0000-0000000000d1")


def make_methodology(**overrides: object) -> MethodologySet:
    """A methodology set with small, explicit values.

    Tests state the thresholds they depend on rather than inheriting the seeded
    provisional defaults, so a future change to those defaults cannot silently
    invalidate a test's premise.
    """
    parameters: dict[MethodologyComponent, dict] = {
        MethodologyComponent.ANTIBIOGRAM: {
            "minimum_isolates": 30,
            "confidence_level": 0.95,
            "modest_n_ceiling": 100,
        },
        MethodologyComponent.DEDUPLICATION: {"window_days": 30, "scope": "facility"},
        MethodologyComponent.SUPPRESSION: {"small_cell_threshold": 5},
        MethodologyComponent.EMERGING_SIGNAL_TRIGGER: {
            "baseline_window_days": 84,
            "current_window_days": 28,
            "minimum_n_per_window": 15,
            "change_threshold_percentage_points": 15.0,
        },
        MethodologyComponent.PHENOTYPE_FLAGS: {"rules": []},
        MethodologyComponent.AST_BREAKPOINTS: {"label": "Test breakpoints"},
    }
    for key, value in overrides.items():
        component = MethodologyComponent(key)
        parameters[component] = {**parameters.get(component, {}), **value}  # type: ignore[dict-item]

    result = MethodologySet(as_of=date(2026, 8, 8), regional_block_id=None)
    for component, params in parameters.items():
        result._resolved[component] = ResolvedMethodology(
            id=uuid.uuid4(),
            component=component,
            version="test",
            description="test",
            is_provisional=False,
            parameters=params,
        )
    return result


def make_isolate(
    *,
    specimen_date: date,
    results: dict[uuid.UUID, SirResult],
    organism_id: uuid.UUID = ORGANISM_A,
    facility_id: uuid.UUID = FACILITY_1,
    patient: str = "patient-1",
    quality_verified: bool = True,
    kingdom: OrganismKingdom = OrganismKingdom.BACTERIA,
    isolate_id: uuid.UUID | None = None,
) -> IsolateRecord:
    return IsolateRecord(
        id=isolate_id or uuid.uuid4(),
        facility_id=facility_id,
        district_id=DISTRICT_1,
        specimen_date=specimen_date,
        organism_id=organism_id,
        organism_kingdom=kingdom,
        specimen_type_id=uuid.UUID("00000000-0000-0000-0000-0000000000e1"),
        care_setting=CareSetting.INPATIENT,
        age_band=AgeBand.FROM_15_TO_44,
        sex=Sex.FEMALE,
        patient_linkage_key=patient.encode().ljust(32, b"\0"),
        quality_verified=quality_verified,
        results=results,
    )


@pytest.fixture
def methodology() -> MethodologySet:
    return make_methodology()
