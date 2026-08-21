/**
 * The regional picture, as the platform computes it.
 *
 * This is the one screen in the application whose numbers are not this
 * computer's. Everything under Analysis is the WHONET file on this machine:
 * fast, complete, and about one laboratory. What is here is the platform's —
 * every contributing facility, deduplicated to one isolate per patient per
 * organism per episode, with facilities whose quality attestations have lapsed
 * excluded, and small cells suppressed so a thin denominator cannot be read
 * back to a person.
 *
 * The two are deliberately not merged, and never averaged together. A
 * laboratory reading a regional resistance rate as its own is the specific
 * mistake this separation exists to prevent, so every figure here is labelled
 * with what it covers and how fresh it is, and the screen says whose numbers
 * they are in the first sentence.
 *
 * Nothing is recomputed here. The rows arrive as the API sends them, because a
 * percentage recalculated in a renderer is a percentage that can disagree with
 * the one the same programme published in a report.
 */

import { api, type PlatformReply } from "../../api.js";
import type { ViewContext } from "../../app.js";
import { count, el, empty, lineChart, notice, percent, select, subtabs } from "../../ui.js";

/* --- What the API sends --------------------------------------------------- */

interface DictionaryRef {
  id: string;
  code: string;
  name: string;
}

interface Freshness {
  data_last_updated: string | null;
  coverage_start: string | null;
  coverage_end: string | null;
  facilities_contributing: number;
  facilities_expected: number;
  completeness_percent: number | null;
  is_stale: boolean;
}

interface Cell {
  antibiotic_id: string;
  state: string;
  susceptible_percent: number | null;
  tested: number | null;
  uncertainty_cue: boolean;
}

interface AntibiogramRow {
  organism: DictionaryRef;
  isolate_count: number;
  cells: Cell[];
}

interface Antibiogram {
  aggregation_level: string;
  rows: AntibiogramRow[];
  antibiotics: DictionaryRef[];
  freshness: Freshness;
  raw_isolate_count: number;
  antibiogram_eligible_count: number;
  minimum_isolates: number;
  small_cell_threshold: number;
  suppression_applied: boolean;
  pending_interpretation_count: number;
  quality_exclusion: { facilities_excluded: number; isolates_excluded: number; note: string };
}

interface TrendPoint {
  label: string;
  susceptible_percent: number | null;
  isolate_count: number;
  sufficient: boolean;
}

interface Trend {
  organism: DictionaryRef;
  antibiotic: DictionaryRef;
  bucket: string;
  minimum_isolates: number;
  points: TrendPoint[];
}

interface Signal {
  organism: DictionaryRef;
  antibiotic: DictionaryRef;
  baseline_susceptible_percent: number;
  current_susceptible_percent: number;
  current_n: number;
  change_percentage_points: number;
  status_label: string;
}

interface Alerts {
  signals: Signal[];
  alerts: Array<{
    organism: DictionaryRef;
    antibiotic: DictionaryRef;
    non_susceptible_count: number;
    isolates: number;
    facility_count: number;
    caveat: string;
  }>;
}

/* --- State ---------------------------------------------------------------- */

type Tab = "antibiogram" | "trend" | "signals";
let tab: Tab = "antibiogram";
let trendOrganism = "";
let trendAntibiotic = "";
let trendBucket: "month" | "quarter" = "month";

export async function renderRegional(host: HTMLElement, context: ViewContext): Promise<void> {
  const redraw = (): void => void renderRegional(host, context);
  const online = context.status.connectivity.online && context.status.session?.mode === "online";

  host.replaceChildren(
    el("div", {
      className: "page-head",
      children: [
        el("div", {
          children: [
            el("h2", { text: "Regional surveillance" }),
            el("p", {
              text: "The platform's figures, not this computer's: every contributing facility, "
                + "deduplicated and quality-gated.",
            }),
          ],
        }),
      ],
    }),
  );

  if (!online) {
    host.append(
      notice(
        "warn",
        "These figures come from the surveillance platform, so they need a connection. "
          + "Everything under Analysis still works — that is this computer's own data.",
      ),
    );
    return;
  }

  host.append(
    subtabs(
      [
        { value: "antibiogram", label: "Antibiogram" },
        { value: "trend", label: "Trends" },
        { value: "signals", label: "Signals" },
      ],
      tab,
      (value) => {
        tab = value as Tab;
        redraw();
      },
    ),
    el("div", { className: "loading", text: "Asking the platform…" }),
  );

  const body = host.lastElementChild as HTMLElement;
  if (tab === "antibiogram") await drawAntibiogram(body);
  else if (tab === "trend") await drawTrend(body, redraw);
  else await drawSignals(body);
}

function fail<T>(host: HTMLElement, reply: PlatformReply<T>): boolean {
  if (reply.ok) return false;
  host.className = "";
  host.replaceChildren(notice("bad", reply.message));
  return true;
}

/* --- Antibiogram ---------------------------------------------------------- */

async function drawAntibiogram(host: HTMLElement): Promise<void> {
  const reply = await api.platformSurveillance<Antibiogram>({ path: "antibiogram" });
  if (fail(host, reply)) return;
  const data = reply.data!;

  host.className = "";
  host.replaceChildren(freshnessBar(data));

  if (data.rows.length === 0) {
    host.append(
      empty(
        data.pending_interpretation_count > 0
          ? `Nothing is reportable yet: ${count(data.pending_interpretation_count)} measurements `
            + "are still awaiting breakpoint interpretation on the platform."
          : "No organism reaches the minimum isolate count in this period.",
      ),
    );
    return;
  }

  // Drawn by hand rather than through the generic table helper: an antibiogram
  // is a matrix whose cells carry three states — reportable, suppressed and
  // not tested — and each has to look different at a glance without colour
  // being the only cue.
  const head = el("tr", {
    children: [
      el("th", { className: "sticky-col", text: "Organism" }),
      el("th", { className: "numeric", text: "n" }),
      ...data.antibiotics.map((agent) =>
        el("th", { className: "numeric", text: agent.code, title: agent.name }),
      ),
    ],
  });

  const body = el("tbody");
  for (const row of data.rows) {
    const cells = new Map(row.cells.map((cell) => [cell.antibiotic_id, cell]));
    body.append(
      el("tr", {
        children: [
          el("td", { className: "sticky-col", children: [el("em", { text: row.organism.name })] }),
          el("td", { className: "numeric", text: count(row.isolate_count) }),
          ...data.antibiotics.map((agent) => antibiogramCell(cells.get(agent.id))),
        ],
      }),
    );
  }

  host.append(
    el("div", {
      className: "table-wrap",
      children: [el("table", { children: [el("thead", { children: [head] }), body] })],
    }),
    el("p", {
      className: "small muted",
      text: `Percentage susceptible. Cells below ${data.small_cell_threshold} isolates are `
        + `suppressed, and organisms below ${data.minimum_isolates} are not shown at all — a thin `
        + "denominator can be read back to a person.",
    }),
  );

  if (data.quality_exclusion.facilities_excluded > 0) {
    host.append(notice("warn", data.quality_exclusion.note));
  }
}

function antibiogramCell(cell: Cell | undefined): HTMLElement {
  if (!cell || cell.state === "not_tested") {
    return el("td", { className: "numeric muted", text: "—" });
  }
  if (cell.state !== "reportable" || cell.susceptible_percent === null) {
    return el("td", {
      className: "numeric insufficient",
      text: "·",
      title: "Suppressed: too few isolates to report without risking identification.",
    });
  }
  const value = cell.susceptible_percent;
  return el("td", {
    className: `numeric ${value >= 80 ? "cell-s" : value >= 50 ? "cell-i" : "cell-r"}`,
    text: percent(value, 0),
    title: `${percent(value, 1)} susceptible of ${count(cell.tested ?? 0)} tested`
      + (cell.uncertainty_cue ? " — wide confidence interval, read with care" : ""),
  });
}

function freshnessBar(data: Antibiogram): HTMLElement {
  const fresh = data.freshness;
  return el("div", {
    className: "stat-row",
    children: [
      tile("Covering", `${fresh.coverage_start ?? "—"} → ${fresh.coverage_end ?? "—"}`),
      tile(
        "Facilities",
        `${fresh.facilities_contributing} of ${fresh.facilities_expected}`,
        fresh.completeness_percent === null
          ? null
          : `${percent(fresh.completeness_percent, 0)} of expected submissions`,
      ),
      tile("Isolates", count(data.antibiogram_eligible_count), "after deduplication"),
      tile(
        "Awaiting breakpoints",
        count(data.pending_interpretation_count),
        data.pending_interpretation_count > 0
          ? "measured, not yet interpretable"
          : null,
      ),
    ],
  });
}

function tile(label: string, value: string, hint?: string | null): HTMLElement {
  return el("div", {
    className: "stat",
    children: [
      el("div", { className: "label", text: label }),
      el("div", { className: value.length > 9 ? "value long" : "value", text: value }),
      hint ? el("div", { className: "hint", text: hint }) : null,
    ].filter(Boolean) as Node[],
  });
}

/* --- Trends --------------------------------------------------------------- */

async function drawTrend(host: HTMLElement, redraw: () => void): Promise<void> {
  const reference = await api.platformSurveillance<{
    organisms: DictionaryRef[];
    antibiotics: DictionaryRef[];
  }>({ path: "reference" });
  if (fail(host, reference)) return;

  const organisms = reference.data?.organisms ?? [];
  const antibiotics = reference.data?.antibiotics ?? [];
  if (organisms.length === 0 || antibiotics.length === 0) {
    host.className = "";
    host.replaceChildren(empty("The platform's dictionary is empty, so there is nothing to plot."));
    return;
  }

  if (!trendOrganism) trendOrganism = organisms[0]!.id;
  if (!trendAntibiotic) trendAntibiotic = antibiotics[0]!.id;

  host.className = "";
  host.replaceChildren(
    el("div", {
      className: "list-toolbar",
      children: [
        el("div", {
          className: "field inline",
          children: [
            el("label", { text: "Organism" }),
            select(
              organisms.map((o) => ({ value: o.id, label: o.name })),
              trendOrganism,
              (value) => {
                trendOrganism = value;
                redraw();
              },
            ),
          ],
        }),
        el("div", {
          className: "field inline",
          children: [
            el("label", { text: "Agent" }),
            select(
              antibiotics.map((a) => ({ value: a.id, label: a.name })),
              trendAntibiotic,
              (value) => {
                trendAntibiotic = value;
                redraw();
              },
            ),
          ],
        }),
        el("div", {
          className: "field inline",
          children: [
            el("label", { text: "By" }),
            select(
              [
                { value: "month", label: "Month" },
                { value: "quarter", label: "Quarter" },
              ],
              trendBucket,
              (value) => {
                trendBucket = value as "month" | "quarter";
                redraw();
              },
            ),
          ],
        }),
      ],
    }),
    el("div", { className: "loading", text: "Loading the series…" }),
  );

  const reply = await api.platformSurveillance<Trend>({
    path: "trend",
    params: {
      organism_id: trendOrganism,
      antibiotic_id: trendAntibiotic,
      bucket: trendBucket,
    },
  });
  const slot = host.lastElementChild as HTMLElement;
  if (fail(slot, reply)) return;

  const trend = reply.data!;
  const usable = trend.points.filter((point) => point.sufficient && point.susceptible_percent !== null);

  slot.className = "";
  slot.replaceChildren();

  if (usable.length < 2) {
    slot.append(
      empty(
        `Too few periods reach ${trend.minimum_isolates} isolates to draw a line. A trend through `
          + "thin buckets says more about the sample size than about resistance.",
      ),
    );
    return;
  }

  slot.append(
    el("h3", { text: `${trend.organism.name} — ${trend.antibiotic.name}` }),
    lineChart(
      [
        {
          name: `${trend.antibiotic.code} — % susceptible`,
          points: usable.map((point) => ({
            label: point.label,
            value: point.susceptible_percent,
            denominator: point.isolate_count,
          })),
        },
      ],
      { yLabel: "% susceptible", yMax: 100 },
    ),
    el("p", {
      className: "small muted",
      text: `${usable.length} of ${trend.points.length} periods have enough isolates to plot. `
        + "Periods below the minimum are left out rather than drawn through.",
    }),
  );
}

/* --- Signals -------------------------------------------------------------- */

async function drawSignals(host: HTMLElement): Promise<void> {
  const reply = await api.platformSurveillance<Alerts>({ path: "alerts" });
  if (fail(host, reply)) return;
  const data = reply.data!;

  host.className = "";
  host.replaceChildren(
    notice(
      "info",
      "A signal is a change worth someone looking at. AMRSS does not determine outbreaks and does "
        + "not rank these by importance — that judgement is a person's.",
    ),
  );

  if (data.signals.length === 0 && data.alerts.length === 0) {
    host.append(empty("Nothing has changed enough to raise a signal in this period."));
    return;
  }

  for (const signal of data.signals) {
    const direction = signal.change_percentage_points < 0 ? "fallen" : "risen";
    host.append(
      el("div", {
        className: "signal-card",
        children: [
          el("div", {
            className: "signal-head",
            children: [
              el("h4", { text: `${signal.organism.name} — ${signal.antibiotic.name}` }),
              el("span", {
                className: `badge ${signal.change_percentage_points < 0 ? "bad" : "ok"}`,
                text: `${signal.change_percentage_points > 0 ? "+" : ""}${signal.change_percentage_points.toFixed(1)} pp`,
              }),
            ],
          }),
          el("p", {
            text: `Susceptibility has ${direction} from ${percent(signal.baseline_susceptible_percent, 1)} `
              + `to ${percent(signal.current_susceptible_percent, 1)} over ${count(signal.current_n)} `
              + "recent isolates.",
          }),
          el("p", { className: "small muted", text: signal.status_label }),
        ],
      }),
    );
  }

  for (const alert of data.alerts) {
    host.append(
      el("div", {
        className: "signal-card",
        children: [
          el("div", {
            className: "signal-head",
            children: [
              el("h4", { text: `${alert.organism.name} — ${alert.antibiotic.name}` }),
              el("span", { className: "badge warn", text: "emerging" }),
            ],
          }),
          el("p", {
            text: `${count(alert.non_susceptible_count)} non-susceptible of ${count(alert.isolates)} `
              + `isolates, across ${alert.facility_count} `
              + `${alert.facility_count === 1 ? "facility" : "facilities"}.`,
          }),
          el("p", { className: "small muted", text: alert.caveat }),
        ],
      }),
    );
  }
}
