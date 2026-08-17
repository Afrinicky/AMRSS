/**
 * Workbooks the laboratory can take away.
 *
 * Everything on screen downloads, in the form it is on screen: the database
 * grid as values or as interpretations, the antibiogram, the trends, the
 * validation queue, the upload history. The rule throughout is that a download
 * carries its own context — the filters that produced it, the breakpoint table
 * that interpreted it, the counting rules behind the percentages — because a
 * spreadsheet emailed onward loses the screen it came from, and a resistance
 * percentage with no denominator beside it is how a wrong number travels.
 */

import type { AnalysedIsolate, AnalysisFilters, AnalysisOptions } from "../core/analytics";
import { antibiogram, antibioticProfiles, organismFrequency, phenotypes, resistanceTrend, siteFrequency, specimenFrequency, volumeTrend, demographicBreakdown } from "../core/analytics";
import type { AppliedDataset, AppliedRecord } from "../core/corrections";
import { antibioticLabel, organismLabel, specimenLabel } from "../core/dictionary";
import { BreakpointIndex, interpretReading } from "../core/interpret";
import type { UploadLogEntry } from "../core/store";
import { ISSUE_TITLES, type ValidationReport } from "../core/validation";
import { buildWorkbook, type CellValue, type Sheet } from "../core/xlsx";

export type GridMode = "interpretations" | "values";

function provenanceSheet(entries: Array<[string, CellValue]>): Sheet {
  return {
    name: "About this export",
    header: ["Field", "Value"],
    rows: entries.map(([label, value]) => [label, value]),
    columnWidths: [34, 70],
  };
}

function describeFilters(filters: AnalysisFilters): string {
  const parts: string[] = [];
  if (filters.dateFrom) parts.push(`from ${filters.dateFrom}`);
  if (filters.dateTo) parts.push(`to ${filters.dateTo}`);
  if (filters.careSetting) parts.push(`care setting ${filters.careSetting}`);
  if (filters.organismCode) parts.push(`organism ${organismLabel(filters.organismCode)}`);
  if (filters.specimenTypeCode) parts.push(`specimen ${specimenLabel(filters.specimenTypeCode)}`);
  if (filters.infectionSite) parts.push(`site ${filters.infectionSite}`);
  if (filters.ward) parts.push(`ward ${filters.ward}`);
  if (filters.department) parts.push(`department ${filters.department}`);
  if (filters.sex) parts.push(`sex ${filters.sex}`);
  if (filters.ageBand) parts.push(`age band ${filters.ageBand}`);
  return parts.length === 0 ? "none — all isolates in the file" : parts.join("; ");
}

function countingRules(options: AnalysisOptions): string {
  return (
    `${options.firstIsolateOnly ? "First isolate per patient per organism" : "Every isolate"}; ` +
    `percentages withheld below ${options.minimumIsolates} interpretable results; ` +
    `S and SDD counted as susceptible, NS counted with resistant; ` +
    `pending and not-interpretable results excluded from percentages.`
  );
}

/**
 * The database grid, in either form.
 *
 * The two forms answer different questions and a laboratory needs both: the
 * measurement is what was read off the plate and what a repeat check compares
 * against, and the interpretation is what a clinician acts on. The interpreted
 * sheet says which breakpoint table produced it, because next year's edition
 * will give a different answer for the same millimetres.
 */
export function gridWorkbook(
  dataset: AppliedDataset,
  index: BreakpointIndex,
  mode: GridMode,
  options: { facility: string | null; includeIdentifiers: boolean },
): Buffer {
  const agents = dataset.agentColumns;

  const header = [
    "Row",
    "Identification number",
    "Specimen number",
    "Specimen date",
    "Date entered",
    "Sex",
    "Age",
    "Ward",
    "Ward type",
    "Department",
    "Specimen type",
    "Specimen (numeric)",
    "Reason",
    "Organism",
    "Organism name",
    "Organism type",
    "Beta-lactamase",
    "ESBL",
    "Comment",
    ...agents.map((agent) => agent.column),
  ];

  const rows: CellValue[][] = dataset.records.map((record) => {
    const interpreted = new Map(
      record.readings.map((reading) => [
        reading.column,
        interpretReading(reading, record.organismCode, record.specimenTypeCode, index),
      ]),
    );
    const byColumn = new Map(record.readings.map((reading) => [reading.column, reading]));

    return [
      record.rowIndex,
      options.includeIdentifiers ? record.patientIdentifier : maskIdentifier(record),
      record.specimenNumber,
      record.specimenDate ? record.specimenDate.toISOString().slice(0, 10) : null,
      record.dateEntered ? record.dateEntered.toISOString().slice(0, 10) : null,
      record.sex,
      record.ageYears,
      record.ward,
      record.careSettingRaw,
      record.department,
      record.specimenTypeCode,
      record.specimenNumericCode,
      record.specimenReason,
      record.organismCode,
      organismLabel(record.organismCode),
      record.organismType,
      record.betaLactamase,
      record.esbl,
      record.comment,
      ...agents.map((agent) => {
        const reading = byColumn.get(agent.column);
        if (!reading) return null;
        if (mode === "values") return reading.raw;
        const interpretation = interpreted.get(agent.column);
        return interpretation ? interpretation.category : null;
      }),
    ];
  });

  const legend: Sheet = {
    name: "Antimicrobial columns",
    header: ["WHONET column", "Code", "Antimicrobial", "Method", "Disk content / scale"],
    rows: agents.map((agent) => [
      agent.column,
      agent.canonicalCode,
      antibioticLabel(agent.canonicalCode),
      agent.method === "disk_diffusion" ? "Disk diffusion" : agent.method === "mic" ? "MIC" : "Gradient strip",
      agent.potency,
    ]),
  };

  return buildWorkbook([
    {
      name: mode === "values" ? "Results as recorded" : "Interpretations",
      header,
      rows,
    },
    legend,
    provenanceSheet([
      ["Facility", options.facility],
      ["Source file", dataset.path],
      ["Read at", dataset.readAt],
      ["View", mode === "values" ? "As recorded in WHONET" : "Interpreted (S / I / R / SDD)"],
      [
        "Breakpoint table",
        index.loaded ? (index.set.label ?? index.set.version ?? "loaded") : "none loaded",
      ],
      ["Isolates included", dataset.records.length],
      ["Rows excluded", dataset.excluded.length],
      ["Corrections applied", dataset.correctionCount],
      [
        "Patient identifiers",
        options.includeIdentifiers
          ? "Included — this file leaves the laboratory only if you send it"
          : "Removed",
      ],
      [
        "Note",
        "PI = measured, awaiting a breakpoint. NI = recorded but not interpretable. Blank = not tested.",
      ],
    ]),
  ]);
}

function maskIdentifier(record: AppliedRecord): string {
  return record.patientIdentifier ? `row ${record.rowIndex}` : "";
}

export function validationWorkbook(
  report: ValidationReport,
  dataset: AppliedDataset,
): Buffer {
  const byKey = new Map(dataset.records.map((record) => [record.key, record]));

  return buildWorkbook([
    {
      name: "Findings",
      header: [
        "Row",
        "Severity",
        "Finding",
        "Field",
        "Current value",
        "Suggested value",
        "Why suggested",
        "Explanation",
        "Specimen date",
        "Organism",
        "Specimen type",
      ],
      rows: report.issues.map((issue) => {
        const record = byKey.get(issue.rowKey);
        return [
          issue.rowIndex,
          issue.severity === "blocking" ? "Must fix" : "Advisory",
          issue.code,
          issue.field,
          issue.currentValue,
          issue.suggestion?.value ?? null,
          issue.suggestion?.rationale ?? null,
          issue.message,
          record?.specimenDate ? record.specimenDate.toISOString().slice(0, 10) : null,
          record?.organismCode ?? null,
          record?.specimenTypeCode ?? null,
        ];
      }),
    },
    {
      name: "Summary",
      header: ["Finding", "Severity", "Findings", "Records affected", "Explanation"],
      rows: report.byCode.map((entry) => [
        entry.code,
        entry.severity === "blocking" ? "Must fix" : "Advisory",
        entry.count,
        entry.rows,
        ISSUE_TITLES[entry.code],
      ]),
    },
    provenanceSheet([
      ["Checked at", report.checkedAt],
      ["Records examined", report.recordsExamined],
      ["Records ready to upload", report.recordsReady],
      ["Findings that must be fixed", report.blocking],
      ["Advisory findings", report.advisory],
      ["Cleared to upload", report.clearedToUpload ? "yes" : "no"],
    ]),
  ]);
}

export function antibiogramWorkbook(
  isolates: AnalysedIsolate[],
  options: AnalysisOptions,
  filters: AnalysisFilters,
  index: BreakpointIndex,
): Buffer {
  const table = antibiogram(isolates, options);

  const header = ["Organism", "Isolates", ...table.antibiotics.map((agent) => agent.name)];
  const percentRows: CellValue[][] = table.rows.map((row) => [
    row.organismName,
    row.isolates,
    ...table.antibiotics.map((agent) => {
      const cell = row.cells[agent.code];
      if (!cell || cell.interpretable === 0) return null;
      return round(cell.susceptiblePercent);
    }),
  ]);

  const detail: CellValue[][] = [];
  for (const row of table.rows) {
    for (const agent of table.antibiotics) {
      const cell = row.cells[agent.code];
      if (!cell || cell.tested === 0) continue;
      detail.push([
        row.organismName,
        agent.name,
        agent.code,
        cell.tested,
        cell.interpretable,
        cell.susceptible,
        cell.intermediate,
        cell.resistant,
        round(cell.susceptiblePercent),
        round(cell.resistantPercent),
        cell.belowThreshold ? "below reporting threshold" : "",
      ]);
    }
  }

  return buildWorkbook([
    { name: "Percent susceptible", header, rows: percentRows },
    {
      name: "Counts",
      header: [
        "Organism",
        "Antimicrobial",
        "Code",
        "Tested",
        "Interpretable",
        "Susceptible",
        "Intermediate",
        "Resistant",
        "% susceptible",
        "% resistant",
        "Note",
      ],
      rows: detail,
    },
    provenanceSheet([
      ["Filters", describeFilters(filters)],
      ["Counting rules", countingRules(options)],
      ["Isolates analysed", table.isolateCount],
      [
        "Breakpoint table",
        index.loaded ? (index.set.label ?? index.set.version ?? "loaded") : "none loaded",
      ],
      [
        "Caution",
        "A percentage over fewer isolates than the reporting threshold is shown in the counts sheet but should not be published.",
      ],
    ]),
  ]);
}

export function analyticsWorkbook(
  isolates: AnalysedIsolate[],
  options: AnalysisOptions,
  filters: AnalysisFilters,
): Buffer {
  const demographics = demographicBreakdown(isolates);
  const countSheet = (name: string, rows: Array<{ label: string; count: number; percent: number }>): Sheet => ({
    name,
    header: [name, "Isolates", "% of isolates"],
    rows: rows.map((row) => [row.label, row.count, round(row.percent)]),
  });

  return buildWorkbook([
    countSheet("Organisms", organismFrequency(isolates, options)),
    countSheet("Specimens", specimenFrequency(isolates)),
    countSheet("Sites of infection", siteFrequency(isolates)),
    countSheet("Care setting", demographics.careSetting),
    countSheet("Age band", demographics.ageBands),
    countSheet("Sex", demographics.sex),
    {
      name: "Antimicrobials",
      header: [
        "Antimicrobial",
        "Code",
        "Class",
        "Tested",
        "Interpretable",
        "% susceptible",
        "% resistant",
        "Organisms pooled",
      ],
      rows: antibioticProfiles(isolates, options).map((profile) => [
        profile.name,
        profile.code,
        profile.antimicrobialClass,
        profile.cell.tested,
        profile.cell.interpretable,
        round(profile.cell.susceptiblePercent),
        round(profile.cell.resistantPercent),
        profile.organismCount,
      ]),
    },
    {
      name: "Volume by month",
      header: ["Month", "Isolates", "Patients"],
      rows: volumeTrend(isolates).map((point) => [point.bucket, point.isolates, point.patients]),
    },
    {
      name: "Phenotypes",
      header: ["Phenotype", "Isolates", "Eligible isolates", "%", "What it means"],
      rows: phenotypes(isolates, options).map((entry) => [
        entry.label,
        entry.isolates,
        entry.eligible,
        round(entry.percent),
        entry.description,
      ]),
    },
    provenanceSheet([
      ["Filters", describeFilters(filters)],
      ["Counting rules", countingRules(options)],
      ["Isolates in scope", isolates.length],
    ]),
  ]);
}

export function trendWorkbook(
  isolates: AnalysedIsolate[],
  options: AnalysisOptions,
  filters: AnalysisFilters,
  antibioticCode: string,
  bucket: "month" | "quarter",
): Buffer {
  return buildWorkbook([
    {
      name: "Resistance trend",
      header: [
        bucket === "month" ? "Month" : "Quarter",
        "Isolates",
        "Interpretable",
        "Resistant",
        "% resistant",
        "Note",
      ],
      rows: resistanceTrend(isolates, antibioticCode, options, bucket).map((point) => [
        point.bucket,
        point.isolates,
        point.interpretable,
        point.resistant,
        round(point.resistantPercent),
        point.belowThreshold ? "below reporting threshold — percentage withheld on screen" : "",
      ]),
    },
    {
      name: "Volume",
      header: [bucket === "month" ? "Month" : "Quarter", "Isolates", "Patients"],
      rows: volumeTrend(isolates, bucket).map((point) => [
        point.bucket,
        point.isolates,
        point.patients,
      ]),
    },
    provenanceSheet([
      ["Antimicrobial", `${antibioticLabel(antibioticCode)} (${antibioticCode})`],
      ["Filters", describeFilters(filters)],
      ["Counting rules", countingRules(options)],
    ]),
  ]);
}

export function historyWorkbook(log: UploadLogEntry[]): Buffer {
  return buildWorkbook([
    {
      name: "Upload history",
      header: [
        "Sent at",
        "Records",
        "Coverage start",
        "Coverage end",
        "Status",
        "Trigger",
        "Batch",
        "Checksum",
        "Message",
      ],
      rows: [...log].reverse().map((entry) => [
        entry.timestamp,
        entry.recordCount,
        entry.coverageStart,
        entry.coverageEnd,
        entry.status,
        entry.trigger ?? "manual",
        entry.batchId,
        entry.checksum,
        entry.message,
      ]),
    },
  ]);
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}
