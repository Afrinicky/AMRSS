# ADR-0003 — Methodology is versioned data, not code

**Status:** Accepted
**Relates to:** SDD §5.1, §5.3, §5.4, §10.3, §10.4

## Context

AMRSS informs clinical decisions. When an epidemiologist or auditor challenges a
specific number six months from now, "the code computed it" is not an answer. They
need to know which minimum-n applied, which deduplication window, which breakpoint
edition, and which suppression rules — as those rules stood *at the time that
statistic was produced*, not as they stand today.

Several of these values are also still open at sign-off (SDD §13): the minimum
isolate threshold (20 vs 30), the deduplication window, and the emerging-signal
trigger thresholds. Hardcoding a placeholder guarantees it gets forgotten.

## Decision

Every parameter that can change the value of a published statistic lives in the
`methodology_version` table as a versioned, effective-dated record with a JSON
parameter payload. The analytics engine resolves the applicable version at
computation time and stamps its ID onto the result.

Versioned components: antibiogram thresholds and aggregation rules,
deduplication, QC rules and gating logic, emerging-signal trigger, suppression
rules, AST breakpoint standard, and the analytics engine version itself.

No literal threshold appears in engine code. Defaults live in a seed file that is
plainly labelled as provisional pending SDD §13 sign-off.

## Consequences

- Recomputation after a methodology change is explicit and auditable: the new
  version gets a new effective date, prior results retain their original stamp.
- The "How was this calculated?" disclosure (SDD §5.9) is a projection of stored
  provenance rather than hand-written prose that can drift out of date.
- A small performance cost per computation to resolve versions. Cached per request.
