# CLSI conformance

How AMRSS implements CLSI methodology, and what the laboratory must supply.

---

## Why no breakpoints ship with this software

CLSI M100 tables are copyrighted, they are revised every edition, and a single
mistyped threshold turns an `R` into an `S` on a real patient's report.
Distributing a hardcoded copy would be a licensing violation and a patient-safety
hazard — it would go stale silently, and no reviewer could tell which edition a
given number came from.

Instead, AMRSS implements the *structure* CLSI requires and treats the numbers
as versioned, validated, auditable data that you load from your own licensed
copy.

Applies equally to M02/M07 methodology, M45 (infrequently isolated organisms),
M60 (yeasts), M61 (filamentous fungi), and VET01 — the `standard` column
records which document a criterion came from.

---

## Loading breakpoints

1. Copy `data/breakpoints/clsi_m100.template.csv`. The template documents every
   column inline; `#` lines are stripped at import.
2. Populate from your licensed edition. Real tables are gitignored — only the
   template is tracked.
3. Import. The set is created **inactive**:

   ```bash
   python -m amrss.cli import-breakpoints CLSI-M100-Ed36 \
       "CLSI M100 36th ed. (2026)" data/breakpoints/m100_ed36.csv
   ```

4. Review against the printed tables, then activate:

   ```
   POST /api/v1/clsi/breakpoint-sets/CLSI-M100-Ed36/activate
   ```

Import records a SHA-256 of the source file, so you can always prove which
document produced a given set. Import and activation are both audited.

> The version string `CLSI-M100-Ed36` is a convention, not a validated value —
> AMRSS does not know CLSI's edition numbering. Use whatever identifier matches
> the document in your hands.

### Validation

Errors **abort the entire import** — a partially loaded breakpoint table is
worse than none:

- susceptible bound at or above the resistant bound
- disk bounds not inverted (`disk_susceptible_min` must exceed `disk_resistant_max`)
- overlapping or inverted category ranges
- both SDD and intermediate ranges on one row (CLSI uses one or the other)
- duplicate organism/agent/method/site/route scope
- implausible zone diameters (outside 6–60 mm)
- disk criteria without a recorded disk content

Warnings are recorded but do not block: values off the doubling-dilution series
(the shape of a transcription error), and SDD rows without a dosage note.

---

## Interpretation

### MICs are not plain numbers

Broth dilution only brackets the true value, so results at the ends of the
tested range are reported off-scale. That distinction changes the answer:

Given S ≤ 2, I = 4, R ≥ 8:

| Reported | Category | Why |
|---|---|---|
| `<=0.5` | S | Certainly at or below 2 |
| `4` | I | Exact value in the intermediate range |
| `>=16` | R | Certainly at or above 8 |
| `<=4` | **NI** | Could be 4 (I) or 0.5 (S) — undecidable |
| `>=4` | **NI** | Could be 4 (I) or 64 (R) — undecidable |

`NI` results carry a reason, are flagged `requires_review`, and block release.
The recommended action — repeat with an extended dilution range, or confirm by
another method — is attached as a comment. **The engine never guesses.**

`MICValue` stores operator and concentration together and uses `Decimal`
throughout, so `0.12` and `0.06` compare exactly. Panel labels are mapped to
their true concentrations (`0.06` → `0.0625`, `0.12` → `0.125`) on input and
rendered back to the conventional label on output.

### Categories

`S`, `SDD`, `I`, `R`, plus `NS` (nonsusceptible — used where only a susceptible
breakpoint exists, so the agent can never be `I`) and `NI`.

`SDD` results carry the dosing regimen the category assumes; SDD is not
interpretable without it.

Where no explicit intermediate range is tabulated, `I` is implied by the gap
between the susceptible and resistant bounds.

### Disk diffusion

Zone diameters run **opposite** to MICs — larger zone, more susceptible. A zone
equal to the 6 mm disk is no inhibition at all. Readings outside 6–60 mm are
rejected as implausible rather than interpreted.

### Breakpoint selection

`organism_groups` is ordered most-specific-first, mirroring how M100 nests
species inside broader groups. For an *E. coli* isolate the engine tries
`Escherichia coli` before `Enterobacterales`, so a species-level criterion wins.

Within a group, the most specific qualifier wins — a meningitis-specific
criterion beats the generic one for a CSF isolate. The same penicillin MIC can
legitimately be `S` systemically and `R` for meningitis.

Gradient-strip results are read as MICs and use the MIC criteria.

### Reproducibility

Every interpretation records the breakpoint set version and table reference.
Adopting a new edition does not rewrite existing results: re-interpretation is a
separate, audited operation, and `interpretation_history` retains every category
a result has carried. Trend analyses published under an old edition stay
explainable.

---

## Intrinsic resistance and expert rules

**Intrinsic resistance** (M100 Appendix B). A susceptible result for an
intrinsically resistant combination means the test or the identification is
wrong, not that the drug will work — so the category is forced to `R` and the
discrepancy is surfaced with a prompt to verify organism identification. Where
the result is already `R`, the agent is suppressed instead.

**Expert rules** currently implemented:

| Rule | Behaviour |
|---|---|
| Oxacillin/cefoxitin-resistant staphylococci | Report `R` to all β-lactams except anti-MRSA cephalosporins — mec-mediated resistance is not reliably detected agent-by-agent |
| Erythromycin-R, clindamycin-S | Flag for a D-zone (inducible clindamycin) test |
| Ampicillin-R enterococci | Infer penicillin `R` |
| Carbapenem-nonsusceptible Enterobacterales | Flag for carbapenemase detection and infection-prevention notification |

> **Every seeded rule is marked `requires_local_verification`.** Appendix B and
> the expert-rule tables change between editions. Verify before clinical use.
> Both tables are extensible without code changes.

Overrides replace the category but never the raw measurement — the measurement
is a fact; the category is an interpretation.

---

## Quality control

CLSI (M02/M07/M100) permits reporting only when QC with reference strains is in
range and current. `qc_status()` is the gate:

- Daily QC must be in range within 24 hours; weekly within 7 days.
- An out-of-range most-recent result blocks reporting **regardless of age** —
  corrective action and repeat QC are required first.
- A missing range yields `not_evaluable`, which blocks. It is never a pass.
- An off-scale QC MIC cannot be confirmed in range: `<=0.004` against a range of
  0.004–0.016 might really be 0.001.

`weekly_conversion_eligible()` implements the conversion study: 20 consecutive
test days with no out-of-range result, or 30 days with at most one.

QC ranges are versioned alongside the breakpoint set, and are loaded from your
licensed edition — none are hardcoded.

---

## Selective (cascade) reporting

M100 Table 1 groups agents into tiers. A tier is released only when no lower
tier offers an effective (`S` or `SDD`) agent — reporting a carbapenem alongside
a working ampicillin drives exactly the broad-spectrum use an AMR programme
exists to prevent.

Agents with no assigned tier are always released. Failing open is deliberate:
withholding a result the clinician needs is the worse error.

Disable with `AMRSS_ENFORCE_CASCADE_REPORTING=false` if your institution reports
in full.

---

## The release gate

`release_decision()` is the single place deciding whether results may leave the
laboratory. It refuses on:

1. any `NI` result needing resolution,
2. unresolved rule flags (e.g. a pending D-zone test),
3. QC not satisfied for the agent and method.

All blockers are reported at once, not just the first, so the bench sees
everything needing attention in one pass.

`AMRSS_ENFORCE_QC_GATING` may be disabled for development but is **refused in
production** — releasing AST results without in-range QC is a CLSI violation, so
it is treated as a configuration error rather than a preference.

---

## Multidrug resistance

`is_multidrug_resistant()` follows the Magiorakos *et al.* definition used by
ECDC and CDC: nonsusceptible to agents in ≥3 antimicrobial **classes**. Counting
classes rather than agents is the point — three fluoroquinolones are one class,
not three.

---

## Scope

AMRSS is decision-*support*. Interpretations must be reviewed and released by a
qualified microbiologist. The laboratory remains responsible for verifying
breakpoints, rules and QC ranges against its own licensed standards, for method
validation and verification, and for its regulatory obligations.
