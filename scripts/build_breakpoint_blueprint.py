#!/usr/bin/env python3
"""Build a blank breakpoint table in the shape of the printed standard.

    python3 scripts/build_breakpoint_blueprint.py 2026

A **blueprint** is the M100 table with every threshold taken out: every organism
group, every antimicrobial the standard prints against it, both methods where
both are printed, the disk contents, the site and route qualifiers — and not one
number.

It exists because of the gap between "AMRSS ships no breakpoints" and "a
laboratory can start using AMRSS". Those are both true and they used to leave
somebody staring at an empty table with nine hundred rows to invent. What a
laboratory actually holds is a licensed copy of M100 and a person willing to
type from it. The blueprint is the form they type into: export it to a
spreadsheet, fill the S / I / R columns from the printed page, import it back.

**On copyright.** The thresholds are what CLSI licenses, and there are none in
here — that is the entire point of the file. What it carries is the list of
organism groups and antimicrobial agents a susceptibility panel covers, which is
the vocabulary of the discipline rather than anybody's property, and the column
layout AMRSS itself defines. Every value column is empty and every comment that
quoted a printed cell has been removed. See data/breakpoints/README.md.

Where the structure comes from, in order:

1. **The converted table**, if the deployment has one. Its scopes are the
   printed document's scopes, which is a better skeleton than anything written
   by hand here.
2. **The rows that conversion could not read** (`*.not-converted.csv`). A row
   whose number was lost to a bad extraction is exactly a row the blueprint
   should carry: the combination is in the printed table and somebody can read
   the value off the page.
3. **The combinations the source workbook never held at all**, listed below.
   Cefoxitin is the one that matters: it is the standard disk screen for
   methicillin resistance, and a laboratory screening MRSA that way with no
   criterion for it sees every result as pending and no MRSA rate at all.

Run it with no source table and you still get (3) — enough to start from, and
honest about being a fraction of the standard.
"""

from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "breakpoints"

#: The interchange format, defined by data/breakpoints/clsi_m100.template.csv.
COLUMNS = [
    "organism_group",
    "agent_code",
    "method",
    "disk_content",
    "site",
    "route",
    "standard",
    "table_reference",
    "tier",
    "mic_susceptible_max",
    "mic_sdd_min",
    "mic_sdd_max",
    "mic_intermediate_min",
    "mic_intermediate_max",
    "mic_resistant_min",
    "disk_susceptible_min",
    "disk_sdd_min",
    "disk_sdd_max",
    "disk_intermediate_min",
    "disk_intermediate_max",
    "disk_resistant_max",
    "dosage_note",
    "comment",
]

#: Columns a blueprint carries. Everything else is emptied.
STRUCTURAL = {
    "organism_group",
    "agent_code",
    "method",
    "disk_content",
    "site",
    "route",
    "standard",
    "table_reference",
    "tier",
}

#: M100's own order for the organism-group sections, so the blueprint reads
#: down the page the way the printed document does.
GROUP_ORDER = [
    "Enterobacterales",
    "Salmonella and Shigella spp.",
    "Pseudomonas aeruginosa",
    "Acinetobacter spp.",
    "Burkholderia cepacia complex",
    "Stenotrophomonas maltophilia",
    "Other Non-Enterobacterales",
    "Staphylococcus spp.",
    "Enterococcus spp.",
    "Streptococcus pneumoniae",
    "Streptococcus spp. β-Hemolytic Group",
    "Streptococcus spp. Viridans Group",
    "Haemophilus influenzae and Haemophilus parainfluenzae",
    "Neisseria gonorrhoeae",
    "Neisseria meningitidis",
    "Anaerobes",
]

#: Combinations the source extraction never carried, from the analysis in
#: data/breakpoints/README.md. Disk contents are the potencies M100 prints; they
#: are part of the test's identity, not a threshold — a 30 µg gentamicin disk
#: and a 10 µg one are different tests with different numbers, so a blueprint
#: that omitted the potency would be a form you cannot fill in correctly.
SUPPLEMENT: list[tuple[str, str, str, str]] = [
    # Staphylococcus spp. — Table 2C.
    ("Staphylococcus spp.", "FOX", "DISK", "30 µg"),
    ("Staphylococcus spp.", "FOX", "MIC", ""),
    ("Staphylococcus spp.", "ERY", "DISK", "15 µg"),
    ("Staphylococcus spp.", "ERY", "MIC", ""),
    ("Staphylococcus spp.", "GEN", "DISK", "10 µg"),
    ("Staphylococcus spp.", "GEN", "MIC", ""),
    ("Staphylococcus spp.", "TEC", "MIC", ""),
    ("Staphylococcus spp.", "DAP", "MIC", ""),
    # Enterococcus spp. — Table 2D. Gentamicin here is the high-level
    # synergy screen, which is a different test from the 10 µg disk above.
    ("Enterococcus spp.", "GEN", "DISK", "120 µg"),
    ("Enterococcus spp.", "GEN", "MIC", ""),
    ("Enterococcus spp.", "TEC", "MIC", ""),
    ("Enterococcus spp.", "DAP", "MIC", ""),
    # Pseudomonas aeruginosa — Table 2B-1.
    ("Pseudomonas aeruginosa", "GEN", "DISK", "10 µg"),
    ("Pseudomonas aeruginosa", "GEN", "MIC", ""),
    # Polymyxins. MIC only: CLSI gives no disk correlate for either agent,
    # and a blueprint row for a test the standard does not recognise would be
    # a place to enter a number that should not exist.
    ("Enterobacterales", "COL", "MIC", ""),
    ("Enterobacterales", "PMB", "MIC", ""),
    ("Pseudomonas aeruginosa", "COL", "MIC", ""),
    ("Pseudomonas aeruginosa", "PMB", "MIC", ""),
    ("Acinetobacter spp.", "COL", "MIC", ""),
    ("Acinetobacter spp.", "PMB", "MIC", ""),
]

#: Which M100 table each organism group's rows cite, for the blueprint's
#: table_reference column when the source has none to copy.
TABLE_REFERENCE = {
    "Enterobacterales": "2A-1",
    "Salmonella and Shigella spp.": "2A-2",
    "Pseudomonas aeruginosa": "2B-1",
    "Acinetobacter spp.": "2B-2",
    "Burkholderia cepacia complex": "2B-3",
    "Stenotrophomonas maltophilia": "2B-4",
    "Other Non-Enterobacterales": "2B-5",
    "Staphylococcus spp.": "2C",
    "Enterococcus spp.": "2D",
    "Streptococcus pneumoniae": "2G",
    "Streptococcus spp. β-Hemolytic Group": "2H-1",
    "Streptococcus spp. Viridans Group": "2H-2",
    "Haemophilus influenzae and Haemophilus parainfluenzae": "2E",
    "Neisseria gonorrhoeae": "2F",
    "Neisseria meningitidis": "2I",
    "Anaerobes": "2J",
}


def scope(row: dict[str, str]) -> tuple[str, str, str, str, str]:
    """A criterion's identity, matching amrss_clsi.breakpoints and the
    uploader's criterionKey. Disk content is deliberately not part of it: the
    platform's importer refuses two rows that differ only in potency."""
    return (
        row.get("organism_group", "").strip(),
        row.get("agent_code", "").strip().upper(),
        row.get("method", "").strip().upper(),
        row.get("site", "").strip().lower(),
        row.get("route", "").strip().lower(),
    )


def blank(row: dict[str, str], note: str) -> dict[str, str]:
    """One blueprint row: the scope kept, every number gone."""
    out = {column: "" for column in COLUMNS}
    for column in STRUCTURAL:
        out[column] = row.get(column, "").strip()
    out["agent_code"] = out["agent_code"].upper()
    out["method"] = out["method"].upper()
    out["standard"] = out["standard"] or "CLSI M100"
    out["table_reference"] = out["table_reference"] or TABLE_REFERENCE.get(
        out["organism_group"], ""
    )
    out["comment"] = note
    return out


def from_source(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        rows = [row for row in csv.DictReader(handle) if row.get("organism_group")]
    return [blank(row, "Blueprint row — enter the thresholds from your licensed M100.") for row in rows]


#: "Enterobacterales · Colistin (MIC)" — the combination column of the
#: not-converted report. The agent is given by its printed name, which has to be
#: matched back to a code; the source table is the only place that mapping
#: exists, so a name with no code in it is skipped rather than guessed at.
COMBINATION = re.compile(r"^(?P<group>.+?)\s+·\s+(?P<agent>.+?)\s+\((?P<method>MIC|DISK|GRADIENT)\)$")


def from_not_converted(path: Path, agent_codes: dict[str, str]) -> list[dict[str, str]]:
    """Rows the extraction damaged past reading, restored as blank scopes.

    Their numbers were never recoverable from the workbook — but the
    combination is in the printed table, and a person with the page open can
    supply what the extraction lost. That is precisely the job a blueprint does.
    """
    if not path.exists():
        return []
    out: list[dict[str, str]] = []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            match = COMBINATION.match(row.get("combination", "").strip())
            if not match:
                continue
            code = agent_codes.get(match["agent"].strip().lower())
            if code is None:
                print(
                    f"  ? no code for {match['agent']!r}; left out of the blueprint",
                    file=sys.stderr,
                )
                continue
            group = match["group"].strip()
            out.append(
                blank(
                    {
                        "organism_group": group,
                        "agent_code": code,
                        "method": match["method"],
                        "standard": "CLSI M100",
                        "table_reference": TABLE_REFERENCE.get(group, ""),
                    },
                    "Blueprint row — the conversion could not read this one; "
                    "read it off the printed table.",
                )
            )
    return out


def from_supplement() -> list[dict[str, str]]:
    return [
        blank(
            {
                "organism_group": group,
                "agent_code": code,
                "method": method,
                "disk_content": content,
                "standard": "CLSI M100",
                "table_reference": TABLE_REFERENCE.get(group, ""),
            },
            "Blueprint row — printed in M100 but absent from the converted "
            "table; enter it from your licensed copy.",
        )
        for group, code, method, content in SUPPLEMENT
    ]


def agent_code_index(path: Path) -> dict[str, str]:
    """Printed agent name → AMRSS code, learned from the source table's own
    comments, which quote the printed row verbatim."""
    index: dict[str, str] = {}
    if not path.exists():
        return index
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            code = row.get("agent_code", "").strip().upper()
            if code:
                index.setdefault(code.lower(), code)
    # The not-converted report names agents as M100 prints them. Only the ones
    # that report actually mentions need mapping, so the list is short and
    # explicit rather than a fuzzy match that could put a threshold on the
    # wrong drug.
    index.update(
        {
            "colistin": "COL",
            "polymyxin b": "PMB",
            "trimethoprim-sulfamethoxazole": "SXT",
            "sulfamethoxazole": "SMX",
            "ceftriaxone": "CRO",
            "cefixime": "CFM",
            "ciprofloxacin": "CIP",
            "levofloxacin": "LVX",
            "ofloxacin": "OFX",
            "daptomycin": "DAP",
        }
    )
    return index


def main() -> int:
    edition = sys.argv[1] if len(sys.argv) > 1 else "2026"
    source = DATA / "clsi_m100_ed36.csv"
    dropped = DATA / "clsi_m100_ed36.not-converted.csv"
    target = DATA / f"clsi_m100_blueprint_{edition}.csv"

    rows: list[dict[str, str]] = []
    seen: set[tuple[str, str, str, str, str]] = set()
    for batch, label in (
        (from_source(source), "converted table"),
        (from_not_converted(dropped, agent_code_index(source)), "rows conversion lost"),
        (from_supplement(), "rows the workbook never held"),
    ):
        added = 0
        for row in batch:
            key = scope(row)
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
            added += 1
        print(f"  {added:>4} from {label}")

    rank = {group: index for index, group in enumerate(GROUP_ORDER)}
    rows.sort(
        key=lambda row: (
            rank.get(row["organism_group"], len(GROUP_ORDER)),
            row["organism_group"],
            row["agent_code"],
            row["method"],
            row["site"],
            row["route"],
        )
    )

    with target.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    groups = len({row["organism_group"] for row in rows})
    agents = len({row["agent_code"] for row in rows})
    print(f"\n{target.relative_to(ROOT)}")
    print(f"  {len(rows)} rows, {groups} organism groups, {agents} antimicrobial agents")
    print("  every threshold column empty, by design")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
