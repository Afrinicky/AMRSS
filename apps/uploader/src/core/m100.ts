/**
 * Turning a CLSI M100 workbook into breakpoint criteria.
 *
 * A laboratory has its licensed M100 as a spreadsheet — the tables lifted out of
 * the published document, one row per organism group and agent, zone diameters
 * and MICs side by side. This converts that into the criteria the interpretation
 * engine reads, and it is what takes a laboratory from "no breakpoint table
 * loaded" to a working antibiogram by choosing a file.
 *
 * Those spreadsheets are extractions, and extractions of a printed table are
 * imperfect in specific, recognisable ways: a long agent name wraps onto two
 * lines, a footnote paragraph lands in the agent column, a value slides one
 * column to the right so that the intermediate band reads `≤2`. None of that is
 * exotic — it is in the file this was written against — and each one, imported
 * silently, is a wrong category on a real patient's report.
 *
 * So three rules govern the conversion:
 *
 * 1. **Nothing is invented.** A value is copied as it stands or the row is
 *    dropped with a reason. There is no closest match for a threshold.
 * 2. **A row that cannot be read is dropped, not guessed at.** The checks below
 *    are structural — a susceptible column that opens with the wrong operator,
 *    an intermediate band that is a bound rather than a range, a cell holding an
 *    operator and no number — and any of them condemns the row.
 * 3. **What was dropped is reported, and the original text travels with every
 *    number that was kept.** `≤8/4` becomes a bound of 8, the convention for a
 *    combination agent whose breakpoint is expressed as its first component, and
 *    the verbatim `≤8/4` stays in the row's comment so the transcription can be
 *    checked against the printed table at any time.
 */

import {
  ANTIBIOTICS,
  antibioticLabel,
  canonicalAntibioticCode,
  lookupAntibiotic,
  M100_AGENT_SYNONYMS,
} from "./dictionary";
import type { BreakpointCriterion } from "./interpret";
import { readWorkbook } from "./xlsx-read";

export interface DroppedRow {
  row: number;
  label: string;
  reason: string;
}

export interface M100Conversion {
  criteria: BreakpointCriterion[];
  organismGroups: string[];
  agentCodes: string[];
  /** Rows that looked like breakpoints and could not be converted. The half of
   * the result worth reading: a laboratory that cannot see what failed will
   * believe its table is complete. */
  dropped: DroppedRow[];
  /** Rows recognised as footnotes, references or headings rather than
   * breakpoints. Counted, not listed — a hundred of them would bury the drops
   * that matter. */
  skippedNotes: number;
  diskCriteria: number;
  micCriteria: number;
  sourceSheet: string;
}

/**
 * The organism headings M100 prints, against the groups the interpretation
 * engine derives from the dictionary.
 *
 * Only the wording differs; the scope is the same. Where CLSI qualifies a
 * heading with an exclusion — "Enterobacterales (excluding Salmonella and
 * Shigella spp.)" — the exclusion is honoured by the more specific "Salmonella
 * and Shigella spp." criteria winning during selection, exactly as M100 intends.
 */
export const M100_ORGANISM_GROUPS: Record<string, string> = {
  "enterobacterales (excluding salmonella and shigella spp.)": "Enterobacterales",
  enterobacterales: "Enterobacterales",
  enterobacteriaceae: "Enterobacterales",
  "salmonella and shigella spp.": "Salmonella and Shigella spp.",
  "pseudomonas aeruginosa": "Pseudomonas aeruginosa",
  "acinetobacter spp.": "Acinetobacter spp.",
  "burkholderia cepacia complex": "Burkholderia cepacia complex",
  "stenotrophomonas maltophilia": "Stenotrophomonas maltophilia",
  "other non-enterobacterales": "Other Non-Enterobacterales",
  "haemophilus influenzae and haemophilus parainfluenzae":
    "Haemophilus influenzae and Haemophilus parainfluenzae",
  "neisseria gonorrhoeae": "Neisseria gonorrhoeae",
  "neisseria meningitidis": "Neisseria meningitidis",
  "staphylococcus spp.": "Staphylococcus spp.",
  "enterococcus spp.": "Enterococcus spp.",
  "streptococcus pneumoniae": "Streptococcus pneumoniae",
  "streptococcus spp. β-hemolytic group": "Streptococcus spp. β-Hemolytic Group",
  "streptococcus spp. beta-hemolytic group": "Streptococcus spp. β-Hemolytic Group",
  "streptococcus spp. viridans group": "Streptococcus spp. Viridans Group",
  anaerobes: "Anaerobes",
  "anaerobes (gram negative)": "Anaerobes",
  "anaerobes (gram positive)": "Anaerobes",
};

/** Qualifiers M100 prints beside an agent that change which criterion applies,
 * rather than which agent it is. */
const SITE_QUALIFIERS: Record<string, string> = {
  meningitis: "meningitis",
  nonmeningitis: "non_meningitis",
  "non-meningitis": "non_meningitis",
  u: "uti",
  uti: "uti",
};

const ROUTE_QUALIFIERS: Record<string, string> = {
  oral: "oral",
  parenteral: "iv",
  iv: "iv",
  intravenous: "iv",
};

/**
 * Where a wrapped agent name resolves to, when the second line was lost.
 *
 * The printed table sets "Trimethoprim-sulfamethoxazole" over two lines and the
 * extraction keeps only the first. Completing it is not a guess: within M100's
 * folate-pathway rows there is exactly one agent beginning "Trimethoprim-", and
 * plain trimethoprim is printed separately as "Trimethoprim (U)". The same holds
 * for each entry here. The continuation found in the row is preferred over this
 * table wherever the file still carries it.
 */
const WRAPPED_AGENT_NAMES: Record<string, string> = {
  "trimethoprim-": "SXT",
  "sulfamethoxazole-": "SXT",
  "amoxicillin-": "AMC",
  "ampicillin-": "SAM",
  "piperacillin-": "TZP",
  "ticarcillin-": "TCC",
  "quinupristin-": "QDA",
  "ceftazidime-": "CZA",
  "ceftolozane-": "CZT",
  "aztreonam-": "AZA",
  "imipenem-": "IMR",
  "meropenem-": "MEV",
  "sulbactam-": "SUD",
};

export interface AgentLabel {
  name: string;
  /** Every agent the cell names. Usually one; a row printed "Ertapenem or
   * imipenem" states one set of thresholds for both, and dropping the second
   * would lose breakpoints the laboratory's own table contains. */
  codes: string[];
  site: string | null;
  route: string | null;
  /** The disk potency printed after the name ("Gentamicin 10"). Stripped from
   * the name, kept here: on a row the extraction split badly the number lands
   * in the label and only the unit survives in the disk-content column, and the
   * two have to be put back together. */
  potency: string | null;
  /** True when the cell is prose — a footnote, a reference, a heading — rather
   * than an attempt at an agent name. */
  isNote: boolean;
}

/** Decoration the printed table carries that says nothing about which agent it
 * is: reporting-tier asterisks, footnote daggers and superscript letters. */
function stripDecoration(text: string): string {
  return text
    .replace(/[*†‡§¶#^]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read one agent cell.
 *
 * Beyond the decoration, three things are removed because they belong to a
 * neighbouring column that the extraction folded in: a trailing disk potency
 * (`Gentamicin 10`), a trailing organism qualifier (`Vancomycin S. aureus,
 * including`, `Linezolid All staphylococci`), and the `or` that ends the first
 * line of a two-agent row. The parenthetical qualifiers are kept, because
 * `(meningitis)` selects a different threshold for the same drug.
 */
export function parseAgentLabel(raw: string, continuation = ""): AgentLabel {
  let text = String(raw ?? "").trim();
  let site: string | null = null;
  let route: string | null = null;

  for (const match of text.matchAll(/\(([^)]*)\)/g)) {
    for (const token of (match[1] ?? "").split(/[,;/]/)) {
      const key = token.trim().toLowerCase().replace(/\.$/, "");
      const lead = key.split(/\s+/)[0] ?? "";
      if (SITE_QUALIFIERS[key]) site = SITE_QUALIFIERS[key]!;
      else if (ROUTE_QUALIFIERS[key]) route = ROUTE_QUALIFIERS[key]!;
      else if (ROUTE_QUALIFIERS[lead]) route = ROUTE_QUALIFIERS[lead]!;
    }
  }

  text = stripDecoration(text.replace(/\([^)]*\)/g, " "))
    // An organism name folded in from the column beside it.
    .replace(/\s+(All\s+\w+|S\.\s+\w+|MRSA|SOSA|Staphylococcus\b).*$/i, "")
    // A footnote letter.
    .replace(/\s+[a-z]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  // A disk potency printed after the name, kept rather than discarded.
  const trailing = /\s+(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)\s*(µg|ug|mcg)?\s*$/i.exec(text);
  let potency: string | null = null;
  if (trailing) {
    potency = trailing[1]!;
    text = text.slice(0, trailing.index).trim();
  }

  // A route printed as a word rather than a parenthesis: "Penicillin parenteral".
  const bareRoute = /\s+(oral|parenteral|intravenous|iv)$/i.exec(text);
  if (bareRoute) {
    route = ROUTE_QUALIFIERS[bareRoute[1]!.toLowerCase()] ?? route;
    text = text.slice(0, bareRoute.index).trim();
  }

  // The "or" that ends the first line of a paired row, and the one that joins
  // two agents on the same line.
  const name = text.replace(/\s+or\s*$/i, "").trim();
  const key = name.toLowerCase();

  if (isNoteText(name)) return { name, codes: [], site, route, potency, isNote: true };

  // A name the extraction cut in half: prefer what the row still carries, fall
  // back to the completions M100's own tables make unambiguous. The continuation
  // is only accepted when the join names a real agent, because the comments
  // column often opens with prose ("See general comment (3).") and
  // "Trimethoprim-See" is not a better label than "Trimethoprim-".
  if (name.endsWith("-")) {
    const word = stripDecoration(continuation).split(/[\s,;.]+/)[0] ?? "";
    const joined = word ? findByName((name + word).toLowerCase()) : null;
    const fallback = WRAPPED_AGENT_NAMES[key] ?? null;
    return {
      name: joined ? name + word : fallback ? namedBy(fallback, name) : name,
      codes: joined ? [joined] : fallback ? [fallback] : [],
      site,
      route,
      potency,
      isNote: false,
    };
  }

  const codes: string[] = [];
  for (const part of name.split(/\s+or\s+/i)) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const direct = lookupAntibiotic(canonicalAntibioticCode(part.trim()));
    const code = M100_AGENT_SYNONYMS[token] ?? findByName(token) ?? (direct ? direct.code : null);
    if (code && !codes.includes(code)) codes.push(code);
  }

  return { name, codes, site, route, potency, isNote: false };
}

/**
 * Prose that landed in the agent column.
 *
 * The published tables end each section with symbol keys, footnotes and a
 * reference list, and an extraction has nowhere to put them but the first wide
 * column. They are recognised so they can be passed over in silence: listing a
 * hundred of them as failures would hide the handful of agents that genuinely
 * did not convert.
 */
function isNoteText(name: string): boolean {
  if (!name) return true;
  const lower = name.toLowerCase();
  if (/^(symbol|note|footnote|reference|abbreviation|rx:|nrs?:)/.test(lower)) return true;
  if (/^(and|or|that|which|are|is|not|for|the|see|when|if|breakpoints?)\b/.test(lower)) return true;
  if (/\b(designation|included in tables|clinical breakpoints|standards institute)\b/.test(lower)) {
    return true;
  }
  if (/[,;]$/.test(name)) return true;
  // A resistance phenotype or a sub-heading lifted from the column beside it.
  if (/^[A-Z]{3,6}$/.test(name)) return true;
  // Prose gives itself away with a verb, a conjunction at the end, or a unit.
  if (/\b(was|were|are|is|be|been|should|may|must|also)\b/i.test(name)) return true;
  if (/\b(and|or|with|from)$/i.test(name)) return true;
  if (/(µg|ug\/mL|mg\/L|MICs)\b/.test(name)) return true;
  // An agent name is short. Five words of prose is a sentence.
  return name.split(/\s+/).length > 4;
}

/** The dictionary's own name for a code, for reporting a wrapped label as the
 * agent it was completed to rather than as the half the file carried. */
function namedBy(code: string, fallback: string): string {
  return lookupAntibiotic(code)?.name ?? fallback;
}

let nameIndex: Map<string, string> | null = null;

/**
 * Agent names, indexed from the dictionary rather than declared here.
 *
 * An agent added to ANTIBIOTICS becomes importable without this file changing,
 * which is the point: the dictionary is the one place an agent is named.
 */
function findByName(lowerName: string): string | null {
  if (!nameIndex) {
    nameIndex = new Map();
    for (const entry of ANTIBIOTICS) {
      nameIndex.set(entry.name.toLowerCase(), entry.code);
      // The same agent written with a slash instead of a hyphen.
      nameIndex.set(entry.name.toLowerCase().replace(/-/g, "/"), entry.code);
      if (entry.clsiAgentCode) nameIndex.set(entry.clsiAgentCode.toLowerCase(), entry.code);
    }
  }
  return nameIndex.get(lowerName) ?? null;
}

/** A cell holding no value. M100 prints an en dash; extractions produce several
 * other spellings of "nothing here". */
function isBlank(value: string | undefined): boolean {
  const text = (value ?? "").trim();
  return (
    text === "" || text === "-" || text === "–" || text === "—" || text === "NA" || text === "N/A"
  );
}

/**
 * The number in a breakpoint cell.
 *
 * Combination agents are printed as a pair — `≤8/4`, `≤2/38` — where the
 * breakpoint is the first component at a fixed ratio. The first number is the
 * value; the whole printed cell is preserved by the caller.
 */
export function parseBound(value: string): number | null {
  const cleaned = stripDecoration(String(value ?? "").replace(/[≤≥<>=]/g, " "));
  const first = /(\d+(?:\.\d+)?)/.exec(cleaned);
  return first ? Number(first[1]) : null;
}

/** A range cell: `14-16`, `1/19-2/38`, or a single value standing for both. */
export function parseRange(value: string): { min: number | null; max: number | null } {
  const cleaned = stripDecoration(String(value ?? ""));
  const range = /(\d+(?:\.\d+)?)(?:\/\d+(?:\.\d+)?)?\s*[-–]\s*(\d+(?:\.\d+)?)/.exec(cleaned);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const single = parseBound(cleaned);
  return { min: single, max: single };
}

/**
 * Whether a row's four value cells can be trusted.
 *
 * Each check names a way the extraction is known to fail, and each is
 * structural — nothing here needs to know what the right answer would have been:
 *
 * - a cell carrying an operator and no number is a value the extraction lost;
 * - an operator anywhere but the front means two cells were run together, or one
 *   slid into the next;
 * - susceptible and resistant open with opposite operators, and which way round
 *   depends on the method — a zone is `≥` susceptible, an MIC is `≤`. The wrong
 *   one means the columns are offset;
 * - intermediate is a band, never a bound. `I ≤2` is a susceptible value that
 *   has moved one column right.
 */
/**
 * One value: a bound, a range, a bare number, or a dash meaning nothing here.
 *
 * The order of the alternatives matters. A bound must be tried before a bare
 * number so `≤14` does not read as `14`, and a range before a bare number so
 * `15-17` does not read as `15`.
 */
const VALUE_TOKEN =
  /[≤≥<>]\s*\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?\^?|\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?\s*[-–]\s*\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?\^?|\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?\^?|[-–—]/g;

/** A leading disk potency, which is not one of the values. */
const POTENCY = /^\s*(?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?\s*)?(?:µg|ug|mcg|units?)\b/i;

/**
 * Put a row's values back in their own columns.
 *
 * Some rows come out of the extraction split at the wrong character: every
 * operator ends up stuck to the end of the cell before it, so the
 * Enterobacterales gentamicin row reads
 *
 *     "µg ≥" | "18" | "– 15-17^" | "≤" | "14 ≤" | "2" | "–" | "4^ ≥" | "8"
 *
 * where the row three lines below it, printed identically, reads
 *
 *     "30 µg" | "≥18" | "–" | "15-17^" | "≤14" | "≤2" | "–" | "4^" | "≥8"
 *
 * The characters are the same and in the same order; only the cell boundaries
 * are wrong. So this re-splits them — it re-reads the row's own text and invents
 * nothing — and the result is accepted only if it yields exactly the number of
 * values the layout has columns for. Anything else is left damaged, to be caught
 * and dropped by the checks that follow.
 *
 * Without this, gentamicin, tobramycin and amikacin against Enterobacterales
 * are missing from the converted table: three of the agents a surveillance
 * antibiogram is mostly made of.
 */
function repairSplit(row: string[], layout: ColumnLayout): string[] {
  const slots = [
    ...(layout.zone ? [layout.zone.s, layout.zone.sdd, layout.zone.i, layout.zone.r] : []),
    ...(layout.mic ? [layout.mic.s, layout.mic.sdd, layout.mic.i, layout.mic.r] : []),
  ].filter((index) => index >= 0);
  if (slots.length === 0) return row;

  // Only rows that are actually broken are touched. A well-formed row re-split
  // would gain nothing and could only lose something.
  const damaged = slots.some((index) => {
    const cell = (row[index] ?? "").trim();
    return cell !== "" && /[≤≥<>]/.test(cell) && cell.search(/[≤≥<>]/) > 0;
  });
  if (!damaged) return row;

  const first = layout.diskContent >= 0 ? Math.min(layout.diskContent, slots[0]!) : slots[0]!;
  const last = Math.max(...slots);
  const joined = row.slice(first, last + 1).join(" ");

  const potency = POTENCY.exec(joined);
  const body = potency ? joined.slice(potency[0].length) : joined;
  const tokens = (body.match(VALUE_TOKEN) ?? []).map((token) => token.replace(/\s+/g, ""));
  if (tokens.length !== slots.length) return row;

  const repaired = [...row];
  if (layout.diskContent >= 0) {
    // The potency's number is often left behind in the agent label
    // ("Gentamicin 10"), so what survives here can be just the unit. Both parts
    // are recombined by the caller, which has the label.
    repaired[layout.diskContent] = (potency?.[0] ?? "").trim();
  }
  slots.forEach((index, position) => {
    repaired[index] = tokens[position]!;
  });
  return repaired;
}

/**
 * The disk content, from wherever the extraction left its two halves.
 *
 * Normally the whole thing is in its own column: `30 µg`. On a badly split row
 * the number ends up in the agent label — `Gentamicin 10` — and only the unit
 * survives in the column, so the two are put back together. Neither half is
 * invented: if the column carries a number already it is used as it stands.
 */
function diskContentOf(column: string, potency: string | null): string | null {
  const cell = column.trim();
  if (/\d/.test(cell)) return cell;
  if (potency) return cell ? `${potency} ${cell}` : potency;
  return cell || null;
}

function columnsAreSound(
  values: { s: string; sdd: string; i: string; r: string },
  method: "disk" | "mic",
): string | null {
  for (const [column, raw] of Object.entries(values)) {
    if (isBlank(raw)) continue;
    const cell = stripDecoration(raw);
    const operator = cell.search(/[≤≥<>]/);
    if (operator > 0) return `the ${column.toUpperCase()} column reads "${raw.trim()}"`;
    if (!/\d/.test(cell)) return `the ${column.toUpperCase()} column has no number in it`;
  }

  const opens = (raw: string): string => stripDecoration(raw).charAt(0);
  const wrongWayRound = method === "disk" ? "≤" : "≥";
  if (!isBlank(values.s) && opens(values.s) === wrongWayRound) {
    return `the susceptible column reads "${values.s.trim()}", which is the wrong way round for ${
      method === "disk" ? "a zone diameter" : "an MIC"
    }`;
  }
  const resistantWrongWayRound = method === "disk" ? "≥" : "≤";
  if (!isBlank(values.r) && opens(values.r) === resistantWrongWayRound) {
    return `the resistant column reads "${values.r.trim()}", which is the wrong way round for ${
      method === "disk" ? "a zone diameter" : "an MIC"
    }`;
  }
  if (!isBlank(values.i) && /[≤≥<>]/.test(stripDecoration(values.i))) {
    return `the intermediate column reads "${values.i.trim()}", which is a bound rather than a range`;
  }
  return null;
}

interface ColumnLayout {
  table: number;
  organism: number;
  drugClass: number;
  agent: number;
  diskContent: number;
  zone: { s: number; sdd: number; i: number; r: number } | null;
  mic: { s: number; sdd: number; i: number; r: number } | null;
  comments: number;
  firstDataRow: number;
}

/**
 * Work out where the columns are.
 *
 * Extractions of the same document differ in column order and in whether the
 * S/SDD/I/R labels sit on the header row or a second row beneath it. Reading the
 * headers rather than assuming positions is what lets one importer accept the
 * workbook a laboratory actually has.
 */
export function detectLayout(rows: string[][]): ColumnLayout | null {
  for (let index = 0; index < Math.min(rows.length, 12); index += 1) {
    const header = (rows[index] ?? []).map((cell) => cell.trim().toLowerCase());
    const agent = header.findIndex((cell) => cell.includes("antimicrobial agent"));
    const organism = header.findIndex((cell) => cell.includes("organism"));
    if (agent < 0 || organism < 0) continue;

    const zoneHeader = header.findIndex((cell) => cell.includes("zone diameter"));
    // `\bmic\b`, not `includes("mic")`: "Antimicrobial Agent" contains the
    // letters, and matching it made every MIC band read the zone columns.
    const micHeader = header.findIndex((cell) => /\bmic\b/.test(cell));
    const second = (rows[index + 1] ?? []).map((cell) => cell.trim().toLowerCase());
    const hasSecondRow = second.includes("s") && second.includes("r");

    const findBand = (start: number): { s: number; sdd: number; i: number; r: number } | null => {
      if (start < 0) return null;
      const source = hasSecondRow ? second : header;
      const s = source.indexOf("s", start);
      if (s < 0) return null;
      return { s, sdd: source.indexOf("sdd", s), i: source.indexOf("i", s), r: source.indexOf("r", s) };
    };

    // A sheet carrying only one method labels its band on the header itself.
    const zone = zoneHeader >= 0 ? findBand(zoneHeader) : hasSecondRow ? null : findBand(agent);
    const mic = micHeader >= 0 ? findBand(micHeader) : null;
    if (!zone && !mic) continue;

    return {
      table: header.findIndex((cell) => cell === "table"),
      organism,
      drugClass: header.findIndex((cell) => cell.includes("drug class")),
      agent,
      diskContent: header.findIndex((cell) => cell.includes("disk content")),
      zone,
      mic,
      comments: header.findIndex((cell) => cell.includes("comment")),
      firstDataRow: index + (hasSecondRow ? 2 : 1),
    };
  }
  return null;
}

export interface ConvertOptions {
  /** What the criteria cite as their source. Stamped on every row, so a result
   * interpreted today stays explicable after the next edition is adopted. */
  standard?: string;
  /** Restrict the conversion to one method, for a laboratory that reads only
   * zones or only MICs and does not want the other half in its table. */
  only?: "disk" | "mic";
}

export function convertM100Workbook(buffer: Buffer, options: ConvertOptions = {}): M100Conversion {
  const workbook = readWorkbook(buffer);
  const standard = options.standard ?? "CLSI M100";

  // The combined sheet carries both methods on one row and is preferred; a
  // workbook holding only one of them still converts.
  const preferred = [
    "Combined (Zone + MIC)",
    "Combined",
    "Zone Diameter Breakpoints",
    "MIC Breakpoints",
  ];
  const sheetName =
    preferred.find(
      (name) => workbook.sheetNames.includes(name) && detectLayout(workbook.sheet(name)) !== null,
    ) ?? workbook.sheetNames.find((name) => detectLayout(workbook.sheet(name)) !== null);

  if (!sheetName) {
    throw new Error(
      "No breakpoint table was found in this workbook. A sheet is expected with Organism and " +
        "Antimicrobial Agent columns, and S/I/R columns beneath a zone diameter or MIC heading.",
    );
  }

  const rows = workbook.sheet(sheetName);
  const layout = detectLayout(rows)!;

  const criteria: Array<{ criterion: BreakpointCriterion; row: number }> = [];
  const dropped: DroppedRow[] = [];
  const groups = new Set<string>();
  const agents = new Set<string>();
  let skippedNotes = 0;
  let diskCriteria = 0;
  let micCriteria = 0;
  let currentOrganism = "";

  const at = (row: string[], index: number): string => (index >= 0 ? (row[index] ?? "").trim() : "");

  for (let index = layout.firstDataRow; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const rowNumber = index + 1;
    const organismCell = at(row, layout.organism);
    if (organismCell) currentOrganism = organismCell;

    const agentCell = at(row, layout.agent);
    if (!agentCell) continue;

    // Some rows arrive split at the wrong character, with each operator stuck to
    // the end of the previous cell. Repaired here, before anything reads them.
    const repaired = repairSplit(row, layout);

    const zoneValues = layout.zone
      ? {
          s: at(repaired, layout.zone.s),
          sdd: at(repaired, layout.zone.sdd),
          i: at(repaired, layout.zone.i),
          r: at(repaired, layout.zone.r),
        }
      : null;
    const micValues = layout.mic
      ? {
          s: at(repaired, layout.mic.s),
          sdd: at(repaired, layout.mic.sdd),
          i: at(repaired, layout.mic.i),
          r: at(repaired, layout.mic.r),
        }
      : null;

    const hasZone = zoneValues !== null && Object.values(zoneValues).some((v) => !isBlank(v));
    const hasMic = micValues !== null && Object.values(micValues).some((v) => !isBlank(v));

    // A row with no values is the first line of a wrapped name, a section
    // heading, or a continuation. Nothing was lost by passing over it.
    if (!hasZone && !hasMic) continue;

    const agent = parseAgentLabel(agentCell, at(row, layout.comments));
    if (agent.isNote) {
      skippedNotes += 1;
      continue;
    }

    // S. pneumoniae prints three penicillin criteria that differ only by site,
    // and the extraction leaves the qualifier in the comments column rather than
    // beside the agent. Without it the three are indistinguishable and the
    // engine would pick one at random, so it is recovered here — from the
    // parenthesised word only, never from prose that merely mentions meningitis.
    const site = agent.site ?? siteFromComment(at(row, layout.comments));

    const group =
      M100_ORGANISM_GROUPS[currentOrganism.trim().toLowerCase()] ?? currentOrganism.trim();
    if (!group) {
      dropped.push({ row: rowNumber, label: agentCell, reason: "the row names no organism group" });
      continue;
    }

    if (agent.codes.length === 0) {
      dropped.push({
        row: rowNumber,
        label: `${group} · ${agent.name || agentCell}`,
        reason: "this agent is not in the AMRSS dictionary, so no result could be matched to it",
      });
      continue;
    }

    const bases = agent.codes.map((code) => ({
      organism_group: group,
      agent_code: code,
      standard,
      table_reference: at(row, layout.table) || null,
      site,
      route: agent.route,
      tier: null,
    }));

    let kept = false;

    if (hasZone && zoneValues && options.only !== "mic") {
      const problem =
        columnsAreSound(zoneValues, "disk") ?? unbounded(zoneValues, "zone diameter");
      if (problem) {
        dropped.push({
          row: rowNumber,
          label: `${group} · ${agent.name} (zone diameter)`,
          reason: `${problem}, so this row could not be read reliably`,
        });
      } else {
        const intermediate = parseRange(zoneValues.i);
        const sdd = parseRange(zoneValues.sdd);
        for (const base of bases) criteria.push({ row: rowNumber, criterion: {
          ...base,
          method: "DISK",
          disk_content: diskContentOf(at(repaired, layout.diskContent), agent.potency),
          disk_susceptible_min: isBlank(zoneValues.s) ? null : parseBound(zoneValues.s),
          disk_sdd_min: isBlank(zoneValues.sdd) ? null : sdd.min,
          disk_sdd_max: isBlank(zoneValues.sdd) ? null : sdd.max,
          disk_intermediate_min: isBlank(zoneValues.i) ? null : intermediate.min,
          disk_intermediate_max: isBlank(zoneValues.i) ? null : intermediate.max,
          disk_resistant_max: isBlank(zoneValues.r) ? null : parseBound(zoneValues.r),
          comment: verbatim("Zone", zoneValues, at(row, layout.comments)),
        } });
        diskCriteria += bases.length;
        kept = true;
      }
    }

    if (hasMic && micValues && options.only !== "disk") {
      const problem =
        columnsAreSound(micValues, "mic") ?? unbounded(micValues, "MIC");
      if (problem) {
        dropped.push({
          row: rowNumber,
          label: `${group} · ${agent.name} (MIC)`,
          reason: `${problem}, so this row could not be read reliably`,
        });
      } else {
        const intermediate = parseRange(micValues.i);
        const sdd = parseRange(micValues.sdd);
        for (const base of bases) criteria.push({ row: rowNumber, criterion: {
          ...base,
          method: "MIC",
          mic_susceptible_max: isBlank(micValues.s) ? null : parseBound(micValues.s),
          mic_sdd_min: isBlank(micValues.sdd) ? null : sdd.min,
          mic_sdd_max: isBlank(micValues.sdd) ? null : sdd.max,
          mic_intermediate_min: isBlank(micValues.i) ? null : intermediate.min,
          mic_intermediate_max: isBlank(micValues.i) ? null : intermediate.max,
          mic_resistant_min: isBlank(micValues.r) ? null : parseBound(micValues.r),
          comment: verbatim("MIC", micValues, at(row, layout.comments)),
        } });
        micCriteria += bases.length;
        kept = true;
      }
    }

    if (kept) {
      groups.add(group);
      for (const code of agent.codes) agents.add(code);
    }
  }

  return {
    criteria: reconcile(criteria, dropped),
    organismGroups: [...groups].sort(),
    agentCodes: [...agents].sort(),
    dropped,
    skippedNotes,
    diskCriteria,
    micCriteria,
    sourceSheet: sheetName,
  };
}

/**
 * A criterion that classifies nothing.
 *
 * An intermediate band with neither a susceptible nor a resistant bound leaves
 * every measurement above and below it unclassifiable. It is not a partial
 * criterion — it is coverage that does not exist, and it would show in the table
 * as a covered combination while interpreting none of them. The platform's
 * importer refuses these outright, so converting one would build a table that
 * cannot be published.
 */
function unbounded(
  values: { s: string; sdd: string; i: string; r: string },
  kind: string,
): string | null {
  if (!isBlank(values.s) || !isBlank(values.r) || !isBlank(values.sdd)) return null;
  return `the ${kind} row gives neither a susceptible nor a resistant bound`;
}

/**
 * The site qualifier as the comments column carries it.
 *
 * Only the bare parenthesised word counts. A comment reading "report
 * interpretations for both meningitis and nonmeningitis" names both and
 * qualifies neither, so it is left alone.
 */
function siteFromComment(comment: string): string | null {
  const tokens = [...comment.matchAll(/\(([^)]*)\)/g)].map((m) =>
    (m[1] ?? "").trim().toLowerCase(),
  );
  const found = tokens.filter((token) => SITE_QUALIFIERS[token]);
  return found.length === 1 ? SITE_QUALIFIERS[found[0]!]! : null;
}

/**
 * One criterion per scope, or none.
 *
 * Two rows claiming the same scope arise two ways, and they are not the same
 * problem:
 *
 * - **A page break.** The extraction repeats the row where the printed table
 *   continued onto the next page. The thresholds are identical, nothing is in
 *   doubt, and one copy is kept silently. Reporting it would bury the drops
 *   that matter, and leaving both would make the criteria count useless as a
 *   check that the file arrived intact.
 * - **A lost sub-heading.** M100 prints several tables carrying two sub-groups
 *   under one heading — ciprofloxacin for Salmonella and for Shigella under
 *   "Salmonella and Shigella spp.", daptomycin for E. faecium and for other
 *   enterococci under "Enterococcus spp." — and the extraction loses the
 *   sub-heading that separated them. The thresholds differ and nothing in the
 *   file says which set belongs to which organism.
 *
 * The second case takes *both* rows out. Keeping one would pick a threshold by
 * row order, and the engine refuses a scope it cannot choose within, so keeping
 * both would make the whole table unpublishable over one ambiguity. Dropped and
 * named, the laboratory adds the pair back under the sub-groups they belong to.
 */
function reconcile(
  entries: Array<{ criterion: BreakpointCriterion; row: number }>,
  dropped: DroppedRow[],
): BreakpointCriterion[] {
  const byScope = new Map<string, Array<{ criterion: BreakpointCriterion; row: number }>>();
  for (const entry of entries) {
    const key = criterionScope(entry.criterion);
    byScope.set(key, [...(byScope.get(key) ?? []), entry]);
  }

  const kept: BreakpointCriterion[] = [];
  for (const group of byScope.values()) {
    const distinct = new Set(group.map((entry) => thresholdsOf(entry.criterion)));
    if (distinct.size === 1) {
      // The first occurrence wins: it carries the comment printed with the
      // table rather than the one carried over onto the next page.
      kept.push(group[0]!.criterion);
      continue;
    }
    const first = group[0]!.criterion;
    dropped.push({
      row: group[0]!.row,
      label: `${first.organism_group} · ${antibioticLabel(first.agent_code)} (${first.method})`,
      reason:
        `the printed table gives this combination ${group.length} times with different thresholds `
        + `(rows ${group.map((entry) => entry.row).join(", ")}) — the sub-group each set belongs to `
        + "is not in this file, so none of them can be applied",
    });
  }
  return kept;
}

/** The scope, as the shared validation engine keys it. */
function criterionScope(criterion: BreakpointCriterion): string {
  return [
    (criterion.organism_group ?? "").toLowerCase(),
    (criterion.agent_code ?? "").toUpperCase(),
    (criterion.method ?? "").toUpperCase(),
    (criterion.site ?? "").toLowerCase(),
    (criterion.route ?? "").toLowerCase(),
  ].join("|");
}

/** The thresholds alone, so a repeat can be told from a contradiction without
 * the comment or table reference — which differ between page copies — counting
 * as a difference. */
function thresholdsOf(criterion: BreakpointCriterion): string {
  const { comment: _comment, table_reference: _table, ...rule } = criterion;
  return JSON.stringify(rule);
}

/** The printed cell, kept beside the number it became. A combination agent's
 * `≤8/4` and a footnote marker are both recoverable from here. */
function verbatim(
  kind: string,
  values: { s: string; sdd: string; i: string; r: string },
  comment: string,
): string {
  const parts = [
    !isBlank(values.s) ? `S ${values.s}` : "",
    !isBlank(values.sdd) ? `SDD ${values.sdd}` : "",
    !isBlank(values.i) ? `I ${values.i}` : "",
    !isBlank(values.r) ? `R ${values.r}` : "",
  ].filter(Boolean);
  const printed = `${kind} as printed: ${parts.join(", ")}`;
  return comment ? `${printed}. ${comment}` : printed;
}
