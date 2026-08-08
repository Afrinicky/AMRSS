# Software Design Document
## AMRSS — Antimicrobial Resistance Surveillance System

**Version:** 0.2 (Supersedes v0.1 "Ahafo Regional AMR Platform / ARAMP" draft)
**Status:** Draft for sign-off — ready to serve as the build specification for the development team
**Prepared for:** Regional AMR Committee (Ahafo — first regional block), with explicit national-scalability requirements

---

## Document Control

| Field | Detail |
|---|---|
| Product name | **AMRSS** — Antimicrobial Resistance Surveillance System |
| Product identity note | The product name carries **no regional identity**. Region is a configuration entity within AMRSS, not part of the software's name, branding, or architecture. |
| First deployment | Ahafo Regional Block (Regional AMR Committee as governing body for this block) |
| Planned expansion | Additional regional blocks (e.g., Ashanti, Greater Accra, others) added as configuration, not code changes; eventual national aggregation |
| Audience | Development team (build specification), Regional AMR Committee (approval), participating facilities (operational reference) |
| Supersedes | SDD v0.1 ("Ahafo Regional Antimicrobial Resistance Surveillance Platform / ARAMP") |
| Change basis | Joint review of v0.1 by Claude and a parallel ChatGPT review; this document reflects the reconciled, agreed-upon design |

---

## 1. Overview & Objectives

### 1.1 What AMRSS Is

AMRSS is a **continuously updated antimicrobial resistance surveillance and clinical intelligence platform** — not a periodic reporting tool and not a prescribing engine. Its core purpose is to give physicians and clinicians **current, quality-assured susceptibility and resistance patterns** for bacteria and fungi, derived from routine microbiology data, without waiting for a periodically-conducted survey to be published.

**Core mission statement:**

> To provide continuously updated, quality-assured antimicrobial susceptibility and resistance intelligence derived from routine microbiology data, enabling clinicians and public-health authorities to view current resistance patterns without waiting for periodic AMR surveys or reports.

### 1.2 What Changed From v0.1

The prior draft (v0.1) was architected and named around a single region (Ahafo) and included an automated treatment-classification engine. Both were identified as problems during review:

- **Naming/architecture were region-bound.** The product was called "ARAMP," owned in name and structure by Ahafo, with multi-region/national deployment explicitly out of scope. This does not fit the stated goal of national rollout.
- **The Recommended / Caution / Avoid classification engine risked overstating what susceptibility percentages can responsibly claim.** A susceptibility percentage is not, by itself, a treatment recommendation — it doesn't account for infection site, severity, patient factors, or drug availability. This has been removed from v1 (see Section 4.5).

This document (v0.2) restructures the system as **AMRSS**, a nationally-scalable product, with Ahafo as its first regional block, and repositions clinical output as **surveillance intelligence** rather than treatment recommendation.

### 1.3 Core Data Flow Philosophy

The system is not "upload → calculate → display." It is:

```
Laboratory data → Quality assurance → Continuous surveillance ingestion →
Statistical analysis → Resistance intelligence → Clinician access
```

Every accepted weekly (or facility-scheduled) upload automatically and immediately affects the relevant aggregate statistics, antibiograms, and trend visualizations — no manual recalculation, no waiting for a periodic report cycle.

### 1.4 Objectives

1. Ingest de-identified, quality-assured WHONET data from every participating laboratory in a regional block, on a facility-configurable schedule (weekly by default).
2. De-identify patient data **before it leaves the originating facility**, via an offline desktop uploader — no raw patient-identifiable data ever transits the internet or reaches the cloud system.
3. Automatically recompute susceptibility/resistance statistics, antibiograms, and trends immediately upon acceptance of new data (near-real-time, bounded by actual upload frequency — see Section 4.2).
4. Present regional, district, and facility-level views to role-appropriate users, with the **cumulative regional pattern as the primary/default view**.
5. Apply statistically defensible reporting thresholds (CLSI-aligned), while separately surfacing below-threshold signals for organisms of special importance as clearly labeled alerts.
6. Enforce a three-tier quality assurance model (laboratory QC attestation, EQA/PT compliance, automated data QC) before data contributes to the "verified" surveillance view.
7. Support **multi-region operation by architecture from day one**, with region and facility as configuration entities — enabling a defined path from a single regional block (Ahafo) to additional regions and eventual national aggregation, without re-architecture.
8. Maintain full auditability, versioning, and data provenance, consistent with the professional/ISO-aligned posture required of a system informing clinical decisions.
9. Present a clean, modern, professional interface — green-and-white primary identity, simple and standard in structure, with a distinct, semantically meaningful color language for resistance/susceptibility data visualization.

### 1.5 Scope

**In scope for v1 (build target):**
- Offline WHONET de-identification and upload tool, deployable to any participating facility in any regional block.
- Cloud backend, regional database, and antibiogram/analytics engine.
- Web dashboard: regional AMR administrators, data stewards, auditors, laboratory staff, facility administrators, clinicians.
- Facility enrollment and regional block management as configuration-driven modules.
- Three-tier QC/EQA compliance tracking (attestation + gating, not in-app wet-lab QC analytics — see Section 6).
- Bacterial **and** fungal/yeast surveillance as co-equal, first-class data types.
- Organism Explorer, Antibiotic Explorer, regional/district/facility antibiograms.
- Emerging-resistance signal detection (defined, versioned trigger — see Section 5.4).
- Audit trail, versioning, data provenance, upload quarantine/retraction (soft-delete only).
- Automated report generation (PDF/Excel).

**Explicitly deferred (named, not silently dropped):**
- Public-facing dashboard (v1 is authenticated institutional users only — see Section 7).
- Automated treatment-recommendation/classification engine (v1 shows susceptibility intelligence only — see Section 4.5). May become a separate, clearly-labeled future module built on top of a national/regional guideline, not on susceptibility percentages alone.
- In-app wet-laboratory QC analytics (e.g., Levey-Jennings charting of QC strain results) — v1 supports QC **attestation and compliance tracking** only (Section 6.1).
- Confirmed resistance-mechanism detection (true ESBL/CRE confirmation) — v1 supports **screening-level phenotype flags only**, explicitly labeled as such, for the subset of organism–antibiotic combinations reliably inferable from a standard WHONET AST panel (Section 5.5).
- Full multi-region *operational* features (cross-region benchmarking dashboards, inter-region quotas/admin comparison) — the **data model and architecture** support multiple regions from day one; these operational features are Phase 2+ (Section 11.4).
- Direct LIS-to-cloud integration bypassing the offline uploader.
- Native mobile application (responsive web only in v1).

### 1.6 Guiding Principles

- **Data never leaves a facility identifiable.** De-identification happens offline, before any network transmission.
- **The system reports surveillance intelligence, not prescribing advice.** AMRSS shows susceptibility patterns with full context (n, period, coverage); it does not tell a clinician what to prescribe.
- **Statistical honesty over completeness.** No statistic is presented as reportable unless it meets a defined minimum-isolate threshold — but clinically important below-threshold signals are still visible, clearly separated and labeled.
- **Region is configuration, not identity.** Nothing about the product's name, schema, or codebase is Ahafo-specific. Ahafo is the first entry in a `regional_block` table.
- **Every statistic is traceable.** Data provenance and methodology transparency are non-negotiable for a system informing clinical decisions.
- **QC gates trust, not just data entry.** A facility whose QC/EQA compliance has lapsed has its contributed data flagged and excluded from the "verified" regional antibiogram until resolved.
- **Standards-aware, not standards-hardcoded.** CLSI (or other future breakpoint/methodology standards), WHONET configuration, and antibiogram methodology are versioned, configurable entities — not fixed assumptions baked into code.

---

## 2. System Architecture

### 2.1 High-Level Data Flow

```
┌───────────────────────────┐
│  Facility WHONET SQLite     │   (Full patient-level data — stays on-site, always)
└─────────────┬───────────────┘
              │ loaded into
              ▼
┌─────────────────────────────────────────────┐
│         Offline AMRSS Uploader (Desktop)      │
│  - Parse WHONET SQLite                          │
│  - Validate schema & regional block config      │
│  - Compute local salted patient-linkage hash    │
│    (for dedup — salt never leaves facility)     │
│  - De-identify (strip / band / bucket fields)   │
│  - QC & EQA status capture/attestation          │
│  - Duplicate detection                           │
│  - Diff vs. last sync (incremental)              │
│  - Compress + encrypt                            │
│  - Facility user reviews & confirms send         │
│    (MOU-based facility-level consent)            │
└─────────────┬─────────────────────────────────┘
              │ HTTPS (TLS 1.2+), authenticated, encrypted payload
              ▼
┌─────────────────────────────────────────────┐
│              Cloud Ingestion API              │
│  - Auth & facility/device identity check        │
│  - Payload & schema validation                  │
│  - Automated Data QC (Tier 3 — Section 6.3)     │
│  - Stage → hold for QC/EQA gate → promote       │
│  - Immutable upload log entry                    │
└─────────────┬─────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│         Regional Database (multi-region-      │
│         aware schema; PostgreSQL)              │
│  - De-identified isolate-level records          │
│  - Facility / district / regional block         │
│    metadata (configuration entities)            │
│  - Canonical organism/antibiotic dictionary     │
│    + per-region code mapping                    │
│  - Suppression / banding views                  │
└─────────────┬─────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│          Analytics & Intelligence Engine       │
│  - CLSI-threshold antibiogram computation       │
│    (bacterial + fungal)                          │
│  - First-isolate-per-period deduplication       │
│  - Trend computation (per time bucket, n-gated) │
│  - Below-threshold alert detection               │
│  - Emerging-resistance signal detection          │
│    (versioned, minimum-n-gated trigger rule)    │
│  - Screening-level phenotype flags               │
└─────────────┬─────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│              Web Dashboard (role-based)        │
│  - Regional AMR Admin   - Data Steward/QC       │
│  - Facility Admin        - Laboratory Staff     │
│  - Clinician (read-only) - Auditor              │
│  - System Admin                                  │
└─────────────────────────────────────────────┘
```

### 2.2 Component Summary

| Component | Responsibility | Runs where |
|---|---|---|
| Offline AMRSS Uploader | WHONET parsing, de-identification, linkage-key hashing, QC/EQA capture, validation, incremental sync, encryption | Facility Windows PC (offline-capable until final upload step) |
| Ingestion API | Authenticate, validate, stage, gate on QC/EQA status | Cloud |
| Regional Database | Store de-identified isolate-level and aggregate data, multi-region schema | Cloud |
| Canonical Dictionary Service | Maintain organism/antibiotic/specimen master codes and per-region/per-facility mappings into them | Cloud |
| Analytics & Intelligence Engine | Antibiograms, trends, alerts, emerging-signal detection, phenotype flags | Cloud (on-ingest + scheduled) |
| Web Dashboard | Role-based presentation, explorers, reports | Cloud (web) |
| Admin/Ops Console | Facility enrollment, regional block management, user management, upload/QC monitoring, audit log review | Cloud (web, restricted) |

### 2.3 Multi-Region Architecture (Core Principle)

> **AMRSS shall be designed as a modular, multi-region surveillance platform capable of supporting regional deployments and subsequent national aggregation without redesigning the core data model.**

Concretely:

- `regional_block` is a first-class configuration entity (id, name, governing body, status, activation date) — **Ahafo is a row in this table, not a fork of the software.**
- `district` and `facility` both reference `regional_block`.
- The canonical organism/antibiotic/specimen dictionary is **regional-block-agnostic**; each regional block's facilities map their local WHONET configuration into the canonical dictionary (Section 3.4).
- Adding a new regional block is an **administrative action** (Section 9.3) — create the block, enroll its facilities, map its WHONET configuration — not a development task.
- **What is deferred, explicitly:** cross-regional-block comparison dashboards, inter-block administrative tooling, and national-aggregation reporting views are **Phase 2+ operational features** (Section 11.4). The architecture supports them without redesign; they are not built in v1 because Ahafo is, for now, the only active block and building comparison UI against a single block has no user yet.

### 2.4 Deployment Topology (v1)

- Cloud deployment (hosting/data-residency decision remains an open item — Section 8.4), containerized (Docker) for backend, database, and frontend.
- Offline uploader distributed as a signed Windows installer (Electron), matching the WHONET operating environment.
- Environments: development, staging/pilot, production. Pilot recommended with the two Ahafo hub laboratories before onboarding all districts (unchanged from v0.1's sound recommendation).

---

## 3. Data Model

### 3.1 Fields Retained After De-identification

| Field | Treatment |
|---|---|
| Age | Banded for any cross-facility/regional/clinician view (`<5, 5–14, 15–44, 45–64, 65+`); exact age retained only in a restricted internal layer, gated by role, only if formally approved (open item, Section 12) |
| Sex | Retained as-is |
| Specimen date | Bucketed to week for cross-facility/regional views; exact date retained in the facility's own restricted view and for internal trend computation |
| Care setting | IPD or OPD |
| Site of infection | Derived from specimen type |
| Specimen type | As recorded, mapped to canonical dictionary |
| Organism | Mapped to canonical organism code (bacterial or fungal) |
| Antibiotic/antifungal results | Per-agent S/I/R (and MIC/zone diameter where available), mapped to canonical antibiotic dictionary |
| Facility identifier | Facility code, visibility governed by role |
| District, regional block | Derived from facility |
| **Patient linkage key** | A **locally-salted, one-way hash** of the patient identifier, computed inside the offline uploader. The salt never leaves the facility. This key allows the cloud system to detect repeat isolates from the same patient within a surveillance period (for deduplication, Section 5.3) **without the cloud ever being able to reverse it to a patient identity.** |

**Never transmitted, under any circumstance:** patient name, hospital/patient ID number (in raw form), phone number, address, next-of-kin details, date of birth (only banded age travels), ward/bed number, attending clinician name.

### 3.2 De-identification & Suppression Rules

- **Age banding, date bucketing:** as above.
- **Small-cell suppression:** any breakdown (facility × organism × antibiotic × specimen × time bucket) with **n < 5** displays as "insufficient data" in any cross-facility, district, or regional view — independent of whether the separate antibiogram reporting threshold (Section 5.1) is met. A facility always sees its own full, un-suppressed data.
- **Linkage key, not identity:** the patient linkage key supports deduplication logic only; it is never displayed, exported, or used for any purpose beyond isolate-level deduplication within the analytics engine.

### 3.3 Core Entities (indicative — finalized during data modeling)

- `regional_block` (id, name, governing_body, status, activated_at)
- `district` (id, regional_block_id, name)
- `facility` (id, district_id, name, status [pending/under_verification/active/suspended/inactive/retired], whonet_config_version, qc_status, eqa_status)
- `canonical_organism`, `canonical_antibiotic`, `canonical_specimen_type` (master dictionaries)
- `facility_code_mapping` (facility_id, local_code, canonical_code, entity_type)
- `isolate` (id, facility_id, specimen_date, age_band, age_exact [restricted], sex, care_setting, canonical_specimen_type_id, canonical_organism_id, patient_linkage_key, organism_kingdom [bacteria/fungi])
- `ast_result` (isolate_id, canonical_antibiotic_id, result [S/I/R], mic_or_zone [optional])
- `upload_batch` (id, facility_id, uploaded_at, record_count, checksum, status [staged/qc_hold/accepted/quarantined/retracted], uploader_version)
- `qc_attestation` (facility_id, period, qc_status, notes, submitted_at)
- `eqa_record` (facility_id, provider, panel, date, result, expected_result, performance, corrective_action, status)
- `user` (id, role, facility_id [nullable for regional/system roles], regional_block_id [nullable for system-wide roles])
- `audit_log` (actor_id, action, entity, entity_id, before_state, after_state, timestamp)
- `methodology_version` (component [antibiogram/dedup/qc_rules/emerging_signal_trigger], version, effective_from, description)

### 3.4 Canonical Dictionary & Cross-Region Mapping

This is a component **not present in either prior draft**, and it is required for the multi-region vision to hold together in practice:

- AMRSS maintains a **single canonical organism/antibiotic/specimen dictionary**, independent of any regional block.
- Each facility's WHONET configuration — even after regional standardization — maps into this canonical dictionary via `facility_code_mapping`.
- **Why this matters:** when a second regional block (e.g., Ashanti) is enrolled, its facilities' local WHONET codes will not automatically match Ahafo's, even if each region is internally standardized. Without a canonical mapping layer, a "national antibiogram" would silently mix incompatible codes. This layer makes that safe.
- The Data Steward role (Section 7) is responsible for reviewing and approving new code mappings as facilities and regional blocks are onboarded.

### 3.5 WHONET Configuration Standardization

The AMR Team for each regional block is responsible for ensuring participating laboratories run a uniform WHONET configuration before onboarding. The platform validates incoming files against the expected configuration and flags non-conforming uploads (Section 6.3) rather than silently accepting or rejecting them.

---

## 4. Data Freshness, Coverage & Surveillance Timing

*(New section in v0.2 — this concept was absent in v0.1 and is central to clinical trust in the system.)*

### 4.1 "Near-Real-Time," Defined Precisely

AMRSS does not claim real-time surveillance. It claims:

> Following successful acceptance of a facility's upload (i.e., passing validation and QC gating), the system automatically incorporates the data into all applicable aggregate statistics, antibiograms, and visualizations without manual analysis, within a defined target processing time.

**Target processing time:** accepted uploads become visible in updated analytics within a defined number of minutes of acceptance (specific target — e.g., 15 or 30 minutes — to be confirmed during build based on actual data volumes; this is a performance NFR, not a design open item).

The system is only ever as current as its most recent accepted upload — it does not simulate a currency it doesn't have.

### 4.2 Data Freshness Display (Required Dashboard Element)

Every antibiogram, trend view, and statistic must be shown with its context, not as a bare number. Minimum required context, displayed prominently:

```
Data last updated:      08 August 2026
Data coverage period:   01 January – 08 August 2026
Facilities contributing: 14 / 18
Latest facility submission: 06 August 2026
Data completeness:      87%
```

And at the individual-statistic level, minimum required context:

```
71% susceptible
n = 246 (tested), 240 (interpretable)
Data period: Jan–Aug 2026
12 facilities contributing
Updated: 8 Aug 2026
```

No susceptibility percentage is ever displayed without its n and time period visible alongside it.

### 4.3 Surveillance Coverage Dashboard (New Module)

A dedicated view, primarily for AMR administrators and data stewards, showing whether the regional pattern is actually representative:

| Indicator | Example |
|---|---|
| Enrolled facilities | 24 |
| Active facilities | 21 |
| Reporting this week | 18 |
| Reporting this month | 22 |
| Facilities overdue | 3 |
| Total isolates this month | 1,284 |
| Laboratories participating | 16 |
| Districts covered | 8/8 |

Plus a **reporting compliance by facility** breakdown, and overdue-facility alerting (Section 6.4).

### 4.4 Upload Scheduling

- **Weekly is the recommended default and operational target**, but the platform supports facility-configurable schedules: weekly, fortnightly, monthly, or custom — because facilities may have different reporting arrangements or capacity.
- The system tracks each facility's expected schedule and flags overdue submissions accordingly (Section 6.4), regardless of which schedule that facility is on.

---

## 5. Analytics & Antibiogram Engine

### 5.1 Reporting Thresholds

- Default minimum isolate threshold for any organism–antibiotic combination to appear in the **general antibiogram**: CLSI M39-aligned (exact default — 20 or 30 — confirmed at build time; recorded as a versioned `methodology_version` entry, not hardcoded — see Section 3.3 and Section 10).
- Thresholds apply independently at each aggregation level (facility, district, regional, national-once-applicable).

### 5.2 Below-Threshold Alerts (Organisms of Special Importance)

- A configurable list of clinically important organisms (e.g., carbapenem-resistant Enterobacterales, MRSA, ESBL-phenotype organisms) is tracked even below the general reporting threshold.
- Displayed in a clearly separated **"Alerts / Emerging Signals"** section, explicitly labeled as based on small numbers, for situational awareness — not general antibiogram inclusion.
- The list is configurable by the regional AMR Team/Data Steward, not hardcoded.

### 5.3 Deduplication (First-Isolate-Per-Patient-Period)

> The platform shall implement a configurable isolate-deduplication methodology for antibiogram calculations, using the patient linkage key (Section 3.1) to identify repeat isolates from the same patient within a defined surveillance period, consistent with the selected antibiogram standard (e.g., CLSI M39's first-isolate convention).

- The deduplication window (e.g., "first isolate per patient per organism per 30-day period," the common M39 convention) is a versioned, configurable rule — not hardcoded.
- Deduplication is applied for **antibiogram calculation purposes**; raw isolate counts remain available separately (e.g., for total-workload reporting) so the distinction between "all isolates" and "antibiogram-eligible isolates" is never conflated.

### 5.4 Emerging Resistance Signal Detection

A defined, versioned trigger — not an arbitrary or unvalidated rule:

- Compares susceptibility over two defined time windows (e.g., a trailing long window vs. a trailing short window), **each independently required to meet the minimum-n threshold** before a comparison is made at all.
- Flags a signal when the change between windows exceeds a defined, versioned percentage-point threshold.
- Every signal is presented as:

  ```
  ⚠ Signal — requires expert review
  Klebsiella pneumoniae — Ceftriaxone
  Previous 12-week susceptibility: 62% (n=41)
  Current 4-week susceptibility: 41% (n=19)
  Change: −21 percentage points
  Status: Flagged for laboratory/public-health review
  ```

- AMRSS **never** labels a signal "outbreak detected" — only "signal, requires review." Outbreak determination is a human/epidemiological judgment, not a software claim.
- The trigger rule itself is a versioned `methodology_version` entry, so any future tuning is auditable.

### 5.5 Screening-Level Phenotype Flags (Phased Scope)

- v1 supports **screening-level phenotype flags only**, for organism–antibiotic combinations that are reliably inferable from a standard WHONET AST panel (e.g., cefoxitin-resistant *S. aureus* → flagged as "MRSA phenotype (screening)").
- Every flag is explicitly labeled **"observed phenotype (screening-level)"**, never **"confirmed [mechanism]."**
- The exact list of supported screening flags (and the antibiotic/organism combination each depends on) is documented and versioned; confirmed-mechanism detection (true ESBL/CRE confirmatory testing-based) is out of scope until facility testing capability supports it consistently region-wide.

### 5.6 Antibiogram Types Supported

- Regional, district, and facility antibiograms.
- Specimen-specific and infection-site-specific antibiograms.
- OPD and IPD antibiograms.
- Adult/pediatric split where statistically appropriate (subject to the same minimum-n threshold).
- **Bacterial antibiograms and fungal/yeast susceptibility profiles as co-equal, first-class outputs** — not fungal-as-an-afterthought. Consistent with CLSI M39's own coverage of yeast and antifungal agents.

### 5.7 Trend Analysis

- Same minimum-n rule applied **per time bucket** as the general antibiogram; a trend point with insufficient n renders as "insufficient data" for that point, not a misleadingly precise line.
- Every trend chart shows isolate count (n) alongside the percentage at each point.
- Confidence indication (interval or simple visual uncertainty cue) shown where n is above threshold but still modest.

### 5.8 What v1 Explicitly Does Not Do

> AMRSS presents **susceptibility percentages with full statistical context** — organism, antibiotic, n, period, coverage. It does not compute or display a "recommended," "caution," or "avoid" treatment label. Any future empiric-therapy guidance module is a **separate, clearly-labeled, clinically-governed feature**, built on top of the regional antibiogram plus an applicable national/regional treatment guideline plus infection-site logic — not a direct function of susceptibility percentage alone.

### 5.9 Methodology Transparency

Every antibiogram/statistic carries a **"How was this calculated?"** disclosure, viewable on demand, showing: surveillance period, participating facilities, inclusion/exclusion criteria, deduplication method and version, minimum n, AST interpretation standard and breakpoint version, and suppression rules applied. This is not optional documentation — it is a per-statistic, always-available feature, required for the platform to be credible to an epidemiologist or auditor examining a specific number.

---

## 6. Quality Assurance (Three-Tier Model)

*(Substantially expanded from v0.1, with an explicit scope boundary added.)*

### 6.1 Scope Boundary (Read First)

AMRSS v1 performs **QC attestation, compliance tracking, and gating** — it does **not** perform in-app wet-laboratory QC analytics (e.g., Levey-Jennings charting of daily QC strain zone diameters). That distinction matters: "build QC" could otherwise be read as a much larger, different piece of software than what v1 is scoped to deliver. Richer in-lab QC analytics may become a defined Phase 2+ feature; v1's job is to know **whether** a facility's QC/EQA status is current and satisfactory, and to **gate that facility's contribution to the verified regional antibiogram accordingly** — not to be the facility's laboratory quality management system.

### 6.2 Tier 1 — Laboratory QC Attestation

- Facilities periodically (per a defined schedule) attest to their internal AST quality control status: QC status (satisfactory/unsatisfactory), date, and corrective action if unsatisfactory.
- This is a structured **attestation record** (`qc_attestation`), not raw QC-strain measurement data.

### 6.3 Tier 2 — EQA / Proficiency Testing Compliance

- Facilities submit EQA/PT participation records: provider, panel/sample, date, result, expected result, performance outcome, corrective action, and status (`eqa_record`).
- EQA status is either **Satisfactory** or **Unsatisfactory — corrective action required**, and this status is visible on the facility's quality profile (Section 6.5).

### 6.4 Tier 3 — Automated Data QC (Platform-Performed)

Performed automatically by the platform on every upload, in addition to Tiers 1–2:

- Missing organism, missing AST result, or other required-field gaps.
- Impossible/out-of-range values.
- Duplicate isolate detection (distinct from Section 5.3's antibiogram-level deduplication — this is upload-level duplicate-record detection).
- Unusual or unexpected organism–antibiotic combinations.
- Sudden, unexplained changes in isolate volume or resistance pattern at the facility level (flagged for review, not auto-corrected).
- Inconsistent specimen type coding.
- Invalid or unmapped antibiotic/organism codes (relative to the canonical dictionary, Section 3.4).
- Outdated WHONET configuration version relative to the regional block's current standard.
- Abnormal S/I/R distribution shapes (e.g., statistically implausible all-susceptible or all-resistant batches).
- Repeated identical records across uploads.

### 6.5 QC/EQA Dashboard (Administrator View)

Per-facility quality profile, e.g.:

| QC Indicator | Status |
|---|---|
| WHONET configuration | ✓ Current |
| Weekly upload | ✓ Received |
| AST QC attestation | ✓ Satisfactory |
| EQA/PT | ✓ Satisfactory |
| Data completeness | 96% |
| Duplicate rate | 0.4% |
| Last QC submission | 02 Aug 2026 |
| Next QC due | 09 Aug 2026 |

### 6.6 Gating Rule

> A facility's contributed data is included in facility-level views regardless of QC/EQA status (a facility always sees its own data). A facility's data is included in the **verified regional/district antibiogram** only while its QC attestation and EQA status are both current and satisfactory. If either lapses, the facility's data is flagged and excluded from the verified aggregate view until resolved, with a visible indicator of how many/which facilities are currently excluded on this basis (transparency, not silent exclusion).

---

## 7. User Roles & Access Control

| Role | Access |
|---|---|
| **Laboratory staff** | Upload data via offline uploader; submit QC/EQA attestations; view own facility's full (un-suppressed) reports |
| **Facility administrator** | View own facility's reports/trends; manage facility-level user accounts; cannot upload data or edit surveillance data |
| **Data Steward / QC Officer** | Regional-level; reviews flagged uploads and code mappings, manages canonical dictionary and WHONET configuration standard, monitors data-quality dashboards, manages QC/EQA gating |
| **Regional AMR Administrator** | Full regional analytics, cross-facility/district comparison, alert-list and emerging-signal configuration, facility enrollment approval, regional block administration |
| **Clinician** | **Read-only.** Regional trends (default/primary view), district trends, facility trends where permitted, antibiograms (bacterial + fungal), Organism Explorer, Antibiotic Explorer, alerts, downloadable approved reports. Cannot upload, edit, modify QC, see patient-level data, or see raw uploaded files. |
| **Auditor** | Read-only access to upload logs, user activity logs, QC/EQA history, and audit trail — separate from the Regional AMR Administrator's operational access, for independent accountability |
| **System Administrator** | Technical administration: user provisioning, infrastructure, backups, regional block/system configuration — distinct from clinical/AMR-team roles |

**No public role in v1** (see Section 1.5). A future **"Public AMR Observatory"** with heavily aggregated, further-suppressed data may be a defined Phase 2+ feature, governed separately given its different governance requirements.

Access control is enforced via role-based permissions (RBAC) **at the API layer**, consistently across dashboard and export endpoints — never solely a UI-level restriction.

---

## 8. Offline Uploader Specification

### 8.1 Purpose

The sole path by which any data leaves a facility's WHONET database and reaches AMRSS. Runs on a facility Windows PC; functions offline up to the point of final transmission.

### 8.2 Functional Requirements

1. Load and parse the facility's WHONET SQLite export.
2. Validate against the expected WHONET schema and the regional block's standardized configuration; reject or flag non-conforming files with a clear, actionable error message.
3. Compute the locally-salted, one-way patient-linkage hash (Section 3.1) — salt generated and retained locally, never transmitted.
4. Strip all direct patient identifiers; apply age-banding and date-bucketing rules for any field destined for cross-facility exposure.
5. Detect and flag duplicate records against the last successful sync.
6. Compute the diff against the last synchronization — **incremental sync only**.
7. Capture the facility user's QC/EQA attestation status for the period (Section 6.2–6.3), as part of the same upload workflow.
8. Compress and encrypt the payload before transmission (in addition to TLS in transit).
9. Present the facility user with an upload summary (record count, date range, QC/EQA status about to be submitted — no raw identifiers visible) and require explicit confirmation before transmission (the practical implementation of facility-level MOU-based consent).
10. Transmit via authenticated HTTPS to the Cloud Ingestion API.
11. Maintain a local, tamper-evident upload log (timestamp, record count, status, checksum).
12. Support facility-configurable sync schedule (weekly recommended default; fortnightly/monthly/custom supported — Section 4.4), with manual trigger always available.
13. Present an **upload dashboard** within the uploader itself — history of past uploads, their status (accepted/quarantined/pending), and any QC flags raised — so the tool functions as a professional surveillance client, not a bare file-transfer utility.
14. Support local reminders/scheduling nudges ("Weekly upload due") ahead of the facility's configured schedule.

### 8.3 Validation & QC (First Pass, at the Uploader)

- Schema conformance check.
- Field completeness check.
- WHONET/regional-block configuration version check, with mismatches flagged to the Data Steward for resolution before the batch is accepted centrally.

### 8.4 Distribution & Trust

- Distributed as a signed installer with published checksums.
- The de-identification and linkage-key-hashing logic is open and auditable (consistent with the platform's open-source posture), since this is the component handling raw patient data.
- Versioned releases; the Ingestion API rejects uploads from uploader versions below a defined minimum supported version.

---

## 9. Cloud Backend, Facility Enrollment & Regional Block Management

### 9.1 Technology (proposed, carried forward from v0.1 — no change recommended)

| Layer | Technology |
|---|---|
| Database | PostgreSQL |
| Backend/API | FastAPI (Python) or NestJS (TypeScript) — align to team's existing expertise |
| Frontend | React or Next.js |
| Offline uploader | Electron |
| Deployment | Docker containers |
| Authentication | Token-based (JWT or session-based), role claims enforced server-side |

### 9.2 Facility Enrollment (Formal Module)

A defined onboarding workflow, not an informal process:

- Facility status lifecycle: **Pending → Under Verification → Active → Suspended → Inactive → Retired.**
- Enrollment captures: facility identity, district/regional block assignment, WHONET configuration mapping (Section 3.4), MOU execution status, initial QC/EQA baseline.
- Only **Active** facilities' data is eligible for the verified regional antibiogram (subject also to the QC/EQA gating rule, Section 6.6).

### 9.3 Regional Block Management (Formal Module)

- Administrators can create a new `regional_block` entity: name, governing body, initial districts/facilities to onboard.
- Adding a new block is a **configuration and enrollment exercise** — no schema or code change required.
- Ahafo is created as the first regional block through this same mechanism (not special-cased in code).

### 9.4 Ingestion API — Responsibilities

- Authenticate the uploading facility/device.
- Validate payload structure and checksum.
- Second-pass automated Data QC (Tier 3, Section 6.4) — independent of the uploader's own checks, to guard against a compromised or outdated client.
- Stage → QC/EQA gate check → promote (or hold for Data Steward review); failed/held batches are never silently dropped or silently accepted.
- Write to the immutable upload log and audit trail.

### 9.5 Analytics API — Responsibilities

- Serve antibiogram, trend, alert, and coverage data to the dashboard, enforcing suppression/banding/QC-gating rules **server-side**.
- Recompute affected aggregates on each accepted ingest (target processing time per Section 4.1).
- Documented, versioned API, structured to support future integration (additional regional blocks, eventual national aggregation, or approved research use under separate governance approval).

### 9.6 Upload Lifecycle & Data Correction

- Upload batches move through: **staged → QC hold (if flagged) → accepted → [quarantined → retracted]** if a problem is discovered post-acceptance.
- **No hard deletion of accepted data.** Problem batches are **soft-deleted/quarantined**, not erased — preserving the audit trail.
- A quarantined/retracted batch triggers **automatic recomputation** of all analytics that batch had contributed to.
- Every state transition is captured in the audit trail (who, when, why).

### 9.7 Report Generation

- Scheduled monthly, quarterly, and annual reports (PDF and Excel).
- Reports respect the same threshold, suppression, QC-gating, and methodology-transparency rules as the live dashboard — a report never shows something the live dashboard wouldn't show.

---

## 10. Governance, Audit & Versioning

### 10.1 Ownership

AMRSS as a **product** (code, architecture) is owned and stewarded at the level appropriate to eventual national rollout — practically, this means the codebase and canonical dictionary are managed centrally, while each **regional block's data and operational governance** sits with that block's Regional AMR Committee (Ahafo's Committee for the Ahafo block).

### 10.2 Auditability

Full audit trail required for: user login/failed login, upload submission/rejection, QC/EQA submission, facility enrollment/suspension, configuration changes (WHONET mapping, dictionary edits), antibiogram/deduplication/QC methodology changes, data correction/retraction, alert acknowledgement, report generation, user creation/deactivation, and permission changes. This is a professional-system requirement, not optional logging.

### 10.3 Versioning

The following are versioned, first-class entities (not hardcoded assumptions), tracked via `methodology_version`:

- WHONET configuration standard (per regional block)
- Canonical organism/antibiotic dictionary
- AST interpretation standard/breakpoints (e.g., "CLSI M100 2026")
- Antibiogram methodology (thresholds, aggregation rules)
- Deduplication methodology
- QC/EQA rules and gating logic
- Emerging-resistance-signal trigger rule
- Analytics engine version

Any statistic can be traced to the exact methodology version that produced it (Section 5.9).

### 10.4 Data Provenance

Every displayed statistic is internally traceable to: which facilities, which upload batches, which time period, which methodology version, and which suppression/QC rules were applied to produce it. This traceability is retained internally at all times, even where not exposed directly to a clinician-facing view.

### 10.5 Standards & Compliance

*(New section — makes "internationally credible, ISO-conformant" a checkable set of references rather than a general aspiration.)*

| Standard/Framework | Relevance to AMRSS |
|---|---|
| **CLSI M39** | Antibiogram compilation methodology (bacterial and fungal/yeast); versioned per Section 10.3 |
| **CLSI M100 / relevant breakpoint documents** | AST interpretation standard; versioned |
| **WHO GLASS** | Surveillance framework alignment — standardized AMR data collection, analysis, and sharing; informs the platform's structural approach to routine and emerging-resistance surveillance |
| **ISO 15189** | Medical laboratory quality and competence — relevant to the Tier 1/2 QC-EQA subsystem's design and the facility quality profile |
| **ISO/IEC 27001** | Information security management — relevant to the platform's overall security posture, even though transmitted data is de-identified |
| **Ghana Data Protection Act, 2012 (Act 843)** | Legal framework for the de-identification design and facility MOU structure; formal review recommended before go-live (Section 12) |

The platform's design should be explicitly reviewable against each of these, and this table should be revisited as the system matures (e.g., when a formal ISO 27001 gap assessment is conducted).

---

## 11. Frontend / Dashboard Specification & UI Direction

### 11.1 Design Principles (apply to all AMRSS interfaces, current and future)

- **Professional, standard, and simple.** This is a clinical-adjacent surveillance tool, not a consumer app — the interface should read as credible and calm, not flashy.
- **Green-and-white primary identity**, per the supplied reference direction: clean sans-serif type, generous whitespace, rounded-corner cards, soft shadows, a confident but restrained layout rhythm (hero stat cards, clean navigation, card grids).
- **The brand palette (green/white) governs chrome — navigation, cards, buttons, backgrounds.** It does **not** govern clinical data visualization.
- **Data visualization uses a separate, semantic palette:** resistant/susceptible/intermediate results and trend lines use colors chosen for **clinical clarity and convention**, not brand matching — red for resistant, amber/orange for intermediate, green for susceptible (which conveniently aligns with the brand's green for the "good" state), with a broader, carefully chosen categorical palette for multi-series charts (e.g., multiple organisms or facilities on one trend chart) where more than three colors are needed. This distinction — brand palette vs. data-semantic palette — should be treated as a fixed design rule, not a per-chart decision.
- This design direction applies to **all future AMRSS-related work**, not just this document.

### 11.2 Core Views

- **Home / regional overview (clinician-facing default):** simplified, not a dense analytics wall. Data-freshness banner, top pathogens, current resistance signals (color-coded by severity), and clear navigation into deeper exploration — modeled on the "What are we seeing now?" structure discussed during planning, rather than a complex dashboard as the first thing a clinician sees.
- **Antibiogram explorer:** filterable by organism, antibiotic, specimen/site of infection, facility, district, regional block, care setting, time period; standard antibiogram table plus visual.
- **Organism Explorer:** select an organism → see isolate count, regional susceptibility table, trend over time, breakdown by district/facility/specimen/care setting.
- **Antibiotic Explorer:** select an antibiotic → see overall regional resistance, resistance by organism, resistance over time, by specimen, by district/facility.
- **Trend view:** resistance/susceptibility over time, n shown alongside every point.
- **Regional heat map:** geographic visualization across districts/facilities.
- **Facility/district comparison:** subject to role permissions and suppression rules.
- **Alerts / Emerging Signals:** clearly separated from the main antibiogram (Sections 5.2, 5.4).
- **Surveillance Coverage:** Section 4.3.
- **Reports:** browse/download historical reports.
- **Admin console:** facility enrollment, regional block management, upload/QC monitoring, canonical dictionary management, methodology versioning, audit log.

### 11.3 Interaction & Trust Requirements

- Every statistic displays its n and time period — never a bare percentage.
- Suppressed/below-threshold cells render as a clearly styled "insufficient data" state.
- "How was this calculated?" available on every antibiogram/statistic (Section 5.9).
- Persistent, non-dismissible framing on any page showing susceptibility data: *"Susceptibility data reflect regional surveillance patterns and support clinical decision-making; they do not replace individualized clinical judgment."*
- Data-freshness banner present on every analytical view, not just a dedicated coverage page.

### 11.4 Accessibility & Performance

- Responsive layout, usable on shared facility computers with modest bandwidth; heavy views degrade gracefully (cached last-known aggregates if a live query is slow) rather than failing outright.

---

## 12. Roadmap

### 12.1 Phase 1 (Build Target of This Document)

- Ahafo regional block: pilot with the two hub laboratories, then full district rollout.
- All modules in Section 1.5's "in scope" list.

### 12.2 Phase 2

- Refinement based on Phase 1 pilot learnings.
- Automatic scheduled synchronization (reducing dependence on manual upload triggering).
- Confirmed-mechanism resistance detection, where facility testing capability supports it consistently.
- In-app wet-laboratory QC analytics (beyond attestation), if warranted.
- Potential direct LIS integration for facilities with compatible systems.
- Cross-regional-block operational features (comparison dashboards, inter-block tooling), once a second regional block is active.

### 12.3 Phase 3

- Enrollment of additional regional blocks (e.g., Ashanti, Greater Accra), using the Regional Block Management module (Section 9.3) — an administrative and facility-onboarding exercise, not a re-architecture.

### 12.4 Phase 4

- National aggregation, potentially aligned with WHO GLASS reporting structures for international comparability.
- Formal "Public AMR Observatory" module (heavily aggregated, further-suppressed public view), governed separately from the clinical/institutional platform.

---

## 13. Open Questions for Sign-off

To be resolved before or during early build, and recorded as addenda to this document once decided:

1. **Exact minimum isolate threshold** (20 vs. 30) for the general antibiogram.
2. **Exact age retention policy** — confirm whether any restricted internal layer retains exact age, or whether banding is applied universally with no exact-age retention anywhere.
3. **Hosting/data-residency decision**, with explicit sign-off given data sovereignty considerations already raised.
4. **Ethics clearance pathway** (GHS-ERC or equivalent) for this as a continuous, multi-facility surveillance system — recommended to run in parallel with build.
5. **List of organisms of special importance** for below-threshold alerting — defined by clinical/microbiology leads.
6. **Named technical custodian(s)** for ongoing operations — specific individuals, not just "the AMR Team" as an abstraction.
7. **Pilot facility selection and timeline** — confirm SECH/SJOG-first approach and target dates.
8. **Target processing time** for near-real-time updates (Section 4.1) — specific minute-level target to confirm as a performance requirement.
9. **Emerging-resistance trigger thresholds** (percentage-point change, window lengths) — to be set by clinical/epidemiological leads, then versioned.
10. **Exact deduplication window** (e.g., 30-day first-isolate convention) — confirm against the specific standard being followed.

---

*End of v0.2. This document is the authoritative build specification, superseding v0.1 in full. It should be treated as living and updated as design decisions in Section 13 are finalized.*
