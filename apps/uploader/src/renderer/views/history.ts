/**
 * Upload history.
 *
 * The log is hash-chained, so an entry that has been edited or removed shows up
 * as a broken chain rather than as a tidy list. That is not tamper-proofing — a
 * determined local administrator can rewrite the whole chain — but it is
 * tamper-evidence, which is what a facility needs to be able to say honestly
 * what it submitted and when.
 */

import { api, type UploadLogEntry } from "../api.js";
import type { ViewContext } from "../app.js";
import {
  badge,
  button,
  card,
  count,
  dateTime,
  el,
  notice,
  relativeTime,
  stat,
  statRow,
  table,
  toast,
} from "../ui.js";

export async function renderHistory(host: HTMLElement, context: ViewContext): Promise<void> {
  const settings = await api.settings();
  const status = context.status;
  const log = [...settings.log].reverse();

  host.replaceChildren(
    el("div", {
      className: "page-head",
      children: [
        el("div", {
          children: [
            el("h2", { text: "Upload history" }),
            el("p", {
              text: "Every batch this computer has sent, in order, with what the platform said about it.",
            }),
          ],
        }),
        el("div", {
          className: "page-actions",
          children: [
            button("Download history", async () => {
              const result = await api.exportHistory();
              toast(result.message, result.ok ? "ok" : "warn");
            }),
          ],
        }),
      ],
    }),
  );

  if (!status.logIntegrity.valid) {
    host.append(
      notice(
        "bad",
        `The log has been altered at entry ${status.logIntegrity.firstBrokenIndex + 1}. Report this to your regional Data Steward before submitting anything further.`,
      ),
    );
  }

  const accepted = log.filter((entry) => entry.status !== "failed");
  host.append(
    statRow(
      stat("Batches sent", count(log.length)),
      stat("Records submitted", count(accepted.reduce((sum, entry) => sum + entry.recordCount, 0))),
      stat("Last upload", relativeTime(status.lastSyncAt)),
      stat(
        "Next due",
        status.daysUntilDue === null
          ? "—"
          : status.daysUntilDue < 0
            ? `${Math.abs(status.daysUntilDue)} day(s) overdue`
            : `in ${status.daysUntilDue} day(s)`,
        status.schedule.description,
      ),
    ),
  );

  host.append(
    card(
      "Batches",
      undefined,
      table<UploadLogEntry>(
        [
          { label: "Sent", value: (entry) => dateTime(entry.timestamp) },
          { label: "Records", value: (entry) => count(entry.recordCount), numeric: true },
          {
            label: "Coverage",
            value: (entry) => `${entry.coverageStart} – ${entry.coverageEnd}`,
          },
          {
            label: "Status",
            value: (entry) =>
              badge(
                entry.status === "failed" ? "bad" : entry.status === "qc_hold" ? "warn" : "ok",
                entry.status.replaceAll("_", " "),
              ),
          },
          { label: "Trigger", value: (entry) => entry.trigger ?? "manual" },
          { label: "Message", value: (entry) => entry.message },
          {
            label: "Checksum",
            value: (entry) => entry.checksum.slice(0, 12),
            title: "SHA-256 of the compressed batch",
          },
        ],
        log,
        "Nothing has been uploaded from this computer yet.",
      ),
    ),
  );
}
