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

import { api, type Settings } from "../api.js";
import type { ViewContext } from "../app.js";
import {
  button,
  card,
  checkbox,
  count,
  definitionList,
  el,
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
        { value: "facility", label: "Facility & server" },
        { value: "whonet", label: "WHONET data" },
        { value: "schedule", label: "Upload schedule" },
        { value: "behaviour", label: "Alerts & analysis" },
        { value: "breakpoints", label: "Breakpoints" },
        { value: "mapping", label: "Code mapping" },
        { value: "about", label: "About this installation" },
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
    breakpoints: () => breakpointsPanel(context),
    mapping: () => mappingPanel(context),
    about: () => aboutPanel(settings, context),
  };

  body.append(await (panels[panel] ?? panels.facility)!());
}

function facilityPanel(settings: Settings, context: ViewContext): HTMLElement {
  const code = textInput(settings.facilityCode, { placeholder: "e.g. SECH-01" });
  const name = textInput(settings.facilityName, { placeholder: "e.g. Suntreso Government Hospital" });
  const apiUrl = textInput(settings.apiUrl, { placeholder: "https://amrss-api.example.org" });
  const webUrl = textInput(settings.webUrl, { placeholder: "https://amrss.example.org" });

  return card(
    "Facility and server",
    "The facility code must match the one your regional administrator enrolled; a batch declaring a different facility is refused by the platform.",
    el("div", {
      className: "inline-fields",
      children: [
        el("div", { className: "field", children: [el("label", { text: "Facility code" }), code] }),
        el("div", { className: "field", children: [el("label", { text: "Facility name" }), name] }),
        el("div", {
          className: "field",
          children: [
            el("label", { text: "API address" }),
            apiUrl,
            el("div", {
              className: "help",
              text: "Where the surveillance API lives. Used for signing in, uploading and syncing breakpoints.",
            }),
          ],
        }),
        el("div", {
          className: "field",
          children: [
            el("label", { text: "Web console address" }),
            webUrl,
            el("div", {
              className: "help",
              text: "Used by “Open web console”, which signs you into the browser as the same account with no second password.",
            }),
          ],
        }),
      ],
    }),
    button(
      "Save",
      async () => {
        const problem = apiUrl.value.trim() ? await api.apiUrlProblem(apiUrl.value) : null;
        if (problem) {
          toast(problem, "warn");
          return;
        }
        await api.saveSettings({
          facilityCode: code.value.trim() || null,
          facilityName: name.value.trim() || null,
          apiUrl: apiUrl.value.trim(),
          webUrl: webUrl.value.trim(),
        });
        await context.refresh();
        toast("Saved.");
      },
      "primary",
    ),
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
  const connectivitySeconds = textInput(String(settings.connectivity.pollSeconds), {
    type: "number",
  });
  const alertSeconds = textInput(String(settings.connectivity.alertIntervalSeconds), {
    type: "number",
  });
  const minimumIsolates = textInput(String(settings.analysis.minimumIsolates), { type: "number" });
  const graceDays = textInput(String(settings.offlineGraceDays), { type: "number" });

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
          children: [
            el("label", { text: "Check the connection every (seconds)" }),
            connectivitySeconds,
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
        el("div", {
          className: "field",
          children: [
            el("label", { text: "Allow offline sign-in for (days)" }),
            graceDays,
            el("div", {
              className: "help",
              text: "After this long without reaching the server, signing in requires a connection — so an account closed centrally cannot keep working here forever.",
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
            pollSeconds: Math.max(10, Number(connectivitySeconds.value) || 30),
            audibleAlert: (audible.querySelector("input") as HTMLInputElement).checked,
            alertIntervalSeconds: Math.max(15, Number(alertSeconds.value) || 60),
          },
          analysis: {
            firstIsolateOnly: (firstIsolate.querySelector("input") as HTMLInputElement).checked,
            minimumIsolates: Math.max(1, Number(minimumIsolates.value) || 30),
          },
          offlineGraceDays: Math.max(1, Number(graceDays.value) || 30),
        });
        await context.refresh();
        toast("Saved.");
      },
      "primary",
    ),
  );
}

function breakpointsPanel(context: ViewContext): HTMLElement {
  const breakpoints = context.status.workspace.breakpoints;
  const coverage = context.status.workspace.coverage;

  return card(
    "Breakpoint table",
    "No breakpoint values ship with AMRSS: the tables are copyrighted and revised every edition, and a mistyped threshold turns an R into an S. The table here is your laboratory's own — synced from the platform, or imported from the same template CSV the platform imports.",
    definitionList([
      ["Loaded", breakpoints.loaded ? "yes" : "no"],
      ["Edition", breakpoints.label ?? breakpoints.version ?? "—"],
      ["Criteria", count(breakpoints.criteria)],
      ["Source", breakpoints.source === "platform" ? "synced from the platform" : breakpoints.source],
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
        button("Import a CSV", async () => {
          const result = await api.importBreakpoints();
          toast(result.message, result.ok ? "ok" : "warn");
          await context.refresh();
        }),
      ],
    }),
    coverage && coverage.uncovered.length > 0
      ? card(
          "Combinations this table does not cover",
          "Most frequent first — the next import is worth prioritising by impact rather than alphabetically.",
          table(
            [
              { label: "Organism / agent / method", value: (row) => row.combination },
              { label: "Results", value: (row) => count(row.measurements), numeric: true },
            ],
            coverage.uncovered.slice(0, 25),
          ),
        )
      : null,
  );
}

async function mappingPanel(context: ViewContext): Promise<HTMLElement> {
  const mappings = await api.mappings();
  const entity = el("div");

  const rows: Array<{ entity: string; from: string; to: string }> = [
    ...Object.entries(mappings.organism).map(([from, to]) => ({ entity: "organism", from, to })),
    ...Object.entries(mappings.specimen).map(([from, to]) => ({ entity: "specimen", from, to })),
    ...Object.entries(mappings.antibiotic).map(([from, to]) => ({ entity: "antibiotic", from, to })),
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

  entity.append(
    el("div", {
      className: "inline-fields",
      children: [
        el("div", { className: "field", children: [el("label", { text: "Kind" }), kind] }),
        el("div", { className: "field", children: [el("label", { text: "Local code" }), from] }),
        el("div", {
          className: "field",
          children: [el("label", { text: "AMRSS code" }), to],
        }),
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
  );

  return card(
    "Code mapping",
    "When your WHONET configuration uses a code the AMRSS dictionary does not hold, map it here once. The mapping applies to every row in the file, and to everything entered afterwards — it is a statement about your configuration, not about one specimen.",
    entity,
    table(
      [
        { label: "Kind", value: (row) => row.entity },
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
  );
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
