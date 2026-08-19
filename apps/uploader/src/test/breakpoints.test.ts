import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  advisoriesFor,
  BREAKPOINT_COLUMNS,
  catalogue,
  organismGroupsIn,
  setCell,
  breakpointCsv,
  criterionKey,
  criterionRow,
  matchesPreference,
  removeCriterion,
  upsertCriterion,
  validateCriterion,
} from "../core/breakpoints";
import { parseBreakpointCsv, type BreakpointCriterion } from "../core/interpret";
import {
  CODE_CATEGORIES,
  codebookWorkbook,
  readCodebookWorkbook,
  unmappedCodes,
} from "../core/codebook";
import { detectLayout, parseAgentLabel, parseBound, parseRange } from "../core/m100";
import { buildWorkbook } from "../core/xlsx";
import { readWorkbook } from "../core/xlsx-read";

const disk: BreakpointCriterion = {
  organism_group: "Enterobacterales",
  agent_code: "AMP",
  method: "DISK",
  disk_content: "10 µg",
  standard: "CLSI M100",
  table_reference: "2A-1",
  disk_susceptible_min: 17,
  disk_intermediate_min: 14,
  disk_intermediate_max: 16,
  disk_resistant_max: 13,
  comment: "Zone as printed: S ≥17, I 14-16, R ≤13",
};

const mic: BreakpointCriterion = {
  organism_group: "Enterobacterales",
  agent_code: "AMP",
  method: "MIC",
  mic_susceptible_max: 8,
  mic_intermediate_min: 16,
  mic_intermediate_max: 16,
  mic_resistant_min: 32,
};

/* ------------------------------------------------------------------ *
 * Export.
 * ------------------------------------------------------------------ */

test("what Export writes is what Import reads, value for value", () => {
  // The whole promise of the export: a laboratory corrects one threshold in
  // Excel and puts the file straight back. A column dropped on the way out, or
  // renamed, breaks that silently and the laboratory finds out when an isolate
  // is categorised wrongly.
  const csv = breakpointCsv([disk, mic]);
  assert.equal(csv.split("\n")[0], BREAKPOINT_COLUMNS.join(","));

  const parsed = parseBreakpointCsv(csv);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.criteria.length, 2);

  const back = parsed.criteria[0]!;
  assert.equal(back.organism_group, "Enterobacterales");
  assert.equal(back.agent_code, "AMP");
  assert.equal(back.method, "DISK");
  assert.equal(String(back.disk_susceptible_min), "17");
  assert.equal(String(back.disk_resistant_max), "13");
  assert.equal(String(back.disk_intermediate_min), "14");
  assert.equal(parsed.criteria[1]!.method, "MIC");
  assert.equal(String(parsed.criteria[1]!.mic_susceptible_max), "8");
});

test("a comment carrying a comma survives the round trip", () => {
  const withComma: BreakpointCriterion = {
    ...disk,
    comment: 'Zone as printed: S ≥17, I 14-16, R ≤13. See "general comment (5)".',
  };
  const parsed = parseBreakpointCsv(breakpointCsv([withComma]));
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.criteria[0]!.comment, withComma.comment);
});

/* ------------------------------------------------------------------ *
 * Validation.
 * ------------------------------------------------------------------ */

test("a disk row without its disk content is refused, as the platform refuses it", () => {
  // 30 µg gentamicin and 10 µg gentamicin have different thresholds. A row the
  // uploader accepted but the platform would reject is a table that cannot be
  // published.
  const { disk_content: _dropped, ...withoutContent } = disk;
  assert.ok(validateCriterion(withoutContent).some((problem) => /disk content/.test(problem)));
});

test("a disk row entered the MIC way round is refused, not saved", () => {
  // The commonest transcription error there is: zones run opposite to MICs, so
  // susceptible ≥17 mm and resistant ≤13 mm. Entered the other way round the
  // table categorises every isolate as susceptible and reports nothing wrong.
  const inverted = { ...disk, disk_susceptible_min: 13, disk_resistant_max: 17 };
  const problems = validateCriterion(inverted);
  assert.ok(problems.some((problem) => /opposite to MICs/.test(problem)));

  assert.deepEqual(validateCriterion(disk), []);
  assert.deepEqual(validateCriterion(mic), []);
});

test("an MIC row with susceptible above resistant is refused", () => {
  const problems = validateCriterion({ ...mic, mic_susceptible_max: 64, mic_resistant_min: 32 });
  assert.ok(problems.some((problem) => /must be below resistant/.test(problem)));
});

test("an intermediate band that overlaps a neighbour is refused", () => {
  const overlapping = { ...disk, disk_intermediate_max: 18 };
  assert.ok(
    validateCriterion(overlapping).some((problem) => /overlaps the susceptible/.test(problem)),
  );
});

test("a zone outside what a disk test can produce is refused", () => {
  assert.ok(
    validateCriterion({ ...disk, disk_susceptible_min: 90 }).some((problem) =>
      /outside what a disk test produces/.test(problem),
    ),
  );
});

test("an agent the dictionary does not hold is refused", () => {
  // A criterion for an agent with no code can never match a result, so it is
  // coverage that does not exist.
  assert.ok(
    validateCriterion({ ...disk, agent_code: "ZZZ" }).some((problem) =>
      /not an antimicrobial the dictionary knows/.test(problem),
    ),
  );
});

test("an SDD band without its dosing regimen is flagged, but not refused", () => {
  // Susceptible-dose-dependent is a statement about the dose, and without the
  // regimen it assumes the category cannot be acted on — so it is said. It is
  // not blocked, because the platform's importer treats it as a warning, and an
  // uploader that refused what the platform accepts would leave a laboratory
  // unable to correct a row it had just imported successfully.
  const sdd: BreakpointCriterion = {
    ...mic,
    mic_susceptible_max: 2,
    mic_sdd_min: 4,
    mic_sdd_max: 8,
    mic_intermediate_min: undefined,
    mic_intermediate_max: undefined,
    mic_resistant_min: 16,
  };
  assert.deepEqual(validateCriterion(sdd), []);
  assert.ok(advisoriesFor(sdd).some((note) => /dosage note/.test(note)));
  assert.deepEqual(advisoriesFor({ ...sdd, dosage_note: "1 g q8h" }), []);
});

test("agents the modern standard names are in the dictionary", () => {
  // The CLSI table names agents a 2018 dictionary did not. Each absence is a
  // whole row of the laboratory's own table that cannot be imported.
  for (const code of ["FDC", "CZA", "CZT", "DAP", "CPT", "MFX", "TGC", "FOS", "TMP", "PMB"]) {
    assert.deepEqual(
      validateCriterion({ ...mic, agent_code: code }),
      [],
      `${code} should be an agent the dictionary holds`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Editing.
 * ------------------------------------------------------------------ */

test("saving a criterion whose scope exists replaces it rather than joining it", () => {
  // Two rows the engine cannot choose between make the reported category depend
  // on the order rows happen to sit in, which is the worst outcome available.
  const first = upsertCriterion([], disk);
  assert.deepEqual(first.problems, []);

  const second = upsertCriterion(first.criteria, { ...disk, disk_susceptible_min: 18 });
  assert.equal(second.criteria.length, 1);
  assert.equal(second.criteria[0]!.disk_susceptible_min, 18);
});

test("two criteria differing only in disk content are one row, as the engine sees it", () => {
  // The shared validation engine keys a criterion on organism group, agent,
  // method, site and route — not disk content. An uploader that allowed both
  // would build a table the platform then rejects whole, so the second replaces
  // the first here rather than joining it.
  const thirty = { ...disk, disk_content: "30 µg" };
  assert.equal(criterionKey(disk), criterionKey(thirty));
  const table = upsertCriterion([disk], thirty);
  assert.equal(table.criteria.length, 1);
  assert.equal(table.criteria[0]!.disk_content, "30 µg");
});

test("a criterion with only an intermediate band is refused", () => {
  // Every measurement above and below the band is unclassifiable, so the row is
  // coverage that does not exist while showing in the table as coverage.
  const bandOnly: BreakpointCriterion = {
    organism_group: "Haemophilus influenzae and Haemophilus parainfluenzae",
    agent_code: "SMX",
    method: "MIC",
    mic_intermediate_min: 2,
    mic_intermediate_max: 2,
  };
  assert.ok(
    validateCriterion(bandOnly).some((problem) => /categorises nothing/.test(problem)),
  );
});

test("a criterion differing only in site is a different row", () => {
  // S. pneumoniae prints three penicillin criteria that differ only by site.
  // Collapsing them would lose the meningitis breakpoint entirely.
  const meningitis: BreakpointCriterion = {
    organism_group: "Streptococcus pneumoniae",
    agent_code: "PEN",
    method: "MIC",
    site: "meningitis",
    mic_susceptible_max: 0.06,
    mic_resistant_min: 0.12,
  };
  const other = { ...meningitis, site: "non_meningitis", mic_susceptible_max: 2, mic_resistant_min: 8 };

  assert.notEqual(criterionKey(meningitis), criterionKey(other));
  const table = upsertCriterion(upsertCriterion([], meningitis).criteria, other);
  assert.equal(table.criteria.length, 2);
});

test("a criterion that fails validation leaves the table untouched", () => {
  const table = upsertCriterion([disk], { ...disk, agent_code: "" });
  assert.equal(table.criteria.length, 1);
  assert.ok(table.problems.length > 0);
  assert.equal(table.criteria[0]!.disk_susceptible_min, 17);
});

test("removing a criterion removes exactly the one addressed", () => {
  const table = [disk, mic];
  const left = removeCriterion(table, criterionKey(disk));
  assert.equal(left.length, 1);
  assert.equal(left[0]!.method, "MIC");
});

test("a row is shown with the operators the printed table uses", () => {
  const row = criterionRow(disk);
  assert.equal(row.susceptible, "≥17 mm");
  assert.equal(row.resistant, "≤13 mm");
  assert.equal(row.intermediate, "14–16 mm");

  const micRow = criterionRow(mic);
  assert.equal(micRow.susceptible, "≤8");
  assert.equal(micRow.resistant, "≥32");
});

test("a laboratory reading only MICs is not shown a table of zone diameters", () => {
  assert.equal(matchesPreference(disk, "mic"), false);
  assert.equal(matchesPreference(mic, "mic"), true);
  assert.equal(matchesPreference({ method: "GRADIENT" }, "mic"), true);
  assert.equal(matchesPreference(disk, "disk"), true);
  assert.equal(matchesPreference(mic, "disk"), false);
  assert.equal(matchesPreference(disk, "both"), true);
  assert.equal(matchesPreference(mic, "both"), true);
});

/* ------------------------------------------------------------------ *
 * The M100 workbook reader.
 * ------------------------------------------------------------------ */

test("an agent label is read through the decoration the printed table carries", () => {
  assert.equal(parseAgentLabel("Ampicillin*").codes[0], "AMP");
  assert.equal(parseAgentLabel("Amikacin (U)a").codes[0], "AMK");
  assert.equal(parseAgentLabel("Amikacin (U)a").site, "uti");
  assert.equal(parseAgentLabel("Gentamicin 10").codes[0], "GEN");
  assert.equal(parseAgentLabel("Cefepime (meningitis)*").site, "meningitis");
  assert.equal(parseAgentLabel("Cefuroxime (oral)").route, "oral");
  assert.equal(parseAgentLabel("Penicillin parenteral").route, "iv");
  assert.equal(parseAgentLabel("Penicillin parenteral").codes[0], "PEN");
  // An organism name folded in from the column beside it.
  assert.equal(parseAgentLabel("Linezolid All staphylococci").codes[0], "LNZ");
  assert.equal(parseAgentLabel("Vancomycin S. aureus, including").codes[0], "VAN");
});

test("a name the extraction cut in half is completed, not dropped", () => {
  // "Trimethoprim-sulfamethoxazole" is set over two lines in the printed table
  // and extractions keep only the first. Plain trimethoprim is printed
  // separately as "Trimethoprim (U)", so the completion is not a guess.
  assert.equal(parseAgentLabel("Ceftolozane-", "tazobactam").codes[0], "CZT");
  assert.equal(parseAgentLabel("Trimethoprim-").codes[0], "SXT");
  assert.equal(parseAgentLabel("Trimethoprim (U)a").codes[0], "TMP");
  // The comments column often opens with prose; it must not become the name.
  const seen = parseAgentLabel("Trimethoprim-", "See general comment (3).");
  assert.equal(seen.codes[0], "SXT");
  assert.doesNotMatch(seen.name, /See/);
});

test("a row printed for two agents states thresholds for both", () => {
  const paired = parseAgentLabel("Ertapenem or imipenem");
  assert.deepEqual(paired.codes.sort(), ["ETP", "IPM"]);
});

test("footnote prose in the agent column is recognised as prose", () => {
  for (const text of [
    "Symbol: *, designation for “Other” agents",
    "Alternative agents are strongly",
    "and Laboratory Standards",
    "ceftazidime, ceftizoxime, and",
    "MRSA",
    "tetracycline MICs ≤4 µg/mL",
  ]) {
    assert.equal(parseAgentLabel(text).isNote, true, `"${text}" should read as prose`);
  }
  assert.equal(parseAgentLabel("Ciprofloxacin").isNote, false);
});

test("a combination agent's printed pair becomes its first component", () => {
  // ≤8/4 is ceftolozane-tazobactam at a fixed ratio: the breakpoint is the
  // first component. The printed cell is kept in the comment either way.
  assert.equal(parseBound("≤8/4"), 8);
  assert.equal(parseBound("≥32"), 32);
  assert.equal(parseBound("≤0.06"), 0.06);
  assert.equal(parseBound("–"), null);

  assert.deepEqual(parseRange("14-16^"), { min: 14, max: 16 });
  assert.deepEqual(parseRange("1/19-2/38"), { min: 1, max: 2 });
  assert.deepEqual(parseRange("4"), { min: 4, max: 4 });
});

test("the MIC band is not mistaken for the zone band by the word antimicrobial", () => {
  // "Antimicrobial Agent" contains the letters m-i-c. Matching it made every
  // MIC criterion read the zone columns, which is a wrong number, not a
  // missing one.
  const layout = detectLayout([
    ["Table", "Organism", "Drug Class", "Antimicrobial Agent", "Disk Content",
     "Zone Diameter Breakpoints (mm)", "", "", "", "MIC Breakpoints (µg/mL)", "", "", "", "Comments"],
    ["", "", "", "", "", "S", "SDD", "I", "R", "S", "SDD", "I", "R", ""],
  ])!;
  assert.ok(layout);
  assert.equal(layout.zone!.s, 5);
  assert.equal(layout.mic!.s, 9);
  assert.equal(layout.firstDataRow, 2);
});

/* ------------------------------------------------------------------ *
 * The table supplied with the software.
 * ------------------------------------------------------------------ */

/** The CLSI table committed under `data/breakpoints/`, which a laboratory loads
 * with one button and therefore nobody re-reads before it starts deciding what
 * an S is. */
const SHIPPED_TABLE = join(
  __dirname, "..", "..", "..", "..", "data", "breakpoints", "clsi_m100_ed36.csv",
);

test("the CLSI table shipped with AMRSS parses, and every criterion is sound", () => {
  // This file is loaded by a button, so nobody re-reads it before it starts
  // deciding what an S is. An edit that broke one row would otherwise be found
  // by a laboratory, in its antibiogram.
  const parsed = parseBreakpointCsv(readFileSync(SHIPPED_TABLE, "utf8"));

  assert.deepEqual(parsed.problems, []);
  assert.ok(parsed.criteria.length > 600, `expected the full table, got ${parsed.criteria.length}`);

  const bad = parsed.criteria.flatMap((criterion) => {
    const problems = validateCriterion(criterion);
    return problems.length === 0
      ? []
      : [`${criterion.organism_group} / ${criterion.agent_code} / ${criterion.method}: ${problems[0]}`];
  });
  assert.deepEqual(bad, []);

  // Every scope appears once. A duplicate would make the reported category
  // depend on the order rows sit in, and the platform refuses the whole table.
  const keys = parsed.criteria.map(criterionKey);
  assert.equal(new Set(keys).size, keys.length);
});

test("the shipped table covers the combinations a surveillance antibiogram is made of", () => {
  const { criteria } = parseBreakpointCsv(readFileSync(SHIPPED_TABLE, "utf8"));
  const covered = new Set(criteria.map((c) => `${c.organism_group}|${c.agent_code}`));

  // If a conversion change quietly dropped one of these, the coverage figure
  // would fall and nothing else would say why.
  for (const pair of [
    "Enterobacterales|AMP",
    "Enterobacterales|CRO",
    "Enterobacterales|CIP",
    "Enterobacterales|GEN",
    "Enterobacterales|AMK",
    "Enterobacterales|MEM",
    "Enterobacterales|SXT",
    "Enterobacterales|NIT",
    "Staphylococcus spp.|OXA",
    "Staphylococcus spp.|VAN",
    "Staphylococcus spp.|CLI",
    "Pseudomonas aeruginosa|CAZ",
    "Pseudomonas aeruginosa|MEM",
    "Acinetobacter spp.|MEM",
    "Streptococcus pneumoniae|PEN",
    "Streptococcus pneumoniae|ERY",
    "Salmonella and Shigella spp.|CRO",
    "Haemophilus influenzae and Haemophilus parainfluenzae|AMP",
  ]) {
    assert.ok(covered.has(pair), `${pair} should be covered by the shipped table`);
  }
});

test("the gaps in the shipped table are the ones documented, and no others", () => {
  // Some combinations a laboratory reports every day are not in this table:
  // either the source workbook never carried them, or the extraction damaged
  // them past the point where they could be read without guessing. They are
  // listed in data/breakpoints/README.md and have to be added by hand.
  //
  // Pinned here so that a change to the converter which silently loses *more*
  // than this is a failing test rather than a quiet drop in coverage.
  const { criteria } = parseBreakpointCsv(readFileSync(SHIPPED_TABLE, "utf8"));
  const covered = new Set(criteria.map((c) => `${c.organism_group}|${c.agent_code}`));

  const known = new Set([
    // Values the extraction damaged past reading.
    "Enterobacterales|COL",
    "Pseudomonas aeruginosa|COL",
    "Acinetobacter spp.|COL",
    "Neisseria gonorrhoeae|CRO",
    "Neisseria gonorrhoeae|CFM",
    // Printed twice under one heading for two sub-groups the extraction lost.
    "Salmonella and Shigella spp.|CIP",
    // Never in the source workbook at all.
    "Staphylococcus spp.|FOX",
    "Staphylococcus spp.|ERY",
    "Staphylococcus spp.|GEN",
    "Staphylococcus spp.|TEC",
    "Staphylococcus spp.|DAP",
    "Enterococcus spp.|GEN",
    "Enterococcus spp.|TEC",
    "Enterococcus spp.|DAP",
    "Pseudomonas aeruginosa|GEN",
  ]);

  const surveillance: Record<string, string[]> = {
    Enterobacterales: ["AMP", "AMC", "CRO", "CAZ", "FEP", "MEM", "GEN", "AMK", "CIP", "SXT", "NIT", "COL"],
    "Salmonella and Shigella spp.": ["AMP", "CRO", "CIP", "AZM", "SXT", "CHL"],
    "Pseudomonas aeruginosa": ["TZP", "CAZ", "FEP", "MEM", "GEN", "AMK", "TOB", "CIP", "COL"],
    "Acinetobacter spp.": ["SAM", "MEM", "AMK", "CIP", "SXT", "COL", "MNO"],
    "Staphylococcus spp.": ["PEN", "OXA", "FOX", "ERY", "CLI", "GEN", "CIP", "SXT", "VAN", "LNZ", "RIF", "TEC", "DAP"],
    "Enterococcus spp.": ["AMP", "PEN", "VAN", "LNZ", "GEN", "NIT", "TEC", "DAP"],
    "Streptococcus pneumoniae": ["PEN", "CRO", "ERY", "CLI", "SXT", "VAN", "CHL"],
    "Neisseria gonorrhoeae": ["CRO", "CFM", "AZM", "CIP", "SPT", "TCY"],
  };

  const gaps = Object.entries(surveillance).flatMap(([group, agents]) =>
    agents.filter((agent) => !covered.has(`${group}|${agent}`)).map((agent) => `${group}|${agent}`),
  );

  const unexpected = gaps.filter((gap) => !known.has(gap));
  assert.deepEqual(unexpected, [], "a combination was lost that the documented gaps do not cover");
});

/* ------------------------------------------------------------------ *
 * The table as CLSI prints it.
 * ------------------------------------------------------------------ */

function loadedSet() {
  const { criteria } = parseBreakpointCsv(readFileSync(SHIPPED_TABLE, "utf8"));
  return {
    version: "M100-Ed36",
    label: "CLSI M100 36th edition (2026)",
    effectiveFrom: null,
    source: "local-import" as const,
    syncedAt: null,
    criteria,
  };
}

test("the two methods are separate tables, as the printed document has them", () => {
  // Side by side is how a zone diameter gets read as a concentration: the two
  // run in opposite directions and share nothing but the agent name.
  const set = loadedSet();
  const zones = catalogue(set, { method: "DISK" });
  const mics = catalogue(set, { method: "MIC" });

  assert.equal(zones.unit, "mm");
  assert.equal(mics.unit, "µg/mL");
  assert.ok(zones.shown > 250);
  assert.ok(mics.shown > 350);
  assert.equal(zones.shown + mics.shown, set.criteria.length);

  // Every row on the zone page is a zone; nothing leaks across.
  const rows = zones.sections.flatMap((s) => s.classes.flatMap((c) => c.rows));
  assert.ok(rows.every((row) => row.susceptible === "—" || /mm$/.test(row.susceptible)));
});

test("a section is laid out the way M100 lays it out", () => {
  const first = catalogue(loadedSet(), { method: "DISK" }).sections[0]!;

  // Enterobacterales first, as the standard runs them — not alphabetically,
  // which would open on Acinetobacter.
  assert.equal(first.organismGroup, "Enterobacterales");
  assert.equal(first.tableReference, "2A-1");

  const headings = first.classes.map((group) => group.label);
  assert.equal(headings[0], "PENICILLINS");
  assert.ok(headings.indexOf("CEPHEMS") < headings.indexOf("CARBAPENEMS"));
  assert.ok(headings.indexOf("CARBAPENEMS") < headings.indexOf("AMINOGLYCOSIDES"));

  // The β of β-LACTAM is the symbol, not a capital Beta. `text-transform`
  // would change the letter, so the casing is carried in the label itself.
  assert.ok(headings.includes("β-LACTAM COMBINATION AGENTS"));
});

test("a threshold is written the way the standard writes it", () => {
  const zones = catalogue(loadedSet(), { method: "DISK", search: "ampicillin" });
  const row = zones.sections
    .find((section) => section.organismGroup === "Enterobacterales")!
    .classes.flatMap((group) => group.rows)
    .find((candidate) => candidate.agentCode === "AMP")!;

  assert.equal(row.susceptible, "≥17 mm");
  assert.equal(row.intermediate, "14–16 mm");
  assert.equal(row.resistant, "≤13 mm");
  assert.equal(row.qualifier, "10 µg");
  // The editor gets the stored numbers, not the formatted text: reading
  // "≥17 mm" back into 17 is the round trip that loses a value.
  assert.equal(row.values.susceptible, "17");
  assert.equal(row.values.intermediateMax, "16");
});

test("an organism covered only by MICs is named rather than silently absent", () => {
  // Otherwise a laboratory on the zone page concludes the organism is missing
  // from its table when it is simply covered the other way.
  const zones = catalogue(loadedSet(), { method: "DISK" });
  assert.ok(zones.onlyUnderOtherMethod.length > 0);
  assert.ok(zones.onlyUnderOtherMethod.every((group) => group !== ""));
});

test("the search covers what a person would type", () => {
  const set = loadedSet();
  const byCode = catalogue(set, { method: "DISK", search: "CIP" });
  const byName = catalogue(set, { method: "DISK", search: "ciprofloxacin" });
  const byOrganism = catalogue(set, { method: "DISK", search: "staphylococcus" });

  assert.ok(byCode.sections.length > 0);
  assert.ok(byName.sections.length > 0);
  assert.ok(byOrganism.sections.every((s) => /staphylo/i.test(s.organismGroup)));
});

test("every organism group is offered for the jump list, in the printed order", () => {
  const groups = organismGroupsIn(loadedSet());
  assert.equal(groups[0], "Enterobacterales");
  assert.ok(groups.includes("Staphylococcus spp."));
  assert.ok(groups.indexOf("Enterobacterales") < groups.indexOf("Staphylococcus spp."));
});

/* ------------------------------------------------------------------ *
 * Editing a threshold where it sits.
 * ------------------------------------------------------------------ */

test("one threshold is corrected without disturbing the rest of the row", () => {
  const edit = setCell([disk], criterionKey(disk), "DISK", "susceptible", "18");
  assert.deepEqual(edit.problems, []);
  assert.equal(edit.criteria[0]!.disk_susceptible_min, "18");
  // Everything else survives, including the printed cell in the comment.
  assert.equal(edit.criteria[0]!.disk_resistant_max, 13);
  assert.equal(edit.criteria[0]!.comment, disk.comment);
});

test("a correction that contradicts the rest of the row is refused as it is made", () => {
  // Not at publication, when whoever typed it has moved on: susceptible 12 mm
  // sits below the resistant bound of 13 and would call every isolate
  // susceptible.
  const edit = setCell([disk], criterionKey(disk), "DISK", "susceptible", "12");
  assert.ok(edit.problems.length > 0);
  assert.equal(edit.criteria[0]!.disk_susceptible_min, 17);
});

test("a threshold can be cleared, and text that is not a number cannot be entered", () => {
  const cleared = setCell([disk], criterionKey(disk), "DISK", "intermediateMin", "");
  assert.deepEqual(cleared.problems, []);
  assert.equal(cleared.criteria[0]!.disk_intermediate_min, null);

  const rubbish = setCell([disk], criterionKey(disk), "DISK", "susceptible", "eighteen");
  assert.ok(rubbish.problems.some((problem) => /is not a number/.test(problem)));
});

test("editing addresses the row by scope, and says so when it is gone", () => {
  const edit = setCell([disk], "no|SUCH|ROW||", "DISK", "susceptible", "18");
  assert.ok(edit.problems.some((problem) => /no longer in the table/.test(problem)));
});

test("the MIC cell writes the MIC column, never the zone column", () => {
  // The two run in opposite directions; writing one into the other is the
  // error the whole method split exists to prevent.
  const edit = setCell([mic], criterionKey(mic), "MIC", "susceptible", "4");
  assert.deepEqual(edit.problems, []);
  assert.equal(edit.criteria[0]!.mic_susceptible_max, "4");
  assert.equal(edit.criteria[0]!.disk_susceptible_min, undefined);
});

/* ------------------------------------------------------------------ *
 * The code book.
 * ------------------------------------------------------------------ */

const emptyMappings = { organism: {}, specimen: {}, antibiotic: {} };

test("the code book workbook holds a sheet for each category and lists every code", () => {
  const workbook = readWorkbook(codebookWorkbook(emptyMappings));
  for (const definition of CODE_CATEGORIES) {
    assert.ok(workbook.sheetNames.includes(definition.sheet), `${definition.sheet} sheet`);
    assert.ok(
      workbook.sheetNames.includes(`${definition.sheet} (all codes)`),
      `${definition.sheet} reference sheet`,
    );
  }
  const organisms = workbook.sheet("Organisms (all codes)");
  assert.ok(organisms.length > 20);
  assert.ok(organisms.some((row) => row[0] === "eco"));
});

test("a code book goes out and comes back with the mappings intact", () => {
  const mappings = {
    organism: { scnx: "cns" },
    specimen: { bx: "ti" },
    antibiotic: { AUGM: "AMC" },
  };
  const result = readCodebookWorkbook(codebookWorkbook(mappings), emptyMappings);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.mappings, mappings);
});

test("the codes a file used that AMRSS cannot name arrive in the workbook already listed", () => {
  // The point of the export: the laboratory opens it and finds its outstanding
  // gaps waiting with a blank column beside them.
  const gaps = codebookWorkbook(emptyMappings, { specimen: ["zzq"], organism: ["qqq"] });
  const sheet = readWorkbook(gaps).sheet("Specimen types");
  assert.ok(sheet.some((row) => row[0] === "zzq" && !row[1]));
});

test("a mapping onto a code AMRSS does not hold is reported, never stored", () => {
  // Stored, it would fail silently on every row that used it.
  const workbook = buildWorkbook([
    {
      name: "Organisms",
      header: ["Your code", "AMRSS code", "AMRSS name"],
      rows: [
        ["myeco", "eco", ""],
        ["mystery", "not-a-code", ""],
      ],
    },
  ]);
  const result = readCodebookWorkbook(workbook, emptyMappings);
  assert.deepEqual(result.mappings.organism, { myeco: "eco" });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0]!, /not an AMRSS organism code/);
});

test("a row deleted in Excel is a mapping removed", () => {
  const workbook = buildWorkbook([
    { name: "Organisms", header: ["Your code", "AMRSS code", "AMRSS name"], rows: [["a", "eco", ""]] },
  ]);
  const result = readCodebookWorkbook(workbook, {
    organism: { a: "eco", b: "sau" },
    specimen: { bx: "ti" },
    antibiotic: {},
  });
  assert.deepEqual(result.mappings.organism, { a: "eco" });
  // A workbook trimmed to one sheet leaves the categories it does not cover.
  assert.deepEqual(result.mappings.specimen, { bx: "ti" });
});

test("a category's codes cannot land in another category's list", () => {
  // WHONET keeps organism and specimen codes in separate lists, and a code that
  // reads the same in both is not the same thing. "ti" is a specimen type.
  const workbook = buildWorkbook([
    { name: "Organisms", header: ["Your code", "AMRSS code", ""], rows: [["mine", "ti", ""]] },
  ]);
  const result = readCodebookWorkbook(workbook, emptyMappings);
  assert.deepEqual(result.mappings.organism, {});
  assert.match(result.problems[0]!, /not an AMRSS organism code/);
});

test("the outstanding gaps are read off the data, not off the validation report", () => {
  const records = [
    {
      organismCode: "eco",
      specimenTypeCode: "zzq",
      readings: [{ antibioticCode: "AMP", canonicalCode: "AMP" }],
    },
    {
      organismCode: "notanorganism",
      specimenTypeCode: "ur",
      readings: [{ antibioticCode: "WXY", canonicalCode: "WXY" }],
    },
  ];
  const gaps = unmappedCodes(records, emptyMappings);
  assert.deepEqual(gaps.organism, ["notanorganism"]);
  assert.deepEqual(gaps.specimen, ["zzq"]);
  assert.deepEqual(gaps.antibiotic, ["WXY"]);

  // Already mapped is not a gap.
  const mapped = unmappedCodes(records, { ...emptyMappings, specimen: { zzq: "ur" } });
  assert.deepEqual(mapped.specimen, []);
});
