# amrss-clsi

CLSI interpretive-category engine: turns a measured MIC or disk zone diameter
into `S` / `SDD` / `I` / `R` / `NS`, or refuses to and says why.

It is a standalone package rather than a module inside either application
because both need it — the surveillance platform (`apps/api`) interprets
uploaded zone diameters so they can enter an antibiogram, and the laboratory
service (`src/amrss`) interprets them at the bench. Two implementations of "is
this isolate resistant" is not a code-duplication problem, it is a
patient-safety problem, so there is exactly one.

## No breakpoint values ship with this package

CLSI M100 tables are copyrighted, revised annually, and a single mistyped
threshold turns an R into an S on a real patient's report. The laboratory loads
the tables from its own licensed copy of the current edition, using the CSV
template at `data/breakpoints/clsi_m100.template.csv`.

What this package provides is the structure CLSI requires around those numbers:
versioned sets, organism-group scoping, method and site/route qualifiers, SDD
support, reporting tiers, and import-time validation that catches transcription
errors before they can interpret a result.

## Design rules

1. **Never guess.** Off-scale MICs that straddle a breakpoint, missing criteria,
   and implausible measurements all produce `Category.NI` with a stated reason,
   not a plausible-looking S or R.
2. **Stay reproducible.** Every result carries the breakpoint set version and
   table reference, so a result interpreted under M100-Ed36 can still be
   explained after the laboratory moves to Ed37.

## Layout

| Module | Responsibility |
|---|---|
| `mic.py` | MIC value parsing, doubling-dilution series, off-scale (`≤`/`>`) handling |
| `breakpoints.py` | `Breakpoint`, `BreakpointSet`, and import-time validation |
| `interpretation.py` | Measurement + criterion → `Interpretation` |
| `rules.py` | Intrinsic resistance and organism-agent exception rules |
| `qc.py` | QC strain result ranges and QC status |
| `reporting.py` | Cascade / selective reporting tiers (M100 Table 1) |
