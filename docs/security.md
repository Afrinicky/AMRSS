# Security design

AMRSS holds two kinds of sensitive data: patient identifiers, and susceptibility
results that inform treatment. This document records what the system does about
that, and — as importantly — what it does not do.

---

## Threat model

Defended against:

| Threat | Control |
|---|---|
| Stolen database backup | Identifiers encrypted with AES-256-GCM; passwords Argon2id; tokens stored as hashes only |
| Stolen refresh token | Rotation on every use; replay revokes the whole session and is audited |
| Forged/replayed access token | Pinned algorithm, issuer and audience; session re-checked against the database on every request |
| Credential stuffing / brute force | Argon2id, per-account lockout, per-IP throttling, rate-limit middleware |
| Account enumeration | Identical error messages and equalised timing on the unknown-account path |
| Insider tampering with history | Hash-chained, append-only audit log with database triggers |
| Silent misconfiguration | Startup validation refuses weak, reused, placeholder or low-entropy secrets |
| Vulnerable dependencies | `pip-audit` in CI |

**Not** defended against, and needing controls outside this codebase:

- A database superuser who can drop triggers *and* recompute the whole hash
  chain. Mitigate by exporting the newest `entry_hash` to append-only external
  storage (see [Audit anchoring](#audit-anchoring)).
- Anyone holding the `field_encryption_key`. Use a KMS or HSM in production;
  the environment variable is the weakest acceptable option.
- Compromise of the host or the application process itself.
- Traffic analysis, and any threat below the TLS terminator.

---

## Configuration

Every secret is required from the environment. There are no usable defaults, so
a misconfigured deployment fails to start rather than running with a guessable
key. Run `python -m amrss.cli check-config` as a deployment pre-flight step.

With `AMRSS_ENVIRONMENT=production`, startup additionally refuses:

- `debug` enabled
- `*` or `http://` CORS origins
- `session_cookie_secure` disabled
- `enforce_qc_gating` disabled — releasing AST results without in-range QC
  violates CLSI, so it is a configuration error, not a preference
- placeholder secrets, checked **both encoded and decoded** (base64-ing
  `changeme-changeme-…` hides the word from a naive scan while leaving the key
  just as guessable)
- low-entropy key material (a key built from a repeated pattern)
- any two of the three keys being identical

That last rule matters: reusing one secret for signing, encryption and
pseudonymisation collapses three separate blast radii into one.

### Key sizes

`jwt_secret` must satisfy the signing algorithm — 64 bytes for the default
HS512, 32 for HS256 (RFC 7518 §3.2). A shorter key silently weakens the
signature below the algorithm's nominal strength, so it is refused rather than
warned about.

`field_encryption_key` accepts any material ≥32 bytes and derives the AES-256
key through HKDF-SHA256 with a fixed info label. **Changing that label makes
every existing ciphertext undecryptable.**

---

## Authentication

### Passwords

Argon2id (memory-hard), NFKC-normalised so composed and decomposed forms of the
same passphrase match. Input is bounded at 1024 bytes so an oversized body
cannot be used to burn CPU. Policy follows NIST SP 800-63B: length and a
blocklist do more real work than symbol-composition rules. Hashes are upgraded
opportunistically when cost parameters change.

Unknown accounts still incur a full Argon2 verification against a decoy hash
built with the same cost parameters, so login timing does not enumerate
accounts.

### Tokens

**Access tokens** are short-lived JWTs (15 min default). Decoding pins the
algorithm — accepting the token's own `alg` header is how `alg: none` and
HS/RS confusion attacks get in — and requires `exp`, `iat`, `nbf`, `sub`,
`iss`, `aud` and `jti`.

A valid signature is not sufficient. Every request re-checks that the session
exists and is unrevoked and that the user is still active, and **roles are read
from the database, not the token**. That is what makes logout, session
revocation, and role changes take effect immediately rather than at token
expiry.

**Refresh tokens** are opaque random strings — never JWTs — stored only as
SHA-256 hashes and rotated on every use. Presenting an already-rotated token
means the legitimate client and an attacker both hold tokens, so the session is
revoked outright and `auth.token.reuse_detected` is audited. The replay history
is capped at 20 entries so a long-lived session cannot grow the row unbounded.

### MFA

TOTP with `valid_window=1` (one 30-second step of drift, no more). The secret is
stored encrypted, bound to the user row. Roles in
`AMRSS_REQUIRE_MFA_FOR_ROLES` cannot sign in at all without enrolment — the
requirement is never silently downgraded.

> Enrolment endpoints are not yet implemented; verification is.

---

## Authorisation

Deny-by-default RBAC. Unknown roles grant nothing.

| Role | Notable capability |
|---|---|
| `viewer` | Read-only |
| `lab_technologist` | Record results and QC; **cannot** override or release |
| `microbiologist` | Override interpretations, release results, read identifiers |
| `data_manager` | Import and activate breakpoint sets; read audit |
| `admin` | Manage users, read audit |

Two separations are deliberate:

- **`admin` cannot release results or read patient identifiers.** Administering
  the system is a different job from clinical sign-out.
- **`lab_technologist` cannot override the engine.** CLSI expects a qualified
  reviewer in that loop.

Permission failures return a deliberately vague message; enumerating the missing
permission tells an attacker how the model is shaped.

---

## Patient privacy

Direct identifiers (MRN, national ID, name, date of birth) are stored **only**
as AES-256-GCM ciphertext and are never indexed. The row's identity is bound in
as associated data (`patient:<uuid>:mrn`), so a ciphertext copied from one row
to another fails to decrypt instead of silently impersonating a patient.

Lookup and linkage use `pseudonym`, an HMAC-SHA256 of the normalised identifier.
So `AB-123`, `ab 123` and ` AB123 ` all resolve to the same patient, and the
ordinary surveillance workload — counting resistant isolates, deduplicating a
patient's repeat isolates — runs without decrypting anything.

Coarse stratifiers (birth year, age group, sex) are kept in the clear because
surveillance stratification needs them and they carry little re-identification
risk on their own.

> **Rotating `pseudonym_hmac_key` breaks all existing linkage.** Every patient
> would be re-derived to a new pseudonym and historical isolates would no longer
> join. Treat it as permanent; if it must change, plan a migration that
> re-derives every row in one pass.

---

## Audit trail

Every state change is appended to `audit_log`. Each row's `entry_hash` covers
the previous row's hash, so editing, deleting or reordering history breaks every
subsequent link. `python -m amrss.cli verify-audit` performs the check.

Appends take a transaction-scoped advisory lock so two concurrent requests
cannot read the same chain head and fork it.

Sensitive keys — passwords, tokens, MFA secrets, MRNs, dates of birth — are
recursively redacted before an entry is persisted, so the audit log never
becomes a secondary leak of the data it is protecting.

Migration `0002_audit_append_only` installs triggers rejecting `UPDATE`,
`DELETE` and `TRUNCATE` (the last needs its own statement-level trigger, since
`TRUNCATE` bypasses row-level ones). Tampering therefore requires superuser
access *and* leaves the chain broken.

### Audit anchoring

The chain proves internal consistency, not external truth: an attacker with
write access and enough time could recompute it. To close that gap, periodically
export the newest row's `entry_hash` to append-only external storage (object
storage with immutability, a transparency log, or a signed daily email to a
separate system). Any recomputation then contradicts the anchor.

*Not yet implemented — this is a documented deployment step.*

---

## Transport and HTTP

The API returns JSON only and renders nothing, so the CSP is maximally
restrictive: `default-src 'none'; frame-ancestors 'none'; base-uri 'none';
form-action 'none'`. Also set: `nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, COOP/CORP, a restrictive `Permissions-Policy`,
and HSTS in production. Clinical responses carry `Cache-Control: no-store` so
they never sit in a shared or browser cache. The server banner is stripped.

Interactive docs (`/docs`, `/openapi.json`) are disabled in production.

Client-supplied `X-Request-ID` is validated against `[A-Za-z0-9_-]{1,64}` before
being echoed or logged; a header carrying CRLF must never reach a log line.

Database and validation errors are logged, never returned — they carry table
names, constraint names and sometimes row values. Validation responses return
field errors only, never the submitted body, so a mistyped password cannot be
reflected into an error tracker.

### Client IP and rate limiting

`X-Forwarded-For` is **not** trusted. It is attacker-controlled unless a known
proxy sets it, and trusting it would let any client spoof its address and defeat
rate limiting. Terminate the proxy chain properly:

```
uvicorn amrss.main:app --proxy-headers --forwarded-allow-ips=<proxy-ip>
```

Never `--forwarded-allow-ips=*`.

> **Deployment limit:** the rate limiter is in-process. Behind more than one
> worker the effective limit multiplies by the worker count. Back it with Redis
> for multi-worker deployments.

---

## Database

- Server-side `statement_timeout` (15 s default) so a pathological query cannot
  pin a connection.
- SQL echo is off; credentials and patient data never reach the logs.
- All access goes through the SQLAlchemy ORM (parameterised). The only raw SQL
  is the advisory lock, which is bound, not interpolated.
- An optional read-only DSN for reporting sets
  `SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` on connect.
- Clinical invariants are enforced by `CHECK` constraints, not only application
  code: an override cannot be saved without a documented reason; the
  measurement must match the method; categories are constrained to the CLSI set.

---

## Deployment checklist

- [ ] Three distinct keys, generated with `gen-key --bytes 64`, held in a KMS
- [ ] `AMRSS_ENVIRONMENT=production`; `check-config` passes
- [ ] TLS terminated upstream; HSTS confirmed on a real response
- [ ] `--proxy-headers` with a specific `--forwarded-allow-ips`
- [ ] Rate limiting backed by Redis if running multiple workers
- [ ] Database user is not the owner of the `audit_log` table; no `TRUNCATE` grant
- [ ] `verify-audit` scheduled, with alerting on a non-zero exit
- [ ] Audit anchor exported to append-only external storage
- [ ] Backups encrypted and restore-tested
- [ ] MFA enrolled for every `admin` and `data_manager`
- [ ] Breakpoint set reviewed against the printed tables before activation
- [ ] Intrinsic-resistance and expert rules verified against your M100 edition

---

## Reporting a vulnerability

Do not open a public issue. Contact the maintainers directly with the details
and a reproduction, and allow reasonable time to remediate before disclosure.
