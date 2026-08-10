# Deploying AMRSS

This is the deployment. Not a demonstration standing in for one — the same
software, the same architecture, the same code paths, running for real on
infrastructure that happens to cost nothing while the system is small.

Scaling it later is a change of plan, not a change of software: the API is a
container, the dashboard is a Next.js app, the database is PostgreSQL. Moving
from a free tier to a paid one is a billing decision and a new connection
string.

What starts small is the *data*. A new deployment has no facilities and no
accounts, so it seeds itself with a synthetic regional block — otherwise there
is nothing to look at and no way in. Those seeded accounts are a way to get
started, not the finished state: sign in with one, create your own accounts and
register your own laboratories through the console, then deactivate the seeded
ones. Section 5.

One boundary the software enforces rather than trusting you to remember: while
`AMRSS_ENVIRONMENT` is `staging`, this deployment may carry synthetic data and
known-password accounts. Setting it to `production` refuses both — so the day
real patient-derived data arrives, the seeded block cannot come with it.

---

## What it costs: nothing

| Piece | Service | Free tier | Catch |
|---|---|---|---|
| Dashboard | **Vercel** Hobby | Permanent | None worth mentioning |
| Surveillance API | **Render** free web service | Permanent | Sleeps after 15 min idle; ~1 min to wake |
| Database | **Neon** free | Permanent, 0.5 GB | Suspends when idle; wakes in under a second |
| Offline uploader | Runs on a laboratory PC | — | Unsigned until certificates are bought |

None of these expire. Fly.io was the earlier recommendation and its free
allowance is now a 7-day trial, which is no use to a project that has to still
be running when the directorate asks to see it again a month later.

**The API cannot go on Vercel.** The uploader submits one gzipped batch of up to
64 MB and Vercel's serverless functions cap request bodies at roughly 4.5 MB.
That is why the API is a container on Render rather than a second Vercel
project.

```
  Laboratory workstation                Vercel                    Render          Neon
  ┌──────────────────┐            ┌──────────────┐          ┌─────────────┐   ┌──────────┐
  │ Uploader         │──batch────────────────────────────▶  │ FastAPI     │──▶│ Postgres │
  │ (de-identifies)  │            │              │          │             │   │          │
  └──────────────────┘            │  Dashboard   │──server──▶             │   └──────────┘
                                  │  (Next.js)   │   side   └─────────────┘
   Browser ─────────────────────▶ └──────────────┘
```

The browser talks only to Vercel. The session lives in an httpOnly cookie there
and the dashboard calls the API from its own server, so no API address and no
token ever reaches the browser.

---

## 1. Database — Neon

Create a project and a database at neon.tech. From the connection details, take
**both** strings; they are different hosts and both are needed.

| Neon endpoint | Used for | Host contains |
|---|---|---|
| Pooled | The API's own connections | `-pooler` |
| Direct | Migrations | no `-pooler` |

Rewrite each for this project's driver and require TLS — change `postgresql://`
to `postgresql+psycopg://` and append `?sslmode=require`:

```
postgresql+psycopg://USER:PASSWORD@ep-xxx-pooler.eu-central-1.aws.neon.tech/amrss?sslmode=require
postgresql+psycopg://USER:PASSWORD@ep-xxx.eu-central-1.aws.neon.tech/amrss?sslmode=require
```

Migrations need the direct endpoint because Neon's pooler runs pgbouncer in
transaction mode, which cannot execute the session-level statements some DDL
requires — this project's own `ALTER TYPE ... ADD VALUE` migration is one, and
it would fail halfway through a release rather than at the start.

---

## 2. API — Render

Render dashboard → **New** → **Blueprint** → point it at this repository. It
reads `infra/render/render.yaml` and asks for the two values that file does not
carry:

- `AMRSS_DATABASE_URL` — the **pooled** string from step 1
- `AMRSS_MIGRATION_DATABASE_URL` — the **direct** string

Everything else is already set: `staging` (not production, because this
deployment carries synthetic data), an empty CORS origin list, a generated
signing key, and `AMRSS_BOOTSTRAP=demo`.

That last one matters. Render's free tier gives **no shell**, so there is no way
to run a seed command after deploying. The container therefore seeds itself on
start: migrations, then the dictionaries, then a synthetic regional block. All
of it is idempotent, which it has to be on a tier that sleeps and restarts.

Wait for the first deploy — three or four minutes, most of it building the
image — then check it is genuinely up rather than merely running:

```bash
curl https://amrss-api.onrender.com/health/ready
# {"status":"ready","version":"0.1.0"}
```

`/health` answering `ok` only means the process started. `/health/ready` means
it reached Neon, and that is the one to trust.

---

## 3. Dashboard — Vercel

Import the repository at vercel.com and set **Root Directory** to `apps/web`.
Vercel detects Next.js on its own; `apps/web/vercel.json` supplies the region
and the security headers.

Add one environment variable, to Production **and** Preview:

```
AMRSS_API_URL = https://amrss-api.onrender.com
```

No trailing slash. It is read per request on the server, never inlined into the
bundle — `next.config.mjs` deliberately declares no `env:` block, because that
setting bakes the build-time value into the deployment and made this variable
inert once already.

There is no `NEXT_PUBLIC_` variable and there should never be one: the API
address is not the browser's business.

Deploy. That is the URL you present.

---

## 4. Sign in

The seeded block carries an account per role — both so the system is usable
immediately, and so you can show what each role sees. Password for all of them:

```
AmrssDemo!2026
```

| Account | Shows |
|---|---|
| `amr.admin@amrss-demo.org` | The regional view — antibiogram, trends, comparison, reports |
| `clinician@amrss-demo.org` | What a prescriber sees, and what is withheld from them |
| `lab@amrss-demo.org` | One laboratory's own data, unsuppressed |
| `sysadmin@amrss-demo.org` | Account administration, with no access to clinical data |
| `auditor@amrss-demo.org` | The audit trail, and nothing else |

That last pair is worth showing deliberately: the person who hands out access
cannot read patient-derived figures, and the person who reads the audit trail
holds no operational permission. It is the kind of thing a directorate asks
about and rarely sees answered.

---

## 5. Make it yours

The seeded accounts got you in. Replace them before anyone else uses the system.

1. Sign in as `sysadmin@amrss-demo.org` and open **Administration → Accounts**.
2. Create your own system administrator, then sign in as that account.
3. Deactivate the seeded accounts. The platform refuses to leave itself with no
   one able to manage accounts, so create yours first — that refusal is the
   safeguard working, not an obstacle.
4. Under **Administration → Facility enrollment**, add your districts and
   register your real laboratories.

None of this needs a redeploy, and none of it needs a shell. That is the point:
the roster and the account list are data this system was built to be filled in,
not configuration baked into a build.

The synthetic isolates stay until you clear them, and they are harmless — they
sit in a block of their own. When you no longer want them, drop the demo block's
facilities from the console and set `AMRSS_BOOTSTRAP` to `none` so a restart
does not put them back.

---

## 6. Before you present

**Wake it up.** The API sleeps after fifteen minutes of inactivity and takes
about a minute to return. Open the dashboard ten minutes before you start and
click through a couple of pages. If you would rather not think about it, a free
uptime pinger (UptimeRobot, cron-job.org) hitting
`https://amrss-api.onrender.com/health` every ten minutes keeps it awake — the
liveness endpoint, deliberately, so the ping costs a database query it does not
need.

**Load the breakpoints.** Without a CLSI table the antibiogram computes from
what the laboratories already interpreted, and every zone diameter sits
uninterpreted. Section 6 covers it, and it is worth doing before the
demonstration: "here is the CLSI table we loaded, here is what it refused and
why" is a strong answer to the first technical question anyone asks.

**Know what the empty pages mean.** Coverage, alerts and some drill-downs will
be sparse — the demonstration block is small on purpose. Sparse is the honest
display state for a small denominator, and saying so is better than apologising
for it.

---

## 7. Load the breakpoint table

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

## 8. Distribute the uploader

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

## 9. Before this carries real patient data

Everything above stands. What changes is small, and deliberately so — the
software is the same, the topology is the same, and scaling is a plan change:

| Setting | Now | When real data arrives |
|---|---|---|
| `AMRSS_ENVIRONMENT` | `staging` | `production` |
| `AMRSS_BOOTSTRAP` | `demo` | `none` |
| Render plan | free (sleeps when idle) | paid (always on) |
| Neon plan | free (0.5 GB) | paid, with point-in-time restore |

Setting `AMRSS_ENVIRONMENT=production` turns on the configuration checks and
makes the seeded block un-loadable — so the switch is the same act as retiring
the synthetic data, and cannot be half-done.

Then the checklist:

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
  (§8). Nothing in the repository can fix that for you.
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
