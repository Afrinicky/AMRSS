# Deploying AMRSS

Getting the surveillance platform and the offline uploader into service.

The platform is two deployed pieces and one distributed piece:

| Piece | Where it runs | How it ships |
|---|---|---|
| Surveillance API | Your server or cloud host | Container image |
| Dashboard | Beside the API, behind the same reverse proxy | Container image |
| Offline uploader | A workstation inside each participating laboratory | Installer, per platform |

The uploader is the only part that touches identifiable data, and it never
leaves the facility. See `docs/security.md` for why that boundary exists.

---

## 1. What you need before starting

- A host with Docker Engine and Compose **v2.24 or later** (the production
  overlay uses the `!override` merge tag).
- PostgreSQL 16. The compose file runs one for you; a managed instance is
  better for anything real, because it gives you backups you did not have to
  build.
- A DNS name and a TLS certificate for the dashboard.
- A reverse proxy — Caddy, nginx, or your cloud's load balancer.

---

## 2. Configure

```bash
cp infra/docker/.env.example infra/docker/.env
```

Fill in every value. Generate the secrets rather than inventing them:

```bash
docker compose -f infra/docker/docker-compose.yml run --rm api \
  python -m amrss.cli gen-secret
```

`AMRSS_CORS_ORIGINS` must be the dashboard's public origin as a JSON array —
`["https://amrss.example.org"]`. The API rejects browser requests from anywhere
else, so getting this wrong looks like a dashboard that cannot sign in.

Check the configuration before serving traffic:

```bash
docker compose -f infra/docker/docker-compose.yml \
               -f infra/docker/docker-compose.prod.yml \
  run --rm api python -m amrss.cli check-config
```

The API refuses to start in production while `AMRSS_JWT_SECRET` is the
development default, so a missed secret fails loudly rather than shipping a
system whose sessions anyone can forge.

---

## 3. Start

```bash
docker compose -f infra/docker/docker-compose.yml \
               -f infra/docker/docker-compose.prod.yml up -d --build
```

Migrations run as the API container starts. Alembic is idempotent, so a restart
finds nothing to apply, and a container can never serve an image against a
schema older than the code inside it.

Reference data — the organism, antimicrobial and specimen dictionaries, and the
provisional methodology versions — is loaded separately:

```bash
docker compose ... exec api python -m amrss.seed
```

In production this loads the dictionaries only. The demo block, its synthetic
isolates and its known-password accounts refuse to load when
`AMRSS_ENVIRONMENT=production`.

---

## 4. Terminate TLS

Neither container speaks TLS. Both bind to loopback and expect a proxy in front.

```caddy
amrss.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

The API is **not** published in production: only the dashboard reaches it, over
the container network. Nothing in the browser ever holds an API address or a
token — the dashboard keeps the session in an httpOnly cookie and calls the API
server-side.

The API runs with `--proxy-headers`. Set `--forwarded-allow-ips` to your proxy's
address if you change the CMD; without it, every request appears to come from
the proxy and per-client rate limiting becomes a single global bucket.

---

## 5. Create the first administrator

A new deployment has no accounts. Nobody can sign in until you make one, and
there is no default account to delete afterwards — that is deliberate.

```bash
docker compose ... exec api python -m amrss.cli create-block \
    AHA "Ahafo" "Ahafo Regional AMR Committee" \
    --district "Asunafo North" --district "Asunafo South"

docker compose ... exec api python -m amrss.cli create-user \
    admin@example.org "Platform Administrator" system_administrator
```

The password is prompted for, never passed as an argument, so it does not reach
your shell history or the process list. Both commands are audited with the
operating-system account as the actor, so a user created out of band is not
invisible in the trail.

Everything after this is done in the console. Districts, laboratories and their
enrollment lifecycle live under **Administration → Facility enrollment**;
accounts live under **Administration → Accounts**. AMRSS ships no facility
roster and no accounts.

Create one **system administrator** from the command line and do the rest from
the console. Note who holds what:

| Role | Creates accounts | Sees surveillance data |
|---|---|---|
| System administrator | Every account, platform-wide | **No** — deliberately |
| Facility administrator | Their own laboratory's staff only | Their own facility |
| Regional AMR administrator | No | Yes, across the block |

That first row is the separation SDD 7 is built on: whoever hands out access
does not also read patient-derived figures. It means your first account should
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
- [ ] HSTS confirmed on a real response from the proxy
- [ ] Database backups running **and a restore tested**, not just scheduled
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
- **Rate limiting is per-process**, so running more than one API worker weakens
  it. Back it with Redis before scaling out.
- **The repository root still carries a second `Dockerfile` and
  `docker-compose.yml`** which build the laboratory service under `src/`, not
  this platform. Use the files under `infra/docker/` for the surveillance
  platform.
