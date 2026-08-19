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
| **Breakpoints** | The CLSI table itself, laid out as the standard prints it, editable in place. |
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

No threshold is hardcoded. The breakpoint table is data the uploader loads, and
it is what every `S`, `I` and `R` on the computer is decided by.

**Settings → Breakpoints** asks one question: does this laboratory read zone
diameters, MICs, or both? A laboratory on an automated MIC panel has no disk
measurements at all, and showing it a table three-quarters full of zone
diameters — and a coverage figure computed over criteria it will never use — is
showing it someone else's laboratory. The answer governs which half of the table
opens first, what an import keeps, and what the coverage report counts.

The table itself is the **Breakpoints** module, not a settings panel: it is
reference material read while working, consulted far more often than it is
configured. It is laid out as the printed standard lays it out — one section per
organism group in M100's order, drug-class rules within each (`PENICILLINS`,
`β-LACTAM COMBINATION AGENTS`, `CEPHEMS`…), agents alphabetically under those,
and the thresholds written the way the standard writes them, `≥17 mm` and
`≤0.5`. Someone checking a row against the book is comparing like with like.

Zone diameters and MICs are shown one at a time, because they are separate
tables in the printed document too and putting them side by side is how a zone
gets read as a concentration.

**Every threshold is editable where it sits.** Click a value, type, press Enter.
The edit is checked against the whole criterion rather than the cell, so a
susceptible zone typed below the resistant one is refused there and then, with
the reason, and the old value comes back — the table on screen never shows a
threshold the software would not accept. **Add an antimicrobial** on any section
adds a row, pre-set to that organism group.

The table itself arrives four ways:

- **Load the supplied CLSI table** uses the copy installed beside the
  application — CLSI M100 36th edition (2026), 707 criteria. It is offered as a
  button and never applied on its own: a table that appeared by itself is a
  table nobody checked against the edition the laboratory actually reports
  under. See [`data/breakpoints/README.md`](../data/breakpoints/README.md) for
  what it covers, what it does not, and the licensing.
- **Sync from platform** pulls the table the platform is using
  (`GET /api/v1/breakpoints/active`), so both halves cite the same edition.
- **Import a table** accepts either the template CSV
  (`data/breakpoints/clsi_m100.template.csv`) or the laboratory's own licensed
  **CLSI M100 workbook**, converted on the way in.
- **Type it in.** The loaded table is listed in full and is editable — add a
  criterion, correct a threshold, remove one.

**Export** writes the template CSV, and it is the file Import reads: export the
table, correct a threshold in Excel, import it back. An Excel export is offered
too, for reading rather than round-tripping.

### Converting a CLSI workbook

The workbook a laboratory holds is an extraction of a printed document, and
extractions are lossy in specific, repeatable ways. The converter is
conservative about every one of them, and reports what it dropped:

| What it does | Why |
|---|---|
| Completes a name the extraction cut in half — `Trimethoprim-` | M100 prints exactly one agent starting that way; plain trimethoprim is printed separately as `Trimethoprim (U)` |
| Keeps `(meningitis)`, `(oral)`, `(U)` as site and route qualifiers | *S. pneumoniae* prints three penicillin criteria differing only by site |
| Emits both agents of a row printed `Ertapenem or imipenem` | One set of thresholds is stated for both |
| Re-splits a row cut at the wrong character — `"µg ≥" \| "18" \| "– 15-17^"` | Same characters, same order, wrong cell boundaries. Accepted only if it yields exactly as many values as there are columns. Recovers gentamicin, tobramycin and amikacin against Enterobacterales |
| Drops a row whose S column opens with the wrong operator | A zone is `≥` susceptible and an MIC is `≤`; the wrong one means the columns are offset |
| Drops a row whose intermediate column is a bound, not a range | `I ≤2` is a susceptible value that has moved one column right |
| Drops a row with neither a susceptible nor a resistant bound | An intermediate band alone categorises nothing |
| Drops **both** rows where one heading covers two sub-groups | *Salmonella* and *Shigella* share a heading with different ciprofloxacin thresholds; keeping one would pick a threshold by row order |
| Keeps one copy of a page-break repeat, silently | Identical thresholds; nothing is in doubt |
| Passes over footnotes and reference lists in the agent column | Listing a hundred of them would bury the drops that matter |

Every kept criterion carries the printed cell in its comment — `Zone as printed:
S ≥17, I 14-16^, R ≤13` — so the transcription can be checked against the
published table at any time. Against the CLSI M100 Ed36 workbook this yields
**707 criteria across 15 organism groups and 95 agents, with 16 rows dropped and
named**, and the result passes the platform's own strict importer with no errors.
That output is what ships as `data/breakpoints/clsi_m100_ed36.csv`; what it does
*not* cover — cefoxitin and erythromycin for staphylococci among them — is
listed in [`data/breakpoints/README.md`](../data/breakpoints/README.md) and
pinned by a test, so a laboratory meets those gaps in a document rather than in
its antibiogram.

With no table loaded, measurements show as `PI` — measured, pending
interpretation. They are still uploaded, still counted as tested, and excluded
from susceptibility rates until a table resolves them. Nothing is guessed. A
category the laboratory recorded itself is always kept; where it disagrees with
the table, the disagreement is reported rather than resolved.

## Code mapping

A code the dictionary does not hold is mapped once, in **Settings → Code
mapping**, and the mapping then applies to every row that uses it.

One at a time works for the two or three a laboratory finds during validation.
It does not work for a WHONET configuration built up over years, and it does not
work at all when the mappings need a microbiologist's eye — a form on one
computer cannot be sent to anyone. So the whole book exports as one workbook and
comes back as one workbook.

WHONET keeps its codes in separate lists, and the workbook keeps that
separation: one sheet per category (Organisms, Specimen types, Antimicrobials),
each paired with an *(all codes)* sheet listing every code AMRSS holds with its
name. A row on the Organisms sheet can only ever map an organism.

The export arrives with the laboratory's outstanding gaps already listed — every
code its own file used that AMRSS could not name, with the answer column blank
beside it. Importing replaces the mappings for the categories the workbook
covers, so a row deleted in Excel is a mapping removed, while a workbook trimmed
to one sheet leaves the other two alone. A row naming a code AMRSS does not hold
is reported back rather than stored: a mapping onto a code that does not exist
would fail silently on every row that used it.

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
| `src/core/breakpoints.ts` | The table as a file and as an editable list: export, validation, edits. |
| `src/core/m100.ts` | Converting a licensed CLSI M100 workbook into criteria, conservatively. |
| `src/core/codebook.ts` | The code book: every code AMRSS holds, and the local codes mapped onto them. |
| `src/core/validation.ts` | The gate: must-fix and advisory findings. |
| `src/core/corrections.ts` | The overlay that fixes records without touching WHONET. |
| `src/core/analytics.ts` | Antibiogram, trends, sites, phenotypes — the platform's counting rules. |
| `src/core/deidentify.ts` | The allow-list. What leaves the building. |
| `src/core/xlsx.ts` | Workbook writer, no dependency. |
| `src/core/xlsx-read.ts` | Workbook reader, no dependency. |
| `src/core/session.ts` | Online and offline sign-in, connectivity probe, console handoff. |
| `src/core/schedule.ts` | When to send, and everything that must be true first. |
