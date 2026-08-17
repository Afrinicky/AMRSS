/**
 * The database view: WHONET's own grid, with the interpretation done.
 *
 * A laboratory recognises this screen — it is the data-entry grid it already
 * works in, one row per isolate, one column per antimicrobial. What is different
 * is the cell: WHONET shows the zone diameter that was measured, and this shows
 * what that diameter *means*, because a clinician acts on S and R and nobody
 * treats an infection with 23 mm.
 *
 * The measurement is one keystroke away. Both views are built here from the same
 * reading, so switching between them cannot change which isolates are on screen,
 * and either can be downloaded as it stands.
 */

import type { AppliedDataset } from "../core/corrections";
import { antibioticLabel, organismLabel, specimenLabel } from "../core/dictionary";
import { BreakpointIndex, type Interpretation, interpretReading } from "../core/interpret";
import type { ValidationReport } from "../core/validation";

export interface GridRequest {
  mode?: "interpretations" | "values";
  page?: number;
  pageSize?: number;
  search?: string;
  /** Show only rows carrying a validation finding. */
  onlyIssues?: boolean;
  /** Show only rows the facility has corrected. */
  onlyCorrected?: boolean;
  sortBy?: "row" | "date" | "organism" | "specimen";
  sortDirection?: "asc" | "desc";
}

export interface GridColumn {
  key: string;
  label: string;
  kind: "text" | "number" | "date" | "code" | "result";
  /** Present on antimicrobial columns: what the column actually is. */
  detail?: string;
}

export interface GridCell {
  value: string | null;
  /** The other form of the same reading, shown on hover: the measurement behind
   * a category, or the category behind a measurement. */
  alternate?: string | null;
  tone?: "S" | "I" | "R" | "SDD" | "NS" | "PI" | "NI";
}

export interface GridRow {
  key: string;
  rowIndex: number;
  cells: Record<string, GridCell>;
  blocking: number;
  advisory: number;
  correctedFields: string[];
}

export interface GridResponse {
  columns: GridColumn[];
  rows: GridRow[];
  total: number;
  page: number;
  pageSize: number;
  mode: "interpretations" | "values";
  breakpointsLoaded: boolean;
  breakpointLabel: string | null;
}

const CORE_COLUMNS: GridColumn[] = [
  { key: "rowIndex", label: "#", kind: "number" },
  { key: "patientIdentifier", label: "Identification number", kind: "text" },
  { key: "specimenNumber", label: "Specimen number", kind: "text" },
  { key: "specimenDate", label: "Specimen date", kind: "date" },
  { key: "dateEntered", label: "Date entered", kind: "date" },
  { key: "sex", label: "Sex", kind: "code" },
  { key: "ageYears", label: "Age", kind: "number" },
  { key: "careSettingRaw", label: "Ward type", kind: "code" },
  { key: "ward", label: "Ward", kind: "text" },
  { key: "department", label: "Department", kind: "text" },
  { key: "specimenTypeCode", label: "Specimen", kind: "code" },
  { key: "organismCode", label: "Organism", kind: "code" },
  { key: "organismType", label: "Organism type", kind: "code" },
  { key: "comment", label: "Comment", kind: "text" },
];

export function buildGrid(
  dataset: AppliedDataset,
  index: BreakpointIndex,
  validation: ValidationReport | null,
  request: GridRequest,
): GridResponse {
  const mode = request.mode ?? "interpretations";
  const page = Math.max(1, request.page ?? 1);
  const pageSize = Math.min(500, Math.max(10, request.pageSize ?? 50));
  const search = (request.search ?? "").trim().toLowerCase();

  const findings = new Map<string, { blocking: number; advisory: number }>();
  for (const issue of validation?.issues ?? []) {
    const entry = findings.get(issue.rowKey) ?? { blocking: 0, advisory: 0 };
    if (issue.severity === "blocking") entry.blocking += 1;
    else entry.advisory += 1;
    findings.set(issue.rowKey, entry);
  }

  const columns: GridColumn[] = [
    ...CORE_COLUMNS,
    ...dataset.agentColumns.map((agent) => ({
      key: agent.column,
      label: agent.column,
      kind: "result" as const,
      detail: `${antibioticLabel(agent.canonicalCode)}${
        agent.potency ? ` ${agent.potency}` : ""
      } · ${
        agent.method === "disk_diffusion"
          ? "disk diffusion, mm"
          : agent.method === "mic"
            ? "MIC, µg/mL"
            : "gradient strip, µg/mL"
      }`,
    })),
  ];

  let rows: GridRow[] = dataset.records.map((record) => {
    const counts = findings.get(record.key) ?? { blocking: 0, advisory: 0 };
    const cells: Record<string, GridCell> = {
      rowIndex: { value: String(record.rowIndex) },
      patientIdentifier: { value: record.patientIdentifier },
      specimenNumber: { value: record.specimenNumber },
      specimenDate: {
        value: record.specimenDate ? record.specimenDate.toISOString().slice(0, 10) : null,
        alternate: record.specimenDateSource === "entry" ? "from the data-entry column" : null,
      },
      dateEntered: {
        value: record.dateEntered ? record.dateEntered.toISOString().slice(0, 10) : null,
      },
      sex: { value: record.sex },
      ageYears: { value: record.ageYears === null ? null : String(record.ageYears) },
      careSettingRaw: {
        value: record.careSettingRaw,
        alternate: record.careSetting === "unknown" ? null : record.careSetting,
      },
      ward: { value: record.ward },
      department: { value: record.department },
      specimenTypeCode: {
        value: record.specimenTypeCode,
        alternate: specimenLabel(record.specimenTypeCode),
      },
      organismCode: {
        value: record.organismCode,
        alternate: organismLabel(record.organismCode),
      },
      organismType: { value: record.organismType },
      comment: { value: record.comment },
    };

    for (const reading of record.readings) {
      const interpretation: Interpretation = interpretReading(
        reading,
        record.organismCode,
        record.specimenTypeCode,
        index,
      );
      cells[reading.column] =
        mode === "values"
          ? {
              value: reading.raw,
              alternate: describeInterpretation(interpretation),
              tone: interpretation.category,
            }
          : {
              value: interpretation.category,
              alternate: describeMeasurement(reading.raw, interpretation),
              tone: interpretation.category,
            };
    }

    return {
      key: record.key,
      rowIndex: record.rowIndex,
      cells,
      blocking: counts.blocking,
      advisory: counts.advisory,
      correctedFields: record.correctedFields,
    };
  });

  if (request.onlyIssues) rows = rows.filter((row) => row.blocking + row.advisory > 0);
  if (request.onlyCorrected) rows = rows.filter((row) => row.correctedFields.length > 0);

  if (search) {
    rows = rows.filter((row) =>
      Object.values(row.cells).some((cell) =>
        (cell.value ?? "").toLowerCase().includes(search),
      ),
    );
  }

  const direction = request.sortDirection === "desc" ? -1 : 1;
  const sortKey = request.sortBy ?? "row";
  rows.sort((a, b) => {
    if (sortKey === "row") return (a.rowIndex - b.rowIndex) * direction;
    const key =
      sortKey === "date" ? "specimenDate" : sortKey === "organism" ? "organismCode" : "specimenTypeCode";
    return (a.cells[key]?.value ?? "").localeCompare(b.cells[key]?.value ?? "") * direction;
  });

  const total = rows.length;
  const start = (page - 1) * pageSize;

  return {
    columns,
    rows: rows.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    mode,
    breakpointsLoaded: index.loaded,
    breakpointLabel: index.set.label ?? index.set.version,
  };
}

function describeInterpretation(interpretation: Interpretation): string {
  if (interpretation.origin === "laboratory") return `${interpretation.category} — as recorded`;
  if (interpretation.origin === "engine") {
    return `${interpretation.category} — ${interpretation.criterion?.organism_group ?? "breakpoint"}${
      interpretation.criterion?.standard ? `, ${interpretation.criterion.standard}` : ""
    }`;
  }
  return explain(interpretation.reason);
}

function describeMeasurement(raw: string, interpretation: Interpretation): string {
  if (interpretation.origin === "none") {
    return `${raw} — ${explain(interpretation.reason)}`;
  }
  if (interpretation.origin === "laboratory") return `${raw} — category recorded by the laboratory`;
  return `${raw} — ${interpretation.criterion?.organism_group ?? ""} ${
    interpretation.criterion?.standard ?? ""
  }`.trim();
}

function explain(reason: string | null): string {
  return (
    PENDING_EXPLANATIONS[reason ?? "no_criterion"] ??
    "this result could not be interpreted"
  );
}

const PENDING_EXPLANATIONS: Record<string, string> = {
  no_breakpoint_table:
    "no breakpoint table is loaded — sync it from the platform or import your CLSI table",
  no_criterion: "the loaded breakpoint table has no criterion for this organism and agent",
  unknown_organism: "the organism code is not in the dictionary, so no breakpoint applies",
  off_scale_ambiguous: "the reading is off-scale and more than one category is consistent with it",
  implausible_measurement: "the measurement is outside the range a disk test can produce",
  not_a_measurement: "the cell holds neither a category nor a measurement",
};
