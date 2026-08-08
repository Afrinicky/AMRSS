# Developer Runbook

## Prerequisites

- Docker (or a local PostgreSQL 16)
- Python 3.11+ with [uv](https://docs.astral.sh/uv/)
- Node 20+

## Full stack

```bash
make dev-up     # Postgres, API and web, with migrations and seed data
make dev-down   # stop, keeping the database volume
```

The dashboard is then at `http://localhost:3000` and the API at
`http://localhost:8000` (interactive docs at `/docs` outside production).

## Running each part on its own

```bash
make db-up      # Postgres only

# API
cd apps/api
uv sync --all-extras
uv run alembic upgrade head
uv run python -m amrss.seed
uv run uvicorn amrss.main:app --reload --port 8000

# Dashboard
cd apps/web
npm install
AMRSS_API_URL=http://localhost:8000 npm run dev

# Offline uploader
cd apps/uploader
npm install
npm run dev
```

## Demo accounts

Loaded by `make seed` in non-production environments only; the seed refuses to
run against `AMRSS_ENVIRONMENT=production`. Password for all: `AmrssDemo!2026`.

| Email | Role | Sees |
|---|---|---|
| `clinician@amrss-demo.org` | Clinician | Regional antibiogram, trends, alerts. Read-only. |
| `amr.admin@amrss-demo.org` | Regional AMR administrator | Full regional analytics, enrollment, alert configuration |
| `steward@amrss-demo.org` | Data steward | Flagged batches, code mappings, quality dashboards |
| `auditor@amrss-demo.org` | Auditor | Audit trail only — no operational access |
| `sysadmin@amrss-demo.org` | System administrator | Users and infrastructure — no surveillance data |
| `lab@amrss-demo.org` | Laboratory staff | Uploads and its own facility's un-suppressed data |
| `facility.admin@amrss-demo.org` | Facility administrator | Own facility's reports; cannot upload or edit data |

The demo block deliberately contains conditions the platform must handle, not a
uniformly clean dataset: a facility with lapsed EQA (excluded from the verified
aggregate), an overdue facility, a facility enrolled but not yet contributing,
repeat isolates that deduplication collapses, and one organism-agent pair whose
susceptibility falls sharply in recent weeks so signal detection has a true
positive to find.

## Tests

```bash
make test                        # backend suite
cd apps/uploader && npm test     # de-identification and WHONET reader
cd apps/web && npm run typecheck
make lint                        # ruff, mypy, eslint, tsc
```

The backend suite includes two structural guards that will fail the build rather
than let an architectural commitment erode quietly:

- no region name may appear in application source (ADR-0002);
- no methodology value may be hardcoded in the analytics engine (ADR-0003).

## Simulating an upload without the desktop client

`apps/uploader` is the real path, but a batch is just gzipped JSON with a
checksum header, so the ingestion pipeline can be exercised directly:

```bash
curl -X POST http://localhost:8000/api/v1/ingestion/batches \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/octet-stream" \
  -H "x-amrss-checksum: $(sha256sum batch.json.gz | cut -d' ' -f1)" \
  --data-binary @batch.json.gz
```

Payload shape: `apps/api/amrss/ingestion/payload.py`.

## Database changes

```bash
make revision m="add facility contact"
make migrate
```

Migrations are reviewed as migrations and excluded from lint formatting.

## Before deploying to a real facility

1. **Validate the WHONET column profile against a real export.** The default
   profile in `apps/uploader/src/core/whonet.ts` follows common conventions and is
   a starting point for detection, not a verified mapping. The uploader refuses to
   proceed when a required field is unmapped, but a *wrongly* mapped column would
   read plausibly and be wrong — this is the single highest-risk assumption in the
   system and must be confirmed against a sample file.
2. **Resolve the open methodology questions** (`docs/STANDARDS.md`). Values are
   seeded as provisional and every statistic computed under one says so.
3. **Brief facilities on salt custody.** If a facility loses its salt file, its
   historical linkage keys cannot be regenerated and deduplication silently
   degrades. That irrecoverability is what makes the key irreversible; it is not a
   defect, but it does need an operational backup routine.
4. **Set `AMRSS_JWT_SECRET`.** The API refuses to start in production with the
   development default.
