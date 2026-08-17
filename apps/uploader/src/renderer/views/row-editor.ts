/**
 * Correcting one record.
 *
 * The gap the validation queue found is fixed here, next to the row it belongs
 * to, by the person who has the request form in front of them. Two properties
 * matter and are stated on the panel itself:
 *
 * - **The WHONET file is not modified.** WHONET owns it, may be writing to it at
 *   this moment, and a surveillance client editing a laboratory's primary record
 *   is not a thing this software will do. The correction is stored beside the
 *   file and applied on every read.
 * - **The original is kept.** Every correction shows what the file said, so the
 *   change is reviewable and can be undone.
 */

import { api } from "../api.js";
import type { ViewContext } from "../app.js";
import { button, el, modal, notice, select, textInput, toast } from "../ui.js";

const FIELD_LABELS: Record<string, string> = {
  specimenDate: "Specimen date",
  specimenTypeCode: "Specimen type",
  organismCode: "Organism",
  sex: "Sex",
  ageYears: "Age (years)",
  careSettingRaw: "Ward type / care setting",
  patientIdentifier: "Identification number",
  specimenNumber: "Specimen number",
};

export async function openRowEditor(rowKey: string, context: ViewContext): Promise<void> {
  const detail = await api.record(rowKey);
  if (!detail) {
    toast("That row is no longer in the file.", "warn");
    return;
  }

  const body = el("div");
  const record = detail.record;

  body.append(
    el("p", {
      className: "small muted",
      text: `Row ${record.rowIndex} · ${record.organismName ?? record.organismCode ?? "no organism"} · ${
        record.specimenName ?? record.specimenTypeCode ?? "no specimen type"
      }`,
    }),
  );

  if (detail.issues.length > 0) {
    for (const issue of detail.issues) {
      body.append(notice(issue.severity === "blocking" ? "bad" : "warn", issue.message));
    }
  } else {
    body.append(notice("ok", "This record has no outstanding findings."));
  }

  const edits = new Map<string, string | null>();

  for (const field of Object.keys(FIELD_LABELS)) {
    const current = (record.values[field] ?? "") as string;
    const correction = detail.corrections[field];
    const suggestion = detail.issues.find(
      (issue) => issue.field === field && issue.suggestion,
    )?.suggestion;

    let input: HTMLElement;
    if (field === "sex") {
      input = select(
        [
          { value: "", label: "not recorded" },
          { value: "f", label: "female" },
          { value: "m", label: "male" },
        ],
        current,
        (value) => edits.set(field, value || null),
      );
    } else if (field === "careSettingRaw") {
      input = select(
        [
          { value: "", label: "not recorded" },
          { value: "in", label: "inpatient" },
          { value: "out", label: "outpatient" },
        ],
        current,
        (value) => edits.set(field, value || null),
      );
    } else if (field === "specimenTypeCode") {
      input = select(
        [
          { value: "", label: "not recorded" },
          ...detail.specimenOptions.map((option) => ({
            value: option.code,
            label: `${option.name} (${option.code})`,
          })),
        ],
        current,
        (value) => edits.set(field, value || null),
      );
    } else if (field === "organismCode") {
      input = select(
        [
          { value: "", label: "not recorded" },
          ...detail.organismOptions.map((option) => ({
            value: option.code,
            label: `${option.name} (${option.code})`,
          })),
        ],
        current,
        (value) => edits.set(field, value || null),
      );
    } else {
      input = textInput(current, {
        type: field === "specimenDate" ? "date" : field === "ageYears" ? "number" : "text",
        onInput: (value) => edits.set(field, value.trim() === "" ? null : value.trim()),
      });
    }

    const help: string[] = [];
    if (correction) {
      help.push(
        `Corrected here on ${new Date(correction.at).toLocaleDateString()}${
          correction.by ? ` by ${correction.by}` : ""
        }. The file says "${correction.originalValue ?? "(blank)"}".`,
      );
    }
    if (suggestion) help.push(`Suggested: ${suggestion.value} — ${suggestion.rationale}.`);

    const wrapper = el("div", {
      className: "field",
      children: [
        el("label", { text: FIELD_LABELS[field]! }),
        input,
        help.length > 0 ? el("div", { className: "help", text: help.join(" ") }) : null,
      ],
    });

    if (suggestion) {
      wrapper.append(
        button(
          `Use ${suggestion.value}`,
          async () => {
            await api.correct({ rowKey, field, value: suggestion.value });
            toast("Correction saved. The WHONET file is unchanged.");
            close();
            await context.refresh();
          },
          "ghost",
          { small: true },
        ),
      );
    }
    if (correction) {
      wrapper.append(
        button(
          "Undo correction",
          async () => {
            await api.clearCorrection({ rowKey, field });
            toast("Correction removed.");
            close();
            await context.refresh();
          },
          "ghost",
          { small: true },
        ),
      );
    }

    body.append(wrapper);
  }

  body.append(
    el("p", {
      className: "small muted",
      text: "Corrections are stored in AMRSS on this computer and applied every time the file is read. Your WHONET database is never written to.",
    }),
  );

  const close = modal(`Record ${record.rowIndex}`, body, [
    button(
      detail.excluded ? "Put back in the upload" : "Hold out of the upload",
      async () => {
        if (detail.excluded) await api.restoreRow({ rowKey });
        else {
          await api.excludeRow({
            rowKey,
            reason: "Excluded by the facility from the uploader",
          });
        }
        close();
        await context.refresh();
        toast(detail.excluded ? "Row restored." : "Row held out of the upload.");
      },
      "danger",
    ),
    button("Close", () => close()),
    button(
      "Save corrections",
      async () => {
        if (edits.size === 0) {
          close();
          return;
        }
        for (const [field, value] of edits) {
          await api.correct({ rowKey, field, value });
        }
        close();
        await context.refresh();
        toast(`${edits.size} correction(s) saved. The WHONET file is unchanged.`);
      },
      "primary",
    ),
  ]);
}
