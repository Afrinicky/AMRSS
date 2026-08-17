/**
 * The gate every batch passes through before it can be sent.
 *
 * A surveillance record with no site of collection is not a record with a gap —
 * it is a record that cannot enter an antibiogram, be attributed to a syndrome,
 * or be compared with anything. Sending it and discovering that at the regional
 * end means a correction round trip through people who never saw the specimen.
 * So the check happens here, at the bench, while the person who ran the culture
 * is still the one looking at it.
 *
 * Findings come in two strengths, and the distinction is the whole design:
 *
 * - **Blocking** — the record cannot be interpreted without this. The upload
 *   does not proceed while any remain. Fix it in the uploader (a correction),
 *   fix it in WHONET, or exclude the row deliberately.
 * - **Advisory** — the record is usable but poorer. Counted, shown, never a
 *   barrier. An age nobody recorded is a real gap in a real laboratory, and
 *   refusing the whole batch over it would teach people to invent ages.
 *
 * Every blocking finding names a field a facility can actually change, and
 * carries a suggested value wherever the file itself supplies one.
 */

import {
  lookupAntibiotic,
  lookupOrganism,
  lookupSpecimen,
  isNoOrganism,
} from "./dictionary";
import type { AppliedDataset, AppliedRecord, CorrectableField } from "./corrections";
import {
  BreakpointIndex,
  MAX_PLAUSIBLE_ZONE_MM,
  MIN_PLAUSIBLE_ZONE_MM,
  interpretReading,
} from "./interpret";

export type Severity = "blocking" | "advisory";

export interface ValidationIssue {
  rowKey: string;
  rowIndex: number;
  severity: Severity;
  code: IssueCode;
  /** The field to correct, where the finding names one. */
  field: CorrectableField | null;
  message: string;
  /** What the file holds now, for the queue's before/after. */
  currentValue: string | null;
  /** A value the file itself justifies — never an invented one. */
  suggestion: { value: string; rationale: string } | null;
}

export type IssueCode =
  | "missing_patient_identifier"
  | "missing_specimen_date"
  | "specimen_date_in_future"
  | "specimen_date_implausible"
  | "specimen_date_from_entry_column"
  | "missing_specimen_type"
  | "unknown_specimen_type"
  | "missing_organism"
  | "unknown_organism"
  | "unknown_antibiotic"
  | "implausible_zone"
  | "unreadable_result"
  | "missing_sex"
  | "missing_age"
  | "missing_care_setting"
  | "duplicate_record"
  | "no_susceptibility_results"
  | "category_conflicts_with_breakpoints";

export interface ValidationOptions {
  /** Specimens dated before this are typing errors, not history. Defaults to
   * five years back — long enough for a genuine backlog entry, short enough to
   * catch a year typed as 1945, which both validation exports contained. */
  earliestPlausibleDate?: Date;
  now?: Date;
  /** Learned from the file: numeric specimen code to specimen type. */
  specimenCodeMap?: Record<string, string>;
  breakpoints?: BreakpointIndex;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  blocking: number;
  advisory: number;
  /** Rows carrying at least one blocking finding. */
  blockedRowKeys: string[];
  recordsExamined: number;
  recordsReady: number;
  byCode: Array<{ code: IssueCode; severity: Severity; count: number; rows: number }>;
  /** True when nothing blocks the upload. Advisory findings may remain. */
  clearedToUpload: boolean;
  checkedAt: string;
}

const LABELS: Record<IssueCode, { severity: Severity; field: CorrectableField | null }> = {
  missing_patient_identifier: { severity: "blocking", field: "patientIdentifier" },
  missing_specimen_date: { severity: "blocking", field: "specimenDate" },
  specimen_date_in_future: { severity: "blocking", field: "specimenDate" },
  specimen_date_implausible: { severity: "blocking", field: "specimenDate" },
  specimen_date_from_entry_column: { severity: "advisory", field: "specimenDate" },
  missing_specimen_type: { severity: "blocking", field: "specimenTypeCode" },
  unknown_specimen_type: { severity: "blocking", field: "specimenTypeCode" },
  missing_organism: { severity: "blocking", field: "organismCode" },
  unknown_organism: { severity: "blocking", field: "organismCode" },
  unknown_antibiotic: { severity: "advisory", field: null },
  implausible_zone: { severity: "blocking", field: null },
  unreadable_result: { severity: "advisory", field: null },
  missing_sex: { severity: "advisory", field: "sex" },
  missing_age: { severity: "advisory", field: "ageYears" },
  missing_care_setting: { severity: "advisory", field: "careSettingRaw" },
  duplicate_record: { severity: "advisory", field: null },
  no_susceptibility_results: { severity: "advisory", field: null },
  category_conflicts_with_breakpoints: { severity: "advisory", field: null },
};

/** One-line explanations, shown in the queue. Written for a laboratory
 * scientist, not for a developer: each says what is wrong and what fixes it. */
export const ISSUE_TITLES: Record<IssueCode, string> = {
  missing_patient_identifier:
    "No patient identifier. Repeat isolates from this patient cannot be linked, so the isolate cannot be counted.",
  missing_specimen_date: "No specimen date in either the specimen or the data-entry column.",
  specimen_date_in_future: "The specimen date is in the future.",
  specimen_date_implausible: "The specimen date is far older than this surveillance period.",
  specimen_date_from_entry_column:
    "The specimen date is blank; the data-entry date was used instead.",
  missing_specimen_type: "No site of collection. The isolate cannot be attributed to a syndrome.",
  unknown_specimen_type: "The specimen code is not in the AMRSS dictionary.",
  missing_organism: "No organism recorded on a row that carries susceptibility results.",
  unknown_organism: "The organism code is not in the AMRSS dictionary.",
  unknown_antibiotic: "An antimicrobial column is not in the AMRSS dictionary.",
  implausible_zone: "A zone diameter is outside the range a disk test can produce.",
  unreadable_result: "A susceptibility cell holds neither a category nor a measurement.",
  missing_sex: "Sex not recorded. The isolate uploads as unknown.",
  missing_age: "Age not recorded. The isolate uploads in the unknown age band.",
  missing_care_setting: "Inpatient or outpatient not recorded. The isolate uploads as unknown.",
  duplicate_record: "Another row carries the same patient, specimen number, date and organism.",
  no_susceptibility_results: "The isolate has no susceptibility results.",
  category_conflicts_with_breakpoints:
    "The recorded category differs from what the breakpoint table gives for the measurement.",
};

export function validate(
  dataset: AppliedDataset,
  options: ValidationOptions = {},
): ValidationReport {
  const now = options.now ?? new Date();
  const earliest =
    options.earliestPlausibleDate ??
    new Date(Date.UTC(now.getUTCFullYear() - 5, now.getUTCMonth(), now.getUTCDate()));
  const specimenCodeMap = options.specimenCodeMap ?? dataset.specimenCodeMap;
  const breakpoints = options.breakpoints;

  const issues: ValidationIssue[] = [];
  const seenSignatures = new Map<string, string>();

  for (const record of dataset.records) {
    const add = (
      code: IssueCode,
      currentValue: string | null,
      suggestion: ValidationIssue["suggestion"] = null,
      messageOverride?: string,
    ): void => {
      issues.push({
        rowKey: record.key,
        rowIndex: record.rowIndex,
        severity: LABELS[code].severity,
        code,
        field: LABELS[code].field,
        message: messageOverride ?? ISSUE_TITLES[code],
        currentValue,
        suggestion,
      });
    };

    if (!record.patientIdentifier) add("missing_patient_identifier", null);

    checkDate(record, now, earliest, add);
    checkSpecimen(record, specimenCodeMap, add);
    checkOrganism(record, add);
    checkDemographics(record, add);
    checkReadings(record, breakpoints, add);

    // Deduplication signature. Uses the same four facts the source record hash
    // is built from, so a duplicate here is exactly a duplicate there.
    const signature = [
      record.patientIdentifier?.trim().toUpperCase() ?? "",
      record.specimenNumber?.trim().toUpperCase() ?? "",
      record.specimenDate ? record.specimenDate.toISOString().slice(0, 10) : "",
      record.organismCode ?? "",
    ].join("|");
    if (record.patientIdentifier && record.specimenDate) {
      const earlier = seenSignatures.get(signature);
      if (earlier) {
        add(
          "duplicate_record",
          signature,
          null,
          `${ISSUE_TITLES.duplicate_record} The first is row ${earlier}. Only one will be counted.`,
        );
      } else {
        seenSignatures.set(signature, String(record.rowIndex));
      }
    }
  }

  return summarise(issues, dataset.records.length);
}

function checkDate(
  record: AppliedRecord,
  now: Date,
  earliest: Date,
  add: (
    code: IssueCode,
    currentValue: string | null,
    suggestion?: ValidationIssue["suggestion"],
    message?: string,
  ) => void,
): void {
  if (!record.specimenDate) {
    add(
      "missing_specimen_date",
      null,
      record.dateEntered
        ? {
            value: record.dateEntered.toISOString().slice(0, 10),
            rationale: "the data-entry date recorded on this row",
          }
        : null,
    );
    return;
  }

  const iso = record.specimenDate.toISOString().slice(0, 10);
  if (record.specimenDate.getTime() > now.getTime()) {
    add("specimen_date_in_future", iso, suggestFromEntryDate(record));
  } else if (record.specimenDate.getTime() < earliest.getTime()) {
    add("specimen_date_implausible", iso, suggestFromEntryDate(record));
  } else if (record.specimenDateSource === "entry") {
    add("specimen_date_from_entry_column", iso);
  }
}

/**
 * The repair a mistyped year usually needs.
 *
 * Both validation exports contained specimens dated a year earlier than every
 * other field on the row — a January habit, typing the old year. Where the
 * data-entry date is plausible and the specimen date is not, the entry date is
 * the honest candidate, and it is offered as a suggestion for a person to
 * accept, never applied on its own.
 */
function suggestFromEntryDate(record: AppliedRecord): ValidationIssue["suggestion"] {
  if (!record.dateEntered) return null;
  return {
    value: record.dateEntered.toISOString().slice(0, 10),
    rationale: "the data-entry date recorded on this row",
  };
}

function checkSpecimen(
  record: AppliedRecord,
  specimenCodeMap: Record<string, string>,
  add: (
    code: IssueCode,
    currentValue: string | null,
    suggestion?: ValidationIssue["suggestion"],
    message?: string,
  ) => void,
): void {
  const code = record.specimenTypeCode;
  if (!code) {
    const numeric = record.specimenNumericCode?.trim();
    const learned = numeric ? specimenCodeMap[numeric] : undefined;
    add(
      "missing_specimen_type",
      null,
      learned
        ? {
            value: learned,
            rationale: `every other row in this file with specimen code ${numeric} is ${learned}`,
          }
        : null,
    );
    return;
  }

  if (!lookupSpecimen(code)) {
    add(
      "unknown_specimen_type",
      code,
      null,
      `${ISSUE_TITLES.unknown_specimen_type} Map "${code}" to a dictionary specimen type in Settings → Code mapping, or correct the row.`,
    );
  }
}

function checkOrganism(
  record: AppliedRecord,
  add: (
    code: IssueCode,
    currentValue: string | null,
    suggestion?: ValidationIssue["suggestion"],
    message?: string,
  ) => void,
): void {
  const code = record.organismCode;
  if (!code || isNoOrganism(code)) {
    if (record.readings.length > 0) add("missing_organism", code);
    return;
  }
  if (!lookupOrganism(code)) {
    add(
      "unknown_organism",
      code,
      null,
      `${ISSUE_TITLES.unknown_organism} Map "${code}" to a dictionary organism in Settings → Code mapping, or correct the row.`,
    );
  }
  if (record.readings.length === 0) add("no_susceptibility_results", code);
}

function checkDemographics(
  record: AppliedRecord,
  add: (code: IssueCode, currentValue: string | null) => void,
): void {
  if (!record.sex) add("missing_sex", null);
  if (record.ageYears === null && !record.dateOfBirth) add("missing_age", null);
  if (record.careSetting === "unknown") add("missing_care_setting", record.careSettingRaw);
}

function checkReadings(
  record: AppliedRecord,
  breakpoints: BreakpointIndex | undefined,
  add: (
    code: IssueCode,
    currentValue: string | null,
    suggestion?: ValidationIssue["suggestion"],
    message?: string,
  ) => void,
): void {
  for (const reading of record.readings) {
    if (!lookupAntibiotic(reading.canonicalCode)) {
      add(
        "unknown_antibiotic",
        reading.canonicalCode,
        null,
        `Column ${reading.column} names an antimicrobial (${reading.canonicalCode}) that is not in the AMRSS dictionary. Its results will not be counted until it is mapped.`,
      );
      continue;
    }

    if (
      reading.method === "disk_diffusion" &&
      reading.zoneDiameterMm !== null &&
      (reading.zoneDiameterMm < MIN_PLAUSIBLE_ZONE_MM ||
        reading.zoneDiameterMm > MAX_PLAUSIBLE_ZONE_MM)
    ) {
      add(
        "implausible_zone",
        `${reading.column} = ${reading.raw}`,
        null,
        `${reading.column} holds a zone of ${reading.zoneDiameterMm} mm. A disk test reads between ${MIN_PLAUSIBLE_ZONE_MM} and ${MAX_PLAUSIBLE_ZONE_MM} mm — correct it in WHONET before uploading.`,
      );
    }

    if (reading.unreadable) {
      add(
        "unreadable_result",
        `${reading.column} = ${reading.raw}`,
        null,
        `${reading.column} holds "${reading.raw}", which is neither a category nor a measurement. It uploads as not interpretable.`,
      );
    }

    if (breakpoints?.loaded) {
      const interpretation = interpretReading(
        reading,
        record.organismCode,
        record.specimenTypeCode,
        breakpoints,
      );
      if (interpretation.conflictsWithRecorded) {
        add(
          "category_conflicts_with_breakpoints",
          `${reading.column} = ${reading.raw}`,
          null,
          `${reading.column} was recorded as ${reading.recordedCategory}, and ${breakpoints.version ?? "the loaded breakpoint table"} gives a different category for that measurement. The recorded category is kept.`,
        );
      }
    }
  }
}

function summarise(issues: ValidationIssue[], recordsExamined: number): ValidationReport {
  const blockedRowKeys = new Set<string>();
  const byCode = new Map<IssueCode, { severity: Severity; count: number; rows: Set<string> }>();
  let blocking = 0;
  let advisory = 0;

  for (const issue of issues) {
    if (issue.severity === "blocking") {
      blocking += 1;
      blockedRowKeys.add(issue.rowKey);
    } else advisory += 1;

    const entry = byCode.get(issue.code) ?? {
      severity: issue.severity,
      count: 0,
      rows: new Set<string>(),
    };
    entry.count += 1;
    entry.rows.add(issue.rowKey);
    byCode.set(issue.code, entry);
  }

  return {
    issues,
    blocking,
    advisory,
    blockedRowKeys: [...blockedRowKeys],
    recordsExamined,
    recordsReady: recordsExamined - blockedRowKeys.size,
    byCode: [...byCode.entries()]
      .map(([code, entry]) => ({
        code,
        severity: entry.severity,
        count: entry.count,
        rows: entry.rows.size,
      }))
      .sort((a, b) =>
        a.severity === b.severity ? b.count - a.count : a.severity === "blocking" ? -1 : 1,
      ),
    clearedToUpload: blocking === 0,
    checkedAt: new Date().toISOString(),
  };
}

/** The records a batch may contain: everything not carrying a blocking finding.
 *
 * A blocked row is held back rather than dropped silently — the queue shows it,
 * the count reconciles, and it uploads on the next run once it is fixed. */
export function uploadableRecords(
  dataset: AppliedDataset,
  report: ValidationReport,
): AppliedRecord[] {
  const blocked = new Set(report.blockedRowKeys);
  return dataset.records.filter((record) => !blocked.has(record.key));
}
