"""Importing a laboratory's licensed CLSI breakpoint table.

No breakpoint values ship with AMRSS. CLSI M100 tables are copyrighted, revised
every edition, and a single mistyped threshold turns an R into an S on a real
patient's report. The laboratory populates
``data/breakpoints/clsi_m100.template.csv`` from its own licensed copy, and this
module turns that file into a versioned methodology row.

Validation runs before anything is stored, and any *error* blocks the import
outright. That is the point of the module: it is the last barrier between a
spreadsheet transcription mistake and a clinical report. Warnings are surfaced
but do not block, because a table can legitimately be incomplete — a laboratory
that tests twelve agents has no reason to load criteria for ninety.
"""

import csv
import io
import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

from amrss_clsi.breakpoints import (
    Breakpoint,
    Method,
    Tier,
    ValidationIssue,
    validate_breakpoints,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from amrss.models import CanonicalAntibiotic, MethodologyVersion
from amrss.models.enums import MethodologyComponent

#: Columns the engine needs. Everything else in the template is optional, so a
#: laboratory that only records disk criteria need not fill the MIC columns.
#: `standard` is required rather than defaulted: M100, M45 and M60 give
#: different criteria for the same organism-agent pair, and a criterion that
#: cannot say which document it came from cannot be audited.
REQUIRED_COLUMNS = ("organism_group", "agent_code", "method", "standard")

_DECIMAL_COLUMNS = (
    "mic_susceptible_max",
    "mic_sdd_min",
    "mic_sdd_max",
    "mic_intermediate_min",
    "mic_intermediate_max",
    "mic_resistant_min",
)
_INT_COLUMNS = (
    "disk_susceptible_min",
    "disk_sdd_min",
    "disk_sdd_max",
    "disk_intermediate_min",
    "disk_intermediate_max",
    "disk_resistant_max",
)


def agent_lookup(db: Session) -> dict[str, str]:
    """Agent names and CLSI aliases, lower-cased, mapped to dictionary codes.

    Read from the dictionary rather than declared in code, so a laboratory that
    adds an agent — or records the spelling its own CLSI table uses in
    ``clsi_agent_code`` — can import a table naming it without a deployment
    (ADR-0002).
    """
    lookup: dict[str, str] = {}
    for antibiotic in db.scalars(select(CanonicalAntibiotic)):
        for alias in (antibiotic.name, antibiotic.clsi_agent_code, antibiotic.code):
            if alias:
                lookup[alias.strip().lower()] = antibiotic.code
    return lookup


class BreakpointImportError(ValueError):
    """The table was not imported. Carries every problem, not just the first.

    Reporting one error at a time would turn correcting a nine-hundred-row
    transcription into nine hundred round trips.
    """

    def __init__(self, problems: list[str]) -> None:
        super().__init__(f"{len(problems)} problem(s) blocked the import")
        self.problems = problems


@dataclass
class ImportResult:
    version: str
    source_edition: str
    imported: int
    warnings: list[str]


def _clean(row: dict[str, str]) -> dict[str, str]:
    return {(k or "").strip(): (v or "").strip() for k, v in row.items()}


def parse_breakpoint_csv(text: str, *, version: str) -> tuple[list[dict], list[str]]:
    """Parse the template CSV into breakpoint rows, collecting every problem.

    Comment lines beginning with ``#`` are skipped: the template carries its own
    instructions inline, and a laboratory should not have to strip them out
    before importing.
    """
    body = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    reader = csv.DictReader(io.StringIO(body))
    if reader.fieldnames is None:
        raise BreakpointImportError(["the file has no header row"])

    missing = [c for c in REQUIRED_COLUMNS if c not in reader.fieldnames]
    if missing:
        raise BreakpointImportError([f"missing required column: {c}" for c in missing])

    rows: list[dict] = []
    problems: list[str] = []

    for line_number, raw in enumerate(reader, start=2):
        row = _clean(raw)
        if not any(row.get(c) for c in REQUIRED_COLUMNS):
            continue  # blank line

        for column in REQUIRED_COLUMNS:
            if not row.get(column):
                problems.append(f"line {line_number}: {column} is required")

        try:
            Method(row.get("method", ""))
        except ValueError:
            problems.append(
                f"line {line_number}: method {row.get('method')!r} is not one of "
                f"{', '.join(m.value for m in Method)}"
            )

        if row.get("tier"):
            try:
                Tier(row["tier"])
            except ValueError:
                problems.append(f"line {line_number}: tier {row['tier']!r} is not a CLSI tier")

        entry: dict = {k: (v or None) for k, v in row.items()}
        for column in _DECIMAL_COLUMNS:
            value = row.get(column)
            if not value:
                entry[column] = None
                continue
            try:
                entry[column] = str(Decimal(value))
            except InvalidOperation:
                problems.append(f"line {line_number}: {column} {value!r} is not a number")
        for column in _INT_COLUMNS:
            value = row.get(column)
            if not value:
                entry[column] = None
                continue
            try:
                entry[column] = int(value)
            except ValueError:
                problems.append(f"line {line_number}: {column} {value!r} is not a whole number")

        rows.append(entry)

    if problems:
        raise BreakpointImportError(problems)

    # Structural validation from the shared engine: overlapping ranges, inverted
    # bounds, duplicate criteria, MICs off the doubling-dilution series.
    engine_issues = validate_breakpoints(
        [
            Breakpoint(
                organism_group=r["organism_group"],
                agent_code=r["agent_code"],
                method=Method(r["method"]),
                standard=r["standard"],
                set_version=version,
                table_reference=r.get("table_reference"),
                tier=Tier(r["tier"]) if r.get("tier") else Tier.UNSPECIFIED,
                site=r.get("site"),
                route=r.get("route"),
                disk_content=r.get("disk_content"),
                **{c: (Decimal(r[c]) if r.get(c) else None) for c in _DECIMAL_COLUMNS},
                **{c: r.get(c) for c in _INT_COLUMNS},
            )
            for r in rows
        ]
    )

    def _at(issue: ValidationIssue) -> str:
        # The engine indexes its own list; a laboratory is looking at a
        # spreadsheet, so report the line number in the file they submitted.
        return f"line {issue.breakpoint_index + 2}: {issue.message}"

    errors = [_at(i) for i in engine_issues if i.severity == "error"]
    if errors:
        raise BreakpointImportError(errors)

    warnings = [_at(i) for i in engine_issues if i.severity != "error"]
    return rows, warnings


def import_breakpoints(
    db: Session,
    text: str,
    *,
    version: str,
    source_edition: str,
    effective_from: date,
    regional_block_id: uuid.UUID | None = None,
    description: str = "",
    commit: bool = True,
) -> ImportResult:
    """Store a parsed table as a versioned methodology row.

    Stored as methodology rather than its own table so a breakpoint edition is
    versioned, dated and scoped exactly like every other rule that shapes a
    published number (ADR-0003) — and so an antibiogram computed today remains
    explicable after the laboratory adopts the next edition.
    """
    rows, warnings = parse_breakpoint_csv(text, version=version)

    existing = db.scalar(
        select(MethodologyVersion).where(
            MethodologyVersion.component == MethodologyComponent.AST_BREAKPOINTS,
            MethodologyVersion.version == version,
            MethodologyVersion.regional_block_id == regional_block_id,
        )
    )
    if existing is not None:
        raise BreakpointImportError(
            [
                f"breakpoint version {version!r} already exists for this scope. "
                "Import under a new version rather than editing a published one — "
                "results already interpreted cite this version."
            ]
        )

    db.add(
        MethodologyVersion(
            component=MethodologyComponent.AST_BREAKPOINTS,
            version=version,
            description=description or f"CLSI breakpoints imported from {source_edition}",
            effective_from=effective_from,
            regional_block_id=regional_block_id,
            is_provisional=False,
            parameters={
                "label": source_edition,
                "breakpoints": rows,
            },
        )
    )
    if commit:
        db.commit()

    return ImportResult(
        version=version,
        source_edition=source_edition,
        imported=len(rows),
        warnings=warnings,
    )
