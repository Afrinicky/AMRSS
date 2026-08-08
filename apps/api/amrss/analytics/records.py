"""In-memory shapes the analytics engine computes over.

The engine loads eligible isolates and then computes in Python rather than
pushing everything into one large SQL statement. Deduplication is a rolling-window
walk per patient that SQL expresses poorly, the intermediate stages need to be
independently testable, and — most importantly — an epidemiologist reviewing a
disputed number should be able to read the rule that produced it.
"""

import uuid
from dataclasses import dataclass
from datetime import date

from amrss.models.enums import AgeBand, CareSetting, OrganismKingdom, Sex, SirResult


@dataclass(frozen=True, slots=True)
class IsolateRecord:
    """One de-identified isolate with its AST panel, ready for computation."""

    id: uuid.UUID
    facility_id: uuid.UUID
    district_id: uuid.UUID
    specimen_date: date
    organism_id: uuid.UUID
    organism_kingdom: OrganismKingdom
    specimen_type_id: uuid.UUID
    care_setting: CareSetting
    age_band: AgeBand
    sex: Sex
    patient_linkage_key: bytes
    #: True when the contributing facility's QC and EQA were both current and
    #: satisfactory, per the gating rule (SDD 6.6). Carried per isolate so a
    #: single pass can produce both the verified aggregate and the count of what
    #: gating excluded, rather than requiring a second query to explain itself.
    quality_verified: bool
    results: dict[uuid.UUID, SirResult]


@dataclass(frozen=True, slots=True)
class DictionaryEntry:
    id: uuid.UUID
    code: str
    name: str


@dataclass(frozen=True, slots=True)
class AntibioticEntry:
    id: uuid.UUID
    code: str
    name: str
    antimicrobial_class: str
    display_order: int
