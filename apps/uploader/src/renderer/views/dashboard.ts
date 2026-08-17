/**
 * The dashboard: what this laboratory's data currently says.
 *
 * Everything here is computed on this machine from the WHONET file as it stands
 * right now, and it is the same arithmetic the platform applies to the same
 * records — first isolate per patient per organism, percentages over
 * interpretable results only. A facility filtering the regional dashboard to
 * itself should see these numbers. If it does not, one of the two is wrong, and
 * that is worth knowing before anyone builds a report on it.
 */

import { api, type Status } from "../api.js";
import type { ViewContext } from "../app.js";
import {
  barList,
  button,
  card,
  count,
  definitionList,
  donut,
  el,
  empty,
  lineChart,
  notice,
  percent,
  relativeTime,
  stat,
  statRow,
  table,
  toast,
} from "../ui.js";

export async function renderDashboard(host: HTMLElement, context: ViewContext): Promise<void> {
  const status = context.status;
  host.replaceChildren(
    el("div", {
      className: "page-head",
      children: [
        el("div", {
          children: [
            el("h2", { text: "Dashboard" }),
            el("p", {
              text: "Your laboratory's own surveillance picture, computed here from your WHONET file. Nothing on this screen has been sent anywhere.",
            }),
          ],
        }),
        el("div", {
          className: "page-actions",
          children: [
            button("Reload from WHONET", async () => {
              await api.reload();
              await context.refresh();
              toast("Reloaded from the WHONET file.");
            }),
            button("Download analysis", async () => {
              const result = await api.exportAnalytics({});
              toast(result.message, result.ok ? "ok" : "warn");
            }, "primary"),
          ],
        }),
      ],
    }),
  );

  if (!status.setupComplete) {
    host.append(
      notice(
        "warn",
        "Setup is not finished. Choose your WHONET database and enter your facility code in Settings — after that, uploading is one button.",
      ),
      button("Go to Settings", () => context.navigate("settings"), "primary"),
    );
    return;
  }

  if (status.workspace.problem) {
    host.append(notice("bad", status.workspace.problem));
    return;
  }

  const loading = el("div", { className: "empty", text: "Reading your data…" });
  host.append(loading);

  const overview = await api.overview({});
  loading.remove();

  const summary = overview.summary;

  host.append(
    statRow(
      stat("Isolates", count(summary.isolates), `${count(summary.patients)} patients`),
      stat(
        "First isolates",
        count(summary.firstIsolates),
        "one per patient per organism — the surveillance denominator",
      ),
      stat("Organisms", count(summary.organisms), `${count(summary.antibiotics)} antimicrobials`),
      stat(
        "Susceptibility results",
        count(summary.results),
        `${percent(summary.coveragePercent, 0)} interpretable`,
      ),
      stat(
        "Resistant",
        percent(summary.resistantPercent),
        `across ${count(summary.interpretable)} interpretable results`,
      ),
      stat(
        "Coverage",
        summary.coverageStart
          ? `${summary.coverageStart} → ${summary.coverageEnd}`
          : "—",
        `read ${relativeTime(status.workspace.readAt)}`,
      ),
    ),
  );

  host.append(readinessCard(status, context));

  if (summary.pending > 0) {
    host.append(
      notice(
        "warn",
        `${count(summary.pending)} measurements are waiting for a breakpoint table before they can be counted as susceptible or resistant. ` +
          (status.workspace.breakpoints.loaded
            ? "The loaded table does not cover these organism and agent combinations."
            : "No breakpoint table is loaded — sync it from the platform in Settings."),
      ),
    );
  }

  const left = el("div");
  const right = el("div");

  left.append(
    card(
      "Most frequent organisms",
      "First isolate per patient per organism.",
      barList(
        summary.topOrganisms.map((row) => ({
          label: row.label,
          count: row.count,
          percent: row.percent,
        })),
      ),
    ),
    card(
      "Isolates over time",
      "Specimen volume by month, with the patients behind it.",
      summary.monthlyVolume.length > 1
        ? lineChart(
            [
              {
                name: "Isolates",
                points: summary.monthlyVolume.map((point) => ({
                  label: point.bucket,
                  value: point.isolates,
                })),
              },
              {
                name: "Patients",
                points: summary.monthlyVolume.map((point) => ({
                  label: point.bucket,
                  value: point.patients,
                })),
                color: "var(--series-4)",
              },
            ],
            { height: 240 },
          )
        : empty("At least two months of dated specimens are needed to draw a trend."),
    ),
  );

  right.append(
    card(
      "Sites of infection",
      "Where the specimens came from.",
      donut(
        summary.topSites.slice(0, 6).map((row) => ({ label: row.label, value: row.count })),
        `${count(summary.isolates)}`,
      ),
    ),
    card(
      "Resistance markers",
      "Screening indicators derived from reported categories. Each needs laboratory confirmation before it is reported as a phenotype.",
      table(
        [
          { label: "Marker", value: (row) => row.label, title: "Phenotype" },
          { label: "Isolates", value: (row) => count(row.isolates), numeric: true },
          { label: "Of tested", value: (row) => count(row.eligible), numeric: true },
          {
            label: "%",
            value: (row) => percent(row.percent),
            numeric: true,
          },
        ],
        summary.phenotypes.filter((row) => row.eligible > 0),
        "No isolate in this file was tested against the agents these markers depend on.",
      ),
    ),
  );

  host.append(el("div", { className: "grid-2", children: [left, right] }));

  host.append(
    card(
      "Where this data stands",
      undefined,
      definitionList([
        ["WHONET file", status.workspace.path],
        ["Last read", relativeTime(status.workspace.readAt)],
        ["Isolates included", count(status.workspace.recordCount)],
        [
          "Rows excluded",
          `${count(status.workspace.excludedCount)} — ${describeExclusions(status)}`,
        ],
        ["Corrections applied here", count(status.workspace.correctionCount)],
        [
          "Breakpoint table",
          status.workspace.breakpoints.loaded
            ? `${status.workspace.breakpoints.label ?? status.workspace.breakpoints.version} (${status.workspace.breakpoints.criteria} criteria)`
            : "none loaded — measurements stay pending",
        ],
        ["Last upload", relativeTime(status.lastSyncAt)],
      ]),
    ),
  );
}

function describeExclusions(status: Status): string {
  const reasons = status.workspace.excludedByReason;
  const parts: string[] = [];
  if (reasons.no_organism) parts.push(`${reasons.no_organism} with no organism isolated`);
  if (reasons.no_results) parts.push(`${reasons.no_results} with no susceptibility results`);
  if (reasons.excluded_by_facility) {
    parts.push(`${reasons.excluded_by_facility} held out by this facility`);
  }
  return parts.length > 0 ? parts.join(", ") : "none";
}

function readinessCard(status: Status, context: ViewContext): HTMLElement {
  const validation = status.workspace.validation;
  const body = el("div");

  if (!validation) {
    body.append(empty("No validation has run yet."));
  } else if (validation.blocking > 0) {
    body.append(
      notice(
        "bad",
        `${validation.blocking} finding(s) across ${validation.blockedRowKeys.length} record(s) must be fixed before those records can be uploaded. The rest of the batch is unaffected.`,
      ),
      button("Open validation", () => context.navigate("validation"), "primary"),
    );
  } else if (!status.approvalCurrent && status.schedule.requireValidatedSignOff) {
    body.append(
      notice(
        "warn",
        "Nothing is blocking the upload, but the data has changed since it was last approved. Review and approve it before sending.",
      ),
      button("Review and approve", () => context.navigate("validation"), "primary"),
    );
  } else {
    body.append(
      notice(
        "ok",
        `${count(validation.recordsReady)} record(s) are ready to send. ${
          status.gate.allowed
            ? "You can upload now."
            : (status.gate.reason ?? "")
        }`,
      ),
      button("Go to upload", () => context.navigate("upload"), "primary"),
    );
  }

  if (validation && validation.advisory > 0) {
    body.append(
      el("p", {
        className: "small muted",
        text: `${validation.advisory} advisory finding(s) — missing age, sex or care setting, duplicates and similar. These upload as recorded and do not hold anything back.`,
      }),
    );
  }

  return card("Ready to upload?", undefined, body);
}
