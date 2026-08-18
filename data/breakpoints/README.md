# Breakpoint tables

| File | What it is |
|---|---|
| `clsi_m100.template.csv` | The interchange format, with its columns documented inline and illustrative rows that are **not** CLSI values. Start here to build a table by hand. |
| `clsi_m100_ed36.csv` | CLSI M100 36th edition (2026), converted for AMRSS. 707 criteria, 15 organism groups, 95 agents. |
| `clsi_m100_ed36.not-converted.csv` | The 16 rows of the source workbook that could not be read, and why. |

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

Each of these is a row to add by hand from the printed table — in the uploader's
**Settings → Breakpoints**, or on the platform at
**/console/admin/breakpoints**. Both editors validate what you type exactly as
the file importer does. The gaps are pinned by a test
(`apps/uploader/src/test/breakpoints.test.ts`), so a future change to the
converter that loses more than this fails rather than passing quietly.

---

## Loading it

**Platform.** `POST /api/v1/breakpoints/import` with the CSV, a version, the
source edition and an effective date; or the CLI:

```bash
python -m amrss.cli import-breakpoints M100-Ed36 "CLSI M100 36th ed. (2026)" \
  data/breakpoints/clsi_m100_ed36.csv
```

**Uploader.** Settings → Breakpoints → **Import a table**, and choose this file.
A copy is installed beside the application, so *Load the supplied CLSI M100
table* does the same thing without a file dialogue.

Either way the import is validated before anything is stored — inverted bounds,
overlapping bands, duplicate scopes, zones outside what a disk test produces —
and a single error blocks the whole table. This file passes with no errors and
38 warnings, all of them either an SDD band whose dosing note the extraction
lost, or a CLSI value that is not on the doubling-dilution series (0.06, 0.12).
