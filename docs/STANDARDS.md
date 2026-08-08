# Standards Conformance Map

SDD §10.5 commits AMRSS to being *reviewable* against these frameworks rather than
merely claiming them. This file maps each claim to the place in the system that
implements it, so a reviewer can check rather than take it on trust.

Status values: **Implemented** — present and tested. **Partial** — implemented for
v1 scope with a named boundary. **Process** — an organisational obligation the
software supports but does not itself satisfy.

## CLSI M39 — Antibiogram compilation

| Requirement | Where | Status |
|---|---|---|
| First-isolate-per-patient deduplication | `apps/api/amrss/analytics/deduplication.py` | Implemented |
| Minimum isolate threshold before reporting | `analytics/thresholds.py`, parameterised via `methodology_version` | Implemented |
| Threshold applied independently per aggregation level | `analytics/antibiogram.py` | Implemented |
| Yeast/antifungal profiles as co-equal output | `organism_kingdom` on `isolate`; no bacterial-only code path | Implemented |
| Methodology disclosed with the statistic | `analytics/provenance.py` → "How was this calculated?" | Implemented |
| Exact threshold value (20 vs 30) | Seeded provisionally; SDD §13.1 sign-off required | Process |

## CLSI M100 — AST interpretation

| Requirement | Where | Status |
|---|---|---|
| Breakpoint edition recorded per statistic | `methodology_version` component `ast_breakpoints` | Implemented |
| S/I/R accepted as interpreted by the source laboratory | Ingestion accepts WHONET interpretations | Partial — AMRSS does not re-interpret MIC/zone against breakpoints in v1; it records the edition the laboratory used |

## WHO GLASS — Surveillance framework

| Requirement | Where | Status |
|---|---|---|
| Standardised specimen/organism/antibiotic coding | Canonical dictionary + `facility_code_mapping` | Implemented |
| Care setting (IPD/OPD) captured | `isolate.care_setting` | Implemented |
| Age and sex stratification | `isolate.age_band`, `isolate.sex` | Implemented |
| Coverage and representativeness reporting | Surveillance Coverage module | Implemented |
| GLASS-format national export | Phase 4 | Deferred (SDD §12.4) |

## ISO 15189 — Medical laboratory quality

AMRSS is not a laboratory quality management system and does not claim to make a
laboratory conformant. It supports the surveillance-relevant subset.

| Requirement | Where | Status |
|---|---|---|
| Internal QC status recorded per period | `qc_attestation` | Implemented |
| EQA/PT participation and outcome recorded | `eqa_record` | Implemented |
| Corrective action captured on unsatisfactory result | `eqa_record.corrective_action` | Implemented |
| Non-conforming data identified and controlled | Tier-3 QC + quarantine lifecycle | Implemented |
| Quality status governs data trust | Gating rule, SDD §6.6 | Implemented |
| Wet-lab QC analytics (Levey-Jennings etc.) | Out of v1 scope, SDD §6.1 | Deferred |

## ISO/IEC 27001 — Information security

Alignment of design posture. A formal gap assessment is a separate exercise.

| Control area | Where | Status |
|---|---|---|
| Access control (A.9) | RBAC enforced at the API layer, never UI-only | Implemented |
| Cryptography (A.10) | TLS 1.2+ in transit; payload encrypted independently of transport | Implemented |
| Operations logging (A.12.4) | `audit_log` covering the SDD §10.2 event list | Implemented |
| Secure development (A.14) | Signed uploader releases, published checksums, minimum-version gate | Implemented |
| Supplier/hosting | Hosting and data residency, SDD §13.3 | Process |
| Formal ISMS, risk register, certification | Organisational | Process |

## Ghana Data Protection Act, 2012 (Act 843)

| Principle | How AMRSS addresses it |
|---|---|
| Minimality | Only the fields in SDD §3.1 are transmitted. Direct identifiers never leave the facility. |
| Purpose limitation | The linkage key is usable only for deduplication and is excluded from every response schema and export. |
| Accountability | Full audit trail; facility MOU status recorded as an enrollment precondition. |
| Security safeguards | De-identification before transmission, encryption in transit and at rest, role-based access. |
| Retention | Soft-delete only for accepted batches, preserving the audit trail; retention schedule is a governance decision. |

Formal legal review before go-live is recorded as SDD §13 open item and is not
discharged by this document.

## Open items blocking full conformance claims

These come from SDD §13 and are surfaced here so they are not lost. Each is seeded
as a provisional value clearly labelled as such.

1. Minimum isolate threshold — 20 or 30.
2. Exact age retention policy.
3. Hosting and data-residency sign-off.
4. Ethics clearance pathway (GHS-ERC or equivalent).
5. List of organisms of special importance for below-threshold alerting.
6. Named technical custodians.
7. Pilot facility selection and timeline.
8. Target processing time for near-real-time updates.
9. Emerging-resistance trigger thresholds and window lengths.
10. Exact deduplication window.
