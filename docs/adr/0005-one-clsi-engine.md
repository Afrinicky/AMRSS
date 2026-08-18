# ADR-0005: One CLSI interpretation engine, shared as a package

**Status:** Accepted
**Date:** 2026-08-09

## Context

AMRSS grew two Python trees that both declared a package named `amrss`:

- `apps/api/amrss` — the surveillance platform: ingestion, quality gating,
  analytics, the antibiogram engine.
- `src/amrss` — the laboratory service, which carries a complete CLSI
  interpretive-category engine under `src/amrss/clsi/`.

The name collision meant `apps/api` could not import the CLSI engine at all.
That mattered because of what the real data looks like: in both WHONET exports
validated against, **every AST value was a raw zone diameter**, not an S/I/R
letter. Those measurements were being stored as `PENDING_INTERPRETATION` and
excluded from every denominator, so a real upload produced a largely empty
antibiogram while reporting success.

Three ways out were available:

1. Reimplement interpretation inside `apps/api`.
2. Rename one of the application packages.
3. Extract the CLSI engine into a package both trees depend on.

## Decision

**Option 3.** `src/amrss/clsi/` becomes `packages/clsi`, distributed as
`amrss-clsi` and importable as `amrss_clsi`. Both applications depend on it.

Option 1 was rejected outright, and not on grounds of code duplication. Two
implementations of "is this isolate resistant" is a patient-safety problem: they
drift, and the drift is invisible until a laboratory's bench report and the
regional antibiogram disagree about the same isolate, with no way to tell which
is right.

Option 2 would have worked but moves more code, touches more imports, and leaves
the engine owned by one application while the other borrows it. The engine is
genuinely shared infrastructure and is now expressed that way.

The extracted package has **no runtime dependencies** — no framework, no
database, no network. It converts a measurement and a criterion into a category.
That is what makes it safe for both sides to import.

## Consequences

- The interpretation bridge lives at `apps/api/amrss/analytics/interpretation.py`
  and converts stored measurements into categories using the shared engine.
- Breakpoint tables are stored as a versioned methodology component (ADR-0003),
  so a result stays explicable after the laboratory adopts a later CLSI edition.
- Organism-to-CLSI-group and agent-code mapping live on the canonical dictionary
  rows, not in code (ADR-0002). A laboratory adding an organism, or CLSI
  reorganising a table, does not require a deployment.
- `.github/workflows/apps.yml` now triggers on `packages/**`, so breaking the
  engine cannot show green on the API that imports it.
- **No breakpoint value is compiled into AMRSS.** Tables are versioned data
  loaded through `POST /api/v1/breakpoints/import`, never literals in the
  engine. A converted CLSI M100 Ed36 table is committed under
  `data/breakpoints/` at the programme owner's direction; a deployment whose
  CLSI licence does not permit that deletes it and imports its own. With no
  table loaded, measurements stay pending and the dashboard says so rather than
  inventing thresholds.

## Rules this preserves

1. **Never guess.** No breakpoint table means no interpretation, not a fallback
   default — the same refusal ADR-0003 requires of every other rule.
2. **"Not covered" is not "uninterpretable."** A combination the loaded table
   does not cover leaves the measurement pending, so a fuller edition can still
   recover it. Marking it `NI` would bury good data permanently.
3. **Nothing is overwritten.** Only results still awaiting interpretation are
   touched. A category the laboratory itself reported is theirs; if the two
   disagree, that is a finding for the data steward, not something to paper over.
