/**
 * Reading a facility's WHONET SQLite database.
 *
 * WHONET installations differ: column names vary by version, by national
 * configuration, and by local customisation. Hardcoding one layout would produce
 * an uploader that works at the pilot site and silently misreads data everywhere
 * else — the worst possible failure, because it looks like success.
 *
 * So the layout is a **profile**: a declared mapping from logical fields onto
 * this database's actual columns. The uploader inspects the file, reports what it
 * found, and refuses to proceed until every required field is mapped. A facility
 * confirms the mapping once, and it is stored and version-checked thereafter.
 *
 * The reader is deliberately one function. Everything downstream — the grid, the
 * validation queue, the analytics, the batch — reads the same `WhonetDataset`,
 * so what a laboratory sees on screen and what it uploads cannot drift apart.
 * The file is opened read-only, always: WHONET owns it, corrections made here
 * are stored beside it (see corrections.ts), and nothing this application does
 * may change what the laboratory recorded.
 */

import { statSync } from "node:fs";

import Database from "better-sqlite3";

import type { SourceIsolate } from "./deidentify";
import {
  canonicalAntibioticCode,
  canonicalOrganismCode,
  canonicalSpecimenCode,
  careSettingOf,
  isNoOrganism,
} from "./dictionary";

export { isNoOrganism, NO_ORGANISM_CODES } from "./dictionary";

export interface ColumnProfile {
  /** Table holding one row per isolate. */
  table: string;
  patientIdentifier: string;
  specimenDate: string;
  /** A second date column used only when the primary specimen date is blank —
   * WHONET files frequently leave SPEC_DATE empty and carry the registration
   * date in DATE_DATA, and dropping those isolates loses a quarter of a real
   * export for a field that is present under a different name. */
  specimenDateFallback: string | null;
  specimenNumber: string | null;
  sex: string | null;
  ageYears: string | null;
  dateOfBirth: string | null;
  careSetting: string | null;
  organism: string;
  specimenType: string;
  /**
   * How AST results are laid out.
   *
   * `wide` — one column per agent, the classic WHONET shape (`AMP_ND10`), with
   * interpretations in a parallel column or encoded in the value itself.
   * `long`  — a separate results table, one row per isolate-agent pair.
   */
  resultLayout: "wide" | "long";
  /** Wide layout: regex capturing the agent code from a column name. */
  antibioticColumnPattern?: string;
  /** Long layout: the results table and its join/value columns. */
  resultTable?: string;
  resultIsolateKey?: string;
  resultAntibioticColumn?: string;
  resultValueColumn?: string;
  /** Column on the isolate table that the results table joins to. */
  isolateKey?: string;

  /* Context columns. All optional: they are shown in the grid, used to explain
   * a record and to fill a gap the surveillance fields leave, and never
   * transmitted. A profile stored by an earlier version simply has them unset. */
  rowKey?: string | null;
  patientType?: string | null;
  ward?: string | null;
  department?: string | null;
  institution?: string | null;
  laboratory?: string | null;
  organismType?: string | null;
  specimenNumericCode?: string | null;
  specimenReason?: string | null;
  betaLactamase?: string | null;
  esbl?: string | null;
  comment?: string | null;
}

/** Candidate column names, most specific first. Used only for detection. */
const CANDIDATES = {
  patientIdentifier: ["PATIENT_ID", "PATIENT", "PATID", "PAT_ID", "HOSPITAL_NUMBER"],
  specimenDate: ["SPEC_DATE", "SPECDATE", "DATE_SPEC", "SPECIMEN_DATE", "DATE_ADMIS"],
  specimenDateFallback: ["DATE_DATA", "DATE_TEST", "DATE_ENTRY", "DATE_RECEIVE", "DATE_RESULT"],
  specimenNumber: ["SPEC_NUM", "SPECNUM", "SPECIMEN_NUMBER", "LAB_NUMBER", "ACCESSION"],
  sex: ["SEX", "GENDER"],
  ageYears: ["AGE", "AGE_YEARS", "PATIENT_AGE"],
  dateOfBirth: ["DATE_BIRTH", "DOB", "BIRTH_DATE", "DATE_OF_BIRTH"],
  careSetting: ["WARD_TYPE", "PAT_TYPE", "LOCATION_TYPE", "INOUT", "CARE_SETTING"],
  organism: ["ORGANISM", "ORG", "ORGANISM_CODE", "ORG_CODE"],
  specimenType: ["SPEC_TYPE", "SPECTYPE", "SPECIMEN_TYPE", "SPEC"],
  rowKey: ["ROW_IDX", "ROWID", "ID", "RECORD_ID"],
  patientType: ["PAT_TYPE", "PATIENT_TYPE"],
  ward: ["WARD", "WARD_NAME", "LOCATION"],
  department: ["DEPARTMENT", "DEPT", "SERVICE"],
  institution: ["INSTITUT", "INSTITUTION", "FACILITY"],
  laboratory: ["LABORATORY", "LAB", "LAB_CODE"],
  organismType: ["ORG_TYPE", "ORGANISM_TYPE"],
  specimenNumericCode: ["SPEC_CODE", "SPECIMEN_CODE"],
  specimenReason: ["SPEC_REAS", "SPEC_REASON", "REASON"],
  betaLactamase: ["BETA_LACT", "BETALACT"],
  esbl: ["ESBL"],
  comment: ["COMMENT", "COMMENTS", "NOTE", "NOTES"],
} as const;

const CANDIDATE_TABLES = ["isolates", "Isolates", "ISOLATES", "data", "WHONET"];

export interface DetectionResult {
  profile: ColumnProfile | null;
  table: string | null;
  availableTables: string[];
  availableColumns: string[];
  /** Logical fields with no candidate column. Empty means the file is usable. */
  unmappedRequired: string[];
  /** Columns whose names suggest they hold identifiers, for the confirmation
   * screen. Their presence is expected and harmless — they are read locally and
   * never transmitted — but the facility should see that the uploader can see
   * them. */
  identifyingColumnsPresent: string[];
  /** Agent columns found, so the confirmation screen can say how many
   * antimicrobials this configuration tests. */
  agentColumns: AgentColumn[];
  recordCount: number;
}

const IDENTIFYING_HINTS = [
  "name",
  "patient",
  "phone",
  "address",
  "kin",
  "birth",
  "dob",
  "ward",
  "bed",
  "clinician",
  "doctor",
  "nhis",
];

function pick(columns: string[], candidates: readonly string[]): string | null {
  const upper = new Map(columns.map((column) => [column.toUpperCase(), column]));
  for (const candidate of candidates) {
    const match = upper.get(candidate);
    if (match) return match;
  }
  return null;
}

export function detectProfile(databasePath: string): DetectionResult {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    const table =
      CANDIDATE_TABLES.find((candidate) => tables.includes(candidate)) ??
      largestTable(db, tables);

    if (!table) {
      return {
        profile: null,
        table: null,
        availableTables: tables,
        availableColumns: [],
        unmappedRequired: ["table"],
        identifyingColumnsPresent: [],
        agentColumns: [],
        recordCount: 0,
      };
    }

    const columns = db
      .prepare<[string], { name: string }>(`SELECT name FROM pragma_table_info(?)`)
      .all(table)
      .map((row) => row.name);

    const mapped = {
      patientIdentifier: pick(columns, CANDIDATES.patientIdentifier),
      specimenDate: pick(columns, CANDIDATES.specimenDate),
      organism: pick(columns, CANDIDATES.organism),
      specimenType: pick(columns, CANDIDATES.specimenType),
    };

    const unmappedRequired = Object.entries(mapped)
      .filter(([, value]) => value === null)
      .map(([key]) => key);

    const identifyingColumnsPresent = columns.filter((column) =>
      IDENTIFYING_HINTS.some((hint) => column.toLowerCase().includes(hint)),
    );

    const agentColumns = matchAntibioticColumns(columns, DEFAULT_AGENT_PATTERN);
    const recordCount =
      db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM "${table}"`).get()?.count ??
      0;

    if (unmappedRequired.length > 0) {
      return {
        profile: null,
        table,
        availableTables: tables,
        availableColumns: columns,
        unmappedRequired,
        identifyingColumnsPresent,
        agentColumns,
        recordCount,
      };
    }

    return {
      profile: {
        table,
        patientIdentifier: mapped.patientIdentifier!,
        specimenDate: mapped.specimenDate!,
        specimenDateFallback: pick(columns, CANDIDATES.specimenDateFallback),
        specimenNumber: pick(columns, CANDIDATES.specimenNumber),
        sex: pick(columns, CANDIDATES.sex),
        ageYears: pick(columns, CANDIDATES.ageYears),
        dateOfBirth: pick(columns, CANDIDATES.dateOfBirth),
        careSetting: pick(columns, CANDIDATES.careSetting),
        organism: mapped.organism!,
        specimenType: mapped.specimenType!,
        resultLayout: "wide",
        // WHONET encodes agent, method and potency in the column name, e.g.
        // AMP_ND10 (ampicillin, disk, 10µg) or CIP_NM (ciprofloxacin, MIC).
        antibioticColumnPattern: DEFAULT_AGENT_PATTERN,
        rowKey: pick(columns, CANDIDATES.rowKey),
        patientType: pick(columns, CANDIDATES.patientType),
        ward: pick(columns, CANDIDATES.ward),
        department: pick(columns, CANDIDATES.department),
        institution: pick(columns, CANDIDATES.institution),
        laboratory: pick(columns, CANDIDATES.laboratory),
        organismType: pick(columns, CANDIDATES.organismType),
        specimenNumericCode: pick(columns, CANDIDATES.specimenNumericCode),
        specimenReason: pick(columns, CANDIDATES.specimenReason),
        betaLactamase: pick(columns, CANDIDATES.betaLactamase),
        esbl: pick(columns, CANDIDATES.esbl),
        comment: pick(columns, CANDIDATES.comment),
      },
      table,
      availableTables: tables,
      availableColumns: columns,
      unmappedRequired: [],
      identifyingColumnsPresent,
      agentColumns,
      recordCount,
    };
  } finally {
    db.close();
  }
}

export const DEFAULT_AGENT_PATTERN = "^([A-Z]{3})_(N[DME])([0-9._]*)$";

function largestTable(db: Database.Database, tables: string[]): string | null {
  let best: { name: string; rows: number } | null = null;
  for (const name of tables) {
    if (name.startsWith("sqlite_")) continue;
    try {
      const row = db
        .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM "${name}"`)
        .get();
      const rows = row?.count ?? 0;
      if (!best || rows > best.rows) best = { name, rows };
    } catch {
      /* unreadable table — ignore it during detection */
    }
  }
  return best?.name ?? null;
}

export type TestMethod = "disk_diffusion" | "mic" | "gradient";

export interface AgentColumn {
  column: string;
  /** The code as WHONET spells it. */
  code: string;
  /** The code after aliasing onto the canonical dictionary. */
  canonicalCode: string;
  /** WHONET's method letters: ND disk, NM MIC, NE gradient strip. */
  methodCode: string;
  method: TestMethod;
  /** Disk content or MIC scale as WHONET appends it, e.g. "30" in AMP_ND30. */
  potency: string | null;
}

/** One AST cell, as read. Interpretation is a separate step (interpret.ts). */
export interface WhonetReading {
  antibioticCode: string;
  canonicalCode: string;
  column: string;
  method: TestMethod;
  potency: string | null;
  /** Exactly what the laboratory typed, for the "as recorded" grid. */
  raw: string;
  zoneDiameterMm: number | null;
  micValue: number | null;
  micOperator: string | null;
  /** A category the laboratory recorded itself, where it did. Never inferred. */
  recordedCategory: string | null;
  /** True when the cell holds a measurement rather than a category. */
  quantitative: boolean;
  /** Recorded, but neither a category nor a number. */
  unreadable: boolean;
}

/** One WHONET row, read whole. */
export interface WhonetRecord {
  /** Stable across reads of the same file, so a correction stays attached to
   * the row it corrected. ROW_IDX where WHONET provides it — it is an
   * autoincrement primary key — and the row ordinal otherwise. */
  key: string;
  rowIndex: number;
  patientIdentifier: string | null;
  specimenNumber: string | null;
  specimenDate: Date | null;
  /** Which column the date came from: a fallback date is a weaker fact and the
   * validation queue says so. */
  specimenDateSource: "specimen" | "entry" | null;
  dateEntered: Date | null;
  sex: string | null;
  ageYears: number | null;
  dateOfBirth: Date | null;
  careSettingRaw: string | null;
  careSetting: "IPD" | "OPD" | "unknown";
  ward: string | null;
  department: string | null;
  institution: string | null;
  laboratory: string | null;
  patientType: string | null;
  organismCode: string | null;
  organismType: string | null;
  specimenTypeCode: string | null;
  specimenNumericCode: string | null;
  specimenReason: string | null;
  betaLactamase: string | null;
  esbl: string | null;
  comment: string | null;
  readings: WhonetReading[];
  /** Every column of the source row, as text, for the grid's "all columns" view. */
  raw: Record<string, string | null>;
}

export interface WhonetDataset {
  path: string;
  table: string;
  columns: string[];
  agentColumns: AgentColumn[];
  records: WhonetRecord[];
  readAt: string;
  fileModifiedMs: number;
  fileSizeBytes: number;
  /** Rows read but held out of surveillance, with the reason. Counted and shown
   * rather than silently dropped: a laboratory must be able to reconcile the
   * uploader's totals against WHONET's own record count. */
  excluded: Array<{ key: string; rowIndex: number; reason: ExclusionReason }>;
  /** SPEC_CODE to SPEC_TYPE, learned from this file. See learnSpecimenCodeMap. */
  specimenCodeMap: Record<string, string>;
}

export type ExclusionReason = "no_organism" | "no_results";

export interface ReadOptions {
  /** Only read isolates on or after this date, for incremental sync. */
  since?: Date;
  limit?: number;
  /** Keep isolates that name an organism but carry no susceptibility result.
   * Off by default: a row with neither an organism nor an antimicrobial result
   * is not a surveillance record. */
  includeUntestedIsolates?: boolean;
}

/**
 * Read the file whole.
 *
 * Nothing is filtered out here beyond the exclusions the dataset reports, and
 * every column is carried so the grid can show the laboratory its own data
 * unchanged. The identifiers this loads never leave the machine: the batch is
 * built from an allow-list in deidentify.ts, which has no route for them.
 */
export function readDataset(
  databasePath: string,
  profile: ColumnProfile,
  options: ReadOptions = {},
): WhonetDataset {
  const stats = statSync(databasePath);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = db
      .prepare<[string], { name: string }>(`SELECT name FROM pragma_table_info(?)`)
      .all(profile.table)
      .map((row) => row.name);

    const agentColumns =
      profile.resultLayout === "wide"
        ? matchAntibioticColumns(columns, profile.antibioticColumnPattern ?? DEFAULT_AGENT_PATTERN)
        : [];

    // Every column is selected: the grid shows the file as WHONET shows it, and
    // a column the profile does not name is still the laboratory's own data.
    // The table name comes from the stored profile, not from this run's input,
    // and is quoted so a name containing a quote cannot alter the statement.
    let sql = `SELECT * FROM "${profile.table.replaceAll('"', '""')}"`;
    const parameters: unknown[] = [];

    if (options.since) {
      const since = options.since.toISOString().slice(0, 10);
      const sd = quote(profile.specimenDate);
      // The primary date column filters most rows; a row whose primary date is
      // blank is kept when its fallback date is in range, so incremental sync
      // reaches the same fallback-dated isolates the first upload does rather
      // than dropping them the moment a since marker exists.
      if (profile.specimenDateFallback) {
        const fb = quote(profile.specimenDateFallback);
        sql += ` WHERE (${sd} >= ? OR (${sd} IS NULL AND ${fb} >= ?))`;
        parameters.push(since, since);
      } else {
        sql += ` WHERE ${sd} >= ?`;
        parameters.push(since);
      }
    }
    if (options.limit) sql += ` LIMIT ${Number(options.limit)}`;

    const rows = db.prepare(sql).all(...parameters) as Array<Record<string, unknown>>;

    const records: WhonetRecord[] = [];
    const excluded: WhonetDataset["excluded"] = [];

    rows.forEach((row, ordinal) => {
      const record = toRecord(row, ordinal, profile, agentColumns, columns);
      const hasOrganism = record.organismCode !== null && !isNoOrganism(record.organismCode);
      if (!hasOrganism) {
        excluded.push({ key: record.key, rowIndex: record.rowIndex, reason: "no_organism" });
        return;
      }
      if (record.readings.length === 0 && !options.includeUntestedIsolates) {
        excluded.push({ key: record.key, rowIndex: record.rowIndex, reason: "no_results" });
        return;
      }
      records.push(record);
    });

    return {
      path: databasePath,
      table: profile.table,
      columns,
      agentColumns,
      records,
      readAt: new Date().toISOString(),
      fileModifiedMs: stats.mtimeMs,
      fileSizeBytes: stats.size,
      excluded,
      specimenCodeMap: learnSpecimenCodeMap(records),
    };
  } finally {
    db.close();
  }
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function toRecord(
  row: Record<string, unknown>,
  ordinal: number,
  profile: ColumnProfile,
  agentColumns: AgentColumn[],
  columns: string[],
): WhonetRecord {
  const at = (column: string | null | undefined): string | null =>
    column ? asText(row[column]) : null;

  const specimenDate = asDate(row[profile.specimenDate]);
  const entryDate = profile.specimenDateFallback ? asDate(row[profile.specimenDateFallback]) : null;
  const careSettingRaw = at(profile.careSetting) ?? at(profile.patientType);

  const raw: Record<string, string | null> = {};
  for (const column of columns) raw[column] = asText(row[column]);

  const rowKeyValue = profile.rowKey ? asText(row[profile.rowKey]) : null;

  return {
    key: rowKeyValue ?? `row:${ordinal + 1}`,
    rowIndex: ordinal + 1,
    patientIdentifier: at(profile.patientIdentifier),
    specimenNumber: at(profile.specimenNumber),
    specimenDate: specimenDate ?? entryDate,
    specimenDateSource: specimenDate ? "specimen" : entryDate ? "entry" : null,
    dateEntered: entryDate,
    sex: at(profile.sex),
    ageYears: profile.ageYears ? asNumber(row[profile.ageYears]) : null,
    dateOfBirth: profile.dateOfBirth ? asDate(row[profile.dateOfBirth]) : null,
    careSettingRaw,
    careSetting: careSettingOf(careSettingRaw),
    ward: at(profile.ward),
    department: at(profile.department),
    institution: at(profile.institution),
    laboratory: at(profile.laboratory),
    patientType: at(profile.patientType),
    organismCode: at(profile.organism)?.toLowerCase() ?? null,
    organismType: at(profile.organismType),
    specimenTypeCode: at(profile.specimenType)?.toLowerCase() ?? null,
    specimenNumericCode: at(profile.specimenNumericCode),
    specimenReason: at(profile.specimenReason),
    betaLactamase: at(profile.betaLactamase),
    esbl: at(profile.esbl),
    comment: at(profile.comment),
    readings: agentColumns
      .map((entry) => readReading(row[entry.column], entry))
      .filter((entry): entry is WhonetReading => entry !== null),
    raw,
  };
}

/**
 * What each numeric specimen code means, learned from the file itself.
 *
 * WHONET carries the specimen twice — a type code (`ur`) and a numeric code
 * (`11`) — and the numbering is a national or local configuration, not a
 * standard the uploader could ship a table for. Deriving it from the rows where
 * both are present is exact for this file and lets a row that has only the
 * number be repaired without anyone guessing: it is what this laboratory itself
 * recorded everywhere else. Ambiguous numbers (two type codes seen against one
 * number) are left out — a repair has to be certain to be offered.
 */
export function learnSpecimenCodeMap(records: WhonetRecord[]): Record<string, string> {
  const seen = new Map<string, Map<string, number>>();
  for (const record of records) {
    const numeric = record.specimenNumericCode?.trim();
    const type = record.specimenTypeCode?.trim().toLowerCase();
    if (!numeric || !type) continue;
    const counts = seen.get(numeric) ?? new Map<string, number>();
    counts.set(type, (counts.get(type) ?? 0) + 1);
    seen.set(numeric, counts);
  }

  const map: Record<string, string> = {};
  for (const [numeric, counts] of seen) {
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [best, next] = ranked;
    if (!best) continue;
    // A single dominant type, by a clear margin, or nothing.
    if (!next || best[1] >= next[1] * 4) map[numeric] = best[0];
  }
  return map;
}

const CATEGORICAL = new Set(["S", "I", "R", "SDD", "NS"]);

/**
 * Read one AST cell.
 *
 * WHONET's `_ND` columns hold whatever the laboratory records, and that differs
 * by site: some enter an interpreted category, others enter the **raw zone
 * diameter in millimetres**. Validation against two real Ghanaian exports found
 * the latter — every AST value in both files was a millimetre measurement with
 * no interpretation anywhere in the file.
 *
 * Treating a measurement as a category is the dangerous direction: "14" is not a
 * recognised category, so it would be recorded as *not interpretable* and
 * silently dropped from every denominator. The antibiogram would render
 * "insufficient data" everywhere while the upload reported success — a wrong
 * answer that looks like a working system.
 *
 * So the value decides, and the cell keeps both halves of what it says: the
 * measurement, and the category if the laboratory wrote one. Turning the first
 * into the second is interpret.ts's job, against a breakpoint table, never here.
 */
export function readReading(raw: unknown, entry: AgentColumn): WhonetReading | null {
  const text = asText(raw);
  if (text === null) return null; // Agent not set up on this isolate.

  const upper = text.toUpperCase();
  const base = {
    antibioticCode: entry.code,
    canonicalCode: entry.canonicalCode,
    column: entry.column,
    method: entry.method,
    potency: entry.potency,
    raw: text,
  };

  if (CATEGORICAL.has(upper)) {
    return {
      ...base,
      zoneDiameterMm: null,
      micValue: null,
      micOperator: null,
      recordedCategory: upper,
      quantitative: false,
      unreadable: false,
    };
  }

  const operator = /^([<>]=?|=|≤|≥)/.exec(text)?.[1] ?? null;
  const magnitude = asNumber(text);
  if (magnitude !== null) {
    const isDisk = entry.method === "disk_diffusion";
    return {
      ...base,
      zoneDiameterMm: isDisk ? Math.round(magnitude) : null,
      micValue: isDisk ? null : magnitude,
      micOperator: isDisk ? null : normaliseOperator(operator),
      recordedCategory: null,
      quantitative: true,
      unreadable: false,
    };
  }

  // Recorded, but neither a category nor a measurement — a comment, a flag, or
  // a typo. Kept so the tested count still reconciles with the laboratory's own
  // records, and raised in the validation queue so someone can fix it.
  return {
    ...base,
    zoneDiameterMm: null,
    micValue: null,
    micOperator: null,
    recordedCategory: null,
    quantitative: false,
    unreadable: true,
  };
}

function normaliseOperator(operator: string | null): string | null {
  if (operator === null) return null;
  if (operator === "≤") return "<=";
  if (operator === "≥") return ">=";
  return operator;
}

export function matchAntibioticColumns(columns: string[], pattern: string): AgentColumn[] {
  const expression = new RegExp(pattern, "i");
  const matched: AgentColumn[] = [];
  for (const column of columns) {
    const match = expression.exec(column);
    if (match?.[1] && match[2]) {
      const code = match[1].toUpperCase();
      const methodCode = match[2].toUpperCase();
      matched.push({
        column,
        code,
        canonicalCode: canonicalAntibioticCode(code),
        methodCode,
        method: methodCode === "ND" ? "disk_diffusion" : methodCode === "NE" ? "gradient" : "mic",
        potency: match[3] ? match[3].replaceAll("_", ".") : null,
      });
    }
  }
  return matched;
}

/* ------------------------------------------------------------------ *
 * The batch path.
 *
 * `readIsolates` is the adapter from the dataset onto the shape
 * de-identification consumes. It reads through `readDataset` rather than
 * issuing its own query, so the rows that are uploaded are the same rows the
 * laboratory reviewed on screen — one reader, one truth.
 * ------------------------------------------------------------------ */

export function readIsolates(
  databasePath: string,
  profile: ColumnProfile,
  options: ReadOptions = {},
): SourceIsolate[] {
  return toSourceIsolates(readDataset(databasePath, profile, options).records);
}

export function toSourceIsolates(records: WhonetRecord[]): SourceIsolate[] {
  const isolates: SourceIsolate[] = [];
  for (const record of records) {
    // A row missing any of these cannot be deduplicated, dated, or attributed.
    // Held back here and reported by the validation queue rather than
    // transmitted with invented values.
    if (
      !record.patientIdentifier ||
      !record.specimenDate ||
      !record.organismCode ||
      !record.specimenTypeCode
    ) {
      continue;
    }
    if (isNoOrganism(record.organismCode)) continue;

    isolates.push({
      patientIdentifier: record.patientIdentifier,
      specimenDate: record.specimenDate,
      specimenNumber: record.specimenNumber,
      sex: record.sex,
      ageYears: record.ageYears,
      dateOfBirth: record.dateOfBirth,
      careSetting: record.careSettingRaw,
      organismCode: canonicalOrganismCode(record.organismCode),
      specimenTypeCode: canonicalSpecimenCode(record.specimenTypeCode),
      results: record.readings.map((reading) => ({
        antibioticCode: reading.canonicalCode,
        // A measurement with no category travels as PI — pending
        // interpretation. It is good data the server can resolve against its
        // own breakpoint table; NI would bury it permanently.
        result: reading.recordedCategory ?? (reading.quantitative ? "PI" : "NI"),
        micValue: reading.micValue,
        micOperator: reading.micOperator,
        zoneDiameterMm: reading.zoneDiameterMm,
        testMethod: reading.method === "disk_diffusion" ? "disk_diffusion" : "mic",
      })),
    });
  }
  return isolates;
}

/** Classify how a file records its AST results, for the confirmation screen. */
export function summariseResultEncoding(
  databasePath: string,
  profile: ColumnProfile,
): { categorical: number; quantitative: number; unreadable: number } {
  const summary = { categorical: 0, quantitative: 0, unreadable: 0 };
  for (const record of readDataset(databasePath, profile).records) {
    for (const reading of record.readings) {
      if (reading.quantitative) summary.quantitative += 1;
      else if (reading.unreadable) summary.unreadable += 1;
      else summary.categorical += 1;
    }
  }
  return summary;
}

export function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

export function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[<>=≤≥]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** WHONET files carry dates in several formats depending on version and locale.
 * An unparseable date returns null and the row is raised in the validation
 * queue, rather than being coerced to today and quietly misdating a specimen. */
export function asDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const text = String(value).trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return utc(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (dmy) return utc(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return utc(Number(compact[1]), Number(compact[2]), Number(compact[3]));

  return null;
}

function utc(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}
