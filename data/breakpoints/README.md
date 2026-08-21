# Breakpoint tables

| File | What it is |
|---|---|
| `clsi_m100_blueprint_2026.csv` | **The blueprint** — the printed table's shape with every threshold removed. 736 rows, 15 organism groups, 98 agents, no values. Ships with every build; carries nothing licensed. Start here. |
| `clsi_m100.template.csv` | The interchange format, with its columns documented inline and illustrative rows that are **not** CLSI values. |
| `clsi_m100_ed36.csv` | CLSI M100 36th edition (2026), converted for AMRSS. 707 criteria, 15 organism groups, 95 agents. Carries CLSI's numbers — read *Licensing* below. |
| `clsi_m100_ed36.not-converted.csv` | The 16 rows of the source workbook that could not be read, and why. |

---

## The blueprint

AMRSS ships no breakpoints, and for a long time that meant a laboratory with no
licensed file to hand had an empty screen and nine hundred rows to invent. Both
halves of that were true and together they were a dead end.

The blueprint is the way out. It is the M100 table with the numbers taken out:
every organism group, every antimicrobial the standard prints against it, both
methods where both are printed, the disk potencies, the site and route
qualifiers — **and not one threshold**. It is a form.

```
organism_group,agent_code,method,disk_content,...,disk_susceptible_min,...
Enterobacterales,AMP,DISK,10 µg,...,,...
Enterobacterales,AMP,MIC,,...,,...
```

**On copyright.** What CLSI licenses is the thresholds, and there are none here
— that is the entire point of the file. What it carries is the list of organism
groups and agents a susceptibility panel covers, which is the vocabulary of the
discipline, and the column layout AMRSS itself defines. Every value column is
empty and every comment that quoted a printed cell has been removed. A test
(`apps/uploader/src/test/breakpoints.test.ts`) checks every row of every value
column on every build, because a single leaked number is exactly the kind of
thing a spot check misses.

### The loop it makes possible

1. **Load it.** Breakpoints → *Start from the blank CLSI layout*. The page fills
   with rows whose thresholds are waiting.
2. **Take it to a spreadsheet.** *Export as Excel* writes the table plus a sheet
   explaining which column is which and which way round zones and MICs run.
3. **Fill it in** from your own licensed M100, beside the printed page.
4. **Bring it back.** *Import a table* reads that workbook — or the CSV —
   straight back. Same columns, same order, nothing to rework by hand.

Typing straight into the page works too, and is the better route for a
correction to one threshold.

A blank row is safe to hold and impossible to be misled by: the engine selects
on thresholds, so a row with none never matches and the measurement stays `PI`
— measured, pending interpretation. What is refused, in the editor and at
import, is a *half*-filled row: an intermediate band with no bounds either side
looks like coverage and is not.

### A new year

A new edition is a new table, not an edit to the old one — every result already
interpreted cites the version it was interpreted under, so changing a threshold
inside a published edition would silently rewrite what past antibiograms mean.

*New edition…* carries the structure forward and blanks every number, so the
day's work is entering what changed rather than retyping what did not. To
regenerate the shipped blueprint against a new source table:

```bash
python3 scripts/build_breakpoint_blueprint.py 2027
```

### Who may fill it in

Breakpoints are national. The superadmin publishes the table the whole
programme interprets against; a facility reads it and cannot edit it, unless
the superadmin has granted that facility an override — recorded against the
facility, with a stated reason, in the audit trail. On publication, rows nobody
has typed into are held back rather than published as coverage that does not
exist, and stay in the draft to be finished.

**Read "What is missing" below before relying on this table.** It does not
cover cefoxitin, erythromycin or gentamicin for staphylococci, or colistin for
any organism, and those are combinations a laboratory reports every day.

---

## Licensing

**CLSI M100 is copyrighted by the Clinical and Laboratory Standards Institute.**
`clsi_m100_ed36.csv` is derived from a licensed copy of the 36th edition,
included here at the programme owner's direction. Whether you may use, copy or
redistribute it depends on your own licence with CLSI, not on this
repository's licence, and nothing here grants you rights to it.

If your deployment cannot rely on that, delete the file and import from your own
licensed copy instead. Nothing in the software depends on its presence: with no
table loaded, measurements read as `PI` — measured, pending interpretation.

---

## What "converted" means

The workbook a laboratory holds is an extraction of a printed document, and
extractions of printed documents are lossy in specific, repeatable ways. The
converter (`apps/uploader/src/core/m100.ts`, and
`apps/api/amrss/analytics/m100_workbook.py` on the platform) is conservative
about every one of them, and **no value was altered**: every threshold is the
number the printed table gives, and every row carries the printed cell verbatim
in its `comment` column —

```
Zone as printed: S ≥17, I 14-16^, R ≤13. (5) Results of ampicillin testing…
```

so any row can be checked against the published table without re-reading the
workbook.

Some rows the extraction split at the wrong character — every operator stuck to
the end of the cell before it, so the gentamicin row read
`"µg ≥" | "18" | "– 15-17^" | "≤" | "14 ≤" | "2"` where the row three lines
below it, printed identically, read `"30 µg" | "≥18" | "–" | "15-17^" | "≤14"`.
Those are re-split rather than dropped: the characters are the same and in the
same order, only the cell boundaries were wrong, and the result is accepted only
if it yields exactly as many values as the table has columns. That recovers
gentamicin, tobramycin and amikacin against Enterobacterales, which a
surveillance antibiogram is mostly made of.

---

## What is missing

Two different things, and the difference matters.

### Rows the extraction damaged past reading

`clsi_m100_ed36.not-converted.csv` is the full list of 16. The categories:

- **A value lost.** `≤` with no number. The Enterobacterales
  trimethoprim-sulfamethoxazole MIC row, two *Neisseria gonorrhoeae* cephalosporin
  rows, one β-haemolytic streptococcal row.
- **Columns offset by one.** *Pseudomonas* and *Acinetobacter* colistin read
  `I ≤2`, which is a susceptible bound that has moved one column right.
  Interpreting it where it landed would call resistant isolates intermediate.
- **Neither bound.** The *Haemophilus* sulfamethoxazole row carries only an
  intermediate band; every measurement above and below it would be
  unclassifiable.
- **One heading, two sub-groups.** M100 prints ciprofloxacin, levofloxacin and
  ofloxacin twice under "Salmonella and Shigella spp." with different
  thresholds, and the sub-heading that separated them is not in the extraction.
  **Both** copies are left out: keeping one would pick a threshold by row order.

### Rows the source workbook never carried

These are not conversion failures. The extraction of Table 2C and Table 2D
simply has no row for them, so there is nothing to convert:

| Organism group | Not in the table |
|---|---|
| *Staphylococcus* spp. | cefoxitin, erythromycin, gentamicin, teicoplanin, daptomycin |
| *Enterococcus* spp. | gentamicin, teicoplanin, daptomycin |
| *Pseudomonas aeruginosa* | gentamicin |
| Every organism | colistin (the rows that exist are damaged, above) |

**Cefoxitin is the one to notice.** It is the standard disk screen for
methicillin resistance, and without a criterion for it a laboratory screening
MRSA that way will see every result as `PI` — measured, pending interpretation —
and no MRSA rate at all. Oxacillin *is* covered, so a laboratory that screens on
oxacillin is unaffected.

**The blueprint carries all of them.** That is what it is for: every row above
is in `clsi_m100_blueprint_2026.csv` as an empty scope waiting for its numbers,
so filling the gap is typing a threshold rather than reconstructing a row.
Failing that, each can be added by hand in the uploader's **Breakpoints**
module or on the platform at **/console/admin/breakpoints**; both editors
validate what you type exactly as the file importer does. The gaps are pinned
by a test
(`apps/uploader/src/test/breakpoints.test.ts`), so a future change to the
converter that loses more than this fails rather than passing quietly.

---

## Loading it

**Platform.** From the console at **/console/admin/breakpoints**, through
`POST /api/v1/breakpoints/import`, or from the host:

```bash
python -m amrss.cli import-breakpoints M100-Ed36 "CLSI M100 36th ed. (2026)" \
  data/breakpoints/clsi_m100_ed36.csv --effective-from 2026-01-01
```

The command is the way to load a table on a deployment being set up, before
anyone has a browser session.

**Uploader.** Settings → Breakpoints → **Import a table**, and choose this file.
A copy is installed beside the application, so *Load the supplied CLSI M100
table* does the same thing without a file dialogue.

Either way the import is validated before anything is stored — inverted bounds,
overlapping bands, duplicate scopes, zones outside what a disk test produces —
and a single error blocks the whole table. This file passes with no errors and
38 warnings, all of them either an SDD band whose dosing note the extraction
lost, or a CLSI value that is not on the doubling-dilution series (0.06, 0.12).
