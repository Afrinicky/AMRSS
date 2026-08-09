from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from amrss_clsi.breakpoints import MAX_PLAUSIBLE_ZONE_MM, NO_ZONE_MM, Method


class InterpretRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    organism_code: str = Field(min_length=1, max_length=20)
    agent_code: str = Field(min_length=1, max_length=10)
    method: Method
    # Free text because "<=0.25" is a legitimate MIC; parsed and validated by
    # amrss_clsi.mic.MICValue.parse, which rejects anything else.
    mic: str | None = Field(default=None, max_length=20)
    zone_mm: int | None = Field(default=None, ge=NO_ZONE_MM, le=MAX_PLAUSIBLE_ZONE_MM)
    site: str | None = Field(default=None, max_length=40)
    route: str | None = Field(default=None, max_length=20)
    breakpoint_set_version: str | None = Field(default=None, max_length=60)


class InterpretResponse(BaseModel):
    category: str
    method: Method
    interpretable: bool
    requires_review: bool
    breakpoint_set_version: str | None = None
    table_reference: str | None = None
    organism_group: str | None = None
    tier: str | None = None
    reason: str | None = None
    comments: list[str] = []


class BreakpointSetSummary(BaseModel):
    version: str
    source_edition: str
    standard_body: str
    is_active: bool
    breakpoint_count: int
    activated_at: str | None = None
