# ADR-0002 — Region is configuration, not identity

**Status:** Accepted
**Relates to:** SDD §1.6, §2.3, §9.3

## Context

The predecessor draft (v0.1, "ARAMP") was named and architected around Ahafo.
That does not survive contact with the stated goal of national rollout.

## Decision

`regional_block` is a first-class configuration table. Ahafo is a row in it,
created through the same Regional Block Management flow any future block will use.
No code path, schema column, migration, seed constant, environment variable, or
UI string may special-case a named region.

Enforcement: the test suite includes a repository-wide check that no region name
appears in application source. Regional names are permitted only in
documentation, seed data, and test fixtures.

## Consequences

- Every analytics query is scoped by `regional_block_id`, even while only one
  block exists. A single-block deployment pays a negligible cost; a multi-block
  deployment does not require a rewrite.
- The canonical organism/antibiotic/specimen dictionary is deliberately
  block-agnostic, with each facility mapping its local WHONET codes into it. Without
  that layer a future national antibiogram would silently mix incompatible codes.
