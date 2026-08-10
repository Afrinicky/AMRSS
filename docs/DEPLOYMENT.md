# Deploying AMRSS

Getting the surveillance platform and the offline uploader into service.

The deployment described here is **Vercel** for the dashboard, **Neon** for
PostgreSQL, and **Fly.io** for the API. Only the third is a choice rather than a
constraint: the API is an ordinary container and runs unchanged on Render,
Railway or a virtual machine — `infra/docker/docker-compose.prod.yml` is that
path. Substitute freely.

| Piece | Where it runs | Why |
|---|---|---|
| Dashboard | Vercel | It is a Next.js app; this is what Vercel is for |
| Surveillance API | Fly.io, region `jnb` | A container, close to the laboratories, with no request-body limit |
| Database | Neon | Managed PostgreSQL 16, with backups you did not have to build |
| Offline uploader | A workstation inside each laboratory | It must never leave the facility |

**The API cannot go on Vercel.** The uploader submits one gzipped batch of up to
64 MB, and Vercel's serverless functions cap request bodies at roughly 4.5 MB.
Splitting a batch into chunks would mean changing the component that handles
identifiable patient data to satisfy a hosting limit, which is the wrong way
round.

The uploader is the only part that touches identifiable data, and it never
leaves the facility. See `docs/security.md` for why that boundary exists.

```
  Laboratory workstation                Vercel                    Fly.io           Neon
  ┌──────────────────┐            ┌──────────────┐          ┌─────────────┐   ┌──────────┐
  │ Uploader         │──batch────────────────────────────▶  │ FastAPI     │──▶│ Postgres │
  │ (de-identifies)  │            │              │          │             │   │          │
  └──────────────────┘            │  Dashboard   │──server──▶             │   └──────────┘
                                  │  (Next.js)   │   side   └─────────────┘
   Browser ─────────────────────▶ └──────────────┘
```

The browser talks only to Vercel. The session lives in an httpOnly cookie there,
and the dashboard calls the API from its own server, so no API address and no
token ever reaches the browser.

---

## 1. Create the database

In Neon, create a project and a database. Take **both** connection strings from
the dashboard — they are different hosts and both are needed:

| Neon endpoint | Used for | Looks like |
|---|---|---|
| Pooled | The API's own connections | `...-pooler.<region>.aws.neon.tech` |
| Direct | Migrations | `...<region>.aws.neon.tech` |

Migrations need the direct one. Neon's pooler runs pgbouncer in transaction
mode, which cannot execute the session-level statements some DDL requires —
this project's own `ALTER TYPE ... ADD VALUE` migration is one, and it fails
halfway through a release rather than at the start.

Rewrite both for the driver this project uses, and require TLS:

```
postgresql+psycopg://USER:PASSWORD@ep-xxx-pooler.eu-central-1.aws.neon.tech/amrss?sslmode=require
postgresql+psycopg://USER:PASSWORD@ep-xxx.eu-central-1.aws.neon.tech/amrss?sslmode=require
```

`check-config` refuses a hosted database URL without `sslmode`, and refuses a
deployment that points migrations at the pooler.

---

## 2. Deploy the API

```bash
fly launch --no-deploy --copy-config --config infra/fly/fly.toml

fly secrets set \
  AMRSS_DATABASE_URL='postgresql+psycopg://...-pooler.../amrss?sslmode=require' \
  AMRSS_MIGRATION_DATABASE_URL='postgresql+psycopg://.../amrss?sslmode=require' \
  AMRSS_JWT_SECRET="$(python -m amrss.cli gen-secret)"

fly deploy --config infra/fly/fly.toml --dockerfile infra/docker/api.Dockerfile
```

Migrations run as the container starts, so an instance can never serve against a
schema older than the code inside it. Alembic is idempotent; a restart finds
nothing to apply.

Confirm it before going further — `/health` says the process is up, `/health/ready`
says it can reach Neon, and only the second one is a real answer:

```bash
curl https://amrss-api.fly.dev/health/ready     # {"status":"ready", ...}
fly ssh console -C "python -m amrss.cli check-config"
```

`AMRSS_ENVIRONMENT=production` makes the API refuse to start on a development
signing key, a key under 32 characters, a database URL carrying the development
password published in this repository, a hosted database without TLS, or a
leftover localhost CORS origin. A missed secret fails loudly rather than
shipping a system whose sessions anyone can forge.

What it deliberately does *not* refuse is a database on `localhost`: a virtual
machine running PostgreSQL beside the API is a legitimate deployment, and a
check that blocks it only teaches operators to work around checks. A database
that genuinely is not there answers at `/health/ready`.

Then load the dictionaries — organisms, antimicrobials, specimen types and the
provisional methodology versions:

```bash
fly ssh console -C "python -m amrss.seed"
```

In production this loads reference data only. The demo block, its synthetic
isolates and its known-password accounts refuse to load when
`AMRSS_ENVIRONMENT=production`.

---

## 3. Deploy the dashboard

Import the repository into Vercel and set **Root Directory** to `apps/web`.
Vercel detects Next.js; `apps/web/vercel.json` supplies the region and the
security headers.

One environment variable, for Production and Preview both:

```
AMRSS_API_URL = https://amrss-api.fly.dev
```

It is read per request on the server, never inlined into the bundle —
`next.config.mjs` deliberately declares no `env:` block, because that setting
bakes the build-time value into the image and made the runtime variable inert
once already.

There is no `NEXT_PUBLIC_` variable and there should never be one: the API
address is not the browser's business.

---

## 4. Close the loop between them

Two settings have to agree, and getting either wrong looks like a broken
dashboard rather than a misconfiguration:

- **`AMRSS_API_URL` on Vercel** must be the API's public HTTPS origin, with no
  trailing slash.
- **`AMRSS_CORS_ORIGINS` on the API** should stay **empty**. The dashboard calls
  the API from Vercel's servers, so no browser origin needs trusting, and an
  empty list is the tighter configuration. Set it only if something else calls
  the API from a browser.

The API is publicly reachable, because Vercel's functions and the laboratories'
uploaders both need to reach it and neither is on a private network with Fly.
That is fine — every endpoint but `/health` and sign-in requires a token — but
it does mean rate limiting and the account lockout are load-bearing rather than
defence in depth.

---

## 5. Create the first administrator

A new deployment has no accounts. Nobody can sign in until you make one, and
there is no default account to delete afterwards — that is deliberate.

```bash
fly ssh console -C "python -m amrss.cli create-block AHA 'Ahafo' 'Ahafo Regional AMR Committee'"
fly ssh console --pty -C "python -m amrss.cli create-user admin@example.org 'Platform Administrator' system_administrator"
```

Use `--pty` for `create-user`: the password is prompted for rather than passed
as an argument, so it never reaches your shell history or the process list. Both
commands are audited with the operating-system account as the actor, so an
account created out of band is not invisible in the trail.

Everything after this is done in the console. Districts, laboratories and their
enrollment lifecycle live under **Administration → Facility enrollment**;
accounts live under **Administration → Accounts**. AMRSS ships no facility
roster and no accounts.

Create one **system administrator** and do the rest from the console. Note who
holds what:

| Role | Creates accounts | Sees surveillance data |
|---|---|---|
| System administrator | Every account, platform-wide | **No** — deliberately |
| Facility administrator | Their own laboratory's staff only | Their own facility |
| Regional AMR administrator | No | Yes, across the block |

That first row is the separation SDD 7 is built on: whoever hands out access
does not also read patient-derived figures. Your first account should therefore
be a system administrator, and the regional AMR lead is an account that
administrator then creates.

An administrator who sets a password necessarily knows it, so the account is
required to change it at first sign-in and says so on every page until it does.
Deliver initial passwords in person or by another channel — not in the same
message as the email address.

---

## 6. Load the breakpoint table

Until a CLSI table is loaded, zone diameters and MICs are stored but not
interpreted, and the antibiogram will look far emptier than the data behind it.

Upload your licensed table — the workbook is accepted directly — and **preview
it first**:

```
POST /api/v1/breakpoints/preview
POST /api/v1/breakpoints/import
```

Read the `dropped` list in the response. It names every criterion the reader
refused and why, and refusals are the point: extractions of the printed tables
lose sub-table boundaries and truncate labels, and a guessed threshold reaches a
patient. See `docs/clsi.md` for the rules and for how to supply the dropped rows
by hand.

Then interpret the stored measurements:

```
POST /api/v1/breakpoints/interpret
```

The response's `uncovered` list names every organism/agent combination your data
contains that your table does not cover. Work that list down before publishing
an antibiogram.

---

## 7. Distribute the uploader

The uploader is an Electron application that reads WHONET SQLite exports,
de-identifies them at the facility and submits only the result.

```bash
cd apps/uploader
npm ci
npm run dist        # installers for the host platform, into release/
```

`npm run dist` produces an NSIS installer on Windows, a DMG on macOS, and an
AppImage and .deb on Linux. Build each platform on that platform — electron-builder
cannot cross-compile the native SQLite module, which is rebuilt against
Electron's ABI rather than Node's. The compiled tests and their WHONET fixtures
are excluded from the package; they have no business on a clinical workstation.

**Sign the builds before distributing them.** electron-builder signs
automatically when the credentials are in the environment and produces an
unsigned artefact when they are not — so an unsigned build means a missing
certificate, never a silent misconfiguration:

| Platform | Environment |
|---|---|
| Windows | `WIN_CSC_LINK` (path or base64 of the .pfx), `WIN_CSC_KEY_PASSWORD` |
| macOS | `CSC_LINK`, `CSC_KEY_PASSWORD`, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarisation |

An unsigned installer is one facility IT should refuse, and telling them to
click through the warning is the worst security advice this project could give.
Certificates are the one part of this that has to be bought rather than built.

No auto-update channel is configured, deliberately. Software that de-identifies
patient data should not replace itself silently on a clinical workstation;
upgrades are coordinated with the facility, and `AMRSS_MINIMUM_UPLOADER_VERSION`
is what refuses genuinely stale clients at the ingestion API.

Before it reaches any real laboratory, confirm the WHONET column profile against
that laboratory's own export. The default profile in
`apps/uploader/src/core/whonet.ts` follows common conventions and is a starting
point for detection, not a verified mapping. The uploader refuses to proceed
when a required field is unmapped — but a *wrongly* mapped column reads
plausibly and is wrong, and that is the single highest-risk assumption in the
system.

Brief each facility on salt custody. A facility that loses its salt file cannot
regenerate its historical linkage keys, and deduplication silently degrades.
That irrecoverability is what makes the key irreversible; it is not a defect,
but it needs an operational backup routine.

---

## 8. Before you call it live

- [ ] `check-config` passes with `AMRSS_ENVIRONMENT=production`
- [ ] `/health/ready` answers `ready`, not just `/health` answering `ok`
- [ ] HSTS confirmed on a real response from the dashboard
- [ ] Neon point-in-time restore **tested**, not just enabled — a backup nobody
      has restored is a belief, not a backup
- [ ] The audit trail exported to append-only storage on a schedule
- [ ] Breakpoint table reviewed against the printed tables before it is relied on
- [ ] Provisional methodology values reviewed and approved (`docs/STANDARDS.md`);
      every figure computed under one says "provisional" until they are
- [ ] The organism list for below-threshold alerts agreed with the clinical and
      microbiology leads
- [ ] WHONET column profile confirmed against a real export from each laboratory

---

## Known gaps

Stated plainly, because a deployment plan that hides them is worse than no plan.

- **No MFA**, which `docs/security.md` lists as a deployment expectation. Until
  it exists, a stolen password is a stolen session; keep the administrator
  accounts few and the password floor high.
- **No self-service password recovery.** By design rather than omission — AMRSS
  holds no email address it could send a reset link to, and sending one would
  put a credential into a mailbox this system does not control. A forgotten
  password is reset by an administrator who can confirm who is asking. That
  needs an administrator to be reachable, which is an operational commitment,
  not a technical one.
- **Uploader installers are built but unsigned** until you supply certificates
  (§7). Nothing in the repository can fix that for you.
- **Rate limiting is per-process**, so it weakens as soon as more than one API
  machine runs. `fly.toml` keeps a single machine for that reason; back the
  limiter with Redis before scaling out, or the limit multiplies by the machine
  count.
- **Scale-to-zero costs the first laboratory of the day a cold start**, and the
  container runs migrations on the way up. Both are seconds, and an uploader
  submitting a batch can absorb them — but if that ever stops being true, set
  `min_machines_running = 1`.
- **The repository root still carries a second `Dockerfile` and
  `docker-compose.yml`** which build the laboratory service under `src/`, not
  this platform. Use `infra/fly/` or `infra/docker/` for the surveillance
  platform.

---

## Running it somewhere else

Nothing above is load-bearing except the database URLs and
`AMRSS_API_URL`. The API image is an ordinary container:

- **Render or Railway** — point them at `infra/docker/api.Dockerfile` with the
  repository root as build context, and set the same secrets.
- **A virtual machine** — `infra/docker/docker-compose.yml` plus
  `docker-compose.prod.yml` runs the API, the dashboard and a local PostgreSQL
  behind your own reverse proxy. Drop the `postgres` service and point
  `AMRSS_DATABASE_URL` at Neon to keep the managed database.

The one constraint that does not move: whatever hosts the API must accept a
64 MB request body.
