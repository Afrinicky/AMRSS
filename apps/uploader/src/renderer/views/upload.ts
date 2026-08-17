/**
 * Upload — the one screen where data leaves the building.
 *
 * Two things are stated plainly here every time, because they are what a
 * facility is agreeing to. First, what is in the batch: counts, coverage,
 * checksum, nothing else. Second, what is *not* in it: no name, no hospital
 * number, no date of birth, no ward. The record that travels is assembled field
 * by field from an allow-list, so an identifier has nowhere to go — and pressing
 * send is the facility's consent to contribute what is listed.
 */

import { api } from "../api.js";
import type { ViewContext } from "../app.js";
import {
  button,
  bytes,
  card,
  count,
  definitionList,
  el,
  notice,
  relativeTime,
  toast,
} from "../ui.js";

export async function renderUpload(host: HTMLElement, context: ViewContext): Promise<void> {
  const status = context.status;

  host.replaceChildren(
    el("div", {
      className: "page-head",
      children: [
        el("div", {
          children: [
            el("h2", { text: "Upload" }),
            el("p", {
              text: "Prepare a batch, review exactly what it contains, and send it to the surveillance platform.",
            }),
          ],
        }),
        el("div", {
          className: "page-actions",
          children: [
            button("Open web console", async () => {
              const result = await api.openWebConsole();
              toast(result.message, result.ok ? "ok" : "warn");
            }),
          ],
        }),
      ],
    }),
  );

  const gate = status.gate;
  host.append(
    card(
      "Status",
      undefined,
      definitionList([
        ["Facility", status.facility.code ?? "not set"],
        ["Server", status.apiUrl || "not set"],
        [
          "Connection",
          status.connectivity.online
            ? `online${status.connectivity.latencyMs ? ` · ${status.connectivity.latencyMs} ms` : ""}`
            : `offline — ${status.connectivity.detail}`,
        ],
        [
          "Signed in",
          status.session
            ? `${status.session.fullName} (${status.session.mode})`
            : "no",
        ],
        ["Schedule", status.schedule.description],
        [
          "Next automatic run",
          status.schedule.nextRunAt
            ? new Date(status.schedule.nextRunAt).toLocaleString()
            : "not scheduled",
        ],
        ["Last upload", relativeTime(status.lastSyncAt)],
        [
          "Records ready",
          count(status.workspace.validation?.recordsReady ?? status.workspace.recordCount),
        ],
      ]),
      gate.allowed
        ? notice("ok", "Everything needed to send is in place.")
        : notice("warn", gate.reason ?? "Not ready to send."),
    ),
  );

  const summaryHost = el("div");
  const resultHost = el("div");

  const sendButton = button(
    "Confirm and send",
    async () => {
      sendButton.disabled = true;
      const result = await api.sendUpload();
      sendButton.disabled = false;

      resultHost.replaceChildren(
        notice(
          result.ok ? (result.batchStatus === "qc_hold" ? "warn" : "ok") : "bad",
          result.message,
        ),
      );

      if (result.findings?.length) {
        const list = el("ul");
        for (const finding of result.findings) {
          list.append(
            el("li", {
              text: `${finding.severity.toUpperCase()} · ${finding.code}: ${finding.message}`,
            }),
          );
        }
        resultHost.append(list);
      }

      await context.refresh();
    },
    "primary",
    { disabled: true },
  );

  const prepareButton = button(
    "Prepare batch",
    async () => {
      summaryHost.replaceChildren(el("div", { className: "empty", text: "Preparing…" }));
      const prepared = await api.prepareUpload();

      if (!prepared.ok || !prepared.summary) {
        summaryHost.replaceChildren(
          notice("warn", prepared.message ?? "There is nothing new to send."),
        );
        sendButton.disabled = true;
        return;
      }

      const summary = prepared.summary;
      summaryHost.replaceChildren(
        definitionList([
          ["Isolates to send", count(summary.isolateCount)],
          ["Already accepted, skipped", count(summary.skippedAsAlreadySent)],
          ["Coverage period", `${summary.coverageStart} – ${summary.coverageEnd}`],
          ["Distinct organisms", count(summary.organismCount)],
          ["Susceptibility results", count(summary.resultCount)],
          ["QC attestation", summary.qcStatus],
          ["Compressed size", bytes(summary.compressedBytes)],
          ["Checksum", prepared.checksum ?? "—"],
        ]),
        notice(
          "info",
          "This batch contains no patient names, hospital numbers, dates of birth, wards or free-text comments. Each isolate carries an irreversible linkage key derived from a salt that never leaves this computer, so repeat isolates from one patient can be recognised without the patient being identifiable. Sending confirms your facility's agreement to contribute this de-identified data.",
        ),
      );

      sendButton.disabled = !prepared.gate.allowed;
      if (!prepared.gate.allowed) {
        summaryHost.append(notice("warn", prepared.gate.reason ?? "Not ready to send."));
      }
    },
    "primary",
  );

  host.append(
    card(
      "Prepare and review",
      "Only records that are not yet accepted and that passed validation are included. Nothing is transmitted until you confirm.",
      prepareButton,
      summaryHost,
      sendButton,
      resultHost,
    ),
  );

  if (!status.logIntegrity.valid) {
    host.append(
      notice(
        "bad",
        `The local upload log has been altered at entry ${status.logIntegrity.firstBrokenIndex + 1}. Report this to your regional Data Steward.`,
      ),
    );
  }
}
