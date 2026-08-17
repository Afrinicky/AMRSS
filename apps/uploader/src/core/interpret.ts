/**
 * Turning a measurement into a susceptibility category, on the bench machine.
 *
 * A laboratory reading its own WHONET file sees zone diameters. What it needs to
 * see before it uploads — and what the grid shows by default — is S, I, R or
 * SDD. This module is what converts the one into the other.
 *
 * Three rules govern the conversion, mirroring the platform's own engine
 * (`apps/api/amrss/analytics/interpretation.py`). Each exists to stop a specific
 * way of showing a number that is not true:
 *
 * 1. **No breakpoint table, no interpretation.** Nothing here invents a
 *    threshold. With no table loaded every measurement reads as *pending*, which
 *    is honest, and the interface says so rather than rendering a plausible
 *    letter.
 * 2. **"No criterion for this combination" is pending, not uninterpretable.**
 *    The measurement is good; the table simply does not cover it yet. A fuller
 *    edition must be able to recover it.
 * 3. **A category the laboratory recorded is the laboratory's.** It is shown as
 *    theirs and never overwritten. Where the recorded category and the table
 *    disagree, that disagreement is surfaced — it is a finding for the data
 *    steward, not something to paper over.
 *
 * No breakpoint values ship with AMRSS. The table is the laboratory's own
 * licensed CLSI edition, synced from the platform or imported from the same
 * template CSV the platform imports (`data/breakpoints/clsi_m100.template.csv`).
 */

import { clsiGroupsFor, lookupSpecimen } from "./dictionary";
import type { WhonetReading, WhonetRecord } from "./whonet";

export type Category = "S" | "SDD" | "I" | "R" | "NS";
export type InterpretedCategory = Category | "PI" | "NI";

/** One row of the breakpoint template, as stored by the platform. Values arrive
 * as strings or numbers depending on the source and are coerced on read. */
export interface BreakpointCriterion {
  organism_group: string;
  agent_code: string;
  method: string;
  standard?: string | null;
  table_reference?: string | null;
  tier?: string | null;
  site?: string | null;
  route?: string | null;
  disk_content?: string | null;
  mic_susceptible_max?: string | number | null;
  mic_sdd_min?: string | number | null;
  mic_sdd_max?: string | number | null;
  mic_intermediate_min?: string | number | null;
  mic_intermediate_max?: string | number | null;
  mic_resistant_min?: string | number | null;
  disk_susceptible_min?: string | number | null;
  disk_sdd_min?: string | number | null;
  disk_sdd_max?: string | number | null;
  disk_intermediate_min?: string | number | null;
  disk_intermediate_max?: string | number | null;
  disk_resistant_max?: string | number | null;
  comment?: string | null;
}

export interface BreakpointSet {
  version: string | null;
  label: string | null;
  effectiveFrom: string | null;
  /** Where the table came from — the platform, or a file imported here. */
  source: "platform" | "local-import" | "none";
  syncedAt: string | null;
  criteria: BreakpointCriterion[];
}

export const EMPTY_BREAKPOINTS: BreakpointSet = {
  version: null,
  label: null,
  effectiveFrom: null,
  source: "none",
  syncedAt: null,
  criteria: [],
};

export type PendingReason =
  | "no_breakpoint_table"
  | "no_criterion"
  | "unknown_organism"
  | "off_scale_ambiguous"
  | "implausible_measurement"
  | "not_a_measurement";

export interface Interpretation {
  category: InterpretedCategory;
  /** "laboratory" when the category is the one the laboratory recorded,
   * "engine" when this module derived it, "none" when it could not. */
  origin: "laboratory" | "engine" | "none";
  reason: PendingReason | null;
  criterion: BreakpointCriterion | null;
  /** Set when the laboratory's own category and the table disagree. */
  conflictsWithRecorded: boolean;
}

/**
 * A breakpoint table indexed for lookup.
 *
 * Built once per read rather than per cell: a 900-row table against 268
 * isolates and 50 agents is 13,000 lookups, and a linear scan each time is the
 * difference between an instant grid and a visible pause.
 */
export class BreakpointIndex {
  private readonly byAgent = new Map<string, BreakpointCriterion[]>();

  constructor(readonly set: BreakpointSet) {
    for (const criterion of set.criteria) {
      const code = (criterion.agent_code ?? "").trim().toUpperCase();
      if (!code) continue;
      const bucket = this.byAgent.get(code) ?? [];
      bucket.push(criterion);
      this.byAgent.set(code, bucket);
    }
  }

  get loaded(): boolean {
    return this.set.criteria.length > 0;
  }

  get version(): string | null {
    return this.set.version;
  }

  /** Every agent code the table covers, for the coverage report. */
  agents(): string[] {
    return [...this.byAgent.keys()].sort();
  }

  candidates(agentCode: string): BreakpointCriterion[] {
    return this.byAgent.get(agentCode.trim().toUpperCase()) ?? [];
  }
}

/** WHONET method to the template's `method` value. */
function methodToken(method: WhonetReading["method"]): string {
  if (method === "disk_diffusion") return "DISK";
  if (method === "gradient") return "GRADIENT";
  return "MIC";
}

/**
 * Site qualifiers M100 tabulates separately, derived from the specimen.
 *
 * Only the ones that change a threshold are derived, and only where the
 * specimen makes the site unambiguous: cerebrospinal fluid is meningitis, urine
 * is a urinary tract isolate. Everything else carries no qualifier and matches
 * the unqualified criterion, which is the correct default — an incorrect
 * qualifier would silently select the wrong breakpoint.
 */
export function siteQualifiers(specimenTypeCode: string | null): string[] {
  if (!specimenTypeCode) return [];
  const specimen = lookupSpecimen(specimenTypeCode);
  const site = specimen?.infectionSite ?? "";
  if (site === "central nervous system") return ["meningitis"];
  if (site === "urinary tract") return ["uti", "uti_uncomplicated", "urine"];
  if (site === "bloodstream") return ["non_meningitis", "bacteraemia"];
  return ["non_meningitis"];
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Choose the criterion that applies to this isolate and agent.
 *
 * Specificity decides, in the order M100 itself is organised: a criterion for
 * the species beats one for the genus, which beats one for the family. Within
 * equal specificity, a criterion qualified by this isolate's site beats an
 * unqualified one, and a criterion qualified by a *different* site is not
 * eligible at all.
 */
export function selectCriterion(
  index: BreakpointIndex,
  agentCode: string,
  method: WhonetReading["method"],
  organismCode: string | null,
  specimenTypeCode: string | null,
): BreakpointCriterion | null {
  if (!organismCode) return null;
  const groups = clsiGroupsFor(organismCode);
  if (groups.length === 0) return null;

  const wantedMethod = methodToken(method);
  const qualifiers = new Set(siteQualifiers(specimenTypeCode));
  const candidates = index
    .candidates(agentCode)
    .filter((criterion) => (criterion.method ?? "").trim().toUpperCase() === wantedMethod);

  for (const group of groups) {
    const normalised = group.trim().toLowerCase();
    const forGroup = candidates.filter(
      (criterion) => (criterion.organism_group ?? "").trim().toLowerCase() === normalised,
    );
    if (forGroup.length === 0) continue;

    const siteMatched = forGroup.find((criterion) => {
      const site = (criterion.site ?? "").trim().toLowerCase();
      return site !== "" && qualifiers.has(site);
    });
    if (siteMatched) return siteMatched;

    const unqualified = forGroup.find((criterion) => !(criterion.site ?? "").trim());
    if (unqualified) return unqualified;
  }

  return null;
}

/** Zone diameters that no disk test produces. A 4 mm zone is smaller than the
 * disk itself and a 60 mm one is off the plate; both are transcription errors,
 * and interpreting them would launder a typo into a clinical category. */
export const MIN_PLAUSIBLE_ZONE_MM = 6;
export const MAX_PLAUSIBLE_ZONE_MM = 50;

export function interpretReading(
  reading: WhonetReading,
  organismCode: string | null,
  specimenTypeCode: string | null,
  index: BreakpointIndex,
): Interpretation {
  const recorded = reading.recordedCategory as Category | null;

  // Nothing usable in the cell at all.
  if (!recorded && !reading.quantitative) {
    return {
      category: "NI",
      origin: "none",
      reason: "not_a_measurement",
      criterion: null,
      conflictsWithRecorded: false,
    };
  }

  const derived = deriveCategory(reading, organismCode, specimenTypeCode, index);

  if (recorded) {
    // The laboratory's own reading stands. Where the table disagrees, both are
    // known and the disagreement is reported.
    return {
      category: recorded,
      origin: "laboratory",
      reason: null,
      criterion: derived.criterion,
      conflictsWithRecorded:
        derived.category !== null && derived.category !== recorded && derived.criterion !== null,
    };
  }

  if (derived.category === null) {
    return {
      category: derived.reason === "not_a_measurement" ? "NI" : "PI",
      origin: "none",
      reason: derived.reason,
      criterion: null,
      conflictsWithRecorded: false,
    };
  }

  return {
    category: derived.category,
    origin: "engine",
    reason: null,
    criterion: derived.criterion,
    conflictsWithRecorded: false,
  };
}

function deriveCategory(
  reading: WhonetReading,
  organismCode: string | null,
  specimenTypeCode: string | null,
  index: BreakpointIndex,
): { category: Category | null; reason: PendingReason | null; criterion: BreakpointCriterion | null } {
  if (!index.loaded) {
    return { category: null, reason: "no_breakpoint_table", criterion: null };
  }
  if (!organismCode || clsiGroupsFor(organismCode).length === 0) {
    return { category: null, reason: "unknown_organism", criterion: null };
  }

  const criterion = selectCriterion(
    index,
    reading.canonicalCode,
    reading.method,
    organismCode,
    specimenTypeCode,
  );
  if (!criterion) return { category: null, reason: "no_criterion", criterion: null };

  if (reading.method === "disk_diffusion") {
    const zone = reading.zoneDiameterMm;
    if (zone === null) return { category: null, reason: "not_a_measurement", criterion };
    if (zone < MIN_PLAUSIBLE_ZONE_MM || zone > MAX_PLAUSIBLE_ZONE_MM) {
      return { category: null, reason: "implausible_measurement", criterion };
    }
    return { category: categoriseDisk(zone, criterion), reason: null, criterion };
  }

  const mic = reading.micValue;
  if (mic === null) return { category: null, reason: "not_a_measurement", criterion };
  return categoriseMic(mic, reading.micOperator, criterion);
}

/**
 * Disk diffusion runs opposite to MIC: a larger zone means more susceptible.
 *
 * The bands are read outward from susceptible so that a table giving only
 * `disk_susceptible_min` still reports S or non-susceptible, which is what a
 * partial edition supports and all it supports.
 */
export function categoriseDisk(zone: number, criterion: BreakpointCriterion): Category | null {
  const susceptibleMin = toNumber(criterion.disk_susceptible_min);
  const resistantMax = toNumber(criterion.disk_resistant_max);
  const sddMin = toNumber(criterion.disk_sdd_min);
  const sddMax = toNumber(criterion.disk_sdd_max);
  const intermediateMin = toNumber(criterion.disk_intermediate_min);
  const intermediateMax = toNumber(criterion.disk_intermediate_max);

  if (susceptibleMin !== null && zone >= susceptibleMin) return "S";
  if (sddMin !== null && sddMax !== null && zone >= sddMin && zone <= sddMax) return "SDD";
  if (
    intermediateMin !== null &&
    intermediateMax !== null &&
    zone >= intermediateMin &&
    zone <= intermediateMax
  ) {
    return "I";
  }
  if (resistantMax !== null && zone <= resistantMax) return "R";

  // A susceptible-only table: anything below the susceptible cut-off is
  // non-susceptible, which is the category CLSI defines for exactly this case.
  if (susceptibleMin !== null && resistantMax === null && intermediateMin === null) return "NS";

  return null;
}

/**
 * An MIC is not a number.
 *
 * `<=4` against a susceptible breakpoint of `2` is *not* susceptible — the true
 * MIC could be 4. An off-scale reading is only categorised when the answer holds
 * for every value consistent with it; otherwise it stays pending with a stated
 * reason. The engine never guesses in the direction of susceptibility.
 */
export function categoriseMic(
  mic: number,
  operator: string | null,
  criterion: BreakpointCriterion,
): { category: Category | null; reason: PendingReason | null; criterion: BreakpointCriterion } {
  const susceptibleMax = toNumber(criterion.mic_susceptible_max);
  const resistantMin = toNumber(criterion.mic_resistant_min);
  const sddMin = toNumber(criterion.mic_sdd_min);
  const sddMax = toNumber(criterion.mic_sdd_max);
  const intermediateMin = toNumber(criterion.mic_intermediate_min);
  const intermediateMax = toNumber(criterion.mic_intermediate_max);

  const lessThan = operator === "<" || operator === "<=";
  const greaterThan = operator === ">" || operator === ">=";

  if (lessThan) {
    // "<= x" is susceptible only if x itself is susceptible; the true value is
    // somewhere at or below x and every one of those values must be S.
    if (susceptibleMax !== null && mic <= susceptibleMax) return ok("S", criterion);
    return pending("off_scale_ambiguous", criterion);
  }

  if (greaterThan) {
    if (resistantMin !== null && mic >= resistantMin) return ok("R", criterion);
    if (susceptibleMax !== null && mic > susceptibleMax && resistantMin === null) {
      return ok("NS", criterion);
    }
    return pending("off_scale_ambiguous", criterion);
  }

  if (susceptibleMax !== null && mic <= susceptibleMax) return ok("S", criterion);
  if (sddMin !== null && sddMax !== null && mic >= sddMin && mic <= sddMax) {
    return ok("SDD", criterion);
  }
  if (
    intermediateMin !== null &&
    intermediateMax !== null &&
    mic >= intermediateMin &&
    mic <= intermediateMax
  ) {
    return ok("I", criterion);
  }
  if (resistantMin !== null && mic >= resistantMin) return ok("R", criterion);
  if (susceptibleMax !== null && resistantMin === null && intermediateMin === null) {
    return ok("NS", criterion);
  }
  return pending("no_criterion", criterion);
}

function ok(
  category: Category,
  criterion: BreakpointCriterion,
): { category: Category; reason: null; criterion: BreakpointCriterion } {
  return { category, reason: null, criterion };
}

function pending(
  reason: PendingReason,
  criterion: BreakpointCriterion,
): { category: null; reason: PendingReason; criterion: BreakpointCriterion } {
  return { category: null, reason, criterion };
}

/** Every cell of one isolate, interpreted. Keyed by the WHONET column so the
 * grid can line an interpretation up with the value it came from. */
export function interpretRecord(
  record: WhonetRecord,
  index: BreakpointIndex,
): Map<string, Interpretation> {
  const result = new Map<string, Interpretation>();
  for (const reading of record.readings) {
    result.set(
      reading.column,
      interpretReading(reading, record.organismCode, record.specimenTypeCode, index),
    );
  }
  return result;
}

export interface CoverageReport {
  measurements: number;
  interpreted: number;
  laboratoryReported: number;
  pending: number;
  notInterpretable: number;
  coveragePercent: number;
  conflicts: number;
  /** Organism / agent / method combinations the table does not cover, most
   * frequent first, so the next import can be prioritised by impact. */
  uncovered: Array<{ combination: string; measurements: number }>;
}

export function coverageReport(records: WhonetRecord[], index: BreakpointIndex): CoverageReport {
  let measurements = 0;
  let interpreted = 0;
  let laboratoryReported = 0;
  let pending = 0;
  let notInterpretable = 0;
  let conflicts = 0;
  const uncovered = new Map<string, number>();

  for (const record of records) {
    for (const reading of record.readings) {
      measurements += 1;
      const interpretation = interpretReading(
        reading,
        record.organismCode,
        record.specimenTypeCode,
        index,
      );
      if (interpretation.conflictsWithRecorded) conflicts += 1;
      if (interpretation.origin === "laboratory") laboratoryReported += 1;
      else if (interpretation.origin === "engine") interpreted += 1;
      else if (interpretation.category === "NI") notInterpretable += 1;
      else {
        pending += 1;
        if (interpretation.reason === "no_criterion" || interpretation.reason === "unknown_organism") {
          const key = `${record.organismCode ?? "?"} / ${reading.canonicalCode} / ${reading.method}`;
          uncovered.set(key, (uncovered.get(key) ?? 0) + 1);
        }
      }
    }
  }

  return {
    measurements,
    interpreted,
    laboratoryReported,
    pending,
    notInterpretable,
    coveragePercent:
      measurements === 0 ? 0 : ((interpreted + laboratoryReported) / measurements) * 100,
    conflicts,
    uncovered: [...uncovered.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([combination, count]) => ({ combination, measurements: count })),
  };
}

/**
 * Parse the breakpoint template CSV, for a laboratory importing its table into
 * the uploader directly.
 *
 * Deliberately the same file the platform imports, so a laboratory maintains one
 * transcription of its licensed edition rather than two. Structural validation
 * happens on the platform at import; here the parse is lenient about optional
 * columns and strict about the four the engine cannot work without.
 */
export function parseBreakpointCsv(text: string): {
  criteria: BreakpointCriterion[];
  problems: string[];
} {
  const problems: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  if (lines.length === 0) return { criteria: [], problems: ["the file is empty"] };

  const header = splitCsvLine(lines[0]!).map((cell) => cell.trim().toLowerCase());
  const required = ["organism_group", "agent_code", "method"];
  for (const column of required) {
    if (!header.includes(column)) problems.push(`missing required column: ${column}`);
  }
  if (problems.length > 0) return { criteria: [], problems };

  const criteria: BreakpointCriterion[] = [];
  for (const [offset, line] of lines.slice(1).entries()) {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((name, position) => {
      row[name] = (cells[position] ?? "").trim();
    });
    if (!row.organism_group && !row.agent_code) continue;

    const lineNumber = offset + 2;
    if (!row.organism_group) problems.push(`line ${lineNumber}: organism_group is required`);
    if (!row.agent_code) problems.push(`line ${lineNumber}: agent_code is required`);
    const method = (row.method ?? "").toUpperCase();
    if (!["MIC", "DISK", "GRADIENT"].includes(method)) {
      problems.push(`line ${lineNumber}: method ${row.method ?? ""} is not MIC, DISK or GRADIENT`);
      continue;
    }

    criteria.push({
      ...(row as unknown as BreakpointCriterion),
      organism_group: row.organism_group ?? "",
      agent_code: (row.agent_code ?? "").toUpperCase(),
      method,
    });
  }

  return { criteria, problems };
}

/** A minimal RFC 4180 reader: quoted cells, doubled quotes inside them. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let position = 0; position < line.length; position += 1) {
    const character = line[position];
    if (quoted) {
      if (character === '"') {
        if (line[position + 1] === '"') {
          cell += '"';
          position += 1;
        } else quoted = false;
      } else cell += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      cells.push(cell);
      cell = "";
    } else cell += character;
  }
  cells.push(cell);
  return cells;
}
