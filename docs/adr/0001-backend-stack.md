# ADR-0001 — Backend stack: FastAPI, PostgreSQL, SQLAlchemy

**Status:** Accepted
**Relates to:** SDD §9.1

## Context

SDD §9.1 offers FastAPI (Python) or NestJS (TypeScript), to be chosen on team
expertise. The decision has to be made before any other code is written.

## Decision

- **API:** FastAPI (Python 3.11), Pydantic v2 for schema validation.
- **Database:** PostgreSQL 16, accessed through SQLAlchemy 2.0 with Alembic
  migrations.
- **Frontend:** Next.js (App Router) with TypeScript and Tailwind CSS.
- **Offline uploader:** Electron with TypeScript, `better-sqlite3` for reading
  WHONET's SQLite database.

## Rationale

The analytics engine is the substantive part of this system — deduplication,
threshold gating, confidence intervals, trend windowing, signal detection. That
work is materially easier and better supported in Python's statistical ecosystem
than in TypeScript, and the people most likely to review it (epidemiologists,
microbiologists) read Python far more often than they read TypeScript.

Node remains in the stack where it is the right tool: the Electron uploader and
the web dashboard.

## Consequences

- Two language runtimes to maintain. Accepted: the boundary is clean and follows
  component boundaries, not arbitrary splits.
- De-identification rules are specified once in `packages/deident` as a
  language-neutral rule document plus a Python reference implementation, and are
  mirrored in the uploader's TypeScript. Both are tested against the same fixture
  vectors so the two implementations cannot silently diverge.
