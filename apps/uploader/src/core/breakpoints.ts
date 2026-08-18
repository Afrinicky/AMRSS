/**
 * Getting a breakpoint table out of the software, and editing it once it is in.
 *
 * Import already existed; export is what makes the table a laboratory's own
 * property rather than something locked inside the application. The two are
 * deliberately the same file: what comes out of Export is exactly what Import
 * accepts, column for column, so a laboratory can export the table, correct a
 * threshold in Excel, and put it back. That round trip is the reason the export
 * writes every column of the template even when the loaded table never uses one.
 *
 * The editable table in Settings uses the same validation the file import does.
 * A threshold typed into a form and a threshold read from a CSV are the same
 * claim about a patient's result, and it would be indefensible for one route to
 * be checked and the other not.
 */

import type { BreakpointCriterion, BreakpointSet } from "./interpret";
import { antibioticLabel, canonicalAntibioticCode, lookupAntibiotic } from "./dictionary";

/**
 * The template's columns, in the template's order.
 *
 * `data/breakpoints/clsi_m100.template.csv` in this repository is the
 * definition, and the platform's own importer
 * (`apps/api/amrss/analytics/breakpoint_import.py`) reads the same shape. The
 * order is fixed because a laboratory reading the exported file alongside the
 * printed table needs the columns where it expects them.
 */
export const BREAKPOINT_COLUMNS = [
  "organism_group",
  "agent_code",
  "method",
  "disk_content",
  "site",
  "route",
  "standard",
  "table_reference",
  "tier",
  "mic_susceptible_max",
  "mic_sdd_min",
  "mic_sdd_max",
  "mic_intermediate_min",
  "mic_intermediate_max",
  "mic_resistant_min",
  "disk_susceptible_min",
  "disk_sdd_min",
  "disk_sdd_max",
  "disk_intermediate_min",
  "disk_intermediate_max",
  "disk_resistant_max",
  "dosage_note",
  "comment",
] as const;

export type BreakpointColumn = (typeof BREAKPOINT_COLUMNS)[number];

/** The method a criterion states thresholds for. GRADIENT is an MIC read from a
 * gradient strip; it uses the MIC columns and the MIC direction. */
export type BreakpointMethod = "MIC" | "DISK" | "GRADIENT";

export const BREAKPOINT_METHODS: BreakpointMethod[] = ["MIC", "DISK", "GRADIENT"];

/**
 * Which of the two a laboratory works with.
 *
 * Not every laboratory reads zones. One running an automated MIC panel has no
 * disk measurements at all, and showing it a table three-quarters full of zone
 * diameters, a coverage figure computed over criteria it will never use, and an
 * import that quietly discards its MIC rows is showing it someone else's
 * laboratory. The choice is made once during configuration and then governs
 * what is imported, what is exported, what the coverage report counts and what
 * the editable table opens on.
 *
 * `both` is the default and the honest answer for a laboratory that does disks
 * routinely and MICs for confirmation, which is most of them.
 */
export type TestingMethodPreference = "disk" | "mic" | "both";

export const METHOD_PREFERENCE_LABELS: Record<TestingMethodPreference, string> = {
  disk: "Disk diffusion — zone diameters in mm",
  mic: "MIC — minimum inhibitory concentration in µg/mL",
  both: "Both — disks routinely, MICs where needed",
};

/** Whether a criterion belongs to the method a laboratory works with. */
export function matchesPreference(
  criterion: Pick<BreakpointCriterion, "method">,
  preference: TestingMethodPreference,
): boolean {
  if (preference === "both") return true;
  const method = (criterion.method ?? "").toUpperCase();
  return preference === "disk" ? method === "DISK" : method === "MIC" || method === "GRADIENT";
}

/* ------------------------------------------------------------------ *
 * Export.
 * ------------------------------------------------------------------ */

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The loaded table as the template CSV.
 *
 * Written with the header the importer requires and nothing else — no comment
 * preamble — so the file goes straight back in without editing. The template in
 * the repository carries explanatory comments for a person starting from
 * scratch; a table exported from a working installation does not need them, and
 * they would have to be stripped before re-import by hand.
 */
export function breakpointCsv(criteria: BreakpointCriterion[]): string {
  const lines = [BREAKPOINT_COLUMNS.join(",")];
  for (const criterion of criteria) {
    const row = criterion as unknown as Record<string, unknown>;
    lines.push(BREAKPOINT_COLUMNS.map((column) => csvCell(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** The table as a spreadsheet, for a laboratory that would rather read it in
 * Excel than in a text editor. The CSV is what re-imports. */
export function breakpointSheetRows(criteria: BreakpointCriterion[]): (string | number | null)[][] {
  return criteria.map((criterion) => {
    const row = criterion as unknown as Record<string, unknown>;
    return BREAKPOINT_COLUMNS.map((column) => {
      const value = row[column];
      if (value === null || value === undefined || value === "") return null;
      return typeof value === "number" ? value : String(value);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Editing.
 * ------------------------------------------------------------------ */

/**
 * A criterion's address within the table.
 *
 * Organism group, agent, method, site and route — exactly the key the shared
 * validation engine uses (`amrss_clsi.breakpoints.validate_breakpoints`), and
 * exactly what the interpretation engine selects on. Two rows with the same
 * scope are a duplicate neither engine can choose between, which makes the
 * reported category depend on the order rows happen to sit in.
 *
 * Disk content is deliberately *not* part of it. It looks like it should be —
 * 10 µg and 30 µg gentamicin are different tests — but the platform's importer
 * refuses two rows that differ only in disk content, and an uploader that
 * allowed them would build a table the platform then rejects whole.
 */
export function criterionKey(criterion: BreakpointCriterion): string {
  return [
    (criterion.organism_group ?? "").trim().toLowerCase(),
    (criterion.agent_code ?? "").trim().toUpperCase(),
    (criterion.method ?? "").trim().toUpperCase(),
    (criterion.site ?? "").trim().toLowerCase(),
    (criterion.route ?? "").trim().toLowerCase(),
  ].join("|");
}

function numberOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Zone diameters a disk test can actually produce. Six is the disk itself. */
const MIN_ZONE_MM = 6;
const MAX_ZONE_MM = 50;

/**
 * Everything wrong with one criterion, in the words the person editing it needs.
 *
 * The checks are the platform's (`breakpoint_import.py`), restated here because
 * the uploader must be able to refuse a bad row with no network. Each one
 * catches a mistake that produces a confidently wrong category rather than an
 * error:
 *
 * - **inverted bounds** — a susceptible MIC above the resistant MIC categorises
 *   every isolate as susceptible;
 * - **disk bounds the MIC way round** — zones run opposite to MICs, and this is
 *   the single most common transcription error;
 * - **overlapping bands** — an isolate that falls in two categories is reported
 *   as whichever the engine reaches first;
 * - **a row with no thresholds at all** — silently interprets nothing while
 *   appearing in the table as coverage.
 */
export function validateCriterion(criterion: BreakpointCriterion): string[] {
  const problems: string[] = [];

  if (!(criterion.organism_group ?? "").trim()) {
    problems.push("An organism group is required — the scope the thresholds apply to.");
  }

  const agent = (criterion.agent_code ?? "").trim().toUpperCase();
  if (!agent) problems.push("An antimicrobial code is required.");
  else if (!lookupAntibiotic(canonicalAntibioticCode(agent))) {
    problems.push(
      `${agent} is not an antimicrobial the dictionary knows, so no result would ever match this row.`,
    );
  }

  const method = (criterion.method ?? "").trim().toUpperCase();
  if (!BREAKPOINT_METHODS.includes(method as BreakpointMethod)) {
    problems.push(`Method must be one of ${BREAKPOINT_METHODS.join(", ")}.`);
    return problems;
  }

  if (method === "DISK") {
    const s = numberOf(criterion.disk_susceptible_min);
    const r = numberOf(criterion.disk_resistant_max);
    const iMin = numberOf(criterion.disk_intermediate_min);
    const iMax = numberOf(criterion.disk_intermediate_max);

    // An intermediate band alone categorises nothing: every measurement above
    // and below it is unclassifiable, so the row is coverage that does not
    // exist. The platform refuses it too.
    if (s === null && r === null) {
      problems.push(
        "A disk row needs a susceptible or a resistant zone diameter. An intermediate band on its own categorises nothing.",
      );
    }
    // The platform refuses this too. A zone diameter means nothing without the
    // disk it was read around — 30 µg gentamicin and 10 µg gentamicin have
    // different thresholds — and a row the uploader accepted but the platform
    // would reject is a table that cannot be published.
    if (!(criterion.disk_content ?? "").trim()) {
      problems.push("A disk row needs its disk content, e.g. 10 µg.");
    }
    for (const [label, value] of [
      ["susceptible", s],
      ["resistant", r],
      ["intermediate lower", iMin],
      ["intermediate upper", iMax],
    ] as const) {
      if (value !== null && (value < MIN_ZONE_MM || value > MAX_ZONE_MM)) {
        problems.push(
          `A ${label} zone of ${value} mm is outside what a disk test produces (${MIN_ZONE_MM}–${MAX_ZONE_MM} mm).`,
        );
      }
    }
    if (s !== null && r !== null && s <= r) {
      problems.push(
        `Zone diameters run opposite to MICs: susceptible (≥${s} mm) must be larger than resistant (≤${r} mm).`,
      );
    }
    if (iMin !== null && iMax !== null && iMin > iMax) {
      problems.push("The intermediate band's lower value is above its upper value.");
    }
    if (iMax !== null && s !== null && iMax >= s) {
      problems.push("The intermediate band overlaps the susceptible zone.");
    }
    if (iMin !== null && r !== null && iMin <= r) {
      problems.push("The intermediate band overlaps the resistant zone.");
    }
  } else {
    const s = numberOf(criterion.mic_susceptible_max);
    const r = numberOf(criterion.mic_resistant_min);
    const iMin = numberOf(criterion.mic_intermediate_min);
    const iMax = numberOf(criterion.mic_intermediate_max);

    if (s === null && r === null) {
      problems.push(
        "An MIC row needs a susceptible or a resistant concentration. An intermediate band on its own categorises nothing.",
      );
    }
    for (const [label, value] of [
      ["susceptible", s],
      ["resistant", r],
      ["intermediate lower", iMin],
      ["intermediate upper", iMax],
    ] as const) {
      if (value !== null && value <= 0) {
        problems.push(`A ${label} MIC must be greater than zero.`);
      }
    }
    if (s !== null && r !== null && s >= r) {
      problems.push(`Susceptible (≤${s}) must be below resistant (≥${r}).`);
    }
    if (iMin !== null && iMax !== null && iMin > iMax) {
      problems.push("The intermediate band's lower value is above its upper value.");
    }
    if (iMin !== null && s !== null && iMin <= s) {
      problems.push("The intermediate band overlaps the susceptible range.");
    }
    if (iMax !== null && r !== null && iMax >= r) {
      problems.push("The intermediate band overlaps the resistant range.");
    }
  }

  const sddMin = numberOf(criterion.mic_sdd_min) ?? numberOf(criterion.disk_sdd_min);
  if (sddMin !== null && !(criterion.dosage_note ?? "").trim()) {
    problems.push(
      "An SDD row needs a dosage note: susceptible-dose-dependent means nothing without the regimen it assumes.",
    );
  }

  return problems;
}

export interface TableEdit {
  criteria: BreakpointCriterion[];
  problems: string[];
}

/**
 * Add or replace one criterion.
 *
 * A criterion whose scope already exists replaces it rather than joining it.
 * Two rows the engine cannot choose between is the worst outcome available
 * here — it makes the reported category depend on the order rows happen to sit
 * in — so the editor never produces one.
 */
export function upsertCriterion(
  criteria: BreakpointCriterion[],
  criterion: BreakpointCriterion,
  replacing?: string,
): TableEdit {
  const normalised: BreakpointCriterion = {
    ...criterion,
    organism_group: (criterion.organism_group ?? "").trim(),
    agent_code: (criterion.agent_code ?? "").trim().toUpperCase(),
    method: (criterion.method ?? "").trim().toUpperCase(),
  };
  const problems = validateCriterion(normalised);
  if (problems.length > 0) return { criteria, problems };

  const key = criterionKey(normalised);
  const kept = criteria.filter(
    (existing) => criterionKey(existing) !== key && criterionKey(existing) !== replacing,
  );
  return { criteria: [...kept, normalised], problems: [] };
}

export function removeCriterion(
  criteria: BreakpointCriterion[],
  key: string,
): BreakpointCriterion[] {
  return criteria.filter((criterion) => criterionKey(criterion) !== key);
}

/* ------------------------------------------------------------------ *
 * Reading the table on screen.
 * ------------------------------------------------------------------ */

export interface CriterionRow {
  key: string;
  organismGroup: string;
  agentCode: string;
  agentName: string;
  method: string;
  scope: string;
  /** The thresholds written the way the printed table writes them, so a person
   * checking the row against M100 is comparing like with like. */
  susceptible: string;
  intermediate: string;
  resistant: string;
  source: string;
  comment: string;
}

function bandText(min: unknown, max: unknown): string {
  const low = numberOf(min);
  const high = numberOf(max);
  if (low === null && high === null) return "";
  if (low !== null && high !== null) return low === high ? String(low) : `${low}–${high}`;
  return String(low ?? high);
}

/** One criterion, formatted for the table on screen. */
export function criterionRow(criterion: BreakpointCriterion): CriterionRow {
  const method = (criterion.method ?? "").toUpperCase();
  const disk = method === "DISK";
  const unit = disk ? " mm" : "";
  const s = numberOf(disk ? criterion.disk_susceptible_min : criterion.mic_susceptible_max);
  const r = numberOf(disk ? criterion.disk_resistant_max : criterion.mic_resistant_min);
  const intermediate = bandText(
    disk ? criterion.disk_intermediate_min : criterion.mic_intermediate_min,
    disk ? criterion.disk_intermediate_max : criterion.mic_intermediate_max,
  );
  const sdd = bandText(
    disk ? criterion.disk_sdd_min : criterion.mic_sdd_min,
    disk ? criterion.disk_sdd_max : criterion.mic_sdd_max,
  );

  const scope = [
    criterion.disk_content ?? "",
    criterion.site ?? "",
    criterion.route ?? "",
    sdd ? `SDD ${sdd}${unit}` : "",
  ]
    .filter((part) => String(part).trim() !== "")
    .join(" · ");

  return {
    key: criterionKey(criterion),
    organismGroup: criterion.organism_group ?? "",
    agentCode: criterion.agent_code ?? "",
    agentName: antibioticLabel(criterion.agent_code ?? null),
    method: disk ? "Disk" : method === "GRADIENT" ? "Gradient" : "MIC",
    scope,
    susceptible: s === null ? "" : `${disk ? "≥" : "≤"}${s}${unit}`,
    intermediate: intermediate ? `${intermediate}${unit}` : "",
    resistant: r === null ? "" : `${disk ? "≤" : "≥"}${r}${unit}`,
    source: [criterion.standard ?? "", criterion.table_reference ?? ""]
      .filter((part) => part.trim() !== "")
      .join(" · "),
    comment: criterion.comment ?? "",
  };
}

/** A label for the loaded set, for the header of an export and the top of the
 * editor. */
export function describeSet(set: BreakpointSet): string {
  const where =
    set.source === "platform"
      ? "synced from the platform"
      : set.source === "local-import"
        ? "imported on this computer"
        : "not loaded";
  const name = set.label ?? set.version ?? "Breakpoint table";
  return set.criteria.length === 0 ? "No breakpoint table loaded" : `${name} — ${where}`;
}
