# The laboratory uploader

`apps/uploader` is the desktop application a laboratory runs beside WHONET. It
reads the laboratory's WHONET database, shows the laboratory its own data
interpreted as S/I/R, checks every record before anything is sent, and submits
de-identified surveillance records to the platform.

It is the only part of AMRSS that ever touches identifiable patient data, and
the boundary is structural: what leaves the building is assembled field by field
from an allow-list in `src/core/deidentify.ts`, so a patient name, hospital
number, date of birth, ward or free-text comment has no route out, whatever a
facility's WHONET happens to contain.

---

## What a laboratory does

**Sign in** with the same username and password as the AMRSS website. That is
the whole screen — two boxes and a button.

Nobody at the bench is asked for a server address. The address is deployment
configuration: the installer is built with it (see below), so the software
already knows where to send data. If an installation has none, the sign-in
screen says the computer has not been connected yet and to ask IT — it does not
present an empty box to someone who has no way to fill it.

Two things a facility administrator sets once, in Settings:

- **Facility** — the code the regional administrator issued at enrolment. A
  batch declaring a different one is refused by the platform.
- **WHONET data** — the WHONET `.sqlite` file. The uploader inspects it, reports
  the columns it found, and asks for confirmation.

After that the file never moves, so the uploader follows it: every result
entered in WHONET appears here, and uploading is one button.

## What IT does, once per computer

Everything technical lives in one place, labelled for the person it is meant
for: **Settings → Connection (IT)**, also reachable from **Help → Connection
settings** before anyone signs in. It holds the service address, the website
address, how often the connection is checked, and how long the machine may work
offline — with a **Test connection** button, so whoever sets it up finds out
there and then whether it works.

Better still, set nothing: build the installer with the addresses baked in.
`deployment.json` sits beside the application and is written by the build from
the programme's repository variables:

| Variable | What it sets |
|---|---|
| `AMRSS_API_URL` | The service the uploader submits to — the API, not the website |
| `AMRSS_WEB_URL` | The dashboard, for "Open the AMRSS website" |
| `AMRSS_SUPPORT_CONTACT` | Who the software names when it cannot reach the service |

`deployment.example.json` shows the shape. A facility's IT can also drop the
file beside an already-installed application, or correct it, without rebuilding
anything.

---

## The modules

| Module | What it answers |
|---|---|
| **Dashboard** | What this laboratory's data currently says, and whether it is ready to send. |
| **Database** | WHONET's own grid, with interpretations instead of millimetres — switchable back, downloadable either way. |
| **Validation** | What is missing, what must be fixed first, and the sign-off that releases the batch. |
| **Upload** | What the batch contains, and the confirmation that sends it. |
| **Antibiogram** | Percent susceptible by organism and antimicrobial. |
| **Organisms** | What is being isolated, from where, in whom, with resistance markers. |
| **Antimicrobials** | Each agent pooled across the organisms tested against it. |
| **Specimens & sites** | Sites of infection, care setting, age, ward, department. |
| **Trends** | Resistance and workload over time. |
| **Upload history** | Every batch sent from this computer, hash-chained. |
| **Settings** | Facility, schedule, alerts, breakpoints, code mapping. |

Every table and figure downloads as `.xlsx`, and every download carries its own
provenance sheet: the filters that produced it, the counting rules behind its
percentages, and the breakpoint edition that interpreted it.

---

## What the uploader excludes, and why

A row is read, counted and shown, but held out of surveillance when:

- **No organism was isolated** — `xxx` (no growth), `xsg` (no significant
  growth), normal or mixed flora. Across the two validation exports these
  accounted for 102 of 183 and 16 of 268 rows. Admitting them would invent
  organisms called "xxx", inflate every workload count and put meaningless rows
  in the antibiogram.
- **Nothing was tested** — an organism with no susceptibility result is not a
  surveillance record. Settings → WHONET data can include these if a facility
  wants them counted.
- **The facility held it out** deliberately, with a reason recorded.

Excluded is not deleted. The counts reconcile against WHONET's own record count,
and the Dashboard says how many were held out and why.

---

## Validation

Findings come in two strengths:

- **Must fix** — the record cannot be interpreted at all: no site of collection,
  no specimen date, no patient identifier, an organism or specimen code the
  dictionary does not know, a zone diameter outside the range a disk test
  produces, a specimen date in the future or years before the surveillance
  period. Those records are held back; the rest of the batch still uploads.
- **Advisory** — the record is poorer but real: age, sex or care setting not
  recorded, a duplicate, a date taken from the data-entry column. These upload
  as recorded. Refusing a batch over a missing age would teach people to invent
  ages.

Fixes are made in the uploader. **The WHONET database is never written to** —
it is opened read-only everywhere in the application. Corrections are stored
beside it and re-applied on every read, keeping the laboratory's original value
so the change is reviewable and reversible. A code the dictionary does not hold
is mapped once, in Settings → Code mapping, and the mapping then applies to
every row that uses it.

Where the file itself justifies a repair, it is offered: a row missing its
specimen type but carrying specimen code `11` is offered `ur`, because every
other row in that file with code `11` is urine.

---

## Interpretation

No breakpoint values ship with AMRSS. The tables are copyrighted, revised every
edition, and a single mistyped threshold turns an `R` into an `S`.

The uploader interprets against the laboratory's own licensed table, obtained
either way:

- **Settings → Breakpoints → Sync from platform** pulls the table the platform
  is using (`GET /api/v1/breakpoints/active`), so both halves cite the same
  edition.
- **Import a CSV** loads the same template the platform imports
  (`data/breakpoints/clsi_m100.template.csv`), for a laboratory that works
  offline.

With no table loaded, measurements show as `PI` — measured, pending
interpretation. They are still uploaded, still counted as tested, and excluded
from susceptibility rates until a table resolves them. Nothing is guessed. A
category the laboratory recorded itself is always kept; where it disagrees with
the table, the disagreement is reported rather than resolved.

---

## Working offline

Connectivity is intermittent in the settings this software is built for, so the
uploader does not stop when the link does.

- The indicator beside your name is **green online, red offline**, and the
  offline state sounds a periodic alert (switchable in Settings).
- Messages are written for the bench: *"AMRSS could not be reached just now.
  Ask your IT support if it continues."* The technical wording — the address,
  the status code, what to check — is one click away under **Details for IT
  support**, where it helps the person who can act on it and nobody else.
- **Offline sign-in** works for the account that last signed in online on this
  computer, checked against a scrypt verifier — never a stored password. It
  lapses after `offlineGraceDays` (30 by default) so an account closed centrally
  cannot keep working here forever.
- Everything local works offline: the grid, validation, corrections, all
  analysis. Only uploading needs the network, and the interface says so rather
  than failing at the last step.
- When the connection returns, an offline session upgrades itself silently and
  uploading resumes.

**Open web console** signs you into the browser as the same account, using a
ninety-second handoff code issued by the API. No second password.

---

## Automatic uploads

Settings → Upload schedule offers manual (the default) or automatic — hourly,
every N hours, daily, weekly or monthly, at a time the facility chooses.

An automatic run is not unattended. It refuses exactly what the send button
would refuse, and reports why:

- not signed in, or offline;
- setup incomplete;
- any must-fix validation finding outstanding;
- data changed since a person last approved it.

That last one matters most. WHONET is still being typed into while this software
watches the file, and a schedule firing mid-entry would upload a half-entered
specimen. The approval is recorded against a fingerprint of the data and lapses
the moment WHONET writes another result. A facility can turn the requirement
off; it is on by default.

---

## Development

```bash
cd apps/uploader
npm install
npm run build      # main + renderer (compiled separately; see tsconfig.renderer.json)
npm test           # node --test over the compiled output
npm run dev        # build and launch Electron
npm run dist       # installers, signed when the certificates are in the environment
```

`better-sqlite3` is native, and Electron and Node need it built against different
ABIs. The scripts handle the switch — `dev` rebuilds it for Electron, `test`
rebuilds it for Node — so running one after the other works; `electron-builder`
rebuilds it for the packaged application itself. A
`NODE_MODULE_VERSION` mismatch means one of those steps was skipped.

The main process holds everything privileged — the WHONET file, the facility
salt, the session token, the password. The renderer runs with node integration
off and context isolation on, reaches the main process only through the channels
listed in `src/main/preload.ts`, and is served over a custom `amrss://` scheme so
it can be split into one module per screen. It is never given the salt, the
token or a linkage key.

| Path | What it is |
|---|---|
| `src/core/whonet.ts` | Reading the file: profile detection, one dataset every view reads. |
| `src/core/dictionary.ts` | WHONET codes, copied from the platform's canonical dictionary. |
| `src/core/interpret.ts` | Measurement → category, against the loaded breakpoint table. |
| `src/core/validation.ts` | The gate: must-fix and advisory findings. |
| `src/core/corrections.ts` | The overlay that fixes records without touching WHONET. |
| `src/core/analytics.ts` | Antibiogram, trends, sites, phenotypes — the platform's counting rules. |
| `src/core/deidentify.ts` | The allow-list. What leaves the building. |
| `src/core/xlsx.ts` | Workbook writer, no dependency. |
| `src/core/session.ts` | Online and offline sign-in, connectivity probe, console handoff. |
| `src/core/schedule.ts` | When to send, and everything that must be true first. |
