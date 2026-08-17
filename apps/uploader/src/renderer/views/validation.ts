/**
 * Validation — the queue that has to be empty before data leaves the building.
 *
 * The findings are split in two, and the split is the point. *Must fix* means
 * the record cannot be interpreted at all — no site of collection, no date, an
 * organism code nothing recognises — and those records are held back until
 * somebody deals with them. *Advisory* means the record is poorer but real: an
 * age nobody wrote down is a genuine gap in a genuine laboratory, and refusing
 * the batch over it would teach people to invent ages.
 *
 * Approval sits at the bottom because it is the last thing done here: a person
 * saying the data is fit to send, recorded against a fingerprint of the data, so
 * that it lapses the moment WHONET writes another result.
 */

import { api, type ValidationIssue, type ValidationReport } from "../api.js";
import type { ViewContext } from "../app.js";
import {
  badge,
  button,
  card,
  count,
  el,
  empty,
  notice,
  segmented,
  stat,
  statRow,
  table,
  toast,
} from "../ui.js";
import { openRowEditor } from "./row-editor.js";

let filter: "blocking" | "advisory" | "all" = "blocking";

export async function renderValidation(host: HTMLElement, context: ViewContext): Promise<void> {
  host.replaceChildren(
    el("div", {
      className: "page-head",
      children: [
        el("div", {
          children: [
            el("h2", { text: "Validation" }),
            el("p", {
              text: "Every record is checked before it can be uploaded. Fix what is missing here — corrections are stored in AMRSS and your WHONET file is never modified.",
            }),
          ],
        }),
        el("div", {
          className: "page-actions",
          children: [
            button("Download findings", async () => {
              const result = await api.exportValidation();
              toast(result.message, result.ok ? "ok" : "warn");
            }),
            button("Re-check now", async () => {
              await api.reload();
              await context.refresh();
              toast("Re-checked against the current file.");
            }, "primary"),
          ],
        }),
      ],
    }),
  );

  const report = await api.validationReport();
  if (!report) {
    host.append(empty("No WHONET data has been read yet. Choose your file in Settings."));
    return;
  }

  host.append(
    statRow(
      stat("Records examined", count(report.recordsExamined)),
      stat("Ready to upload", count(report.recordsReady), "records with nothing blocking them"),
      stat(
        "Must fix",
        count(report.blocking),
        `${report.blockedRowKeys.length} record(s) held back`,
      ),
      stat("Advisory", count(report.advisory), "uploads as recorded"),
    ),
  );

  host.append(approvalCard(report, context));

  host.append(
    card(
      "Findings by type",
      "Fix the most common first: one mapping or one habit usually clears a whole row of this table.",
      table(
        [
          {
            label: "Finding",
            value: (row) =>
              el("span", {
                children: [
                  badge(row.severity === "blocking" ? "bad" : "warn", row.severity === "blocking" ? "Must fix" : "Advisory"),
                  document.createTextNode(` ${humanise(row.code)}`),
                ],
              }),
          },
          { label: "Findings", value: (row) => count(row.count), numeric: true },
          { label: "Records", value: (row) => count(row.rows), numeric: true },
        ],
        report.byCode,
        "Nothing to report — every record passed.",
      ),
    ),
  );

  const listHost = el("div");
  host.append(
    card(
      "Records to review",
      "Click a row to open the record, apply a suggested value, or hold it out of the upload.",
      el("div", {
        className: "toolbar",
        children: [
          segmented(
            [
              { value: "blocking", label: `Must fix (${report.blocking})` },
              { value: "advisory", label: `Advisory (${report.advisory})` },
              { value: "all", label: "All" },
            ],
            filter,
            (value) => {
              filter = value as typeof filter;
              renderList();
            },
          ),
        ],
      }),
      listHost,
    ),
  );

  renderList();

  function renderList(): void {
    const issues = report!.issues.filter((issue) =>
      filter === "all" ? true : issue.severity === filter,
    );

    listHost.replaceChildren(
      table<ValidationIssue>(
        [
          {
            label: "Row",
            value: (issue) =>
              button(
                String(issue.rowIndex),
                () => openRowEditor(issue.rowKey, context),
                "ghost",
                { small: true },
              ),
            numeric: true,
          },
          {
            label: "Finding",
            value: (issue) => humanise(issue.code),
          },
          { label: "What is wrong", value: (issue) => issue.message },
          { label: "Current value", value: (issue) => issue.currentValue },
          {
            label: "Suggested fix",
            value: (issue) => {
              if (!issue.suggestion || !issue.field) return "—";
              return button(
                `Use ${issue.suggestion.value}`,
                async () => {
                  await api.correct({
                    rowKey: issue.rowKey,
                    field: issue.field!,
                    value: issue.suggestion!.value,
                  });
                  toast(`Row ${issue.rowIndex} corrected. The WHONET file is unchanged.`);
                  await context.refresh();
                },
                "ghost",
                { small: true, title: issue.suggestion.rationale },
              );
            },
          },
        ],
        issues.slice(0, 400),
        filter === "blocking"
          ? "Nothing is blocking this upload."
          : "No findings of this kind.",
      ),
    );

    if (issues.length > 400) {
      listHost.append(
        el("p", {
          className: "small muted",
          text: `Showing the first 400 of ${count(issues.length)} findings. Download the workbook for the full list.`,
        }),
      );
    }
  }
}

function approvalCard(report: ValidationReport, context: ViewContext): HTMLElement {
  const status = context.status;
  const body = el("div");

  if (report.blocking > 0) {
    body.append(
      notice(
        "bad",
        `${report.blocking} finding(s) must be fixed before the data can be approved. Those ${report.blockedRowKeys.length} record(s) stay at the laboratory; the remaining ${report.recordsReady} can be uploaded once approved.`,
      ),
    );
  } else if (status.approvalCurrent && status.approval) {
    body.append(
      notice(
        "ok",
        `Approved by ${status.approval.approvedBy ?? "a user of this computer"} on ${new Date(
          status.approval.approvedAt,
        ).toLocaleString()}, covering ${count(status.approval.recordCount)} record(s). This approval lapses automatically as soon as WHONET writes another result.`,
      ),
    );
  } else {
    body.append(
      notice(
        "warn",
        status.approval
          ? "The data has changed since it was last approved. Review it and approve again."
          : "Nothing is blocking the upload. Approve the data to release it for sending.",
      ),
    );
  }

  body.append(
    button(
      "Approve this data for upload",
      async () => {
        const result = await api.approve();
        toast(result.message, result.ok ? "ok" : "warn");
        await context.refresh();
      },
      "primary",
      { disabled: report.blocking > 0 || status.approvalCurrent },
    ),
  );

  return card(
    "Approval",
    "An automatic upload will not send data nobody has approved since it last changed. You can turn that requirement off in Settings, but it is the safeguard that stops a schedule firing in the middle of data entry.",
    body,
  );
}

function humanise(code: string): string {
  return code.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}
