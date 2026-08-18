/**
 * Settings — and, on a new installation, setup.
 *
 * Setup is deliberately short and happens once: name the facility, name the
 * server, point at the WHONET file. After that, uploading is a button, because
 * the file never moves and the software follows it.
 *
 * The panels below are in the order a facility meets them: what this laboratory
 * is, where its data comes from, when it sends, how it behaves, and what it
 * interprets against.
 */

import { api, type BreakpointTableRow, type Settings } from "../api.js";
import type { ViewContext } from "../app.js";
import {
  button,
  card,
  checkbox,
  count,
  definitionList,
  el,
  modal,
  notice,
  relativeTime,
  select,
  subtabs,
  table,
  textInput,
  toast,
} from "../ui.js";

let panel = "facility";

export async function renderSettings(host: HTMLElement, context: ViewContext): Promise<void> {
  const settings = await api.settings();

  host.replaceChildren(
    el("div", {
      className: "page-head",
      children: [
        el("div", {
          children: [
            el("h2", { text: "Settings" }),
            el("p", {
              text: "Everything this uploader needs to know about your laboratory, in one place.",
            }),
          ],
        }),
        el("div", {
          className: "page-actions",
          children: [
            button("Open data folder", async () => {
              const result = await api.openStateFolder();
              toast(result.message, result.ok ? "ok" : "warn");
            }),
          ],
        }),
      ],
    }),
  );

  if (!context.status.setupComplete) {
    host.append(
      notice(
        "info",
        "Setup is not finished. Enter your facility code, then choose your WHONET database — those two steps are the whole setup, and you only do them once.",
      ),
    );
  }

  const body = el("div");
  host.append(
    subtabs(
      [
        { value: "facility", label: "Facility" },
        { value: "whonet", label: "WHONET data" },
        { value: "schedule", label: "Upload schedule" },
        { value: "behaviour", label: "Alerts & analysis" },
        { value: "breakpoints", label: "Breakpoints" },
        { value: "mapping", label: "Code mapping" },
        { value: "connection", label: "Connection (IT)" },
        { value: "about", label: "About" },
      ],
      panel,
      (value) => {
        panel = value;
        void renderSettings(host, context);
      },
    ),
    body,
  );

  const panels: Record<string, () => Promise<HTMLElement> | HTMLElement> = {
    facility: () => facilityPanel(settings, context),
    whonet: () => whonetPanel(settings, context),
    schedule: () => schedulePanel(settings, context),
    behaviour: () => behaviourPanel(settings, context),
    breakpoints: () => breakpointsPanel(settings, context),
    mapping: () => mappingPanel(context),
    connection: () => connectionPanel(settings, context),
    about: () => aboutPanel(settings, context),
  };

  body.append(await (panels[panel] ?? panels.facility)!());
}

function facilityPanel(settings: Settings, context: ViewContext): HTMLElement {
  const code = textInput(settings.facilityCode, { placeholder: "e.g. SECH-01" });
  const name = textInput(settings.facilityName, { placeholder: "e.g. Suntreso Government Hospital" });

  return card(
    "Your facility",
    "How this laboratory is identified on the surveillance platform. Your regional administrator issues the code when the facility is enrolled; a batch declaring a different one is refused.",
    el("div", {
      className: "inline-fields",
      children: [
        el("div", { className: "field", children: [el("label", { text: "Facility code" }), code] }),
        el("div", { className: "field", children: [el("label", { text: "Facility name" }), name] }),
      ],
    }),
    button(
      "Save",
      async () => {
        await api.saveSettings({
          facilityCode: code.value.trim() || null,
          facilityName: name.value.trim() || null,
        });
        await context.refresh();
        toast("Saved.");
      },
      "primary",
    ),
    el("p", {
      className: "small muted",
      text: "Server addresses live under Connection (IT) — they are set once when this computer is installed and do not need changing here.",
    }),
  );
}

function whonetPanel(settings: Settings, context: ViewContext): HTMLElement {
  const status = context.status;
  const detection = el("div");

  const configVersion = textInput(settings.whonetConfigVersion, {
    placeholder: "e.g. GLASS-GH-2026",
  });
  const standard = textInput(settings.astBreakpointStandard, { placeholder: "e.g. CLSI M100 Ed35" });

  return card(
    "WHONET data",
    "Point this at your WHONET database once. It stays pointed there: every time WHONET records a result, this software sees it.",
    definitionList([
      ["Current file", settings.whonetDatabasePath ?? "none selected"],
      ["Last read", relativeTime(status.workspace.readAt)],
      ["Isolates loaded", count(status.workspace.recordCount)],
      [
        "Rows held out",
        `${count(status.workspace.excludedCount)} (no organism isolated, no susceptibility results, or held out by you)`,
      ],
    ]),
    detection,
    el("div", {
      className: "toolbar",
      children: [
        button(
          settings.whonetDatabasePath ? "Choose a different file" : "Choose WHONET file",
          async () => {
            const chosen = await api.chooseWhonetFile();
            if (!chosen) return;

            if (!chosen.detection?.profile) {
              detection.replaceChildren(
                notice(
                  "bad",
                  chosen.error
                    ? `That file could not be opened: ${chosen.error}`
                    : `This file could not be read as a WHONET database. Missing: ${
                        chosen.detection?.unmappedRequired.join(", ") ?? "required columns"
                      }. Contact your regional Data Steward rather than proceeding with a partial mapping.`,
                ),
              );
              return;
            }

            const profile = chosen.detection.profile as Record<string, string | null>;
            const parts: Array<Node | null> = [
              notice(
                "ok",
                `Read ${chosen.detection.recordCount} rows and ${chosen.detection.agentColumns.length} antimicrobial columns from table "${chosen.detection.table}".`,
              ),
              definitionList([
                ["File", chosen.path],
                ["Patient identifier column", profile.patientIdentifier ?? "—"],
                ["Specimen date column", profile.specimenDate ?? "—"],
                ["Fallback date column", profile.specimenDateFallback ?? "not present"],
                ["Organism column", profile.organism ?? "—"],
                ["Specimen type column", profile.specimenType ?? "—"],
                ["Ward type column", profile.careSetting ?? "not present"],
              ]),
              chosen.detection.identifyingColumnsPresent.length > 0
                ? notice(
                    "info",
                    `This file contains identifying columns (${chosen.detection.identifyingColumnsPresent.join(", ")}). They are read on this computer to compute the patient linkage key and to show you your own grid. They are never transmitted.`,
                  )
                : null,
              button(
                "Use this file",
                async () => {
                  await api.confirmWhonetFile({
                    path: chosen.path,
                    profile: chosen.detection!.profile,
                  });
                  await context.refresh();
                  toast("WHONET file confirmed. The uploader now follows it.");
                },
                "primary",
              ),
            ];
            detection.replaceChildren(...parts.filter((part): part is Node => part !== null));
          },
        ),
        button("Reload now", async () => {
          await api.reload();
          await context.refresh();
          toast("Reloaded.");
        }),
      ],
    }),
    el("div", {
      className: "inline-fields",
      children: [
        el("div", {
          className: "field",
          children: [
            el("label", { text: "WHONET configuration version" }),
            configVersion,
            el("div", {
              className: "help",
              text: "Recorded with every batch so the platform knows which configuration produced it.",
            }),
          ],
        }),
        el("div", {
          className: "field",
          children: [
            el("label", { text: "AST breakpoint standard in use at the bench" }),
            standard,
          ],
        }),
      ],
    }),
    checkbox(
      "Include isolates that name an organism but have no susceptibility results",
      settings.includeUntestedIsolates,
      async (checked) => {
        await api.saveSettings({ includeUntestedIsolates: checked });
        await context.refresh();
        toast(
          checked
            ? "Untested isolates are now included."
            : "Untested isolates are held out, as are cultures with no organism.",
        );
      },
    ),
    button(
      "Save",
      async () => {
        await api.saveSettings({
          whonetConfigVersion: configVersion.value.trim() || null,
          astBreakpointStandard: standard.value.trim() || null,
        });
        await context.refresh();
        toast("Saved.");
      },
      "primary",
    ),
  );
}

function schedulePanel(settings: Settings, context: ViewContext): HTMLElement {
  const schedule = settings.schedule;
  const fields = el("div", { className: "inline-fields" });

  const frequency = select(
    [
      { value: "hourly", label: "Every hour" },
      { value: "interval", label: "Every N hours" },
      { value: "daily", label: "Daily" },
      { value: "weekly", label: "Weekly" },
      { value: "monthly", label: "Monthly" },
    ],
    schedule.frequency,
    () => undefined,
  );
  const timeOfDay = textInput(schedule.timeOfDay, { type: "time" });
  const dayOfWeek = select(
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
      (label, index) => ({ value: String(index), label }),
    ),
    String(schedule.dayOfWeek),
    () => undefined,
  );
  const dayOfMonth = textInput(String(schedule.dayOfMonth), { type: "number" });
  const intervalHours = textInput(String(schedule.intervalHours), { type: "number" });
  const retryMinutes = textInput(String(schedule.retryMinutes), { type: "number" });

  fields.append(
    el("div", { className: "field", children: [el("label", { text: "How often" }), frequency] }),
    el("div", { className: "field", children: [el("label", { text: "Time of day" }), timeOfDay] }),
    el("div", { className: "field", children: [el("label", { text: "Day of week" }), dayOfWeek] }),
    el("div", {
      className: "field",
      children: [el("label", { text: "Day of month (1–28)" }), dayOfMonth],
    }),
    el("div", {
      className: "field",
      children: [el("label", { text: "Interval, hours" }), intervalHours],
    }),
    el("div", {
      className: "field",
      children: [
        el("label", { text: "Retry after, minutes" }),
        retryMinutes,
        el("div", {
          className: "help",
          text: "How long to wait before trying again when a scheduled run is held back.",
        }),
      ],
    }),
  );

  const mode = el("div");
  const requireValidation = checkbox(
    "Never send while any record has a must-fix finding",
    schedule.requireValidation,
    () => undefined,
  );
  const requireSignOff = checkbox(
    "Never send data nobody has approved since it last changed",
    schedule.requireValidatedSignOff,
    () => undefined,
  );

  mode.append(
    el("div", {
      className: "toolbar",
      children: [
        button(
          "Manual",
          async () => {
            await api.saveSettings({ schedule: { ...schedule, mode: "manual" } });
            await context.refresh();
            toast("Uploads are manual. Nothing is sent until you send it.");
          },
          schedule.mode === "manual" ? "primary" : "default",
        ),
        button(
          "Automatic",
          async () => {
            await api.saveSettings({ schedule: { ...schedule, mode: "automatic" } });
            await context.refresh();
            toast("Automatic uploads enabled.");
          },
          schedule.mode === "automatic" ? "primary" : "default",
        ),
      ],
    }),
    notice(
      schedule.mode === "automatic" ? "ok" : "info",
      `${schedule.description}${
        context.status.schedule.nextRunAt
          ? ` Next run ${new Date(context.status.schedule.nextRunAt).toLocaleString()}.`
          : ""
      }`,
    ),
  );

  return card(
    "Upload schedule",
    "Automatic uploads send on their own, but they never skip the checks: an automatic run refuses the same batch the send button would refuse, and says why.",
    mode,
    fields,
    el("div", {
      children: [requireValidation, requireSignOff],
    }),
    button(
      "Save schedule",
      async () => {
        await api.saveSettings({
          schedule: {
            ...schedule,
            frequency: frequency.value as typeof schedule.frequency,
            timeOfDay: timeOfDay.value || "18:00",
            dayOfWeek: Number(dayOfWeek.value),
            dayOfMonth: Math.min(28, Math.max(1, Number(dayOfMonth.value) || 1)),
            intervalHours: Math.max(1, Number(intervalHours.value) || 6),
            retryMinutes: Math.max(5, Number(retryMinutes.value) || 30),
            requireValidation: (requireValidation.querySelector("input") as HTMLInputElement).checked,
            requireValidatedSignOff: (requireSignOff.querySelector("input") as HTMLInputElement)
              .checked,
          },
        });
        await context.refresh();
        toast("Schedule saved.");
      },
      "primary",
    ),
  );
}

function behaviourPanel(settings: Settings, context: ViewContext): HTMLElement {
  const pollSeconds = textInput(String(settings.realtime.pollSeconds), { type: "number" });
  const alertSeconds = textInput(String(settings.connectivity.alertIntervalSeconds), {
    type: "number",
  });
  const minimumIsolates = textInput(String(settings.analysis.minimumIsolates), { type: "number" });

  const realtimeEnabled = checkbox(
    "Follow the WHONET file and reload as results are entered",
    settings.realtime.enabled,
    () => undefined,
  );
  const audible = checkbox(
    "Sound an alert while the connection is down",
    settings.connectivity.audibleAlert,
    () => undefined,
  );
  const firstIsolate = checkbox(
    "Count one isolate per patient per organism in analyses",
    settings.analysis.firstIsolateOnly,
    () => undefined,
  );

  return card(
    "Alerts and analysis",
    "How closely the uploader follows the file, how loudly it says it is offline, and the counting rules behind every percentage it shows.",
    el("div", {
      className: "inline-fields",
      children: [
        el("div", {
          className: "field",
          children: [
            el("label", { text: "Check the WHONET file every (seconds)" }),
            pollSeconds,
            el("div", {
              className: "help",
              text: "A file watcher catches most changes immediately; this is the backstop for network drives.",
            }),
          ],
        }),
        el("div", {
          className: "field",
          children: [el("label", { text: "Repeat the offline alert every (seconds)" }), alertSeconds],
        }),
        el("div", {
          className: "field",
          children: [
            el("label", { text: "Withhold percentages below (isolates)" }),
            minimumIsolates,
            el("div", {
              className: "help",
              text: "The platform's reporting threshold. Cells below it are shown here but marked, so you can see your own small numbers without publishing them.",
            }),
          ],
        }),

      ],
    }),
    el("div", { children: [realtimeEnabled, audible, firstIsolate] }),
    button(
      "Save",
      async () => {
        await api.saveSettings({
          realtime: {
            enabled: (realtimeEnabled.querySelector("input") as HTMLInputElement).checked,
            pollSeconds: Math.max(5, Number(pollSeconds.value) || 30),
          },
          connectivity: {
            ...settings.connectivity,
            audibleAlert: (audible.querySelector("input") as HTMLInputElement).checked,
            alertIntervalSeconds: Math.max(15, Number(alertSeconds.value) || 60),
          },
          analysis: {
            firstIsolateOnly: (firstIsolate.querySelector("input") as HTMLInputElement).checked,
            minimumIsolates: Math.max(1, Number(minimumIsolates.value) || 30),
          },
        });
        await context.refresh();
        toast("Saved.");
      },
      "primary",
    ),
  );
}

/**
 * Connection — for whoever installs and supports this computer.
 *
 * Everything here was decided by the programme, not by the laboratory: where
 * data goes, how often the connection is checked, and how long a machine may
 * keep working without seeing the server. It is one click away from daily work
 * on purpose, and labelled so nobody at the bench feels they should be reading
 * it.
 */
function connectionPanel(settings: Settings, context: ViewContext): HTMLElement {
  const serviceAddress = textInput(settings.apiUrl, {
    placeholder: "https://amrss-api.example.org",
  });
  const websiteAddress = textInput(settings.webUrl, { placeholder: "https://amrss.example.org" });
  const connectivitySeconds = textInput(String(settings.connectivity.pollSeconds), {
    type: "number",
  });
  const graceDays = textInput(String(settings.offlineGraceDays), { type: "number" });
  const testResult = el("div");

  return card(
    "Connection",
    "Set once, when this computer is installed. Laboratory staff never need these.",
    el("div", {
      className: "inline-fields",
      children: [
        el("div", {
          className: "field",
          children: [
            el("label", { text: "AMRSS service address" }),
            serviceAddress,
            el("div", {
              className: "help",
              text: "Where surveillance data is submitted, and where sign-in is checked. This is the API service — not the website staff open in a browser. On the website's own deployment it is the AMRSS_API_URL setting.",
            }),
          ],
        }),
        el("div", {
          className: "field",
          children: [
            el("label", { text: "AMRSS website address" }),
            websiteAddress,
            el("div", {
              className: "help",
              text: "Optional. Used by “Open the AMRSS website”, which opens the dashboard already signed in as the same person.",
            }),
          ],
        }),
        el("div", {
          className: "field",
          children: [
            el("label", { text: "Check the connection every (seconds)" }),
            connectivitySeconds,
          ],
        }),
        el("div", {
          className: "field",
          children: [
            el("label", { text: "Allow working offline for (days)" }),
            graceDays,
            el("div", {
              className: "help",
              text: "After this long without reaching the service, signing in needs a connection — so an account closed centrally cannot keep working here indefinitely.",
            }),
          ],
        }),
      ],
    }),
    el("div", {
      className: "toolbar",
      children: [
        button("Test connection", async () => {
          testResult.replaceChildren(notice("info", "Testing…"));
          const test = await api.testConnection(serviceAddress.value.trim());
          testResult.replaceChildren(notice(test.ok ? "ok" : "bad", test.message));
          if (!test.ok && typeof test.detail === "string") {
            testResult.append(el("p", { className: "small muted", text: test.detail }));
          }
        }),
        button(
          "Save",
          async () => {
            await api.saveSettings({
              apiUrl: serviceAddress.value.trim(),
              webUrl: websiteAddress.value.trim(),
              connectivity: {
                ...settings.connectivity,
                pollSeconds: Math.max(10, Number(connectivitySeconds.value) || 30),
              },
              offlineGraceDays: Math.max(1, Number(graceDays.value) || 30),
            });
            await context.refresh();
            toast("Connection settings saved.");
          },
          "primary",
        ),
      ],
    }),
    testResult,
  );
}

/* ------------------------------------------------------------------ *
 * Breakpoints.
 * ------------------------------------------------------------------ */

/** Which slice of the table is on screen. Kept outside the render so a search
 * survives the redraw that follows every edit. */
let breakpointSearch = "";
let breakpointMethod = "";
let breakpointOffset = 0;

const PAGE_SIZE = 60;

async function breakpointsPanel(settings: Settings, context: ViewContext): Promise<HTMLElement> {
  const breakpoints = context.status.workspace.breakpoints;
  const coverage = context.status.workspace.coverage;
  const preference = settings.testingMethod ?? "both";
  const panel = el("div");

  panel.append(
    card(
      "What this laboratory tests with",
      "Disk diffusion reads a zone in millimetres; an MIC reads a concentration. Choosing here keeps the breakpoint table, the coverage figure and the imports to the method you actually use — a laboratory on an automated MIC panel should not be shown a table of zone diameters.",
      el("div", {
        className: "field",
        children: [
          el("label", { text: "Susceptibility testing method" }),
          select(
            [
              { value: "both", label: "Both — disks routinely, MICs where needed" },
              { value: "disk", label: "Disk diffusion — zone diameters in mm" },
              { value: "mic", label: "MIC — concentrations in µg/mL" },
            ],
            preference,
            (value) => {
              void api.saveSettings({ testingMethod: value }).then(async () => {
                toast("Testing method saved.", "ok");
                await context.refresh();
              });
            },
          ),
        ],
      }),
    ),
  );

  panel.append(
    card(
      "Breakpoint table",
      "No breakpoint values ship with AMRSS: the tables are copyrighted, revised every edition, and a mistyped threshold turns an R into an S. The table here is your laboratory's own — synced from the platform, imported from your licensed CLSI M100 workbook, or typed in below.",
      definitionList([
        ["Loaded", breakpoints.loaded ? "yes" : "no"],
        ["Edition", breakpoints.label ?? breakpoints.version ?? "—"],
        ["Criteria", count(breakpoints.criteria)],
        [
          "Source",
          breakpoints.source === "platform" ? "synced from the platform" : breakpoints.source,
        ],
        ["Last synced", relativeTime(breakpoints.syncedAt)],
        [
          "Interpretation coverage",
          coverage
            ? `${coverage.interpreted + coverage.laboratoryReported} of ${coverage.measurements} results (${coverage.coveragePercent.toFixed(0)}%)`
            : "—",
        ],
      ]),
      coverage && coverage.conflicts > 0
        ? notice(
            "warn",
            `${coverage.conflicts} result(s) carry a category that differs from what this table gives for the same measurement. The laboratory's own category is kept and the disagreement is listed in Validation.`,
          )
        : null,
      el("div", {
        className: "toolbar",
        children: [
          button(
            "Sync from platform",
            async () => {
              const result = await api.syncBreakpoints();
              toast(result.message, result.ok ? "ok" : "warn");
              await context.refresh();
            },
            "primary",
          ),
          button("Import a table…", async () => {
            const result = await api.importBreakpoints();
            if (result.problems && result.problems.length > 0) {
              showImportProblems("Rows that could not be read", result.message, result.problems);
            } else {
              toast(result.message, result.ok ? "ok" : "warn");
            }
            await context.refresh();
          }),
          button("Export as CSV", async () => {
            const result = await api.exportBreakpoints({ format: "csv" });
            toast(result.message, result.ok ? "ok" : "warn");
          }),
          button("Export as Excel", async () => {
            const result = await api.exportBreakpoints({ format: "xlsx" });
            toast(result.message, result.ok ? "ok" : "warn");
          }),
        ],
      }),
      el("p", {
        className: "small muted",
        text: "Import accepts two files: the CSV this page exports — which round-trips exactly, so you can export it, correct a threshold in Excel and put it back — or your own licensed CLSI M100 workbook, which is converted on the way in. Any row of the workbook that cannot be read is listed rather than guessed at.",
      }),
    ),
  );

  panel.append(await breakpointTableCard(context));

  if (coverage && coverage.uncovered.length > 0) {
    panel.append(
      card(
        "Combinations this table does not cover",
        "Most frequent first — worth working through by impact rather than alphabetically. A result with no criterion reads as PI, pending interpretation: measured, counted as tested, and left out of the susceptibility rates until a criterion covers it.",
        table(
          [
            { label: "Organism / agent / method", value: (row) => row.combination },
            { label: "Results", value: (row) => count(row.measurements), numeric: true },
          ],
          coverage.uncovered.slice(0, 25),
        ),
      ),
    );
  }

  return panel;

  function showImportProblems(title: string, message: string, problems: string[]): void {
    const close = modal(
      title,
      el("div", {
        children: [
          el("p", { text: message }),
          el("ul", {
            className: "problem-list",
            children: problems.map((problem) => el("li", { text: problem })),
          }),
        ],
      }),
      [button("Close", () => close(), "primary")],
    );
  }
}

/**
 * The editable table.
 *
 * Everything that reaches it — a synced table, a converted workbook, a typed
 * row — is checked the same way, because a threshold typed into a form and one
 * read from a file are the same claim about a patient's result. A row the
 * conversion could not read is not a dead end: it is added here.
 */
async function breakpointTableCard(context: ViewContext): Promise<HTMLElement> {
  const page = await api.breakpointTable({
    search: breakpointSearch,
    method: breakpointMethod,
    offset: breakpointOffset,
    limit: PAGE_SIZE,
  });

  const redraw = (): void => {
    const host = document.querySelector(".content");
    if (host) void renderSettings(host as HTMLElement, context);
  };

  const search = textInput(breakpointSearch, {
    placeholder: "organism group, agent code or name",
    onInput: (value) => {
      breakpointSearch = value;
      breakpointOffset = 0;
    },
  });
  search.addEventListener("change", redraw);
  search.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") redraw();
  });

  const toolbar = el("div", {
    className: "inline-fields",
    children: [
      el("div", { className: "field", children: [el("label", { text: "Find" }), search] }),
      el("div", {
        className: "field",
        children: [
          el("label", { text: "Method" }),
          select(
            [
              { value: "", label: "All methods" },
              { value: "DISK", label: "Disk diffusion" },
              { value: "MIC", label: "MIC" },
              { value: "GRADIENT", label: "Gradient strip" },
            ],
            breakpointMethod,
            (value) => {
              breakpointMethod = value;
              breakpointOffset = 0;
              redraw();
            },
          ),
        ],
      }),
    ],
  });

  const pager = el("div", {
    className: "toolbar",
    children: [
      button(
        "Add a breakpoint",
        () => openCriterionEditor(null, context),
        "primary",
        { small: true },
      ),
      el("div", { className: "topbar-spacer" }),
      el("span", {
        className: "small muted",
        text:
          page.matched === 0
            ? "Nothing matches"
            : `Showing ${page.offset + 1}–${Math.min(page.offset + PAGE_SIZE, page.matched)} of ${count(page.matched)}${
                page.matched !== page.total ? ` (of ${count(page.total)} in the table)` : ""
              }`,
      }),
      button(
        "Previous",
        () => {
          breakpointOffset = Math.max(0, breakpointOffset - PAGE_SIZE);
          redraw();
        },
        "ghost",
        { small: true, disabled: page.offset === 0 },
      ),
      button(
        "Next",
        () => {
          breakpointOffset = breakpointOffset + PAGE_SIZE;
          redraw();
        },
        "ghost",
        { small: true, disabled: page.offset + PAGE_SIZE >= page.matched },
      ),
    ],
  });

  return card(
    "The table itself",
    "Every criterion the software interprets against, exactly as loaded. Edit a row where your edition differs, or add one the import could not read — the same checks apply either way, and a row that would categorise every isolate as susceptible is refused with the reason.",
    toolbar,
    pager,
    table(
      [
        { label: "Organism group", value: (row) => row.organismGroup },
        {
          label: "Antimicrobial",
          value: (row) => `${row.agentName} (${row.agentCode})`,
        },
        { label: "Method", value: (row) => row.method },
        { label: "Scope", value: (row) => row.scope || "—" },
        { label: "S", value: (row) => row.susceptible || "—" },
        { label: "I", value: (row) => row.intermediate || "—" },
        { label: "R", value: (row) => row.resistant || "—" },
        { label: "Source", value: (row) => row.source || "—", title: "The edition and table this criterion cites." },
        {
          label: "",
          value: (row) =>
            el("div", {
              className: "row-actions",
              children: [
                button("Edit", () => openCriterionEditor(row, context), "ghost", { small: true }),
                button(
                  "Remove",
                  async () => {
                    const result = await api.removeBreakpoint({ key: row.key });
                    toast(result.message, result.ok ? "ok" : "warn");
                    await context.refresh();
                  },
                  "ghost",
                  { small: true },
                ),
              ],
            }),
        },
      ],
      page.rows,
      "No breakpoints are loaded. Sync from the platform, import your CLSI table, or add one here.",
    ),
  );
}

/**
 * One criterion, in a form.
 *
 * The disk and MIC fields are both shown, and which set applies follows the
 * method chosen at the top, because the two run in opposite directions and a
 * form that hid the distinction would invite the single commonest transcription
 * error: a zone entered as though it were a concentration.
 */
function openCriterionEditor(row: BreakpointTableRow | null, context: ViewContext): void {
  const fields: Record<string, HTMLInputElement> = {};
  const field = (name: string, label: string, placeholder = ""): HTMLElement => {
    const input = textInput("", { placeholder });
    fields[name] = input;
    return el("div", { className: "field", children: [el("label", { text: label }), input] });
  };

  const method = select(
    [
      { value: "DISK", label: "Disk diffusion — zone diameter in mm" },
      { value: "MIC", label: "MIC — concentration in µg/mL" },
      { value: "GRADIENT", label: "Gradient strip — read as an MIC" },
    ],
    row?.method === "Disk" ? "DISK" : row?.method === "Gradient" ? "GRADIENT" : "MIC",
    (value) => {
      diskBlock.hidden = value !== "DISK";
      micBlock.hidden = value === "DISK";
    },
  );

  const scope = el("div", {
    className: "inline-fields",
    children: [
      field("organism_group", "Organism group", "e.g. Enterobacterales"),
      field("agent_code", "Antimicrobial code", "e.g. CIP"),
    ],
  });

  const qualifiers = el("div", {
    className: "inline-fields",
    children: [
      field("disk_content", "Disk content", "e.g. 5 µg"),
      field("site", "Site", "e.g. meningitis, uti"),
      field("route", "Route", "e.g. oral, iv"),
    ],
  });

  const diskBlock = el("div", {
    className: "inline-fields",
    children: [
      field("disk_susceptible_min", "Susceptible ≥ (mm)"),
      field("disk_intermediate_min", "Intermediate from (mm)"),
      field("disk_intermediate_max", "Intermediate to (mm)"),
      field("disk_resistant_max", "Resistant ≤ (mm)"),
    ],
  });

  const micBlock = el("div", {
    className: "inline-fields",
    children: [
      field("mic_susceptible_max", "Susceptible ≤ (µg/mL)"),
      field("mic_intermediate_min", "Intermediate from"),
      field("mic_intermediate_max", "Intermediate to"),
      field("mic_resistant_min", "Resistant ≥ (µg/mL)"),
    ],
  });

  const provenance = el("div", {
    className: "inline-fields",
    children: [
      field("standard", "Standard", "e.g. CLSI M100"),
      field("table_reference", "Table", "e.g. 2A-1"),
      field("dosage_note", "Dosage note (required for SDD)"),
    ],
  });

  diskBlock.hidden = method.value !== "DISK";
  micBlock.hidden = method.value === "DISK";

  if (row) {
    fields.organism_group!.value = row.organismGroup;
    fields.agent_code!.value = row.agentCode;
    // The scope and the printed thresholds are re-entered rather than parsed
    // back out of their display form: reading "≥17 mm" back into a number is
    // exactly the kind of round trip that quietly loses a value.
  }

  const problems = el("div");

  const close = modal(
    row ? `Edit ${row.agentName} · ${row.organismGroup}` : "Add a breakpoint",
    el("div", {
      children: [
        el("p", {
          className: "small muted",
          text: row
            ? "Re-enter the thresholds for this criterion. Saving replaces the row with the same scope."
            : "Enter the criterion as your edition prints it. A row whose bounds contradict each other is refused rather than saved.",
        }),
        scope,
        el("div", { className: "field", children: [el("label", { text: "Method" }), method] }),
        qualifiers,
        diskBlock,
        micBlock,
        provenance,
        problems,
      ],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      button(
        "Save",
        async () => {
          const criterion: Record<string, unknown> = { method: method.value };
          for (const [name, input] of Object.entries(fields)) {
            const value = input.value.trim();
            if (value !== "") criterion[name] = value;
          }
          const result = await api.saveBreakpoint({
            criterion,
            replacing: row?.key,
          });
          if (!result.ok) {
            problems.replaceChildren(
              el("ul", {
                className: "problem-list",
                children: (result.problems ?? [result.message]).map((text) =>
                  el("li", { text }),
                ),
              }),
            );
            return;
          }
          close();
          toast(result.message, "ok");
          await context.refresh();
        },
        "primary",
      ),
    ],
    { wide: true },
  );
}

/* ------------------------------------------------------------------ *
 * Code mapping.
 * ------------------------------------------------------------------ */

async function mappingPanel(context: ViewContext): Promise<HTMLElement> {
  const mappings = await api.mappings();

  const rows: Array<{ entity: string; kind: string; from: string; to: string }> = [
    ...Object.entries(mappings.organism).map(([from, to]) => ({
      entity: "organism",
      kind: "Organism",
      from,
      to,
    })),
    ...Object.entries(mappings.specimen).map(([from, to]) => ({
      entity: "specimen",
      kind: "Specimen type",
      from,
      to,
    })),
    ...Object.entries(mappings.antibiotic).map(([from, to]) => ({
      entity: "antibiotic",
      kind: "Antimicrobial",
      from,
      to,
    })),
  ];

  const kind = select(
    [
      { value: "organism", label: "Organism" },
      { value: "specimen", label: "Specimen type" },
      { value: "antibiotic", label: "Antimicrobial" },
    ],
    "organism",
    () => undefined,
  );
  const from = textInput("", { placeholder: "your local code, e.g. bx" });
  const to = textInput("", { placeholder: "AMRSS dictionary code, e.g. ti" });

  const single = el("div", {
    children: [
      el("div", {
        className: "inline-fields",
        children: [
          el("div", { className: "field", children: [el("label", { text: "Kind" }), kind] }),
          el("div", { className: "field", children: [el("label", { text: "Local code" }), from] }),
          el("div", { className: "field", children: [el("label", { text: "AMRSS code" }), to] }),
        ],
      }),
      button(
        "Add mapping",
        async () => {
          if (!from.value.trim() || !to.value.trim()) {
            toast("Enter both codes.", "warn");
            return;
          }
          const result = await api.mapCode({
            entity: kind.value,
            from: from.value.trim(),
            to: to.value.trim(),
          });
          toast(result.message, result.ok ? "ok" : "warn");
          from.value = "";
          to.value = "";
          await context.refresh();
        },
        "primary",
      ),
    ],
  });

  const workbook = card(
    "The whole code book, in one workbook",
    "Export writes every code AMRSS understands — organisms, specimen types and antimicrobials, each on its own sheet, the way WHONET keeps them — along with the codes your own file used that AMRSS could not name, waiting with a blank column beside them. Fill that column in, in Excel or with your microbiologist, and import the workbook back.",
    el("div", {
      className: "toolbar",
      children: [
        button(
          "Export the code book",
          async () => {
            const result = await api.exportMappings();
            toast(result.message, result.ok ? "ok" : "warn");
          },
          "primary",
        ),
        button("Import a completed workbook…", async () => {
          const result = await api.importMappings();
          if (result.problems && result.problems.length > 0) {
            const close = modal(
              "Rows that were not applied",
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
          } else {
            toast(result.message, result.ok ? "ok" : "warn");
          }
          await context.refresh();
        }),
      ],
    }),
    el("p", {
      className: "small muted",
      text: "Importing replaces the mappings for the categories the workbook covers, so deleting a row in Excel removes that mapping. A row naming a code AMRSS does not hold is reported back rather than stored — a mapping onto a code that does not exist would fail silently on every row that used it.",
    }),
  );

  return el("div", {
    children: [
      workbook,
      card(
        "Code mapping",
        "When your WHONET configuration uses a code the AMRSS dictionary does not hold, map it here once. The mapping applies to every row in the file, and to everything entered afterwards — it is a statement about your configuration, not about one specimen.",
        single,
        table(
          [
            { label: "Kind", value: (row) => row.kind },
            { label: "Local code", value: (row) => row.from },
            { label: "AMRSS code", value: (row) => row.to },
            {
              label: "",
              value: (row) =>
                button(
                  "Remove",
                  async () => {
                    await api.unmapCode({ entity: row.entity, from: row.from });
                    await context.refresh();
                    toast("Mapping removed.");
                  },
                  "ghost",
                  { small: true },
                ),
            },
          ],
          rows,
          "No local codes are mapped. Validation will tell you if any are needed.",
        ),
      ),
    ],
  });
}

function aboutPanel(settings: Settings, context: ViewContext): HTMLElement {
  return card(
    "About this installation",
    undefined,
    definitionList([
      ["Uploader version", context.status.uploaderVersion],
      ["Data folder", settings.stateDirectory],
      [
        "Facility salt",
        settings.hasSalt
          ? "present — back it up; without it, patient linkage across uploads cannot be reproduced"
          : "not created yet (it is created on the first upload)",
      ],
      ["Signed in as", context.status.session?.fullName ?? "—"],
      ["Role", context.status.session?.roleLabel ?? "—"],
      ["Session", context.status.session?.mode ?? "—"],
      ["Batches sent from this computer", count(context.status.uploadCount)],
    ]),
    notice(
      "info",
      "The facility salt is the one file here that cannot be regenerated. If it is lost, repeat isolates from a patient stop linking to the ones already submitted and start counting as separate people. Back up the data folder as part of the laboratory's routine backup.",
    ),
  );
}
