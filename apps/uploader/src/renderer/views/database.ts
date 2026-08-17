/**
 * The database view — WHONET's grid, interpreted.
 *
 * A laboratory scientist opens this and recognises it immediately: the same rows
 * in the same order, the same antimicrobial columns, the identifiers they typed.
 * The one difference is the cell. WHONET holds `23`; this holds `S`, with `23`
 * one hover away, and a single switch turns the whole grid back into the
 * millimetres if that is what the moment calls for.
 *
 * Both views download as they stand. The interpreted sheet records which
 * breakpoint edition produced it, because next year's edition will read the same
 * millimetres differently.
 */

import { api, type GridResponse } from "../api.js";
import type { ViewContext } from "../app.js";
import {
  button,
  checkbox,
  count,
  el,
  empty,
  notice,
  segmented,
  textInput,
  toast,
} from "../ui.js";
import { openRowEditor } from "./row-editor.js";

interface GridState {
  mode: "interpretations" | "values";
  page: number;
  pageSize: number;
  search: string;
  onlyIssues: boolean;
  onlyCorrected: boolean;
}

const state: GridState = {
  mode: "interpretations",
  page: 1,
  pageSize: 50,
  search: "",
  onlyIssues: false,
  onlyCorrected: false,
};

export async function renderDatabase(host: HTMLElement, context: ViewContext): Promise<void> {
  host.replaceChildren(
    el("div", {
      className: "page-head",
      children: [
        el("div", {
          children: [
            el("h2", { text: "Database" }),
            el("p", {
              text: "Your WHONET data, read live from the file. Interpretations are computed here from the loaded breakpoint table; switch to the recorded values to see exactly what was typed at the bench.",
            }),
          ],
        }),
        el("div", {
          className: "page-actions",
          children: [
            button("Download this view", async () => {
              const result = await api.exportGrid({ mode: state.mode });
              toast(result.message, result.ok ? "ok" : "warn");
            }, "primary"),
            button("Reload", async () => {
              await api.reload();
              await context.refresh();
            }),
          ],
        }),
      ],
    }),
  );

  if (!context.status.workspace.loaded) {
    host.append(
      notice(
        "warn",
        context.status.workspace.problem ??
          "No WHONET file is loaded. Choose one in Settings — you only do this once.",
      ),
    );
    return;
  }

  const toolbar = el("div", { className: "toolbar" });
  const tableHost = el("div");
  const pager = el("div", { className: "pager" });

  const search = textInput(state.search, {
    placeholder: "Search identifier, organism, ward…",
    onInput: (value) => {
      state.search = value;
      state.page = 1;
      void load();
    },
  });

  toolbar.append(
    segmented(
      [
        { value: "interpretations", label: "Interpretations" },
        { value: "values", label: "As recorded" },
      ],
      state.mode,
      (value) => {
        state.mode = value as GridState["mode"];
        void load();
      },
    ),
    el("div", { className: "field", children: [search] }),
    checkbox("Only rows with findings", state.onlyIssues, (checked) => {
      state.onlyIssues = checked;
      state.page = 1;
      void load();
    }),
    checkbox("Only corrected rows", state.onlyCorrected, (checked) => {
      state.onlyCorrected = checked;
      state.page = 1;
      void load();
    }),
  );

  host.append(toolbar, tableHost, pager);
  await load();

  async function load(): Promise<void> {
    tableHost.replaceChildren(el("div", { className: "empty", text: "Loading…" }));
    const grid = await api.grid({ ...state });
    tableHost.replaceChildren(renderGrid(grid, context));
    pager.replaceChildren(...renderPager(grid, load));
  }
}

function renderGrid(grid: GridResponse, context: ViewContext): HTMLElement {
  if (grid.total === 0) {
    return empty("No rows match this filter.");
  }

  const head = el("tr");
  for (const column of grid.columns) {
    head.append(
      el("th", {
        text: column.label,
        title: column.detail ?? column.label,
        className: column.key === "rowIndex" || column.key === "patientIdentifier" ? "sticky-col" : "",
      }),
    );
  }

  const body = el("tbody");
  for (const row of grid.rows) {
    const tr = el("tr");
    for (const column of grid.columns) {
      const cell = row.cells[column.key];
      const td = el("td", {
        className: column.key === "rowIndex" || column.key === "patientIdentifier" ? "sticky-col" : "",
      });

      if (column.key === "rowIndex") {
        if (row.blocking > 0) td.append(el("span", { className: "row-flag blocking" }));
        else if (row.advisory > 0) td.append(el("span", { className: "row-flag advisory" }));
        td.append(document.createTextNode(String(row.rowIndex)));
        td.style.cursor = "pointer";
        td.title = "Open this record";
        td.addEventListener("click", () => openRowEditor(row.key, context));
      } else if (column.kind === "result" && cell?.value) {
        td.append(
          grid.mode === "interpretations"
            ? el("span", {
                className: `sir sir-${cell.tone ?? "NI"}`,
                text: cell.value,
                title: cell.alternate ?? undefined,
              })
            : el("span", {
                className: cell.tone ? `sir sir-${cell.tone}` : "",
                text: cell.value,
                title: cell.alternate ?? undefined,
              }),
        );
      } else if (cell?.value) {
        td.textContent = cell.value;
        if (cell.alternate) td.title = cell.alternate;
        if (row.correctedFields.includes(column.key)) {
          td.className = `${td.className} corrected`.trim();
          td.title = "Corrected in AMRSS — the WHONET file is unchanged";
        }
      }
      tr.append(td);
    }
    body.append(tr);
  }

  const legend = el("div", {
    className: "legend",
    children: [
      legendItem("S", "Susceptible"),
      legendItem("I", "Intermediate"),
      legendItem("R", "Resistant"),
      legendItem("SDD", "Susceptible, dose-dependent"),
      legendItem("PI", "Measured, awaiting a breakpoint"),
      legendItem("NI", "Not interpretable"),
    ],
  });

  const banner = grid.breakpointsLoaded
    ? el("p", {
        className: "small muted",
        text: `Interpreted with ${grid.breakpointLabel ?? "the loaded breakpoint table"}. Hover any cell to see the measurement behind it.`,
      })
    : notice(
        "warn",
        "No breakpoint table is loaded, so measurements show as PI — measured, pending interpretation. Sync your table in Settings and this grid fills in.",
      );

  return el("div", {
    children: [
      banner,
      el("div", {
        className: "table-wrap",
        children: [el("table", { children: [el("thead", { children: [head] }), body] })],
      }),
      legend,
    ],
  });
}

function legendItem(category: string, label: string): HTMLElement {
  return el("span", {
    children: [
      el("span", { className: `sir sir-${category}`, text: category }),
      document.createTextNode(` ${label}`),
    ],
  });
}

function renderPager(grid: GridResponse, reload: () => Promise<void>): HTMLElement[] {
  const pages = Math.max(1, Math.ceil(grid.total / grid.pageSize));
  return [
    el("span", {
      text: `${count(grid.total)} row(s) · page ${grid.page} of ${pages}`,
    }),
    button(
      "Previous",
      () => {
        stateSetPage(grid.page - 1);
        void reload();
      },
      "default",
      { small: true, disabled: grid.page <= 1 },
    ),
    button(
      "Next",
      () => {
        stateSetPage(grid.page + 1);
        void reload();
      },
      "default",
      { small: true, disabled: grid.page >= pages },
    ),
    el("span", {
      className: "small muted",
      text: "Click a row number to open the record and correct it.",
    }),
  ];
}

function stateSetPage(page: number): void {
  state.page = Math.max(1, page);
}
