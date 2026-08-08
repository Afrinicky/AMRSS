"""The upload payload contract between the offline uploader and the cloud.

This schema is the security boundary. Direct patient identifiers have no field to
land in, so a defective or tampered client cannot transmit them even by accident —
``extra="forbid"`` rejects any unexpected key rather than quietly ignoring it. A
schema that silently dropped unknown fields would accept a payload containing a
patient name and report success.
"""

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from amrss.models.enums import (
    AgeBand,
    CareSetting,
    OrganismKingdom,
    QcStatus,
    Sex,
    SirResult,
)

#: 64 hex characters — the SHA-256 of the linkage key computed by the uploader.
LinkageKey = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Checksum = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AstResultPayload(Strict):
    antibiotic_code: str = Field(max_length=64)
    result: SirResult
    mic_value: float | None = None
    mic_operator: Literal["<", ">", "<=", ">=", "="] | None = None
    zone_diameter_mm: int | None = Field(default=None, ge=0, le=100)
    test_method: str | None = Field(default=None, max_length=32)


class IsolatePayload(Strict):
    #: Stable identity of the source record, used to detect the same record
    #: arriving twice across incremental uploads.
    source_record_hash: Checksum
    patient_linkage_key: LinkageKey

    specimen_date: date
    age_band: AgeBand
    #: Transmitted only where the regional block has formally approved exact-age
    #: retention. SDD 13.2 is unresolved, so the uploader omits it by default.
    age_exact_years: int | None = Field(default=None, ge=0, le=130)
    sex: Sex
    care_setting: CareSetting

    organism_code: str = Field(max_length=64)
    organism_kingdom: OrganismKingdom
    specimen_type_code: str = Field(max_length=64)

    ast_results: list[AstResultPayload] = Field(default_factory=list)

    @field_validator("ast_results")
    @classmethod
    def reject_duplicate_agents(cls, value: list[AstResultPayload]) -> list[AstResultPayload]:
        codes = [result.antibiotic_code for result in value]
        if len(codes) != len(set(codes)):
            raise ValueError("an antibiotic appears more than once on the same isolate")
        return value


class QcAttestationPayload(Strict):
    """Captured in the same workflow as the upload (SDD 8.2 item 7)."""

    period_start: date
    period_end: date
    status: QcStatus
    corrective_action: str | None = None
    notes: str | None = None


class UploadPayload(Strict):
    """The decrypted body of one transmission."""

    payload_version: Literal["1.0"]
    uploader_version: str = Field(max_length=32)
    facility_code: str = Field(max_length=32)
    whonet_config_version: str | None = Field(default=None, max_length=64)
    ast_breakpoint_standard: str | None = Field(default=None, max_length=64)

    generated_at: datetime
    coverage_start: date
    coverage_end: date

    isolates: list[IsolatePayload]
    qc_attestation: QcAttestationPayload | None = None

    def model_post_init(self, __context: object) -> None:
        if self.coverage_end < self.coverage_start:
            raise ValueError("coverage_end precedes coverage_start")
