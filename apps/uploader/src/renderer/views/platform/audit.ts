/**
 * The audit trail.
 *
 * Append-only and hash-chained at the database: updates, deletes and truncates
 * are rejected by triggers rather than by convention, and `amrss verify-audit`
 * detects any edit, deletion or reordering after the fact. This screen reads
 * it; nothing in the application can write to it except by doing the thing
 * being recorded.
 *
 * What it is for is answering "who did this, and when" about the decisions that
 * change what the platform means — a role granted, a facility suspended, a
 * breakpoint table published, an override permitted. Those are the entries
 * worth reading, so the filter offers them by name rather than as a free-text
 * box over an action vocabulary nobody has memorised.
 */

import { api, type AuditEntry } from "../../api.js";
import type { ViewContext } from "../../app.js";
import { el, empty, notice, relativeTime, select, table } from "../../ui.js";

let action = "";

const NOTABLE_ACTIONS = [
  { value: "", label: "Everything" },
  { value: "permission_changed", label: "Roles and permissions" },
  { value: "user_created", label: "Accounts created" },
  { value: "user_deactivated", label: "Accounts deactivated" },
  { value: "user_deleted", label: "Accounts deleted" },
  { value: "block_created", label: "Regions created" },
  { value: "facility_enrolled", label: "Facilities enrolled" },
  { value: "facility_status_changed", label: "Facility status changes" },
  { value: "breakpoints_imported", label: "Breakpoint tables" },
  { value: "batch_status_changed", label: "Batch decisions" },
  { value: "results_interpreted", label: "Interpretation runs" },
];

export async function renderAudit(host: HTMLElement, context: ViewContext): Promise<void> {
  const redraw = (): void => void renderAudit(host, context);

  host.replaceChildren(
    el("div", {
      className: "page-head",
      children: [
        el("div", {
          children: [
            el("h2", { text: "Audit trail" }),
            el("p", {
              text: "Append-only and hash-chained. Nothing here can be edited or removed, "
                + "including by the account reading it.",
            }),
          ],
        }),
        el("div", {
          className: "page-actions",
          children: [
            el("div", {
              className: "field inline",
              children: [
                select(NOTABLE_ACTIONS, action, (value) => {
                  action = value;
                  redraw();
                }),
              ],
            }),
          ],
        }),
      ],
    }),
    el("div", { className: "loading", text: "Reading the trail…" }),
  );

  const result = await api.platformAudit({ action: action || null, limit: 200 });
  host.lastElementChild!.remove();

  if (!result.ok) {
    host.append(notice("bad", result.message));
    return;
  }

  const entries = result.data?.entries ?? [];
  if (entries.length === 0) {
    host.append(empty("Nothing recorded under that filter."));
    return;
  }

  host.append(
    el("p", {
      className: "small muted",
      text: `Showing ${entries.length} of ${result.data!.total} entries, most recent first.`,
    }),
    table<AuditEntry>(
      [
        {
          label: "When",
          sticky: true,
          value: (entry) =>
            el("div", {
              className: "cell-stack",
              children: [
                el("span", { className: "cell-title", text: relativeTime(entry.recordedAt) }),
                el("span", { className: "cell-sub", text: entry.recordedAt.slice(0, 19).replace("T", " ") }),
              ],
            }),
        },
        { label: "Who", value: (entry) => entry.actor },
        { label: "Did", value: (entry) => entry.action.replaceAll("_", " ") },
        {
          label: "To",
          value: (entry) =>
            el("div", {
              className: "cell-stack",
              children: [
                el("span", { text: entry.entity.replaceAll("_", " ") }),
                entry.entityId
                  ? el("span", { className: "cell-sub mono", text: entry.entityId.slice(0, 8) })
                  : null,
              ].filter(Boolean) as Node[],
            }),
        },
        { label: "Note", value: (entry) => entry.note ?? "—" },
        { label: "From", value: (entry) => entry.sourceIp ?? "—" },
      ],
      entries,
    ),
  );
}
