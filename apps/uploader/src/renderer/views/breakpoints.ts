/**
 * The breakpoint table, as CLSI prints it.
 *
 * This is a module of its own rather than a panel inside Settings, because it
 * is not a setting. It is the reference table a laboratory reads while it
 * works — the thing that decides whether a 16 mm zone is reported as
 * intermediate or resistant — and it is consulted far more often than it is
 * configured.
 *
 * The layout follows the printed document as closely as a screen allows: one
 * section per organism group in M100's order, drug-class headings within each,
 * agents alphabetically under those, and the thresholds written the way the
 * standard writes them (`≥17 mm`, `≤0.5`). A person checking a row against the
 * book is comparing like with like, which is the whole point.
 *
 * Zone diameters and MICs are shown one at a time. They are different tables in
 * the printed document too, and putting them side by side is how a zone gets
 * read as a concentration.
 *
 * Every threshold is editable in place. Click a value, type, press Enter. The
 * edit is validated as it is made — against the whole criterion, not the cell —
 * so a correction that makes the row self-contradictory is refused at the
 * moment it is typed rather than at publication, when whoever typed it has
 * moved on.
 *
 * **Two ways to start, and the populated one leads.** A deployment built with
 * the programme's converted CLSI table has its thresholds one click away, and
 * that is the button offered first — it is what most laboratories want and what
 * they already have.
 *
 * The **blueprint** is the second offer, for the case the first cannot serve: a
 * laboratory whose licence does not extend to the supplied file, or a
 * deployment built without one. It is the table's *shape* — every organism
 * group, every agent the standard prints against it, both methods where both
 * are printed, the disk potencies — and not one number. Loading it fills this
 * page with rows whose values are waiting to be typed, from the page or from a
 * spreadsheet and back.
 *
 * Loading a blueprint over a table that already has thresholds in it is refused
 * outright, so neither offer can cost somebody the table they were using.
 *
 * A blank row is safe to hold and impossible to be misled by. The engine
 * selects on thresholds, so a row with none never matches and the measurement
 * stays `PI` — measured, pending interpretation — which is exactly what it is.
 * What the page has to do is never let a blank row *look* like coverage, which
 * is why the fill meter sits above the table rather than in a report.
 *
 * **Who may edit.** Breakpoints are set nationally so that a susceptible result
 * at one laboratory means what it means at every other. This page is read-only
 * unless the account may change the table — either because it holds national
 * authority, or because the superadmin has granted this facility an exception.
 * The server decides; this page shows the answer and says why.
 */

import { api, type Catalogue, type CatalogueRow } from "../api.js";
import type { ViewContext } from "../app.js";
import { button, el, field, modal, notice, select, textInput, toast } from "../ui.js";

/** Which half of the table is open, and what is filtered. Module-level so the
 * position survives the redraw after every edit. */
let method: "DISK" | "MIC" | null = null;
let search = "";
let organismGroup = "";

export async function renderBreakpoints(host: HTMLElement, context: ViewContext): Promise<void> {
  const data = await api.breakpointCatalogue({
    method: method ?? undefined,
    search,
    organismGroup,
  });
  method = data.method;

  const redraw = (): void => void renderBreakpoints(host, context);
  const refresh = async (): Promise<void> => {
    await context.refresh();
    redraw();
  };

  host.replaceChildren(head(data, refresh, redraw));

  if (!data.loaded) {
    host.append(emptyState(refresh));
    return;
  }

  host.append(provenance(data));

  if (!data.editable) {
    host.append(
      notice(
        "info",
        data.editRefusal ||
          "This table is read-only for your account. It is the table your results are "
            + "interpreted against; changing it is a national decision.",
      ),
    );
  }

  host.append(toolbar(data, redraw));

  if (data.sections.length === 0) {
    host.append(
      notice(
        "info",
        search || organismGroup
          ? "Nothing in the table matches that. Clear the filter to see everything."
          : `The table holds no ${data.method === "DISK" ? "zone diameter" : "MIC"} criteria. Switch to ${data.method === "DISK" ? "MICs" : "zone diameters"} above.`,
      ),
    );
  }

  for (const section of data.sections) {
    host.append(sectionTable(section, data, refresh, redraw));
  }

  if (data.onlyUnderOtherMethod.length > 0) {
    host.append(
      el("p", {
        className: "small muted bp-footnote",
        text: `Also in this table, under ${data.method === "DISK" ? "MICs" : "zone diameters"} only: ${data.onlyUnderOtherMethod.join(", ")}.`,
      }),
    );
  }
}

/* --- The header ----------------------------------------------------------- */

function head(
  data: Catalogue,
  refresh: () => Promise<void>,
  redraw: () => void,
): HTMLElement {
  return el("div", {
    className: "page-head",
    children: [
      el("div", {
        children: [
          el("h2", { text: "Breakpoints" }),
          el("p", {
            text: data.loaded
              ? data.blueprint
                ? "Every organism group and antimicrobial the standard prints, with the "
                  + "thresholds still to be entered. Nothing is interpreted until they are — "
                  + "measurements read as PI, which is what they are."
                : `${data.edition} — the table that decides every S, I and R on this computer.`
              : "The table that decides every S, I and R on this computer.",
          }),
        ],
      }),
      // With no table loaded there is nothing to export and no edition to
      // succeed, and the empty state below already offers the two things that
      // do make sense. Showing the full row here would put four buttons in
      // front of somebody where three of them fail.
      el("div", {
        className: "page-actions",
        children: (data.loaded
          ? [
              // Export leads, because on a blueprint it is the first thing
              // anybody does: take the form to the spreadsheet, fill it in
              // beside the printed page, bring it back.
              button("Export as Excel", async () => {
                const result = await api.exportBreakpoints({ format: "xlsx" });
                toast(result.message, result.ok ? "ok" : "warn");
              }),
              button("Export as CSV", async () => {
                const result = await api.exportBreakpoints({ format: "csv" });
                toast(result.message, result.ok ? "ok" : "warn");
              }),
              button(
                "Import a table…",
                async () => {
                  const result = await api.importBreakpoints();
                  report(result, "Rows that could not be read");
                  await refresh();
                },
                data.blueprint ? "primary" : "default",
                {
                  title:
                    "Reads back the spreadsheet or CSV this page exports, and a licensed "
                    + "CLSI M100 workbook.",
                },
              ),
              button(
                "Sync from platform",
                async () => {
                  const result = await api.syncBreakpoints();
                  toast(result.message, result.ok ? "ok" : "warn");
                  await refresh();
                },
                "ghost",
              ),
              data.editable
                ? button("New edition…", () => openNewEdition(refresh), "ghost")
                : null,
            ]
          : []
        ).filter(Boolean) as Node[],
      }),
    ],
  });
}

/**
 * What a laboratory sees before it has a table.
 *
 * The order is the design, and it follows what a laboratory actually has.
 *
 * **The supplied CLSI table leads**, where the deployment was built with one.
 * It carries the thresholds — the table is usable the moment it is loaded — and
 * that is what nearly every laboratory here wants. It is still a button rather
 * than something applied on first run: a table that appeared by itself is a
 * table nobody checked against the edition their laboratory reports under.
 *
 * **The blueprint is the second offer**, and it exists for the case the first
 * cannot serve — a deployment built without the supplied table, or a laboratory
 * whose CLSI licence does not extend to it. It carries the printed table's
 * shape and no values, so it ships regardless of licence, and it turns that
 * case from a dead end into a form to fill in.
 *
 * Where a deployment has no supplied table at all, the blueprint takes the
 * lead, because then it is the only way to start rather than the fallback.
 */
function emptyState(refresh: () => Promise<void>): HTMLElement {
  const panel = el("div", { className: "bp-empty" });

  void Promise.all([api.suppliedBreakpoints(), api.blueprints()]).then(
    ([supplied, blueprints]) => {
      const blueprint = blueprints[0];

      const suppliedOffer = (primary: boolean): HTMLElement =>
        el("div", {
          className: primary ? "bp-start" : "bp-secondary",
          children: [
            button(
              "Load the supplied CLSI table",
              async () => {
                const result = await api.loadSuppliedBreakpoints();
                toast(result.message, result.ok ? "ok" : "warn");
                await refresh();
              },
              primary ? "primary" : "default",
            ),
            el("p", {
              className: "small muted",
              text: `${supplied.label}. Thresholds included, so the table interprets as soon as `
                + "it is loaded — check it against your own copy of the edition before you rely "
                + "on it.",
            }),
          ],
        });

      const blueprintOffer = (primary: boolean): HTMLElement =>
        el("div", {
          className: primary ? "bp-start" : "bp-secondary",
          children: [
            button(
              primary ? "Start from the blank CLSI layout" : "Start from a blank layout instead",
              async () => {
                const result = await api.loadBlueprint({ edition: blueprint!.edition });
                toast(result.message, result.ok ? "ok" : "bad");
                await refresh();
              },
              primary ? "primary" : "default",
            ),
            el("p", {
              className: "small muted",
              text: `Every organism group and antimicrobial the ${blueprint!.edition} edition `
                + "prints, with the thresholds blank for you to enter from your own licensed "
                + "copy — by spreadsheet, or straight into the table. For a laboratory whose "
                + "licence does not cover the file above.",
            }),
            blueprints.length > 1
              ? el("div", {
                  className: "small muted",
                  children: [
                    document.createTextNode("Other editions: "),
                    ...blueprints.slice(1).map((other) =>
                      el("button", {
                        className: "link-button",
                        text: other.edition,
                        onClick: async () => {
                          const result = await api.loadBlueprint({ edition: other.edition });
                          toast(result.message, result.ok ? "ok" : "bad");
                          await refresh();
                        },
                      }),
                    ),
                  ],
                })
              : null,
          ].filter(Boolean) as Node[],
        });

      const children: Array<Node | null> = [
        el("h3", { text: "No breakpoint table is loaded" }),
        el("p", {
          text: "Until one is, every measurement reads as PI — measured, pending "
            + "interpretation. Nothing is guessed, and nothing is lost: the results still "
            + "upload and are still counted as tested.",
        }),

        supplied.available ? suppliedOffer(true) : null,
        blueprint ? blueprintOffer(!supplied.available) : null,
        supplied.available || blueprint
          ? null
          : el("p", {
              className: "small muted",
              text: "This installation was built with neither a table nor a layout. Import your "
                + "own licensed CLSI M100 workbook, or sync from the platform.",
            }),

        el("div", {
          className: "toolbar",
          children: [
            button("Import a table…", async () => {
              const result = await api.importBreakpoints();
              report(result, "Rows that could not be read");
              await refresh();
            }),
            button("Sync from platform", async () => {
              const result = await api.syncBreakpoints();
              toast(result.message, result.ok ? "ok" : "warn");
              await refresh();
            }),
          ],
        }),
      ];
      panel.replaceChildren(...(children.filter(Boolean) as Node[]));
    },
  );

  return panel;
}

/**
 * Which table this is, where it came from, and how much of it is filled in.
 *
 * The fill figure is the one that has to be here rather than in a report. "707
 * criteria" sounds like a complete table; a blueprint with 707 blank rows is
 * not one, and a laboratory that read the count and stopped reading would
 * believe it was interpreting results it is not.
 */
function provenance(data: Catalogue): HTMLElement {
  const { completeness: fill } = data;
  const source =
    data.source === "platform"
      ? "synced from the platform"
      : data.source === "blueprint"
        ? "blank layout"
        : "imported on this computer";

  const meter = el("div", {
    className: "bp-fill",
    title: `${fill.filled} of ${fill.rows} rows state a threshold`,
    children: [
      el("div", {
        className: "bp-fill-track",
        children: [
          (() => {
            const bar = el("div", { className: "bp-fill-bar" });
            bar.style.width = `${Math.round(fill.percent)}%`;
            return bar;
          })(),
        ],
      }),
      el("span", {
        text:
          fill.placeholders === 0
            ? "complete"
            : `${fill.filled.toLocaleString()} of ${fill.rows.toLocaleString()} filled in`,
      }),
    ],
  });

  return el("div", {
    className: "bp-provenance",
    children: [
      el("strong", { text: data.editionLabel }),
      el("span", { className: "sep", text: "·" }),
      el("span", { text: source }),
      el("span", { className: "sep", text: "·" }),
      meter,
      el("div", { className: "topbar-spacer" }),
      fill.placeholders > 0
        ? el("span", {
            className: "small",
            text: `${fill.placeholders.toLocaleString()} combination${
              fill.placeholders === 1 ? "" : "s"
            } read as pending until filled in`,
          })
        : null,
    ].filter(Boolean) as Node[],
  });
}

/**
 * Begin the next edition.
 *
 * A new edition is a new table rather than an edit to this one, and the
 * dialogue says so: every result already interpreted cites the version it was
 * interpreted under, so changing thresholds inside a published edition would
 * quietly rewrite what past antibiograms mean. The structure carries over —
 * groups, agents, potencies, qualifiers — because that is what barely changes
 * between editions and what would take a day to retype. No number does.
 */
function openNewEdition(refresh: () => Promise<void>): void {
  const nextYear = String(new Date().getFullYear() + 1);
  const edition = textInput(nextYear, { placeholder: "2027" });
  const problems = el("div");

  const close = modal(
    "Start a new edition",
    el("div", {
      children: [
        el("p", {
          text: "The structure of the table you have now — every organism group, agent, disk "
            + "potency and qualifier — carried forward with every threshold blank, ready to be "
            + "filled in from the new standard.",
        }),
        notice(
          "warn",
          "This replaces the loaded table. Export the current one first if you have not "
            + "already: results interpreted under it cite its version, and you will want it "
            + "on file.",
        ),
        field("Edition year", edition),
        problems,
      ],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      button(
        "Start it",
        async () => {
          problems.replaceChildren();
          const result = await api.newBreakpointEdition({ edition: edition.value.trim() });
          if (!result.ok) {
            problems.replaceChildren(notice("bad", result.message));
            return;
          }
          close();
          toast(result.message, "ok");
          await refresh();
        },
        "primary",
      ),
    ],
  );
}

/* --- Filters -------------------------------------------------------------- */

function toolbar(data: Catalogue, redraw: () => void): HTMLElement {
  const find = textInput(search, {
    placeholder: "organism, agent code or name",
    onInput: (value) => {
      search = value;
    },
  });
  find.addEventListener("change", redraw);
  find.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") redraw();
  });

  // A segmented control rather than a dropdown: it is the single most
  // consequential choice on the page and it should read as a choice, not as a
  // setting someone has to open.
  const toggle = el("div", {
    className: "segmented",
    children: (["DISK", "MIC"] as const).map((value) =>
      el("button", {
        className: `segment ${data.method === value ? "active" : ""}`.trim(),
        text: value === "DISK" ? "Zone diameters (mm)" : "MICs (µg/mL)",
        onClick: () => {
          method = value;
          redraw();
        },
      }),
    ),
  });

  return el("div", {
    className: "bp-toolbar",
    children: [
      toggle,
      el("div", { className: "topbar-spacer" }),
      el("div", {
        className: "field",
        children: [
          el("label", { text: "Organism group" }),
          select(
            [
              { value: "", label: "All organism groups" },
              ...data.organismGroups.map((group) => ({ value: group, label: group })),
            ],
            organismGroup,
            (value) => {
              organismGroup = value;
              redraw();
            },
          ),
        ],
      }),
      el("div", {
        className: "field",
        children: [el("label", { text: "Find" }), find],
      }),
    ],
  });
}

/* --- One organism group --------------------------------------------------- */

function sectionTable(
  section: Catalogue["sections"][number],
  data: Catalogue,
  refresh: () => Promise<void>,
  redraw: () => void,
): HTMLElement {
  const body = el("tbody");

  for (const group of section.classes) {
    body.append(
      el("tr", {
        className: "bp-class",
        children: [el("td", { attrs: { colspan: "7" }, text: group.label })],
      }),
    );
    for (const row of group.rows) {
      body.append(dataRow(row, data, refresh, redraw));
    }
  }

  const table = el("table", {
    className: "bp-table",
    children: [
      el("thead", {
        children: [
          el("tr", {
            children: [
              el("th", { className: "bp-agent", text: "Antimicrobial agent" }),
              el("th", {
                text: data.method === "DISK" ? "Disk content" : "Applies to",
                className: "bp-qualifier",
              }),
              el("th", { className: "bp-value", text: "S" }),
              el("th", { className: "bp-value", text: "SDD" }),
              el("th", { className: "bp-value", text: "I" }),
              el("th", { className: "bp-value", text: "R" }),
              el("th", { className: "bp-actions", text: "" }),
            ],
          }),
        ],
      }),
      body,
    ],
  });

  return el("section", {
    className: "card bp-section",
    children: [
      el("div", {
        className: "bp-section-head",
        children: ([
          el("div", {
            children: [
              el("h3", { text: section.organismGroup }),
              el("p", {
                className: "small muted",
                text:
                  `${section.filled} of ${section.rowCount} filled in` +
                  (section.tableReference ? ` · Table ${section.tableReference}` : "") +
                  ` · thresholds in ${data.unit}`,
              }),
            ],
          }),
          data.editable
            ? button(
                "Add an antimicrobial",
                () => openEditor(null, section.organismGroup, data, refresh),
                "ghost",
                { small: true },
              )
            : null,
        ].filter(Boolean) as Node[]),
      }),
      el("div", { className: "bp-scroll", children: [table] }),
    ],
  });
}

function dataRow(
  row: CatalogueRow,
  data: Catalogue,
  refresh: () => Promise<void>,
  redraw: () => void,
): HTMLElement {
  const node = el("tr", {
    className: [
      "bp-row",
      row.advisories.length > 0 ? "flagged" : "",
      row.placeholder ? "placeholder" : "",
    ]
      .filter(Boolean)
      .join(" "),
    children: [
      el("td", {
        className: "bp-agent",
        children: [
          el("span", { className: "bp-agent-name", text: row.agentName }),
          el("span", { className: "bp-agent-code", text: row.agentCode }),
        ],
      }),
      el("td", { className: "bp-qualifier", text: row.qualifier || "—" }),
      cell(row, "susceptible", data, refresh),
      cell(row, "sdd", data, refresh),
      cell(row, "intermediate", data, refresh),
      cell(row, "resistant", data, refresh),
      el("td", {
        className: "bp-actions",
        children: data.editable
          ? [
              button("Edit", () => openEditor(row, "", data, refresh), "ghost", { small: true }),
              button(
                "Remove",
                async () => {
                  const result = await api.removeBreakpoint({ key: row.key });
                  toast(result.message, result.ok ? "ok" : "warn");
                  await refresh();
                },
                "ghost",
                { small: true },
              ),
            ]
          : [],
      }),
    ],
  });

  if (row.comment) node.title = row.comment;
  if (row.advisories.length > 0) node.title = `${row.advisories.join(" ")}\n\n${row.comment}`.trim();
  void redraw;
  return node;
}

/**
 * One threshold, editable where it sits.
 *
 * A bound is a single box; a band is two, because that is what a band is. The
 * value is written back the moment the box loses focus, and the row is
 * re-validated as a whole — a susceptible zone typed below the resistant one is
 * refused there and then, with the reason, and the old value comes back.
 */
function cell(
  row: CatalogueRow,
  column: "susceptible" | "sdd" | "intermediate" | "resistant",
  data: Catalogue,
  refresh: () => Promise<void>,
): HTMLElement {
  const prefix =
    column === "susceptible"
      ? data.method === "DISK"
        ? "≥"
        : "≤"
      : column === "resistant"
        ? data.method === "DISK"
          ? "≤"
          : "≥"
        : "";

  const band = column === "sdd" || column === "intermediate";
  const fields: Array<{ field: string; value: string }> = band
    ? [
        { field: `${column === "sdd" ? "sdd" : "intermediate"}Min`, value: column === "sdd" ? row.values.sddMin : row.values.intermediateMin },
        { field: `${column === "sdd" ? "sdd" : "intermediate"}Max`, value: column === "sdd" ? row.values.sddMax : row.values.intermediateMax },
      ]
    : [{ field: column, value: column === "susceptible" ? row.values.susceptible : row.values.resistant }];

  const boxes = fields.map(({ field, value }) => {
    const input = el("input", { className: "bp-input" });
    input.value = value;
    input.inputMode = "decimal";
    input.title = `${row.agentName} — ${column}`;
    // A blank cell on a blueprint has to read as *waiting for a value*, not as
    // "not applicable". The placeholder glyph is what makes an unfilled form
    // look like a form.
    if (value === "") input.placeholder = "–";

    if (!data.editable) {
      input.readOnly = true;
      input.disabled = true;
      input.title = data.editRefusal || input.title;
      return input;
    }

    const commit = async (): Promise<void> => {
      if (input.value.trim() === value.trim()) return;
      const result = await api.setBreakpointCell({
        key: row.key,
        method: data.method,
        field,
        value: input.value,
      });
      if (!result.ok) {
        // The refusal is the point: the old value comes back so the table on
        // screen never shows a threshold the software would not accept.
        input.value = value;
        input.classList.add("rejected");
        window.setTimeout(() => input.classList.remove("rejected"), 1200);
        toast(result.message, "bad");
        return;
      }
      await refresh();
    };

    input.addEventListener("blur", () => void commit());
    input.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Enter") input.blur();
      if (key === "Escape") {
        input.value = value;
        input.blur();
      }
    });
    return input;
  });

  const children: Node[] = [];
  if (prefix) children.push(el("span", { className: "bp-operator", text: prefix }));
  children.push(boxes[0]!);
  if (boxes[1]) {
    children.push(el("span", { className: "bp-dash", text: "–" }), boxes[1]);
  }

  return el("td", {
    className: `bp-value ${band ? "bp-band" : ""}`.trim(),
    children: [el("div", { className: "bp-cell", children })],
  });
}

/* --- The full editor ------------------------------------------------------ */

/**
 * Everything about one criterion, for the parts that are not a number.
 *
 * The inline cells cover the thresholds, which is the common edit. This covers
 * adding a row, and the fields that decide *which* results a row applies to —
 * the agent, the disk content, the site and route. Those are worth a
 * deliberate step: changing the site on a criterion silently redirects it at a
 * different set of specimens.
 */
function openEditor(
  row: CatalogueRow | null,
  organismGroupFor: string,
  data: Catalogue,
  refresh: () => Promise<void>,
): void {
  const disk = data.method === "DISK";
  const inputs: Record<string, HTMLInputElement> = {};
  const field = (name: string, label: string, value = "", placeholder = ""): HTMLElement => {
    const input = textInput(value, { placeholder });
    inputs[name] = input;
    return el("div", { className: "field", children: [el("label", { text: label }), input] });
  };

  const values = row?.values;
  const problems = el("div");

  const close = modal(
    row ? `${row.agentName} — ${data.method === "DISK" ? "zone diameter" : "MIC"}` : "Add an antimicrobial",
    el("div", {
      children: [
        el("p", {
          className: "small muted",
          text: row
            ? "The scope decides which results this row applies to. Change the agent, site or route and it becomes a different criterion alongside this one."
            : `Enter the row as CLSI prints it. Thresholds are ${data.unit}; anything left blank is simply not stated.`,
        }),
        el("div", {
          className: "inline-fields",
          children: [
            field(
              "organism_group",
              "Organism group",
              row ? "" : organismGroupFor,
              "e.g. Enterobacterales",
            ),
            field("agent_code", "Antimicrobial code", row?.agentCode ?? "", "e.g. CIP"),
          ],
        }),
        el("div", {
          className: "inline-fields",
          children: [
            field(
              "disk_content",
              disk ? "Disk content (required)" : "Disk content",
              values?.diskContent ?? "",
              "e.g. 5 µg",
            ),
            field("site", "Site", values?.site ?? "", "e.g. meningitis, uti"),
            field("route", "Route", values?.route ?? "", "e.g. oral, iv"),
          ],
        }),
        el("div", {
          className: "inline-fields",
          children: [
            field(
              "susceptible",
              `Susceptible ${disk ? "≥" : "≤"} (${data.unit})`,
              values?.susceptible ?? "",
            ),
            field("intermediateMin", "Intermediate from", values?.intermediateMin ?? ""),
            field("intermediateMax", "Intermediate to", values?.intermediateMax ?? ""),
            field(
              "resistant",
              `Resistant ${disk ? "≤" : "≥"} (${data.unit})`,
              values?.resistant ?? "",
            ),
          ],
        }),
        el("div", {
          className: "inline-fields",
          children: [
            field("sddMin", "SDD from", values?.sddMin ?? ""),
            field("sddMax", "SDD to", values?.sddMax ?? ""),
            field(
              "dosage_note",
              "Dosage note (for an SDD band)",
              values?.dosageNote ?? "",
              "e.g. 1 g q8h",
            ),
          ],
        }),
        el("div", {
          className: "inline-fields",
          children: [
            field("standard", "Standard", values?.standard ?? "CLSI M100"),
            field("table_reference", "Table", values?.tableReference ?? "", "e.g. 2A-1"),
          ],
        }),
        field("comment", "Comment", values?.comment ?? ""),
        problems,
      ],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      button(
        "Save",
        async () => {
          const value = (name: string): string => inputs[name]?.value.trim() ?? "";
          const criterion: Record<string, unknown> = {
            organism_group: value("organism_group") || organismGroupFor,
            agent_code: value("agent_code"),
            method: data.method,
            standard: value("standard") || "CLSI M100",
            table_reference: value("table_reference") || null,
            disk_content: value("disk_content") || null,
            site: value("site") || null,
            route: value("route") || null,
            dosage_note: value("dosage_note") || null,
            comment: value("comment") || null,
          };
          const numeric: Record<string, string> = disk
            ? {
                susceptible: "disk_susceptible_min",
                intermediateMin: "disk_intermediate_min",
                intermediateMax: "disk_intermediate_max",
                resistant: "disk_resistant_max",
                sddMin: "disk_sdd_min",
                sddMax: "disk_sdd_max",
              }
            : {
                susceptible: "mic_susceptible_max",
                intermediateMin: "mic_intermediate_min",
                intermediateMax: "mic_intermediate_max",
                resistant: "mic_resistant_min",
                sddMin: "mic_sdd_min",
                sddMax: "mic_sdd_max",
              };
          for (const [name, column] of Object.entries(numeric)) {
            const raw = value(name);
            if (raw !== "") criterion[column] = raw;
          }

          const result = await api.saveBreakpoint({ criterion, replacing: row?.key });
          if (!result.ok) {
            problems.replaceChildren(
              el("ul", {
                className: "problem-list",
                children: (result.problems ?? [result.message]).map((text) => el("li", { text })),
              }),
            );
            return;
          }
          close();
          toast(result.message, "ok");
          await refresh();
        },
        "primary",
      ),
    ],
    { wide: true },
  );
}

/** An import result whose drop list is worth reading in full. */
function report(result: { ok: boolean; message: string; problems?: string[] }, title: string): void {
  if (!result.problems || result.problems.length === 0) {
    toast(result.message, result.ok ? "ok" : "warn");
    return;
  }
  const close = modal(
    title,
    el("div", {
      children: [
        el("p", { text: result.message }),
        el("ul", {
          className: "problem-list",
          children: result.problems.map((problem) => el("li", { text: problem })),
        }),
      ],
    }),
    [button("Close", () => close(), "primary")],
  );
}
