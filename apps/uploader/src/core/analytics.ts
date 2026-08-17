/**
 * Analysis, computed on the laboratory's own machine.
 *
 * The platform answers regional questions. This answers the laboratory's own,
 * and it can answer more of them: it holds the ward, the department, the
 * specimen number and the data-entry date — everything the batch deliberately
 * leaves behind — so a laboratory can look at its own data in ways regional
 * surveillance never will.
 *
 * Two rules keep the two halves honest with each other:
 *
 * 1. **The same counting rules.** First-isolate deduplication, the minimum
 *    isolate count below which a percentage is not published, and what counts as
 *    interpretable are the platform's rules, applied here. A facility filtering
 *    the regional dashboard to itself must see what it sees here, or one of the
 *    two is lying.
 * 2. **Percentages come from interpretable results only.** A pending
 *    measurement is not a susceptible one. Denominators are stated everywhere a
 *    percentage is, so a 100% that rests on three isolates says so.
 */

import {
  infectionSite,
  lookupAntibiotic,
  lookupOrganism,
  organismLabel,
  specimenLabel,
} from "./dictionary";
import type { AppliedRecord } from "./corrections";
import { BreakpointIndex, type InterpretedCategory, interpretReading } from "./interpret";

export type AgeBand = "<5" | "5-14" | "15-44" | "45-64" | "65+" | "unknown";

export const AGE_BANDS: AgeBand[] = ["<5", "5-14", "15-44", "45-64", "65+", "unknown"];

export function ageBand(years: number | null): AgeBand {
  if (years === null || !Number.isFinite(years) || years < 0 || years > 130) return "unknown";
  if (years < 5) return "<5";
  if (years < 15) return "5-14";
  if (years < 45) return "15-44";
  if (years < 65) return "45-64";
  return "65+";
}

export interface AnalysisFilters {
  dateFrom?: string | null;
  dateTo?: string | null;
  careSetting?: "IPD" | "OPD" | "unknown" | null;
  organismCode?: string | null;
  specimenTypeCode?: string | null;
  infectionSite?: string | null;
  ward?: string | null;
  department?: string | null;
  sex?: string | null;
  ageBand?: AgeBand | null;
}

export interface AnalysisOptions {
  /** Count one isolate per patient per organism, the surveillance convention.
   * Repeat isolates from the same patient describe one infection being treated,
   * not two infections, and counting them all overstates resistance wherever
   * treatment failures are re-cultured. */
  firstIsolateOnly: boolean;
  /** Below this many interpretable results, a percentage is withheld rather
   * than published. A 100% resistance rate over two isolates is not a finding. */
  minimumIsolates: number;
}

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  firstIsolateOnly: true,
  minimumIsolates: 30,
};

/** One isolate, reduced to what analysis needs, with its results interpreted. */
export interface AnalysedIsolate {
  key: string;
  rowIndex: number;
  patientKey: string;
  specimenDate: string | null;
  month: string | null;
  organismCode: string;
  organismName: string;
  gramStain: string | null;
  specimenTypeCode: string | null;
  specimenName: string;
  site: string;
  careSetting: "IPD" | "OPD" | "unknown";
  sex: string;
  ageYears: number | null;
  ageBand: AgeBand;
  ward: string | null;
  department: string | null;
  results: Array<{
    code: string;
    name: string;
    antimicrobialClass: string;
    category: InterpretedCategory;
    origin: "laboratory" | "engine" | "none";
    method: string;
    raw: string;
  }>;
}

export function analyse(records: AppliedRecord[], index: BreakpointIndex): AnalysedIsolate[] {
  const isolates: AnalysedIsolate[] = [];

  for (const record of records) {
    if (!record.organismCode) continue;
    const organism = lookupOrganism(record.organismCode);
    const date = record.specimenDate ? record.specimenDate.toISOString().slice(0, 10) : null;

    isolates.push({
      key: record.key,
      rowIndex: record.rowIndex,
      // Patient identity stays on this machine; it is used to deduplicate and
      // nothing else. The batch carries a salted, irreversible key instead.
      patientKey: (record.patientIdentifier ?? `row:${record.rowIndex}`).trim().toUpperCase(),
      specimenDate: date,
      month: date ? date.slice(0, 7) : null,
      organismCode: record.organismCode,
      organismName: organism?.name ?? record.organismCode,
      gramStain: organism?.gramStain ?? null,
      specimenTypeCode: record.specimenTypeCode,
      specimenName: specimenLabel(record.specimenTypeCode),
      site: infectionSite(record.specimenTypeCode),
      careSetting: record.careSetting,
      sex: normaliseSexToken(record.sex),
      ageYears: record.ageYears,
      ageBand: ageBand(record.ageYears),
      ward: record.ward,
      department: record.department,
      results: record.readings.map((reading) => {
        const interpretation = interpretReading(
          reading,
          record.organismCode,
          record.specimenTypeCode,
          index,
        );
        return {
          code: reading.canonicalCode,
          name: lookupAntibiotic(reading.canonicalCode)?.name ?? reading.canonicalCode,
          antimicrobialClass: lookupAntibiotic(reading.canonicalCode)?.antimicrobialClass ?? "other",
          category: interpretation.category,
          origin: interpretation.origin,
          method: reading.method,
          raw: reading.raw,
        };
      }),
    });
  }

  return isolates;
}

function normaliseSexToken(value: string | null): string {
  const token = (value ?? "").trim().toLowerCase();
  if (["m", "male", "1"].includes(token)) return "male";
  if (["f", "female", "2"].includes(token)) return "female";
  return "unknown";
}

export function applyFilters(
  isolates: AnalysedIsolate[],
  filters: AnalysisFilters,
): AnalysedIsolate[] {
  return isolates.filter((isolate) => {
    if (filters.dateFrom && (!isolate.specimenDate || isolate.specimenDate < filters.dateFrom)) {
      return false;
    }
    if (filters.dateTo && (!isolate.specimenDate || isolate.specimenDate > filters.dateTo)) {
      return false;
    }
    if (filters.careSetting && isolate.careSetting !== filters.careSetting) return false;
    if (filters.organismCode && isolate.organismCode !== filters.organismCode) return false;
    if (filters.specimenTypeCode && isolate.specimenTypeCode !== filters.specimenTypeCode) {
      return false;
    }
    if (filters.infectionSite && isolate.site !== filters.infectionSite) return false;
    if (filters.ward && isolate.ward !== filters.ward) return false;
    if (filters.department && isolate.department !== filters.department) return false;
    if (filters.sex && isolate.sex !== filters.sex) return false;
    if (filters.ageBand && isolate.ageBand !== filters.ageBand) return false;
    return true;
  });
}

/**
 * Keep one isolate per patient per organism.
 *
 * The earliest specimen wins, which is the convention: it is the isolate that
 * described the infection before treatment shaped it.
 */
export function firstIsolates(isolates: AnalysedIsolate[]): AnalysedIsolate[] {
  const chosen = new Map<string, AnalysedIsolate>();
  for (const isolate of isolates) {
    const key = `${isolate.patientKey}|${isolate.organismCode}`;
    const existing = chosen.get(key);
    if (!existing) {
      chosen.set(key, isolate);
      continue;
    }
    const a = existing.specimenDate ?? "9999-12-31";
    const b = isolate.specimenDate ?? "9999-12-31";
    if (b < a) chosen.set(key, isolate);
  }
  return [...chosen.values()].sort((a, b) => a.rowIndex - b.rowIndex);
}

export function forAnalysis(
  isolates: AnalysedIsolate[],
  options: AnalysisOptions,
): AnalysedIsolate[] {
  return options.firstIsolateOnly ? firstIsolates(isolates) : isolates;
}

const INTERPRETABLE = new Set<InterpretedCategory>(["S", "I", "R", "SDD", "NS"]);

export interface SusceptibilityCell {
  tested: number;
  interpretable: number;
  susceptible: number;
  intermediate: number;
  resistant: number;
  susceptiblePercent: number | null;
  resistantPercent: number | null;
  /** True when the denominator is below the reporting threshold. The cell is
   * still shown — a laboratory may look at its own small numbers — but it is
   * marked, and it is what the platform would suppress. */
  belowThreshold: boolean;
}

function emptyCell(): SusceptibilityCell {
  return {
    tested: 0,
    interpretable: 0,
    susceptible: 0,
    intermediate: 0,
    resistant: 0,
    susceptiblePercent: null,
    resistantPercent: null,
    belowThreshold: true,
  };
}

function finaliseCell(cell: SusceptibilityCell, minimum: number): SusceptibilityCell {
  if (cell.interpretable === 0) return { ...cell, belowThreshold: true };
  return {
    ...cell,
    susceptiblePercent: (cell.susceptible / cell.interpretable) * 100,
    resistantPercent: (cell.resistant / cell.interpretable) * 100,
    belowThreshold: cell.interpretable < minimum,
  };
}

function accumulate(cell: SusceptibilityCell, category: InterpretedCategory): void {
  cell.tested += 1;
  if (!INTERPRETABLE.has(category)) return;
  cell.interpretable += 1;
  // SDD is a susceptible category at the dose it names, and NS is counted with
  // resistant: both are how CLSI intends them to be read in a cumulative
  // antibiogram, and doing otherwise would silently shift the rate.
  if (category === "S" || category === "SDD") cell.susceptible += 1;
  else if (category === "I") cell.intermediate += 1;
  else cell.resistant += 1;
}

export interface AntibiogramRow {
  organismCode: string;
  organismName: string;
  isolates: number;
  cells: Record<string, SusceptibilityCell>;
}

export interface Antibiogram {
  antibiotics: Array<{ code: string; name: string; antimicrobialClass: string }>;
  rows: AntibiogramRow[];
  isolateCount: number;
  minimumIsolates: number;
  firstIsolateOnly: boolean;
}

export function antibiogram(
  isolates: AnalysedIsolate[],
  options: AnalysisOptions = DEFAULT_ANALYSIS_OPTIONS,
): Antibiogram {
  const population = forAnalysis(isolates, options);
  const rows = new Map<string, AntibiogramRow>();
  const agents = new Map<string, { code: string; name: string; antimicrobialClass: string }>();

  for (const isolate of population) {
    const row = rows.get(isolate.organismCode) ?? {
      organismCode: isolate.organismCode,
      organismName: isolate.organismName,
      isolates: 0,
      cells: {},
    };
    row.isolates += 1;

    for (const result of isolate.results) {
      agents.set(result.code, {
        code: result.code,
        name: result.name,
        antimicrobialClass: result.antimicrobialClass,
      });
      const cell = row.cells[result.code] ?? emptyCell();
      accumulate(cell, result.category);
      row.cells[result.code] = cell;
    }
    rows.set(isolate.organismCode, row);
  }

  for (const row of rows.values()) {
    for (const [code, cell] of Object.entries(row.cells)) {
      row.cells[code] = finaliseCell(cell, options.minimumIsolates);
    }
  }

  return {
    antibiotics: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)),
    rows: [...rows.values()].sort((a, b) => b.isolates - a.isolates),
    isolateCount: population.length,
    minimumIsolates: options.minimumIsolates,
    firstIsolateOnly: options.firstIsolateOnly,
  };
}

export interface CountRow {
  key: string;
  label: string;
  count: number;
  percent: number;
}

function tally(
  isolates: AnalysedIsolate[],
  keyOf: (isolate: AnalysedIsolate) => string | null,
  labelOf: (key: string) => string,
): CountRow[] {
  const counts = new Map<string, number>();
  for (const isolate of isolates) {
    const key = keyOf(isolate);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      label: labelOf(key),
      count,
      percent: total === 0 ? 0 : (count / total) * 100,
    }))
    .sort((a, b) => b.count - a.count);
}

export function organismFrequency(
  isolates: AnalysedIsolate[],
  options: AnalysisOptions = DEFAULT_ANALYSIS_OPTIONS,
): CountRow[] {
  return tally(forAnalysis(isolates, options), (isolate) => isolate.organismCode, organismLabel);
}

export function specimenFrequency(isolates: AnalysedIsolate[]): CountRow[] {
  return tally(
    isolates,
    (isolate) => isolate.specimenTypeCode,
    (code) => specimenLabel(code),
  );
}

export function siteFrequency(isolates: AnalysedIsolate[]): CountRow[] {
  return tally(
    isolates,
    (isolate) => isolate.site,
    (site) => site,
  );
}

export function wardFrequency(isolates: AnalysedIsolate[]): CountRow[] {
  return tally(
    isolates,
    (isolate) => isolate.ward,
    (ward) => ward,
  );
}

export function departmentFrequency(isolates: AnalysedIsolate[]): CountRow[] {
  return tally(
    isolates,
    (isolate) => isolate.department,
    (department) => department,
  );
}

export function demographicBreakdown(isolates: AnalysedIsolate[]): {
  sex: CountRow[];
  ageBands: CountRow[];
  careSetting: CountRow[];
} {
  return {
    sex: tally(isolates, (isolate) => isolate.sex, (key) => key),
    ageBands: tally(isolates, (isolate) => isolate.ageBand, (key) => key),
    careSetting: tally(isolates, (isolate) => isolate.careSetting, (key) => key),
  };
}

export interface AntibioticProfile {
  code: string;
  name: string;
  antimicrobialClass: string;
  cell: SusceptibilityCell;
  organismCount: number;
}

/** One agent, pooled across every organism tested against it.
 *
 * Pooled figures are shaped by which organisms happened to be isolated, so the
 * organism count travels with the number — the same caveat the platform's
 * antibiotic explorer carries. */
export function antibioticProfiles(
  isolates: AnalysedIsolate[],
  options: AnalysisOptions = DEFAULT_ANALYSIS_OPTIONS,
): AntibioticProfile[] {
  const population = forAnalysis(isolates, options);
  const cells = new Map<string, { profile: AntibioticProfile; organisms: Set<string> }>();

  for (const isolate of population) {
    for (const result of isolate.results) {
      const entry = cells.get(result.code) ?? {
        profile: {
          code: result.code,
          name: result.name,
          antimicrobialClass: result.antimicrobialClass,
          cell: emptyCell(),
          organismCount: 0,
        },
        organisms: new Set<string>(),
      };
      accumulate(entry.profile.cell, result.category);
      entry.organisms.add(isolate.organismCode);
      cells.set(result.code, entry);
    }
  }

  return [...cells.values()]
    .map((entry) => ({
      ...entry.profile,
      cell: finaliseCell(entry.profile.cell, options.minimumIsolates),
      organismCount: entry.organisms.size,
    }))
    .sort((a, b) => b.cell.interpretable - a.cell.interpretable);
}

export interface TrendPoint {
  bucket: string;
  isolates: number;
  interpretable: number;
  resistant: number;
  resistantPercent: number | null;
  belowThreshold: boolean;
}

/**
 * Resistance over time.
 *
 * Buckets with too few interpretable results keep their counts but withhold the
 * percentage. A resistance trend that swings between 0% and 100% because a month
 * held two isolates is not a trend, and drawing it as one is how a laboratory
 * ends up chasing noise.
 */
export function resistanceTrend(
  isolates: AnalysedIsolate[],
  antibioticCode: string,
  options: AnalysisOptions = DEFAULT_ANALYSIS_OPTIONS,
  bucket: "month" | "quarter" = "month",
): TrendPoint[] {
  const population = forAnalysis(isolates, options);
  const buckets = new Map<string, { isolates: number; cell: SusceptibilityCell }>();

  for (const isolate of population) {
    if (!isolate.specimenDate) continue;
    const key = bucket === "month" ? isolate.month! : quarterOf(isolate.specimenDate);
    const entry = buckets.get(key) ?? { isolates: 0, cell: emptyCell() };
    entry.isolates += 1;
    const result = isolate.results.find((candidate) => candidate.code === antibioticCode);
    if (result) accumulate(entry.cell, result.category);
    buckets.set(key, entry);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucketKey, entry]) => {
      const cell = finaliseCell(entry.cell, options.minimumIsolates);
      return {
        bucket: bucketKey,
        isolates: entry.isolates,
        interpretable: cell.interpretable,
        resistant: cell.resistant,
        resistantPercent: cell.resistantPercent,
        belowThreshold: cell.belowThreshold,
      };
    });
}

/** Isolate volume over time, which needs no threshold — a count is a count. */
export function volumeTrend(
  isolates: AnalysedIsolate[],
  bucket: "month" | "quarter" = "month",
): Array<{ bucket: string; isolates: number; patients: number }> {
  const buckets = new Map<string, { isolates: number; patients: Set<string> }>();
  for (const isolate of isolates) {
    if (!isolate.specimenDate) continue;
    const key = bucket === "month" ? isolate.month! : quarterOf(isolate.specimenDate);
    const entry = buckets.get(key) ?? { isolates: 0, patients: new Set<string>() };
    entry.isolates += 1;
    entry.patients.add(isolate.patientKey);
    buckets.set(key, entry);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, entry]) => ({
      bucket: key,
      isolates: entry.isolates,
      patients: entry.patients.size,
    }));
}

function quarterOf(isoDate: string): string {
  const month = Number(isoDate.slice(5, 7));
  return `${isoDate.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`;
}

/**
 * Phenotypes worth counting on their own.
 *
 * These are screening indicators derived from the reported categories, not
 * confirmatory results: an isolate flagged here is one to look at, and the
 * wording says so wherever it is shown. Confirmation is a laboratory
 * procedure — a cefoxitin-resistant *S. aureus* is presumptively MRSA, and
 * calling it MRSA outright would be the software making a diagnosis.
 */
export interface PhenotypeCount {
  key: string;
  label: string;
  description: string;
  isolates: number;
  eligible: number;
  percent: number | null;
}

const MRSA_MARKERS = ["FOX", "OXA"];
const ESBL_MARKERS = ["CTX", "CRO", "CAZ"];
const CARBAPENEMS = ["IPM", "MEM", "ETP"];
const FLUOROQUINOLONES = ["CIP", "LVX", "NOR", "OFX"];

function isResistant(isolate: AnalysedIsolate, codes: string[]): boolean {
  return isolate.results.some(
    (result) =>
      codes.includes(result.code) && (result.category === "R" || result.category === "NS"),
  );
}

function wasTested(isolate: AnalysedIsolate, codes: string[]): boolean {
  return isolate.results.some(
    (result) => codes.includes(result.code) && INTERPRETABLE.has(result.category),
  );
}

export function phenotypes(
  isolates: AnalysedIsolate[],
  options: AnalysisOptions = DEFAULT_ANALYSIS_OPTIONS,
): PhenotypeCount[] {
  const population = forAnalysis(isolates, options);

  const definitions: Array<{
    key: string;
    label: string;
    description: string;
    eligible: (isolate: AnalysedIsolate) => boolean;
    flagged: (isolate: AnalysedIsolate) => boolean;
  }> = [
    {
      key: "mrsa",
      label: "Methicillin-resistant S. aureus (presumptive)",
      description:
        "S. aureus resistant to cefoxitin or oxacillin. A screening indicator — confirm by the laboratory's own method.",
      eligible: (isolate) => isolate.organismCode === "sau" && wasTested(isolate, MRSA_MARKERS),
      flagged: (isolate) => isResistant(isolate, MRSA_MARKERS),
    },
    {
      key: "esbl_suspected",
      label: "Third-generation cephalosporin resistance (ESBL suspected)",
      description:
        "Enterobacterales resistant to ceftriaxone, cefotaxime or ceftazidime. Suggests an ESBL; confirmation is a separate test.",
      eligible: (isolate) =>
        (lookupOrganism(isolate.organismCode)?.isEnterobacterales ?? false) &&
        wasTested(isolate, ESBL_MARKERS),
      flagged: (isolate) => isResistant(isolate, ESBL_MARKERS),
    },
    {
      key: "carbapenem_resistant",
      label: "Carbapenem resistance",
      description:
        "Resistance to imipenem, meropenem or ertapenem. Every isolate here warrants immediate infection-prevention attention.",
      eligible: (isolate) => wasTested(isolate, CARBAPENEMS),
      flagged: (isolate) => isResistant(isolate, CARBAPENEMS),
    },
    {
      key: "vre",
      label: "Vancomycin-resistant Enterococcus (presumptive)",
      description: "Enterococcus resistant to vancomycin. Confirm before reporting as VRE.",
      eligible: (isolate) =>
        lookupOrganism(isolate.organismCode)?.genus === "Enterococcus" &&
        wasTested(isolate, ["VAN"]),
      flagged: (isolate) => isResistant(isolate, ["VAN"]),
    },
    {
      key: "fluoroquinolone_resistant",
      label: "Fluoroquinolone resistance",
      description: "Resistance to ciprofloxacin, levofloxacin, norfloxacin or ofloxacin.",
      eligible: (isolate) => wasTested(isolate, FLUOROQUINOLONES),
      flagged: (isolate) => isResistant(isolate, FLUOROQUINOLONES),
    },
    {
      key: "multidrug_resistant",
      label: "Resistant to three or more antimicrobial classes",
      description:
        "Counted across the classes actually tested on each isolate, so a narrow panel cannot manufacture one.",
      eligible: (isolate) => distinctClassesTested(isolate) >= 3,
      flagged: (isolate) => resistantClasses(isolate) >= 3,
    },
  ];

  return definitions.map((definition) => {
    const eligible = population.filter(definition.eligible);
    const flagged = eligible.filter(definition.flagged);
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      isolates: flagged.length,
      eligible: eligible.length,
      percent: eligible.length === 0 ? null : (flagged.length / eligible.length) * 100,
    };
  });
}

function distinctClassesTested(isolate: AnalysedIsolate): number {
  return new Set(
    isolate.results
      .filter((result) => INTERPRETABLE.has(result.category))
      .map((result) => result.antimicrobialClass),
  ).size;
}

function resistantClasses(isolate: AnalysedIsolate): number {
  return new Set(
    isolate.results
      .filter((result) => result.category === "R" || result.category === "NS")
      .map((result) => result.antimicrobialClass),
  ).size;
}

export interface DashboardSummary {
  isolates: number;
  firstIsolates: number;
  patients: number;
  organisms: number;
  antibiotics: number;
  results: number;
  interpretable: number;
  pending: number;
  coveragePercent: number;
  resistantPercent: number | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  latestSpecimenDate: string | null;
  topOrganisms: CountRow[];
  topSites: CountRow[];
  careSetting: CountRow[];
  monthlyVolume: Array<{ bucket: string; isolates: number; patients: number }>;
  phenotypes: PhenotypeCount[];
}

export function dashboard(
  isolates: AnalysedIsolate[],
  options: AnalysisOptions = DEFAULT_ANALYSIS_OPTIONS,
): DashboardSummary {
  const dates = isolates
    .map((isolate) => isolate.specimenDate)
    .filter((date): date is string => date !== null)
    .sort();

  let results = 0;
  let interpretable = 0;
  let pending = 0;
  let resistant = 0;
  const agents = new Set<string>();

  for (const isolate of isolates) {
    for (const result of isolate.results) {
      results += 1;
      agents.add(result.code);
      if (INTERPRETABLE.has(result.category)) {
        interpretable += 1;
        if (result.category === "R" || result.category === "NS") resistant += 1;
      } else if (result.category === "PI") pending += 1;
    }
  }

  return {
    isolates: isolates.length,
    firstIsolates: firstIsolates(isolates).length,
    patients: new Set(isolates.map((isolate) => isolate.patientKey)).size,
    organisms: new Set(isolates.map((isolate) => isolate.organismCode)).size,
    antibiotics: agents.size,
    results,
    interpretable,
    pending,
    coveragePercent: results === 0 ? 0 : (interpretable / results) * 100,
    resistantPercent: interpretable === 0 ? null : (resistant / interpretable) * 100,
    coverageStart: dates[0] ?? null,
    coverageEnd: dates[dates.length - 1] ?? null,
    latestSpecimenDate: dates[dates.length - 1] ?? null,
    topOrganisms: organismFrequency(isolates, options).slice(0, 10),
    topSites: siteFrequency(isolates).slice(0, 8),
    careSetting: demographicBreakdown(isolates).careSetting,
    monthlyVolume: volumeTrend(isolates),
    phenotypes: phenotypes(isolates, options),
  };
}

/** Distinct values available to filter on, taken from the data itself so the
 * filter bar never offers a choice that returns nothing. */
export function filterOptions(isolates: AnalysedIsolate[]): {
  organisms: Array<{ code: string; name: string; count: number }>;
  specimens: Array<{ code: string; name: string; count: number }>;
  sites: string[];
  wards: string[];
  departments: string[];
  antibiotics: Array<{ code: string; name: string }>;
  months: string[];
} {
  const organisms = new Map<string, { code: string; name: string; count: number }>();
  const specimens = new Map<string, { code: string; name: string; count: number }>();
  const antibiotics = new Map<string, { code: string; name: string }>();
  const sites = new Set<string>();
  const wards = new Set<string>();
  const departments = new Set<string>();
  const months = new Set<string>();

  for (const isolate of isolates) {
    const organism = organisms.get(isolate.organismCode) ?? {
      code: isolate.organismCode,
      name: isolate.organismName,
      count: 0,
    };
    organism.count += 1;
    organisms.set(isolate.organismCode, organism);

    if (isolate.specimenTypeCode) {
      const specimen = specimens.get(isolate.specimenTypeCode) ?? {
        code: isolate.specimenTypeCode,
        name: isolate.specimenName,
        count: 0,
      };
      specimen.count += 1;
      specimens.set(isolate.specimenTypeCode, specimen);
    }

    sites.add(isolate.site);
    if (isolate.ward) wards.add(isolate.ward);
    if (isolate.department) departments.add(isolate.department);
    if (isolate.month) months.add(isolate.month);
    for (const result of isolate.results) {
      antibiotics.set(result.code, { code: result.code, name: result.name });
    }
  }

  return {
    organisms: [...organisms.values()].sort((a, b) => b.count - a.count),
    specimens: [...specimens.values()].sort((a, b) => b.count - a.count),
    sites: [...sites].sort(),
    wards: [...wards].sort(),
    departments: [...departments].sort(),
    antibiotics: [...antibiotics.values()].sort((a, b) => a.name.localeCompare(b.name)),
    months: [...months].sort(),
  };
}
