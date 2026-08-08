# AMRSS — Antimicrobial Resistance Surveillance System

Continuously updated, quality-assured antimicrobial susceptibility and resistance
intelligence derived from routine microbiology data, enabling clinicians and
public-health authorities to view current resistance patterns without waiting for
periodic AMR surveys or reports.

AMRSS carries no regional identity. A **region is a configuration entity**, not a
fork of the software. Ahafo is the first row in `regional_block`; additional
regional blocks are onboarded administratively, not by changing code.

> AMRSS reports **surveillance intelligence, not prescribing advice.** It presents
> susceptibility patterns with full statistical context; it does not tell a
> clinician what to prescribe.

Build specification: [`docs/sdd/AMRSS_SDD_v0.2.md`](docs/sdd/AMRSS_SDD_v0.2.md).

---

## The two halves of AMRSS

| Half | What it is | Where it runs |
|---|---|---|
| **Offline uploader** (`apps/uploader`) | Signed desktop installer that parses the facility's WHONET SQLite database, computes a locally-salted patient linkage hash, de-identifies, and transmits. Raw patient data never leaves the facility. | Facility Windows PC |
| **Cloud platform** (`apps/api` + `apps/web`) | Ingestion, quality gating, antibiogram/analytics engine, and the role-based web dashboard clinicians use. | Cloud |

```
Facility WHONET SQLite  →  Offline Uploader (de-identify)  →  Ingestion API
   →  Quality gating  →  Regional Database  →  Analytics Engine  →  Web Dashboard
```

## Repository layout

```
apps/
  api/         FastAPI backend — ingestion, analytics, admin, RBAC, audit
  web/         Next.js dashboard — antibiograms, explorers, coverage, admin
  uploader/    Electron offline de-identification and upload client
packages/
  deident/     De-identification + linkage-hash rules, shared and independently auditable
docs/
  sdd/         Software Design Document (authoritative build specification)
  adr/         Architecture Decision Records
  design/      UI design language: brand palette vs. clinical data palette
infra/
  docker/      Container definitions and compose stack
```

## Quick start

Requirements: Docker, Python 3.11+, Node 20+.

```bash
make dev-up          # Postgres + API + web, with migrations and seed data
make test            # backend test suite
make seed            # (re)load the Ahafo regional block and synthetic WHONET data
```

Full instructions, including running each app on its own, are in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Standards posture

AMRSS is built to be reviewable against the frameworks it claims alignment with,
rather than merely asserting them. See [`docs/STANDARDS.md`](docs/STANDARDS.md).

| Standard | Relevance |
|---|---|
| CLSI M39 | Antibiogram compilation methodology (bacterial and fungal/yeast) |
| CLSI M100 | AST interpretation standard and breakpoints |
| WHO GLASS | Surveillance framework alignment |
| ISO 15189 | Medical laboratory quality — informs the QC/EQA subsystem |
| ISO/IEC 27001 | Information security management posture |
| Ghana Data Protection Act, 2012 (Act 843) | Legal basis for the de-identification design |

Every methodology that affects a published statistic — thresholds, deduplication
window, breakpoint version, signal trigger — is a **versioned database entity**,
never a hardcoded constant. Any statistic can be traced back to the exact
methodology version that produced it.

## Licence

See [`LICENSE`](LICENSE). The de-identification logic in `packages/deident` is
deliberately open and auditable: it is the component that handles raw patient data.
