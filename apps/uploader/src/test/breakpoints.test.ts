import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BREAKPOINT_COLUMNS,
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

test("an SDD band without its dosing regimen is refused", () => {
  // Susceptible-dose-dependent is a statement about the dose. Without the
  // regimen it assumes, the category cannot be acted on.
  const sdd: BreakpointCriterion = {
    ...mic,
    mic_susceptible_max: 2,
    mic_sdd_min: 4,
    mic_sdd_max: 8,
    mic_intermediate_min: undefined,
    mic_intermediate_max: undefined,
    mic_resistant_min: 16,
  };
  assert.ok(validateCriterion(sdd).some((problem) => /dosage note/.test(problem)));
  assert.deepEqual(validateCriterion({ ...sdd, dosage_note: "1 g q8h" }), []);
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
