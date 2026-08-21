/**
 * What laboratories have sent, and what is waiting on a decision.
 *
 * A data steward's day is mostly this screen: batches that arrived, quality
 * findings that held some of them, and facility codes nobody has yet mapped
 * into the canonical dictionary. All three are queues, and a queue is only
 * useful if it says what is blocked and on whom.
 *
 * The two halves are kept apart deliberately. A batch decision is about one
 * laboratory's submission; a mapping decision is about the dictionary every
 * laboratory shares, and approving one silently changes what the aggregates
 * mean for everybody. Reviewing them in the same list would blur that.
 */

import { api, type PlatformBatch, type PlatformMapping } from "../../api.js";
import type { ViewContext } from "../../app.js";
import {
  badge,
  button,
  count,
  el,
  empty,
  field,
  modal,
  notice,
  relativeTime,
  select,
  subtabs,
  table,
  textInput,
  toast,
} from "../../ui.js";

type Tab = "batches" | "mappings";
let tab: Tab = "batches";
let batchFilter = "";

export async function renderSubmissions(host: HTMLElement, context: ViewContext): Promise<void> {
  const redraw = (): void => void renderSubmissions(host, context);

  host.replaceChildren(
    el("div", {
      className: "page-head",
      children: [
        el("div", {
          children: [
            el("h2", { text: "Submissions" }),
            el("p", { text: "What laboratories have sent, and what is waiting on your decision." }),
          ],
        }),
      ],
    }),
    subtabs(
      [
        { value: "batches", label: "Batches" },
        { value: "mappings", label: "Code mappings" },
      ],
      tab,
      (value) => {
        tab = value as Tab;
        redraw();
      },
    ),
    el("div", { className: "loading", text: "Loading…" }),
  );

  const body = host.lastElementChild!;
  if (tab === "batches") await drawBatches(body as HTMLElement, redraw);
  else await drawMappings(body as HTMLElement, redraw);
}

/* --- Batches -------------------------------------------------------------- */

const BATCH_STATES = [
  { value: "", label: "Every batch" },
  { value: "qc_hold", label: "Held for review" },
  { value: "staged", label: "Staged" },
  { value: "accepted", label: "Accepted" },
  { value: "quarantined", label: "Quarantined" },
  { value: "retracted", label: "Retracted" },
  { value: "rejected", label: "Rejected" },
];

async function drawBatches(host: HTMLElement, redraw: () => void): Promise<void> {
  const result = await api.platformBatches({ status: batchFilter || null });
  host.className = "";
  host.replaceChildren();

  if (!result.ok) {
    host.append(notice("bad", result.message));
    return;
  }

  const batches = result.data ?? [];
  const held = batches.filter((batch) => batch.status === "qc_hold").length;

  host.append(
    el("div", {
      className: "list-toolbar",
      children: [
        held > 0
          ? el("div", {
              className: "small",
              text: `${held} batch${held === 1 ? "" : "es"} waiting on a review decision.`,
            })
          : el("div", { className: "small muted", text: "Nothing is waiting on a decision." }),
        el("div", { className: "topbar-spacer" }),
        el("div", {
          className: "field inline",
          children: [
            select(BATCH_STATES, batchFilter, (value) => {
              batchFilter = value;
              redraw();
            }),
          ],
        }),
      ],
    }),
  );

  if (batches.length === 0) {
    host.append(empty("No batches match that."));
    return;
  }

  host.append(
    table<PlatformBatch>(
      [
        {
          label: "Facility",
          sticky: true,
          value: (batch) =>
            el("div", {
              className: "cell-stack",
              children: [
                el("span", { className: "cell-title", text: batch.facilityCode }),
                el("span", { className: "cell-sub", text: relativeTime(batch.uploadedAt) }),
              ],
            }),
        },
        {
          label: "Status",
          value: (batch) =>
            badge(
              batch.status === "accepted"
                ? "ok"
                : batch.status === "qc_hold"
                  ? "warn"
                  : batch.status === "staged"
                    ? ""
                    : "bad",
              batch.status.replaceAll("_", " "),
            ),
        },
        { label: "Isolates", numeric: true, value: (batch) => count(batch.isolateCount) },
        {
          label: "Covering",
          value: (batch) =>
            batch.coverageStart && batch.coverageEnd
              ? `${batch.coverageStart} → ${batch.coverageEnd}`
              : "—",
        },
        {
          label: "Findings",
          numeric: true,
          value: (batch) =>
            batch.findingCount > 0
              ? el("span", { className: "badge warn", text: String(batch.findingCount) })
              : "—",
        },
        {
          label: "",
          value: (batch) =>
            batch.availableTransitions.length > 0
              ? button("Decide…", () => openBatchDecision(batch, redraw), "ghost", { small: true })
              : el("span", { className: "small muted", text: "settled" }),
        },
      ],
      batches,
    ),
  );
}

function openBatchDecision(batch: PlatformBatch, redraw: () => void): void {
  let target = batch.availableTransitions[0] ?? "";
  const reason = textInput("", { placeholder: "what you checked, and what you concluded" });
  const problems = el("div");

  const close = modal(
    `${batch.facilityCode} — ${relativeTime(batch.uploadedAt)}`,
    el("div", {
      children: [
        batch.findingCount > 0
          ? notice(
              "warn",
              `${batch.findingCount} quality finding${batch.findingCount === 1 ? "" : "s"} on this `
                + "batch. Read them in the web console before accepting: accepting is what puts "
                + "these isolates into the regional antibiogram.",
            )
          : null,
        el("p", {
          className: "small muted",
          text: `${count(batch.isolateCount)} isolates`
            + (batch.coverageStart ? `, covering ${batch.coverageStart} to ${batch.coverageEnd}.` : "."),
        }),
        field(
          "Decision",
          select(
            batch.availableTransitions.map((value) => ({
              value,
              label: value.replaceAll("_", " "),
            })),
            target,
            (value) => {
              target = value;
            },
          ),
        ),
        field("Reason", reason, "Recorded against the batch, with your name."),
        problems,
      ].filter(Boolean) as Node[],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      button(
        "Record the decision",
        async () => {
          problems.replaceChildren();
          const result = await api.platformTransitionBatch({
            batchId: batch.id,
            target,
            reason: reason.value.trim(),
          });
          if (!result.ok) {
            problems.replaceChildren(notice("bad", result.message));
            return;
          }
          close();
          toast(result.message, "ok");
          redraw();
        },
        "primary",
      ),
    ],
  );
}

/* --- Mappings ------------------------------------------------------------- */

async function drawMappings(host: HTMLElement, redraw: () => void): Promise<void> {
  const result = await api.platformMappings({ status: "proposed" });
  host.className = "";
  host.replaceChildren();

  if (!result.ok) {
    host.append(notice("bad", result.message));
    return;
  }

  const mappings = result.data ?? [];
  host.append(
    notice(
      "info",
      "A facility's own organism, antibiotic and specimen codes have to be matched to the "
        + "canonical dictionary before its data can be counted alongside anybody else's. Until a "
        + "mapping is approved, records carrying that code contribute nothing to the aggregates.",
    ),
  );

  if (mappings.length === 0) {
    host.append(empty("No mappings are waiting for review."));
    return;
  }

  host.append(
    table<PlatformMapping>(
      [
        { label: "Facility", sticky: true, value: (mapping) => mapping.facilityCode },
        { label: "Kind", value: (mapping) => mapping.entityType.replaceAll("_", " ") },
        {
          label: "Their code",
          value: (mapping) => el("code", { text: mapping.sourceCode }),
        },
        { label: "Proposed match", value: (mapping) => mapping.proposedName ?? "unmatched" },
        {
          label: "Seen on",
          numeric: true,
          value: (mapping) => `${count(mapping.observedCount)} records`,
        },
        {
          label: "",
          value: (mapping) =>
            el("div", {
              className: "row-actions",
              children: [
                button(
                  "Approve",
                  () => openMappingReview(mapping, true, redraw),
                  "ghost",
                  { small: true },
                ),
                button(
                  "Reject",
                  () => openMappingReview(mapping, false, redraw),
                  "ghost",
                  { small: true },
                ),
              ],
            }),
        },
      ],
      mappings,
    ),
  );
}

function openMappingReview(mapping: PlatformMapping, approve: boolean, redraw: () => void): void {
  const note = textInput("", { placeholder: "optional note" });
  const problems = el("div");

  const close = modal(
    approve ? "Approve this mapping" : "Reject this mapping",
    el("div", {
      children: [
        el("p", {
          text: `${mapping.facilityCode} sends “${mapping.sourceCode}”`
            + (mapping.proposedName ? `, proposed as ${mapping.proposedName}.` : ", unmatched."),
        }),
        approve
          ? notice(
              "warn",
              `Approving brings ${count(mapping.observedCount)} records into the aggregates under `
                + "that match. A wrong match does not fail — it quietly counts one organism as "
                + "another.",
            )
          : null,
        field("Note", note),
        problems,
      ].filter(Boolean) as Node[],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      button(
        approve ? "Approve" : "Reject",
        async () => {
          problems.replaceChildren();
          const result = await api.platformReviewMapping({
            mappingId: mapping.id,
            approve,
            note: note.value.trim(),
          });
          if (!result.ok) {
            problems.replaceChildren(notice("bad", result.message));
            return;
          }
          close();
          toast(result.message, "ok");
          redraw();
        },
        "primary",
      ),
    ],
  );
}
