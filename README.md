# AMRSS — Antimicrobial Resistance Surveillance System

A surveillance platform for antimicrobial susceptibility testing (AST) data,
built to conform to CLSI methodology and to hold patient data safely.

The repository holds two deployable services and one desktop client:

| | Path | What it is |
|---|---|---|
| **Surveillance platform** | `apps/api`, `apps/web` | The regional API and dashboard: ingestion, quality gating, antibiograms, trends, reports, administration. Deployed from `infra/docker/` — see **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. |
| **Offline uploader** | `apps/uploader` | Runs inside a laboratory. Reads WHONET exports, de-identifies them there, submits only the result. |
| **Laboratory service** | `src/amrss` | The bench-side service. Its own stack: the root `Dockerfile` and `docker-compose.yml`, and the quick start below. |
| **CLSI engine** | `packages/clsi` | The interpretive engine both halves share rather than reimplement (ADR-0005). |

---

## Getting the platform live

Read **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. In short:

```bash
cp infra/docker/.env.example infra/docker/.env      # then fill it in
docker compose -f infra/docker/docker-compose.yml \
               -f infra/docker/docker-compose.prod.yml up -d --build
docker compose ... exec api python -m amrss.seed              # dictionaries
docker compose ... exec api python -m amrss.cli create-block  # your region
docker compose ... exec api python -m amrss.cli create-user   # first admin
```

A new deployment has no accounts and no facilities, by design. Laboratories are
registered from **Administration → Facility enrollment** once you can sign in.

---

## Two things to read before deploying

**1. No breakpoint values ship with this software.**
CLSI M100 tables are copyrighted, revised annually, and a single mistyped
threshold turns an `R` into an `S` on a real patient's report. AMRSS is
breakpoint-*table-driven*: you import the tables from your laboratory's
licensed copy of the current edition, the import is validated and versioned,
and every interpretation records which set produced it. See [docs/clsi.md](docs/clsi.md).

**2. The seeded intrinsic-resistance and expert rules need local verification.**
`src/amrss/clsi/rules.py` ships a small, textbook subset so the system is
useful on day one. Every entry is marked `requires_local_verification`. Check
them against your edition's Appendix B before clinical use.

---

## What is implemented

### CLSI conformance

| Capability | Module |
|---|---|
| MIC values with off-scale semantics (`<=`, `>=`) preserved | `clsi/mic.py` |
| Versioned breakpoint sets, organism-group scoping, site/route qualifiers | `clsi/breakpoints.py` |
| S / SDD / I / R / NS categorisation, MIC and disk diffusion | `clsi/interpretation.py` |
| Intrinsic resistance (App. B) and mechanism-driven expert rules | `clsi/rules.py` |
| QC ranges, daily/weekly frequency, 20- and 30-day conversion studies | `clsi/qc.py` |
| Tiered (cascade) reporting and the result-release gate | `clsi/reporting.py` |

Three design decisions carry most of the clinical safety:

- **An MIC is not a number.** `<=4` against a susceptible breakpoint of `2` is
  *not* susceptible — the true MIC could be `4`. `MICValue` keeps the operator
  and concentration together and only resolves a category when the answer holds
  for every value consistent with the reading. Otherwise the result is `NI`
  (no interpretation) with a stated reason, flagged for review. The engine
  never guesses.
- **Interpretations are reproducible.** Each result stores the breakpoint set
  version and table reference used. Adopting a new edition does not silently
  rewrite history; re-interpretation is a separate, audited operation and the
  previous categories remain in `interpretation_history`.
- **Zone diameters run opposite to MICs.** Larger zone means more susceptible.
  Import validation enforces `disk_susceptible_min > disk_resistant_max` and
  rejects inverted or overlapping ranges.

### Security

Detailed in [docs/security.md](docs/security.md). Summary:

- **Passwords** — Argon2id, NFKC-normalised, length-bounded, opportunistic rehash.
- **Tokens** — short-lived JWTs with a pinned algorithm (no `alg: none` /
  HS-RS confusion); opaque refresh tokens stored only as SHA-256 hashes and
  rotated on every use. Replaying a rotated token revokes the whole session.
- **Patient identifiers** — AES-256-GCM at rest with the row identity bound in
  as associated data, so a ciphertext copied between rows fails to decrypt.
  Routine surveillance queries run against an HMAC pseudonym and never decrypt
  anything.
- **Audit trail** — append-only and hash-chained; `UPDATE`/`DELETE`/`TRUNCATE`
  are rejected by database triggers, and `amrss verify-audit` detects any edit,
  deletion, or reordering.
- **RBAC** — deny-by-default, five roles. Notably, `admin` cannot release
  clinical results or read patient identifiers: administering the system is a
  different job from clinical sign-out.
- **Configuration** — no usable defaults. Weak, reused, placeholder, or
  low-entropy secrets are refused at startup rather than warned about.

### Verification

231 tests, including 29 integration tests against real PostgreSQL:

```
pytest -q                                    # unit tests
AMRSS_TEST_DATABASE_URL=postgresql+psycopg://... pytest -q   # + integration
ruff check src tests && bandit -r src -c pyproject.toml && pip-audit --skip-editable
```

---

## Quick start

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"

cp .env.example .env
# Generate three DIFFERENT keys and paste them into .env:
python -m amrss.cli gen-key --bytes 64   # AMRSS_JWT_SECRET
python -m amrss.cli gen-key --bytes 64   # AMRSS_FIELD_ENCRYPTION_KEY
python -m amrss.cli gen-key --bytes 64   # AMRSS_PSEUDONYM_HMAC_KEY

python -m amrss.cli check-config         # fails loudly on a bad config
alembic upgrade head
uvicorn amrss.main:app --reload
```

Or `docker compose up --build` (development only — see the file's header).

Then load breakpoints and create your first user:

```bash
cp data/breakpoints/clsi_m100.template.csv data/breakpoints/m100_ed36.csv
# populate from your licensed M100 copy, then:
python -m amrss.cli import-breakpoints CLSI-M100-Ed36 "CLSI M100 36th ed. (2026)" \
    data/breakpoints/m100_ed36.csv
python -m amrss.cli create-user lead@lab.example "Lab Lead" microbiologist
# review the import, then activate via
# POST /api/v1/clsi/breakpoint-sets/CLSI-M100-Ed36/activate
```

### CLI

| Command | Purpose |
|---|---|
| `gen-key [--bytes N]` | Generate base64url key material |
| `check-config` | Validate configuration without starting the server |
| `verify-audit` | Verify the audit hash chain end to end |
| `import-breakpoints <version> <edition> <file>` | Import a CLSI table (created inactive) |
| `create-user <email> <name> <roles>` | Create an account |

---

## Layout

```
src/amrss/
  clsi/          interpretation engine — no persistence, no framework
  core/          crypto, tokens, RBAC, audit chain
  db/models/     SQLAlchemy models
  services/      auth, audit, breakpoint lifecycle
  api/v1/        FastAPI routers
  middleware/    security headers, rate limiting, request context
alembic/         migrations (0002 installs the append-only triggers)
data/breakpoints/  import template — real tables are gitignored
docs/            security.md, clsi.md
```

The `clsi/` package has no database or web dependencies, so the interpretation
logic is testable in isolation and reusable outside this service.

## Roadmap

Not yet built, in rough priority order:

1. Specimen / isolate / AST result ingest endpoints (the models exist).
2. Persisting interpretations, the override workflow, and the release gate
   behind the API (`clsi/reporting.py` implements the decision logic).
3. Bulk re-interpretation on edition rollover, writing `interpretation_history`.
4. WHO GLASS export and the antibiogram report (`report_exports` is modelled).
5. First-isolate deduplication on ingest (`isolates.is_first_isolate`).
6. Instrument feeds (WHONET / VITEK / Phoenix) and HL7.
7. MFA enrolment endpoints (verification is implemented; enrolment is not).

## Licence and clinical use

This software does not distribute CLSI content. CLSI M100, M02, M07, M45,
M60 and related standards are copyrighted by the Clinical and Laboratory
Standards Institute and must be licensed separately.

AMRSS is decision-*support*. Interpretations must be reviewed and released by a
qualified microbiologist, and the laboratory remains responsible for verifying
breakpoints, rules, and QC ranges against its own licensed standards and
regulatory obligations.
