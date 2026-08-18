import Link from "next/link";

import { EmptyState, ScrollTable } from "@/components/admin";
import { Modal } from "@/components/modal";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api, type BreakpointCriterion } from "@/lib/api";
import { requireProfile } from "@/lib/session";

import { publishBreakpoints, removeBreakpoint, saveBreakpoint } from "./actions";

export const metadata = { title: "Breakpoint table" };

const FIELD = "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink";
const LABEL = "block text-xs font-medium uppercase tracking-wide text-ink-muted";
const PRIMARY =
  "rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700";

/** How many rows are listed at once. The full CLSI table is several hundred
 * criteria, and a page of that is unreadable and slow to render. */
const PAGE_SIZE = 60;

/**
 * The breakpoint table, editable.
 *
 * The table is the single most consequential piece of configuration in the
 * platform: it decides whether a measurement reads S or R, and every antibiogram
 * is computed from what it says. It arrives by import from a laboratory's
 * licensed edition, and it needs correcting — an edition amends a threshold, a
 * conversion from a printed workbook loses a row, a programme adopts a
 * supplementary table.
 *
 * What it does *not* need is editing in place. Every result already interpreted
 * cites the version it was interpreted under, so a threshold changed inside a
 * published version would silently rewrite what past figures mean, with nothing
 * in the record to say so. Editing therefore works on a draft that no
 * computation can resolve, and publishing produces a new dated version alongside
 * the old one. The old version stays, because the figures that cite it stay.
 *
 * The same page exists in the desktop uploader, against the same template and
 * the same checks, so a laboratory working offline is not editing a different
 * kind of table from the one the platform holds.
 */
export default async function BreakpointsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; q?: string; method?: string; page?: string }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;

  const draft = await api.breakpointDraft();

  const query = (params.q ?? "").trim().toLowerCase();
  const method = (params.method ?? "").trim().toUpperCase();
  const page = Math.max(1, Number(params.page ?? 1) || 1);

  const matched = draft.criteria
    .filter((criterion) => !method || (criterion.method ?? "").toUpperCase() === method)
    .filter((criterion) =>
      query
        ? `${criterion.organism_group} ${criterion.agent_code}`.toLowerCase().includes(query)
        : true,
    )
    .sort(
      (a, b) =>
        a.organism_group.localeCompare(b.organism_group) ||
        a.agent_code.localeCompare(b.agent_code) ||
        (a.method ?? "").localeCompare(b.method ?? ""),
    );

  const shown = matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const disk = draft.criteria.filter((c) => (c.method ?? "").toUpperCase() === "DISK").length;

  return (
    <Shell profile={profile} current="/console/admin">
      <PageHeading
        title="Breakpoint table"
        description="The thresholds every measurement is interpreted against. Edited as a draft, published as a dated version — the version a figure was computed under never changes underneath it."
        aside={
          <>
            <BannerFigure label="Criteria in draft" value={draft.criteria_count} />
            <BannerFigure
              label="Disk / MIC"
              value={`${disk} / ${draft.criteria_count - disk}`}
              detail="Zone diameters and concentrations"
            />
          </>
        }
      />

      <div className="space-y-6">
        {params.error ? <Notice tone="warn">{params.error}</Notice> : null}
        {params.ok ? <Notice tone="ok">{params.ok}</Notice> : null}

        <div className="rounded-[--radius-card] border border-line bg-surface px-4 py-3">
          <p className="text-sm font-medium text-ink">
            Draft {draft.version}
            {draft.based_on ? ` — started from ${draft.based_on}` : " — a new table"}
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            Nothing here interprets a result yet. The draft is dated beyond anything the engine
            resolves, so a half-finished table cannot reach a report. Publishing gives it an
            effective date and a version of its own; the table currently in force keeps interpreting
            until that date arrives.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <PublishTable draft={draft} />
            <a
              href="/console/admin/breakpoints/export"
              className="rounded-lg border border-line px-4 py-2 text-sm text-ink hover:bg-surface-muted"
            >
              Export the table in force (CSV)
            </a>
            <NewCriterion />
            <Link
              href="/console/admin/methodology"
              className="text-sm text-brand-700 underline underline-offset-2"
            >
              Published versions
            </Link>
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            The export is the same file the importer reads, so the table can be exported, corrected
            in a spreadsheet and imported back as the next version without being reshaped by hand.
          </p>
        </div>

        {draft.problems.length > 0 ? (
          <div className="rounded-[--radius-card] border border-accent-strong/45 bg-accent/10 px-4 py-3">
            <p className="text-sm font-medium text-ink">
              {draft.problems.length} problem(s) block publication
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              A draft may be inconsistent while it is being worked on. Publishing is what refuses —
              accepting a table with three bad rows out of nine hundred would put three wrong
              thresholds into clinical reports, with no way afterwards to tell which results they
              touched.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink">
              {draft.problems.slice(0, 25).map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <form className="flex flex-wrap items-end gap-3" action="" method="get">
          <div>
            <label htmlFor="q" className={LABEL}>
              Find
            </label>
            <input
              id="q"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="organism group or agent code"
              className={`${FIELD} w-64`}
            />
          </div>
          <div>
            <label htmlFor="method" className={LABEL}>
              Method
            </label>
            <select id="method" name="method" defaultValue={method} className={FIELD}>
              <option value="">All methods</option>
              <option value="DISK">Disk diffusion</option>
              <option value="MIC">MIC</option>
              <option value="GRADIENT">Gradient strip</option>
            </select>
          </div>
          <button type="submit" className="rounded-lg border border-line px-4 py-2 text-sm text-ink">
            Filter
          </button>
        </form>

        {shown.length === 0 ? (
          <EmptyState>
            {draft.criteria_count === 0
              ? "The draft is empty. Import a licensed CLSI table, or add criteria one at a time — either way nothing is interpreted until the draft is published."
              : "No criteria match this filter."}
          </EmptyState>
        ) : (
          <>
            <ScrollTable>
              <table className="w-full min-w-[64rem] text-sm">
                <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                  <tr>
                    <th className="px-3 py-2">Organism group</th>
                    <th className="px-3 py-2">Agent</th>
                    <th className="px-3 py-2">Method</th>
                    <th className="px-3 py-2">Scope</th>
                    <th className="px-3 py-2">S</th>
                    <th className="px-3 py-2">I</th>
                    <th className="px-3 py-2">R</th>
                    <th className="px-3 py-2">Source</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((criterion) => (
                    <Row key={scopeKey(criterion)} criterion={criterion} />
                  ))}
                </tbody>
              </table>
            </ScrollTable>

            <Pager
              page={page}
              matched={matched.length}
              total={draft.criteria_count}
              query={params.q ?? ""}
              method={method}
            />
          </>
        )}
      </div>
    </Shell>
  );
}

/* --- Reading a criterion -------------------------------------------------- */

function scopeKey(criterion: BreakpointCriterion): string {
  return [
    criterion.organism_group,
    criterion.agent_code,
    criterion.method,
    criterion.site ?? "",
    criterion.route ?? "",
    criterion.disk_content ?? "",
  ]
    .map((part) => String(part).trim().toLowerCase())
    .join("|");
}

function band(min: unknown, max: unknown): string {
  const low = min === null || min === undefined || min === "" ? null : String(min);
  const high = max === null || max === undefined || max === "" ? null : String(max);
  if (low === null && high === null) return "—";
  if (low !== null && high !== null) return low === high ? low : `${low}–${high}`;
  return (low ?? high) as string;
}

function value(raw: unknown): string | null {
  return raw === null || raw === undefined || raw === "" ? null : String(raw);
}

function Row({ criterion }: { criterion: BreakpointCriterion }) {
  const disk = (criterion.method ?? "").toUpperCase() === "DISK";
  const unit = disk ? " mm" : "";
  const s = value(disk ? criterion.disk_susceptible_min : criterion.mic_susceptible_max);
  const r = value(disk ? criterion.disk_resistant_max : criterion.mic_resistant_min);
  const i = band(
    disk ? criterion.disk_intermediate_min : criterion.mic_intermediate_min,
    disk ? criterion.disk_intermediate_max : criterion.mic_intermediate_max,
  );

  const scope = [criterion.disk_content, criterion.site, criterion.route]
    .filter((part) => part && String(part).trim() !== "")
    .join(" · ");

  return (
    <tr className="border-b border-line/60 last:border-0">
      <td className="px-3 py-2">{criterion.organism_group}</td>
      <td className="px-3 py-2 font-medium text-ink">{criterion.agent_code}</td>
      <td className="px-3 py-2">{disk ? "Disk" : criterion.method}</td>
      <td className="px-3 py-2 text-ink-muted">{scope || "—"}</td>
      {/* Written with the operators the printed table uses, so a person checking
          a row against M100 is comparing like with like. */}
      <td className="px-3 py-2">{s === null ? "—" : `${disk ? "≥" : "≤"}${s}${unit}`}</td>
      <td className="px-3 py-2">{i === "—" ? "—" : `${i}${unit}`}</td>
      <td className="px-3 py-2">{r === null ? "—" : `${disk ? "≤" : "≥"}${r}${unit}`}</td>
      <td className="px-3 py-2 text-xs text-ink-muted">
        {[criterion.standard, criterion.table_reference].filter(Boolean).join(" · ") || "—"}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex justify-end gap-2">
          <EditCriterion criterion={criterion} />
          <form action={removeBreakpoint}>
            <ScopeFields criterion={criterion} />
            <button
              type="submit"
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink hover:bg-surface-muted"
            >
              Remove
            </button>
          </form>
        </div>
      </td>
    </tr>
  );
}

/** The scope, carried through a form so a criterion can be addressed without an
 * identifier the table does not have. */
function ScopeFields({ criterion }: { criterion: BreakpointCriterion }) {
  return (
    <>
      <input type="hidden" name="organism_group" value={criterion.organism_group} />
      <input type="hidden" name="agent_code" value={criterion.agent_code} />
      <input type="hidden" name="method" value={criterion.method} />
      <input type="hidden" name="site" value={criterion.site ?? ""} />
      <input type="hidden" name="route" value={criterion.route ?? ""} />
    </>
  );
}

/* --- Editing -------------------------------------------------------------- */

function CriterionForm({ criterion }: { criterion?: BreakpointCriterion }) {
  const disk = (criterion?.method ?? "DISK").toUpperCase() === "DISK";

  return (
    <form action={saveBreakpoint} className="grid gap-4 sm:grid-cols-2">
      <div>
        <label className={LABEL}>Organism group</label>
        <input
          name="organism_group"
          required
          defaultValue={criterion?.organism_group ?? ""}
          placeholder="e.g. Enterobacterales"
          className={FIELD}
        />
      </div>
      <div>
        <label className={LABEL}>Antimicrobial code</label>
        <input
          name="agent_code"
          required
          defaultValue={criterion?.agent_code ?? ""}
          placeholder="e.g. CIP"
          className={FIELD}
        />
      </div>

      <div>
        <label className={LABEL}>Method</label>
        <select name="method" defaultValue={criterion?.method ?? "DISK"} className={FIELD}>
          <option value="DISK">Disk diffusion — zone diameter in mm</option>
          <option value="MIC">MIC — concentration in µg/mL</option>
          <option value="GRADIENT">Gradient strip — read as an MIC</option>
        </select>
        <p className="mt-1 text-xs text-ink-muted">
          Only the matching set of thresholds below is kept. Zones and MICs run in opposite
          directions, so a value left over from the other method would be a wrong answer, not a
          spare one.
        </p>
      </div>
      <div>
        <label className={LABEL}>Disk content</label>
        <input
          name="disk_content"
          defaultValue={criterion?.disk_content ?? ""}
          placeholder="e.g. 10 µg"
          className={FIELD}
        />
        <p className="mt-1 text-xs text-ink-muted">
          Required for a disk criterion: 30 µg and 10 µg gentamicin have different thresholds.
        </p>
      </div>

      <div>
        <label className={LABEL}>Site</label>
        <input
          name="site"
          defaultValue={criterion?.site ?? ""}
          placeholder="e.g. meningitis, uti"
          className={FIELD}
        />
      </div>
      <div>
        <label className={LABEL}>Route</label>
        <input
          name="route"
          defaultValue={criterion?.route ?? ""}
          placeholder="e.g. oral, iv"
          className={FIELD}
        />
      </div>

      <fieldset className="sm:col-span-2 rounded-[--radius-card] border border-line p-3">
        <legend className="px-1 text-xs uppercase tracking-wide text-ink-muted">
          Zone diameters (mm) — for a disk criterion
        </legend>
        <div className="grid gap-3 sm:grid-cols-4">
          <NumberField name="disk_susceptible_min" label="Susceptible ≥" criterion={criterion} show={disk} />
          <NumberField name="disk_intermediate_min" label="Intermediate from" criterion={criterion} show={disk} />
          <NumberField name="disk_intermediate_max" label="Intermediate to" criterion={criterion} show={disk} />
          <NumberField name="disk_resistant_max" label="Resistant ≤" criterion={criterion} show={disk} />
        </div>
      </fieldset>

      <fieldset className="sm:col-span-2 rounded-[--radius-card] border border-line p-3">
        <legend className="px-1 text-xs uppercase tracking-wide text-ink-muted">
          Concentrations (µg/mL) — for an MIC criterion
        </legend>
        <div className="grid gap-3 sm:grid-cols-4">
          <NumberField name="mic_susceptible_max" label="Susceptible ≤" criterion={criterion} show={!disk} />
          <NumberField name="mic_intermediate_min" label="Intermediate from" criterion={criterion} show={!disk} />
          <NumberField name="mic_intermediate_max" label="Intermediate to" criterion={criterion} show={!disk} />
          <NumberField name="mic_resistant_min" label="Resistant ≥" criterion={criterion} show={!disk} />
        </div>
      </fieldset>

      <div>
        <label className={LABEL}>Standard</label>
        <input
          name="standard"
          required
          defaultValue={criterion?.standard ?? "CLSI M100"}
          className={FIELD}
        />
        <p className="mt-1 text-xs text-ink-muted">
          M100, M45 and M60 give different criteria for the same pair. A criterion that cannot say
          which document it came from cannot be audited.
        </p>
      </div>
      <div>
        <label className={LABEL}>Table reference</label>
        <input
          name="table_reference"
          defaultValue={criterion?.table_reference ?? ""}
          placeholder="e.g. 2A-1"
          className={FIELD}
        />
      </div>

      <div className="sm:col-span-2">
        <label className={LABEL}>Dosage note</label>
        <input
          name="dosage_note"
          defaultValue={criterion?.dosage_note ?? ""}
          placeholder="Required for an SDD band, e.g. 1 g q8h"
          className={FIELD}
        />
      </div>
      <div className="sm:col-span-2">
        <label className={LABEL}>Comment</label>
        <input name="comment" defaultValue={criterion?.comment ?? ""} className={FIELD} />
      </div>

      <div className="sm:col-span-2">
        <button type="submit" className={PRIMARY}>
          Save to the draft
        </button>
      </div>
    </form>
  );
}

function NumberField({
  name,
  label,
  criterion,
  show,
}: {
  name: keyof BreakpointCriterion;
  label: string;
  criterion?: BreakpointCriterion;
  show: boolean;
}) {
  const raw = criterion?.[name];
  return (
    <div>
      <label className={LABEL}>{label}</label>
      <input
        name={name}
        inputMode="decimal"
        defaultValue={show && raw !== null && raw !== undefined ? String(raw) : ""}
        className={FIELD}
      />
    </div>
  );
}

function NewCriterion() {
  return (
    <Modal label="Add a criterion" triggerLabel="Add a criterion" triggerClassName={PRIMARY}>
      <CriterionForm />
    </Modal>
  );
}

function EditCriterion({ criterion }: { criterion: BreakpointCriterion }) {
  return (
    <Modal
      label={`Edit ${criterion.agent_code} · ${criterion.organism_group}`}
      triggerLabel="Edit"
      triggerClassName="rounded-lg border border-line px-3 py-1.5 text-xs text-ink hover:bg-surface-muted"
    >
      <p className="mb-3 text-xs text-ink-muted">
        Saving replaces the criterion with the same scope — organism group, agent, method, site,
        route and disk content. Change any of those and this becomes a new criterion alongside the
        old one.
      </p>
      <CriterionForm criterion={criterion} />
    </Modal>
  );
}

/* --- Publishing ----------------------------------------------------------- */

function PublishTable({ draft }: { draft: { criteria_count: number; problems: string[] } }) {
  const blocked = draft.criteria_count === 0 || draft.problems.length > 0;

  return (
    <Modal label="Publish the breakpoint table" triggerLabel="Publish…" triggerClassName={PRIMARY}>
      {blocked ? (
        <p className="text-sm text-ink">
          {draft.criteria_count === 0
            ? "The draft is empty. There is nothing to publish."
            : `The draft has ${draft.problems.length} outstanding problem(s). Every one must be resolved before publication: a table accepted with bad rows puts wrong thresholds into clinical reports, and there is no way afterwards to tell which results they touched.`}
        </p>
      ) : (
        <form action={publishBreakpoints} className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL}>Version</label>
            <input name="version" required maxLength={32} placeholder="e.g. M100-Ed36" className={FIELD} />
            <p className="mt-1 text-xs text-ink-muted">
              Stamped onto every figure computed against this table.
            </p>
          </div>
          <div>
            <label className={LABEL}>Edition it came from</label>
            <input
              name="source_edition"
              required
              placeholder="e.g. CLSI M100 36th ed. (2026)"
              className={FIELD}
            />
          </div>
          <div>
            <label className={LABEL}>Effective from</label>
            <input name="effective_from" type="date" required className={FIELD} />
            <p className="mt-1 text-xs text-ink-muted">
              Results interpreted on or after this date use this table. Earlier figures keep citing
              the version they were computed under.
            </p>
          </div>
          <div>
            <label className={LABEL}>Description</label>
            <input name="description" className={FIELD} />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" className={PRIMARY}>
              Publish {draft.criteria_count} criteria
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/* --- Chrome --------------------------------------------------------------- */

function Pager({
  page,
  matched,
  total,
  query,
  method,
}: {
  page: number;
  matched: number;
  total: number;
  query: string;
  method: string;
}) {
  const first = (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, matched);
  const href = (next: number): string => {
    const search = new URLSearchParams();
    if (query) search.set("q", query);
    if (method) search.set("method", method);
    if (next > 1) search.set("page", String(next));
    const rendered = search.toString();
    return rendered ? `?${rendered}` : "/console/admin/breakpoints";
  };

  return (
    <div className="flex items-center justify-between text-sm text-ink-muted">
      <p>
        Showing {first}–{last} of {matched.toLocaleString()}
        {matched !== total ? ` (of ${total.toLocaleString()} in the draft)` : ""}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className="rounded-lg border border-line px-3 py-1.5">
            Previous
          </Link>
        ) : null}
        {last < matched ? (
          <Link href={href(page + 1)} className="rounded-lg border border-line px-3 py-1.5">
            Next
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "ok" | "warn"; children: React.ReactNode }) {
  return (
    <p
      role="status"
      className={`rounded-[--radius-card] border px-4 py-3 text-sm text-ink ${
        tone === "ok" ? "border-brand-600/40 bg-brand-50" : "border-accent-strong/45 bg-accent/10"
      }`}
    >
      {children}
    </p>
  );
}
