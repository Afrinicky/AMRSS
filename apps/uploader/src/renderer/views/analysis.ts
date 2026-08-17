/**
 * The analysis modules: antibiogram, organisms, antimicrobials, specimens and
 * sites, and trends.
 *
 * These are the same five questions the regional dashboard answers, asked of one
 * laboratory's own file, and computed with the same rules — first isolate per
 * patient per organism, percentages over interpretable results only, a stated
 * minimum below which a percentage is not published. A facility filtering the
 * platform to itself should see these numbers.
 *
 * What this can do that the platform cannot is go further down: ward,
 * department, specimen number, the isolates behind any cell. The platform never
 * receives those fields, by design, and they are exactly what a laboratory needs
 * to act on its own data.
 */

import {
  api,
  type AnalysisFilters,
  type Antibiogram,
  type Overview,
} from "../api.js";
import type { ViewContext } from "../app.js";
import {
  badge,
  barList,
  button,
  card,
  count,
  donut,
  el,
  empty,
  lineChart,
  notice,
  percent,
  select,
  stat,
  statRow,
  table,
  textInput,
  toast,
} from "../ui.js";

/** Filters persist across the analysis modules within a session, so moving from
 * the antibiogram to the trends does not silently change the population. */
const filters: AnalysisFilters = {};
let trendAntibiotic: string | null = null;
let trendBucket: "month" | "quarter" = "month";

type Renderer = (host: HTMLElement, context: ViewContext) => Promise<void>;

async function shell(
  host: HTMLElement,
  context: ViewContext,
  title: string,
  description: string,
  actions: HTMLElement[],
  render: (body: HTMLElement, overview: Overview) => Promise<void> | void,
): Promise<void> {
  host.replaceChildren(
    el("div", {
      className: "page-head",
      children: [
        el("div", {
          children: [el("h2", { text: title }), el("p", { text: description })],
        }),
        el("div", { className: "page-actions", children: actions }),
      ],
    }),
  );

  if (!context.status.workspace.loaded) {
    host.append(
      notice(
        "warn",
        context.status.workspace.problem ?? "No WHONET file is loaded. Choose one in Settings.",
      ),
    );
    return;
  }

  const body = el("div");
  const filterHost = el("div");
  host.append(filterHost, body);

  const draw = async (): Promise<void> => {
    body.replaceChildren(el("div", { className: "empty", text: "Computing…" }));
    const overview = await api.overview(filters);
    filterHost.replaceChildren(filterBar(overview, draw, context));
    body.replaceChildren();
    await render(body, overview);
  };

  await draw();
}

function filterBar(
  overview: Overview,
  reload: () => Promise<void>,
  context: ViewContext,
): HTMLElement {
  const set = <K extends keyof AnalysisFilters>(key: K, value: string): void => {
    (filters[key] as string | null) = value === "" ? null : value;
    void reload();
  };

  const toolbar = el("div", { className: "toolbar" });

  toolbar.append(
    el("div", {
      className: "field",
      children: [
        el("label", { text: "From" }),
        textInput(filters.dateFrom ?? "", {
          type: "date",
          onInput: (value) => {
            filters.dateFrom = value || null;
            void reload();
          },
        }),
      ],
    }),
    el("div", {
      className: "field",
      children: [
        el("label", { text: "To" }),
        textInput(filters.dateTo ?? "", {
          type: "date",
          onInput: (value) => {
            filters.dateTo = value || null;
            void reload();
          },
        }),
      ],
    }),
    el("div", {
      className: "field",
      children: [
        el("label", { text: "Care setting" }),
        select(
          [
            { value: "", label: "All" },
            { value: "IPD", label: "Inpatient" },
            { value: "OPD", label: "Outpatient" },
            { value: "unknown", label: "Not recorded" },
          ],
          filters.careSetting ?? "",
          (value) => set("careSetting", value),
        ),
      ],
    }),
    el("div", {
      className: "field",
      children: [
        el("label", { text: "Organism" }),
        select(
          [
            { value: "", label: "All organisms" },
            ...overview.available.organisms.map((organism) => ({
              value: organism.code,
              label: `${organism.name} (${organism.count})`,
            })),
          ],
          filters.organismCode ?? "",
          (value) => set("organismCode", value),
        ),
      ],
    }),
    el("div", {
      className: "field",
      children: [
        el("label", { text: "Specimen" }),
        select(
          [
            { value: "", label: "All specimens" },
            ...overview.available.specimens.map((specimen) => ({
              value: specimen.code,
              label: `${specimen.name} (${specimen.count})`,
            })),
          ],
          filters.specimenTypeCode ?? "",
          (value) => set("specimenTypeCode", value),
        ),
      ],
    }),
    el("div", {
      className: "field",
      children: [
        el("label", { text: "Ward" }),
        select(
          [
            { value: "", label: "All wards" },
            ...overview.available.wards.map((ward) => ({ value: ward, label: ward })),
          ],
          filters.ward ?? "",
          (value) => set("ward", value),
        ),
      ],
    }),
    button(
      "Clear filters",
      () => {
        for (const key of Object.keys(filters)) {
          delete (filters as Record<string, unknown>)[key];
        }
        void reload();
      },
      "ghost",
      { small: true },
    ),
  );

  const scope = el("p", {
    className: "small muted",
    text:
      `${count(overview.isolatesInScope)} isolate(s) in this selection · ` +
      `${count(overview.isolatesAnalysed)} counted after ${
        overview.options.firstIsolateOnly
          ? "first-isolate deduplication"
          : "including repeat isolates"
      } · percentages withheld below ${overview.options.minimumIsolates} interpretable results` +
      (context.status.workspace.breakpoints.loaded
        ? ""
        : " · no breakpoint table loaded, so most results are still pending"),
  });

  return el("div", { children: [toolbar, scope] });
}

/* --- Antibiogram --------------------------------------------------------- */

export const renderAntibiogram: Renderer = (host, context) =>
  shell(
    host,
    context,
    "Antibiogram",
    "Percent susceptible by organism and antimicrobial. Cells over too few isolates to publish are shown muted — hover any cell for its counts, because a percentage over four isolates is not a rate.",
    [
      button(
        "Download antibiogram",
        async () => {
          const result = await api.exportAntibiogram(filters);
          toast(result.message, result.ok ? "ok" : "warn");
        },
        "primary",
      ),
    ],
    async (body) => {
      const table_ = await api.antibiogram(filters);
      body.append(antibiogramTable(table_));
    },
  );

function antibiogramTable(data: Antibiogram): HTMLElement {
  if (data.rows.length === 0) {
    return empty("No isolates in this selection.");
  }

  const head = el("tr");
  head.append(el("th", { text: "Organism", className: "sticky-col" }), el("th", { text: "Isolates", className: "numeric" }));
  for (const agent of data.antibiotics) {
    head.append(el("th", { text: agent.code, title: `${agent.name} · ${agent.antimicrobialClass}` }));
  }

  const body = el("tbody");
  for (const row of data.rows) {
    const tr = el("tr");
    tr.append(
      el("td", { text: row.organismName, className: "sticky-col" }),
      el("td", { text: String(row.isolates), className: "numeric" }),
    );
    for (const agent of data.antibiotics) {
      const cell = row.cells[agent.code];
      const td = el("td", { className: "numeric" });
      if (!cell || cell.interpretable === 0) {
        td.textContent = cell && cell.tested > 0 ? "·" : "";
        td.title =
          cell && cell.tested > 0
            ? `${cell.tested} result(s), none interpretable yet — pending a breakpoint`
            : "not tested";
      } else {
        const value = percent(cell.susceptiblePercent, 0);
        td.textContent = value;
        td.title =
          `${cell.susceptible} susceptible of ${cell.interpretable} interpretable ` +
          `(${cell.resistant} resistant, ${cell.intermediate} intermediate)` +
          (cell.belowThreshold
            ? ` — below the reporting threshold of ${data.minimumIsolates}, do not publish`
            : "");
        if (cell.belowThreshold) td.style.color = "var(--insufficient-ink)";
        else if ((cell.susceptiblePercent ?? 0) < 50) td.style.color = "var(--sir-r)";
        else if ((cell.susceptiblePercent ?? 0) < 80) td.style.color = "var(--sir-i)";
        else td.style.color = "var(--sir-s)";
      }
      tr.append(td);
    }
    body.append(tr);
  }

  return el("div", {
    children: [
      el("div", {
        className: "table-wrap",
        children: [el("table", { children: [el("thead", { children: [head] }), body] })],
      }),
      el("p", {
        className: "small muted",
        text: `${data.isolateCount} isolates · ${
          data.firstIsolateOnly ? "first isolate per patient per organism" : "all isolates"
        } · hover a cell for its counts. Green ≥80% susceptible, amber 50–79%, red <50%, grey below the reporting threshold.`,
      }),
    ],
  });
}

/* --- Organisms ----------------------------------------------------------- */

export const renderOrganisms: Renderer = (host, context) =>
  shell(
    host,
    context,
    "Organisms",
    "What is being isolated, from where, and in whom.",
    [
      button("Download analysis", async () => {
        const result = await api.exportAnalytics(filters);
        toast(result.message, result.ok ? "ok" : "warn");
      }),
    ],
    (body, overview) => {
      body.append(
        statRow(
          stat("Distinct organisms", count(overview.summary.organisms)),
          stat("Isolates", count(overview.summary.isolates)),
          stat("Patients", count(overview.summary.patients)),
          stat(
            "Most frequent",
            overview.organisms[0]?.label ?? "—",
            overview.organisms[0]
              ? `${count(overview.organisms[0].count)} isolates · ${percent(overview.organisms[0].percent)}`
              : null,
          ),
        ),
        el("div", {
          className: "grid-2",
          children: [
            card(
              "Organism frequency",
              "First isolate per patient per organism.",
              barList(overview.organisms.slice(0, 20)),
            ),
            card(
              "Resistance markers",
              "Screening indicators, each needing laboratory confirmation before it is reported as a phenotype.",
              table(
                [
                  { label: "Marker", value: (row) => row.label },
                  { label: "Isolates", value: (row) => count(row.isolates), numeric: true },
                  { label: "Tested", value: (row) => count(row.eligible), numeric: true },
                  { label: "%", value: (row) => percent(row.percent), numeric: true },
                ],
                overview.phenotypes.filter((row) => row.eligible > 0),
                "No isolate here was tested against the agents these markers need.",
              ),
            ),
          ],
        }),
        card(
          "Where these organisms came from",
          undefined,
          el("div", {
            className: "grid-2",
            children: [
              barList(overview.sites, { tone: "count" }),
              barList(overview.wards, { tone: "count" }),
            ],
          }),
        ),
      );
    },
  );

/* --- Antimicrobials ------------------------------------------------------ */

export const renderAntibiotics: Renderer = (host, context) =>
  shell(
    host,
    context,
    "Antimicrobials",
    "Each agent pooled across every organism tested against it. A pooled figure is shaped by which organisms happened to be isolated — the antibiogram gives the organism-specific answer.",
    [
      button("Download analysis", async () => {
        const result = await api.exportAnalytics(filters);
        toast(result.message, result.ok ? "ok" : "warn");
      }),
    ],
    async (body) => {
      const profiles = await api.antibiotics(filters);
      body.append(
        table(
          [
            { label: "Antimicrobial", value: (row) => row.name },
            { label: "Code", value: (row) => row.code },
            { label: "Class", value: (row) => row.antimicrobialClass.replaceAll("_", " ") },
            { label: "Tested", value: (row) => count(row.cell.tested), numeric: true },
            { label: "Interpretable", value: (row) => count(row.cell.interpretable), numeric: true },
            {
              label: "% susceptible",
              value: (row) =>
                row.cell.interpretable === 0
                  ? "—"
                  : el("span", {
                      text: percent(row.cell.susceptiblePercent),
                      className: row.cell.belowThreshold ? "muted" : "",
                      title: row.cell.belowThreshold
                        ? "Below the reporting threshold — do not publish this figure"
                        : `${row.cell.susceptible} of ${row.cell.interpretable}`,
                    }),
              numeric: true,
            },
            {
              label: "% resistant",
              value: (row) =>
                row.cell.interpretable === 0 ? "—" : percent(row.cell.resistantPercent),
              numeric: true,
            },
            {
              label: "Organisms pooled",
              value: (row) =>
                row.organismCount > 6
                  ? el("span", {
                      children: [
                        document.createTextNode(String(row.organismCount)),
                        badge("warn", "mixed"),
                      ],
                    })
                  : String(row.organismCount),
              numeric: true,
            },
          ],
          profiles,
          "No susceptibility results in this selection.",
        ),
      );
    },
  );

/* --- Specimens and sites -------------------------------------------------- */

export const renderSpecimens: Renderer = (host, context) =>
  shell(
    host,
    context,
    "Specimens & sites",
    "Where infections are being sampled from, and who they came from. Sites are derived from the WHONET specimen code through the AMRSS dictionary.",
    [
      button("Download analysis", async () => {
        const result = await api.exportAnalytics(filters);
        toast(result.message, result.ok ? "ok" : "warn");
      }),
    ],
    (body, overview) => {
      body.append(
        el("div", {
          className: "grid-2",
          children: [
            card("Specimen types", undefined, barList(overview.specimens, { tone: "count" })),
            card(
              "Sites of infection",
              undefined,
              donut(
                overview.sites.slice(0, 7).map((row) => ({ label: row.label, value: row.count })),
                count(overview.isolatesInScope),
              ),
            ),
          ],
        }),
        el("div", {
          className: "grid-2",
          children: [
            card(
              "Care setting",
              "Inpatient and outpatient populations differ in what they carry; a rate pooled across both is hard to act on.",
              barList(overview.demographics.careSetting),
            ),
            card("Age bands", undefined, barList(overview.demographics.ageBands)),
          ],
        }),
        el("div", {
          className: "grid-2",
          children: [
            card("Requesting departments", undefined, barList(overview.departments, { tone: "count" })),
            card("Wards", undefined, barList(overview.wards, { tone: "count" })),
          ],
        }),
      );
    },
  );

/* --- Trends ---------------------------------------------------------------- */

export const renderTrends: Renderer = (host, context) =>
  shell(
    host,
    context,
    "Trends",
    "Resistance and workload over time. Points computed over too few interpretable results are drawn hollow and their percentage is withheld — a rate that swings between 0 and 100 because a month held two isolates is noise, not a trend.",
    [
      button(
        "Download trend",
        async () => {
          if (!trendAntibiotic) {
            toast("Choose an antimicrobial first.", "warn");
            return;
          }
          const result = await api.exportTrend({
            filters,
            antibioticCode: trendAntibiotic,
            bucket: trendBucket,
          });
          toast(result.message, result.ok ? "ok" : "warn");
        },
        "primary",
      ),
    ],
    async (body, overview) => {
      const agents = overview.available.antibiotics;
      if (agents.length === 0) {
        body.append(empty("No susceptibility results in this selection."));
        return;
      }
      trendAntibiotic ??= agents[0]!.code;

      const chartHost = el("div");

      body.append(
        el("div", {
          className: "toolbar",
          children: [
            el("div", {
              className: "field",
              children: [
                el("label", { text: "Antimicrobial" }),
                select(
                  agents.map((agent) => ({ value: agent.code, label: agent.name })),
                  trendAntibiotic,
                  (value) => {
                    trendAntibiotic = value;
                    void draw();
                  },
                ),
              ],
            }),
            el("div", {
              className: "field",
              children: [
                el("label", { text: "Period" }),
                select(
                  [
                    { value: "month", label: "Monthly" },
                    { value: "quarter", label: "Quarterly" },
                  ],
                  trendBucket,
                  (value) => {
                    trendBucket = value as "month" | "quarter";
                    void draw();
                  },
                ),
              ],
            }),
          ],
        }),
        chartHost,
      );

      await draw();

      async function draw(): Promise<void> {
        chartHost.replaceChildren(el("div", { className: "empty", text: "Computing…" }));
        const trend = await api.trend({
          filters,
          antibioticCode: trendAntibiotic!,
          bucket: trendBucket,
        });

        chartHost.replaceChildren(
          card(
            "Resistance over time",
            `${agents.find((agent) => agent.code === trendAntibiotic)?.name ?? trendAntibiotic}, percent resistant.`,
            trend.resistance.length > 1
              ? lineChart(
                  [
                    {
                      name: "% resistant",
                      points: trend.resistance.map((point) => ({
                        label: point.bucket,
                        value: point.resistantPercent,
                        denominator: point.interpretable,
                        suppressed: point.belowThreshold,
                      })),
                      color: "var(--sir-r)",
                    },
                  ],
                  { yMax: 100, yLabel: "%" },
                )
              : empty("At least two periods of interpretable results are needed for a trend."),
            table(
              [
                { label: "Period", value: (row) => row.bucket },
                { label: "Isolates", value: (row) => count(row.isolates), numeric: true },
                { label: "Interpretable", value: (row) => count(row.interpretable), numeric: true },
                { label: "Resistant", value: (row) => count(row.resistant), numeric: true },
                {
                  label: "% resistant",
                  value: (row) =>
                    row.belowThreshold
                      ? el("span", {
                          className: "muted",
                          text: percent(row.resistantPercent),
                          title: "Below the reporting threshold — do not publish",
                        })
                      : percent(row.resistantPercent),
                  numeric: true,
                },
              ],
              trend.resistance,
              "No dated results in this selection.",
            ),
          ),
          card(
            "Workload over time",
            "Isolates and the patients behind them.",
            trend.volume.length > 1
              ? lineChart([
                  {
                    name: "Isolates",
                    points: trend.volume.map((point) => ({
                      label: point.bucket,
                      value: point.isolates,
                    })),
                  },
                  {
                    name: "Patients",
                    points: trend.volume.map((point) => ({
                      label: point.bucket,
                      value: point.patients,
                    })),
                    color: "var(--series-4)",
                  },
                ])
              : empty("Not enough dated specimens to draw workload over time."),
          ),
        );
      }
    },
  );
