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

/** The table as a spreadsheet.
 *
 * Excel is where a laboratory actually fills a blueprint in — it is what is on
 * the machine, it is what a person can put a printed page beside, and it is
 * what gets emailed to the colleague who owns the licensed copy of M100. So the
 * workbook round-trips as exactly as the CSV does: same columns, same order,
 * same header, and `readBreakpointSheet` below reads it straight back.
 */
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

/**
 * Read an exported workbook back into criteria.
 *
 * The counterpart to `breakpointSheetRows`, and the reason the export is worth
 * having: a blueprint goes out as a spreadsheet, somebody types the thresholds
 * from their licensed M100 into the S / I / R columns, and it comes back here.
 * Round-tripping through the *same* columns is what makes that safe — an export
 * in some other shape would have to be reworked by hand before it could go
 * back, and reworking a nine-hundred-row table by hand is where transposed
 * thresholds come from.
 *
 * Recognising the sheet is a matter of the header row: a workbook whose first
 * row carries the template's columns is one of ours. Anything else is somebody
 * else's spreadsheet — most likely the CLSI workbook itself — and is left for
 * the M100 converter, which knows how to read that instead of guessing.
 */
export function readBreakpointSheet(rows: string[][]): {
  criteria: BreakpointCriterion[];
  problems: string[];
} | null {
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => (cell ?? "").trim().toLowerCase() === "organism_group"),
  );
  if (headerIndex < 0) return null;

  const header = (rows[headerIndex] ?? []).map((cell) => (cell ?? "").trim().toLowerCase());
  for (const required of ["organism_group", "agent_code", "method"]) {
    if (!header.includes(required)) return null;
  }

  const criteria: BreakpointCriterion[] = [];
  const problems: string[] = [];

  for (const [offset, row] of rows.slice(headerIndex + 1).entries()) {
    const record: Record<string, string> = {};
    header.forEach((name, position) => {
      record[name] = (row[position] ?? "").trim();
    });
    // A wholly blank line is the gap somebody left between sections, not an
    // error. A line with a group but no agent is a mistake worth naming.
    if (!record.organism_group && !record.agent_code) continue;

    const line = headerIndex + offset + 2;
    if (!record.organism_group) problems.push(`row ${line}: organism_group is required`);
    if (!record.agent_code) problems.push(`row ${line}: agent_code is required`);

    const method = (record.method ?? "").toUpperCase();
    if (!BREAKPOINT_METHODS.includes(method as BreakpointMethod)) {
      problems.push(`row ${line}: method ${record.method || "(blank)"} is not MIC, DISK or GRADIENT`);
      continue;
    }

    criteria.push({
      ...(record as unknown as BreakpointCriterion),
      organism_group: record.organism_group ?? "",
      agent_code: (record.agent_code ?? "").toUpperCase(),
      method,
    });
  }

  return { criteria, problems };
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
/**
 * Whether a row states no threshold at all.
 *
 * A **placeholder** — the row exists, the combination is real, nobody has typed
 * the numbers yet. It is the unit a blueprint is made of: the printed table's
 * organism groups and agents laid out with the values left for a person to read
 * off their licensed copy.
 *
 * Placeholders are safe to hold because they cannot mislead. The interpretation
 * engine selects on thresholds, so a row with none never matches; a measurement
 * against it stays `PI` — measured, pending interpretation — which is exactly
 * what it is. Nothing is guessed and nothing is lost.
 *
 * What is *not* safe, and stays refused, is a half-filled row: a susceptible
 * bound with no resistant one, or bands that contradict each other. Those look
 * like coverage and are not.
 */
export function isPlaceholder(criterion: BreakpointCriterion): boolean {
  const disk = (criterion.method ?? "").trim().toUpperCase() === "DISK";
  const values = disk
    ? [
        criterion.disk_susceptible_min,
        criterion.disk_resistant_max,
        criterion.disk_intermediate_min,
        criterion.disk_intermediate_max,
        criterion.disk_sdd_min,
        criterion.disk_sdd_max,
      ]
    : [
        criterion.mic_susceptible_max,
        criterion.mic_resistant_min,
        criterion.mic_intermediate_min,
        criterion.mic_intermediate_max,
        criterion.mic_sdd_min,
        criterion.mic_sdd_max,
      ];
  return values.every((value) => numberOf(value) === null);
}

export interface Completeness {
  /** Rows in the table. */
  rows: number;
  /** Rows that state at least one threshold. */
  filled: number;
  /** Rows still waiting for their numbers. */
  placeholders: number;
  percent: number;
}

/**
 * How much of the table can actually interpret anything.
 *
 * The number that matters while a blueprint is being filled in, and the reason
 * it is shown beside the table rather than buried in a report: "707 criteria"
 * sounds like a complete table, and a blueprint with 707 empty rows is not one.
 */
export function completeness(criteria: BreakpointCriterion[]): Completeness {
  const filled = criteria.filter((criterion) => !isPlaceholder(criterion)).length;
  return {
    rows: criteria.length,
    filled,
    placeholders: criteria.length - filled,
    percent: criteria.length === 0 ? 0 : (filled / criteria.length) * 100,
  };
}

export interface ValidationOptions {
  /** Accept a row that states no threshold at all.
   *
   * True wherever a table is being *worked on* — the editor, the file import,
   * the blueprint — because a blueprint is nothing but such rows and refusing
   * them would make it unloadable. False where a table is being *relied on*.
   * Half-filled rows are refused either way; this only decides whether an
   * entirely empty one is an error or a job not yet done. */
  allowPlaceholder?: boolean;
}

export function validateCriterion(
  criterion: BreakpointCriterion,
  options: ValidationOptions = {},
): string[] {
  const problems: string[] = [];
  const placeholder = (options.allowPlaceholder ?? true) && isPlaceholder(criterion);

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
    if (s === null && r === null && !placeholder) {
      problems.push(
        "A disk row needs a susceptible or a resistant zone diameter. An intermediate band on its own categorises nothing.",
      );
    }
    // The platform refuses this too. A zone diameter means nothing without the
    // disk it was read around — 30 µg gentamicin and 10 µg gentamicin have
    // different thresholds — and a row the uploader accepted but the platform
    // would reject is a table that cannot be published.
    if (!(criterion.disk_content ?? "").trim() && !placeholder) {
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

    if (s === null && r === null && !placeholder) {
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

  return problems;
}

/**
 * What is worth saying about a criterion that is nonetheless allowed.
 *
 * Separate from `validateCriterion` because severity is the whole point. The
 * platform's importer treats these as warnings, and an uploader that refused
 * what the platform accepts would leave a laboratory unable to save a row it had
 * just imported successfully — or unable to correct a threshold on one.
 */
export function advisoriesFor(criterion: BreakpointCriterion): string[] {
  const advisories: string[] = [];
  const sddMin = numberOf(criterion.mic_sdd_min) ?? numberOf(criterion.disk_sdd_min);
  if (sddMin !== null && !(criterion.dosage_note ?? "").trim()) {
    advisories.push(
      "This row has an SDD band but no dosage note. Susceptible-dose-dependent is a statement "
      + "about the dose, so the category cannot be acted on without the regimen it assumes — "
      + "add it from the printed table.",
    );
  }
  return advisories;
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
        : set.source === "blueprint"
          ? "blank layout, ready to fill in"
          : "not loaded";
  const name = set.label ?? set.version ?? "Breakpoint table";
  return set.criteria.length === 0 ? "No breakpoint table loaded" : `${name} — ${where}`;
}

/* ------------------------------------------------------------------ *
 * The table as CLSI prints it.
 * ------------------------------------------------------------------ */

/**
 * The drug-class headings M100 sets its rows under, in the order it sets them.
 *
 * A laboratory reading this screen has the printed table open beside it. Rows
 * in the same order, under the same headings, is the difference between
 * checking a threshold in five seconds and hunting for it — and an antimicrobial
 * list sorted alphabetically puts cefepime between cefazolin and cefotaxime,
 * which is right, and ertapenem between erythromycin and ethambutol, which is
 * not how anyone reads a breakpoint table.
 */
const CLASS_ORDER: Array<{ key: string; label: string }> = [
  // Set in the casing M100 prints them, rather than upper-cased by CSS: a
  // `text-transform` turns the β of "β-LACTAM" into a capital Beta, which is a
  // different letter and reads as a typo to anyone who knows the table.
  { key: "penicillin", label: "PENICILLINS" },
  { key: "beta_lactam_inhibitor", label: "β-LACTAM COMBINATION AGENTS" },
  { key: "cephalosporin", label: "CEPHEMS" },
  { key: "monobactam", label: "MONOBACTAMS" },
  { key: "carbapenem", label: "CARBAPENEMS" },
  { key: "aminoglycoside", label: "AMINOGLYCOSIDES" },
  { key: "tetracycline", label: "TETRACYCLINES" },
  { key: "fluoroquinolone", label: "FLUOROQUINOLONES" },
  { key: "folate_inhibitor", label: "FOLATE PATHWAY ANTAGONISTS" },
  { key: "phenicol", label: "PHENICOLS" },
  { key: "macrolide", label: "MACROLIDES" },
  { key: "lincosamide", label: "LINCOSAMIDES" },
  { key: "glycopeptide", label: "GLYCOPEPTIDES AND LIPOGLYCOPEPTIDES" },
  { key: "oxazolidinone", label: "OXAZOLIDINONES" },
  { key: "polymyxin", label: "LIPOPEPTIDES AND POLYMYXINS" },
  { key: "nitrofuran", label: "NITROFURANS" },
  { key: "azole", label: "AZOLES" },
  { key: "echinocandin", label: "ECHINOCANDINS" },
  { key: "polyene", label: "POLYENES" },
  { key: "pyrimidine_analogue", label: "PYRIMIDINE ANALOGUES" },
  { key: "other", label: "OTHER AGENTS" },
];

const CLASS_LABELS = new Map(CLASS_ORDER.map((entry, index) => [entry.key, { ...entry, index }]));

/**
 * The order organism groups are printed in.
 *
 * M100 runs Gram-negatives before Gram-positives and puts Enterobacterales
 * first, because that is the order a laboratory works through them. Anything
 * not named here follows, alphabetically, so a laboratory's own group is
 * visible rather than dropped.
 */
const GROUP_ORDER = [
  "Enterobacterales",
  "Salmonella and Shigella spp.",
  "Pseudomonas aeruginosa",
  "Acinetobacter spp.",
  "Burkholderia cepacia complex",
  "Stenotrophomonas maltophilia",
  "Other Non-Enterobacterales",
  "Staphylococcus spp.",
  "Enterococcus spp.",
  "Streptococcus pneumoniae",
  "Streptococcus spp. β-Hemolytic Group",
  "Streptococcus spp. Viridans Group",
  "Haemophilus influenzae and Haemophilus parainfluenzae",
  "Neisseria gonorrhoeae",
  "Neisseria meningitidis",
  "Anaerobes",
];

export interface CatalogueRow {
  key: string;
  agentCode: string;
  agentName: string;
  /** Disk potency, or the site/route qualifier for an MIC row — whatever
   * distinguishes this criterion from another for the same agent. */
  qualifier: string;
  susceptible: string;
  sdd: string;
  intermediate: string;
  resistant: string;
  comment: string;
  /** The stored numbers, unformatted, for the editor to put back in the boxes
   * rather than parsing "≥17 mm" back into 17 — the round trip that loses a
   * value. */
  values: {
    susceptible: string;
    sddMin: string;
    sddMax: string;
    intermediateMin: string;
    intermediateMax: string;
    resistant: string;
    diskContent: string;
    site: string;
    route: string;
    dosageNote: string;
    comment: string;
    standard: string;
    tableReference: string;
  };
  /** Anything true but worth saying — an SDD band with no dosing regimen. */
  advisories: string[];
  /** No threshold typed yet. The row is a place for a number, not a number. */
  placeholder: boolean;
}

export interface CatalogueSection {
  organismGroup: string;
  /** The M100 table this group's rows cite, e.g. "2A-1". */
  tableReference: string;
  classes: Array<{ label: string; rows: CatalogueRow[] }>;
  rowCount: number;
  /** How far this organism group has been filled in. Shown in the section
   * heading, because "which groups still need work" is the question somebody
   * typing from a printed table asks every few minutes. */
  filled: number;
}

export interface Catalogue {
  /** Which half of the table is on screen. */
  method: "DISK" | "MIC";
  unit: string;
  loaded: boolean;
  /** The table described in full — name and where it came from. Used where
   * there is room for a sentence. */
  edition: string;
  /** Its name alone. The provenance strip states the source separately, and
   * "CLSI M100, 2026 edition — blank layout · blank layout" is what happens
   * when both do it. */
  editionLabel: string;
  /** Criteria in the whole table, both methods. */
  criteria: number;
  /** Criteria for the method shown. */
  shown: number;
  sections: CatalogueSection[];
  /** Organism groups that have criteria under the *other* method only, so a
   * laboratory does not conclude an organism is missing when it is simply
   * covered by MICs and the zone view is open. */
  onlyUnderOtherMethod: string[];
  /** How much of the whole table states thresholds, and how much is still a
   * form. Over the whole table rather than the filtered view: a laboratory
   * working through Enterobacterales needs to know where the *table* stands. */
  completeness: Completeness;
  /** Over the rows currently shown, so the section headings can say how far
   * this organism group has got. */
  shownCompleteness: Completeness;
  /** True when the table carries no thresholds at all — a blueprint that
   * nobody has started filling in. */
  blueprint: boolean;
}

function plain(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/** One criterion as a row of the printed table. */
function catalogueRow(criterion: BreakpointCriterion, disk: boolean): CatalogueRow {
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

  const qualifier = [criterion.disk_content, criterion.site, criterion.route]
    .map(plain)
    .filter((part) => part !== "")
    .join(" · ");

  return {
    key: criterionKey(criterion),
    agentCode: plain(criterion.agent_code),
    agentName: antibioticLabel(plain(criterion.agent_code)),
    qualifier,
    susceptible: s === null ? "—" : `${disk ? "≥" : "≤"}${s}${unit}`,
    sdd: sdd ? `${sdd}${unit}` : "—",
    intermediate: intermediate ? `${intermediate}${unit}` : "—",
    resistant: r === null ? "—" : `${disk ? "≤" : "≥"}${r}${unit}`,
    comment: plain(criterion.comment),
    values: {
      susceptible: plain(disk ? criterion.disk_susceptible_min : criterion.mic_susceptible_max),
      sddMin: plain(disk ? criterion.disk_sdd_min : criterion.mic_sdd_min),
      sddMax: plain(disk ? criterion.disk_sdd_max : criterion.mic_sdd_max),
      intermediateMin: plain(
        disk ? criterion.disk_intermediate_min : criterion.mic_intermediate_min,
      ),
      intermediateMax: plain(
        disk ? criterion.disk_intermediate_max : criterion.mic_intermediate_max,
      ),
      resistant: plain(disk ? criterion.disk_resistant_max : criterion.mic_resistant_min),
      diskContent: plain(criterion.disk_content),
      site: plain(criterion.site),
      route: plain(criterion.route),
      dosageNote: plain(criterion.dosage_note),
      comment: plain(criterion.comment),
      standard: plain(criterion.standard) || "CLSI M100",
      tableReference: plain(criterion.table_reference),
    },
    advisories: advisoriesFor(criterion),
    placeholder: isPlaceholder(criterion),
  };
}

export interface CatalogueOptions {
  /** Which half to show. A laboratory that reads zones has no use for the MIC
   * half, and reading both at once is how a zone gets entered as an MIC. */
  method: "DISK" | "MIC";
  /** Free text over organism group, agent code and agent name. */
  search?: string;
  /** Show only this organism group. */
  organismGroup?: string;
}

/**
 * The loaded table, arranged the way CLSI prints it.
 *
 * One section per organism group, in the order M100 runs them; within each, the
 * drug-class headings in M100's order; within each class, the agents
 * alphabetically, which is how the printed table sets them. A gradient-strip
 * criterion is shown with the MICs, because that is what it is.
 */
export function catalogue(set: BreakpointSet, options: CatalogueOptions): Catalogue {
  const disk = options.method === "DISK";
  const search = (options.search ?? "").trim().toLowerCase();
  const wanted = (options.organismGroup ?? "").trim();

  const forMethod = set.criteria.filter((criterion) => {
    const method = plain(criterion.method).toUpperCase();
    return disk ? method === "DISK" : method === "MIC" || method === "GRADIENT";
  });

  const groupsWithAny = new Set(set.criteria.map((criterion) => plain(criterion.organism_group)));
  const groupsHere = new Set(forMethod.map((criterion) => plain(criterion.organism_group)));

  const matching = forMethod.filter((criterion) => {
    if (wanted && plain(criterion.organism_group) !== wanted) return false;
    if (!search) return true;
    const haystack = `${criterion.organism_group} ${criterion.agent_code} ${antibioticLabel(
      plain(criterion.agent_code),
    )}`.toLowerCase();
    return haystack.includes(search);
  });

  const byGroup = new Map<string, BreakpointCriterion[]>();
  for (const criterion of matching) {
    const group = plain(criterion.organism_group);
    byGroup.set(group, [...(byGroup.get(group) ?? []), criterion]);
  }

  const rank = (group: string): number => {
    const index = GROUP_ORDER.indexOf(group);
    return index < 0 ? GROUP_ORDER.length : index;
  };

  const sections: CatalogueSection[] = [...byGroup.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([organismGroup, criteria]) => {
      const byClass = new Map<string, CatalogueRow[]>();
      for (const criterion of criteria) {
        const agent = lookupAntibiotic(canonicalAntibioticCode(plain(criterion.agent_code)));
        const key = agent?.antimicrobialClass ?? "other";
        byClass.set(key, [...(byClass.get(key) ?? []), catalogueRow(criterion, disk)]);
      }

      const classes = [...byClass.entries()]
        .sort(
          ([a], [b]) =>
            (CLASS_LABELS.get(a)?.index ?? CLASS_ORDER.length) -
            (CLASS_LABELS.get(b)?.index ?? CLASS_ORDER.length),
        )
        .map(([key, rows]) => ({
          label: CLASS_LABELS.get(key)?.label ?? "OTHER AGENTS",
          rows: rows.sort(
            (a, b) => a.agentName.localeCompare(b.agentName) || a.qualifier.localeCompare(b.qualifier),
          ),
        }));

      return {
        organismGroup,
        tableReference:
          criteria.map((criterion) => plain(criterion.table_reference)).find((ref) => ref !== "") ??
          "",
        classes,
        rowCount: criteria.length,
        filled: criteria.filter((criterion) => !isPlaceholder(criterion)).length,
      };
    });

  const whole = completeness(set.criteria);
  return {
    method: options.method,
    unit: disk ? "mm" : "µg/mL",
    loaded: set.criteria.length > 0,
    edition: describeSet(set),
    editionLabel: set.label ?? set.version ?? "Breakpoint table",
    criteria: set.criteria.length,
    shown: forMethod.length,
    sections,
    onlyUnderOtherMethod: [...groupsWithAny]
      .filter((group) => group !== "" && !groupsHere.has(group))
      .sort(),
    completeness: whole,
    shownCompleteness: completeness(matching),
    blueprint: set.criteria.length > 0 && whole.filled === 0,
  };
}

/** Every organism group in the table, for the section jump-list. */
export function organismGroupsIn(set: BreakpointSet): string[] {
  const groups = [...new Set(set.criteria.map((criterion) => plain(criterion.organism_group)))]
    .filter((group) => group !== "");
  const rank = (group: string): number => {
    const index = GROUP_ORDER.indexOf(group);
    return index < 0 ? GROUP_ORDER.length : index;
  };
  return groups.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Change one threshold in place.
 *
 * The editor writes a single cell at a time, because that is how a person
 * corrects a table against a printed page: one number, checked, then the next.
 * The whole criterion is re-validated on every change, so a correction that
 * makes the row self-contradictory is refused at the moment it is made rather
 * than at publication, when its author has moved on.
 */
export type CellField =
  | "susceptible"
  | "sddMin"
  | "sddMax"
  | "intermediateMin"
  | "intermediateMax"
  | "resistant";

const DISK_FIELDS: Record<CellField, string> = {
  susceptible: "disk_susceptible_min",
  sddMin: "disk_sdd_min",
  sddMax: "disk_sdd_max",
  intermediateMin: "disk_intermediate_min",
  intermediateMax: "disk_intermediate_max",
  resistant: "disk_resistant_max",
};

const MIC_FIELDS: Record<CellField, string> = {
  susceptible: "mic_susceptible_max",
  sddMin: "mic_sdd_min",
  sddMax: "mic_sdd_max",
  intermediateMin: "mic_intermediate_min",
  intermediateMax: "mic_intermediate_max",
  resistant: "mic_resistant_min",
};

export function setCell(
  criteria: BreakpointCriterion[],
  key: string,
  method: "DISK" | "MIC",
  field: CellField,
  value: string,
): TableEdit {
  const index = criteria.findIndex((criterion) => criterionKey(criterion) === key);
  if (index < 0) return { criteria, problems: ["That row is no longer in the table."] };

  const column = (method === "DISK" ? DISK_FIELDS : MIC_FIELDS)[field];
  const text = value.trim();
  if (text !== "" && !Number.isFinite(Number(text))) {
    return { criteria, problems: [`"${value}" is not a number.`] };
  }

  const updated: BreakpointCriterion = {
    ...criteria[index]!,
    [column]: text === "" ? null : text,
  };
  const problems = validateCriterion(updated);
  if (problems.length > 0) return { criteria, problems };

  const next = [...criteria];
  next[index] = updated;
  return { criteria: next, problems: [] };
}
