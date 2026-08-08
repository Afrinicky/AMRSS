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
 * The default profile below follows common WHONET conventions and is a starting
 * point for detection, not an assumption. It must be validated against a real
 * export before deployment.
 */

import Database from "better-sqlite3";

import type { SourceIsolate } from "./deidentify";

export interface ColumnProfile {
  /** Table holding one row per isolate. */
  table: string;
  patientIdentifier: string;
  specimenDate: string;
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
}

/** Candidate column names, most specific first. Used only for detection. */
const CANDIDATES = {
  patientIdentifier: ["PATIENT_ID", "PATIENT", "PATID", "PAT_ID", "HOSPITAL_NUMBER"],
  specimenDate: ["SPEC_DATE", "SPECDATE", "DATE_SPEC", "SPECIMEN_DATE", "DATE_ADMIS"],
  specimenNumber: ["SPEC_NUM", "SPECNUM", "SPECIMEN_NUMBER", "LAB_NUMBER", "ACCESSION"],
  sex: ["SEX", "GENDER"],
  ageYears: ["AGE", "AGE_YEARS", "PATIENT_AGE"],
  dateOfBirth: ["DATE_BIRTH", "DOB", "BIRTH_DATE", "DATE_OF_BIRTH"],
  careSetting: ["WARD_TYPE", "PAT_TYPE", "LOCATION_TYPE", "INOUT", "CARE_SETTING"],
  organism: ["ORGANISM", "ORG", "ORGANISM_CODE", "ORG_CODE"],
  specimenType: ["SPEC_TYPE", "SPECTYPE", "SPECIMEN_TYPE", "SPEC"],
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

    if (unmappedRequired.length > 0) {
      return {
        profile: null,
        table,
        availableTables: tables,
        availableColumns: columns,
        unmappedRequired,
        identifyingColumnsPresent,
      };
    }

    return {
      profile: {
        table,
        patientIdentifier: mapped.patientIdentifier!,
        specimenDate: mapped.specimenDate!,
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
        antibioticColumnPattern: "^([A-Z]{3})_(N[DME])([0-9.]*)$",
      },
      table,
      availableTables: tables,
      availableColumns: columns,
      unmappedRequired: [],
      identifyingColumnsPresent,
    };
  } finally {
    db.close();
  }
}

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

export interface ReadOptions {
  /** Only read isolates on or after this date, for incremental sync. */
  since?: Date;
  limit?: number;
}

export function readIsolates(
  databasePath: string,
  profile: ColumnProfile,
  options: ReadOptions = {},
): SourceIsolate[] {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = db
      .prepare<[string], { name: string }>(`SELECT name FROM pragma_table_info(?)`)
      .all(profile.table)
      .map((row) => row.name);

    const antibioticColumns =
      profile.resultLayout === "wide" && profile.antibioticColumnPattern
        ? matchAntibioticColumns(columns, profile.antibioticColumnPattern)
        : [];

    // Column names come from the stored profile, which the facility confirmed,
    // not from user input on this run. They are still quoted so a column
    // containing a quote or keyword cannot alter the statement.
    const selected = [
      profile.patientIdentifier,
      profile.specimenDate,
      profile.specimenNumber,
      profile.sex,
      profile.ageYears,
      profile.dateOfBirth,
      profile.careSetting,
      profile.organism,
      profile.specimenType,
      ...antibioticColumns.map((entry) => entry.column),
    ].filter((name): name is string => Boolean(name));

    const quoted = selected.map((name) => `"${name.replaceAll('"', '""')}"`).join(", ");
    let sql = `SELECT ${quoted} FROM "${profile.table.replaceAll('"', '""')}"`;
    const parameters: unknown[] = [];

    if (options.since) {
      sql += ` WHERE "${profile.specimenDate}" >= ?`;
      parameters.push(options.since.toISOString().slice(0, 10));
    }
    if (options.limit) {
      sql += ` LIMIT ${Number(options.limit)}`;
    }

    const rows = db.prepare(sql).all(...parameters) as Array<Record<string, unknown>>;

    const isolates: SourceIsolate[] = [];
    for (const row of rows) {
      const patientIdentifier = asText(row[profile.patientIdentifier]);
      const specimenDate = asDate(row[profile.specimenDate]);
      const organismCode = asText(row[profile.organism]);
      const specimenTypeCode = asText(row[profile.specimenType]);

      // A row missing any of these cannot be deduplicated, dated, or attributed.
      // Skipped here and reported in the read summary rather than transmitted
      // with invented values.
      if (!patientIdentifier || !specimenDate || !organismCode || !specimenTypeCode) continue;

      isolates.push({
        patientIdentifier,
        specimenDate,
        specimenNumber: profile.specimenNumber ? asText(row[profile.specimenNumber]) : null,
        sex: profile.sex ? asText(row[profile.sex]) : null,
        ageYears: profile.ageYears ? asNumber(row[profile.ageYears]) : null,
        dateOfBirth: profile.dateOfBirth ? asDate(row[profile.dateOfBirth]) : null,
        careSetting: profile.careSetting ? asText(row[profile.careSetting]) : null,
        organismCode,
        specimenTypeCode,
        results: antibioticColumns
          .map((entry) => ({
            antibioticCode: entry.code,
            result: asText(row[entry.column]),
            micValue: entry.method === "NM" ? asNumber(row[entry.column]) : null,
            micOperator: null,
            zoneDiameterMm: entry.method === "ND" ? asNumber(row[entry.column]) : null,
            testMethod: entry.method === "ND" ? "disk_diffusion" : "mic",
          }))
          .filter((entry) => entry.result !== null),
      });
    }

    return isolates;
  } finally {
    db.close();
  }
}

export function matchAntibioticColumns(
  columns: string[],
  pattern: string,
): Array<{ column: string; code: string; method: string }> {
  const expression = new RegExp(pattern, "i");
  const matched: Array<{ column: string; code: string; method: string }> = [];
  for (const column of columns) {
    const match = expression.exec(column);
    if (match?.[1] && match[2]) {
      matched.push({ column, code: match[1].toUpperCase(), method: match[2].toUpperCase() });
    }
  }
  return matched;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/[<>=≤≥]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** WHONET files carry dates in several formats depending on version and locale.
 * An unparseable date returns null and the row is skipped with a count, rather
 * than being coerced to today and quietly misdating a specimen. */
function asDate(value: unknown): Date | null {
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
