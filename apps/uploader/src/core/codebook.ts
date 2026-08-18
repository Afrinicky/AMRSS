/**
 * The code book: every code AMRSS knows, and every local code mapped onto one.
 *
 * Mapping codes one at a time in a form works for the two or three a laboratory
 * discovers during validation. It does not work for a laboratory bringing over
 * a WHONET configuration built up over years, where a hundred local spellings
 * need reconciling before the first upload — and it does not work at all for a
 * laboratory that wants its microbiologist to review the mappings, because a
 * form on one computer cannot be sent to anyone.
 *
 * So the whole book exports as one workbook and comes back as one workbook.
 *
 * WHONET keeps its codes in separate lists — a specimen code and an organism
 * code that happen to read the same are different things — and the workbook
 * keeps that separation as one sheet per category. A row on the Organisms sheet
 * can only ever map an organism. There is no sheet where the two could be
 * confused, and no import path where a mapping could land in the wrong list.
 *
 * The exported workbook is also the reference table: every code the dictionary
 * holds is listed with its name, so the person filling in the "AMRSS code"
 * column is choosing from what exists rather than guessing.
 */

import type { CodeMappings } from "./corrections";
import {
  ANTIBIOTICS,
  ORGANISMS,
  SPECIMEN_TYPES,
  antibioticLabel,
  canonicalAntibioticCode,
  canonicalOrganismCode,
  canonicalSpecimenCode,
  lookupAntibiotic,
  lookupOrganism,
  lookupSpecimen,
  organismLabel,
  specimenLabel,
} from "./dictionary";
import { buildWorkbook, type Sheet } from "./xlsx";
import { readWorkbook } from "./xlsx-read";

export type CodeCategory = keyof CodeMappings;

export interface CategoryDefinition {
  category: CodeCategory;
  /** The sheet the category lives on. Matched case-insensitively on import, so
   * a laboratory renaming a tab in Excel does not break the round trip. */
  sheet: string;
  /** What WHONET calls this list, for the person reading the sheet. */
  whonetList: string;
  heading: string;
}

export const CODE_CATEGORIES: CategoryDefinition[] = [
  {
    category: "organism",
    sheet: "Organisms",
    whonetList: "WHONET organism codes",
    heading: "Organism",
  },
  {
    category: "specimen",
    sheet: "Specimen types",
    whonetList: "WHONET specimen type codes",
    heading: "Specimen type",
  },
  {
    category: "antibiotic",
    sheet: "Antimicrobials",
    whonetList: "WHONET antimicrobial codes",
    heading: "Antimicrobial",
  },
];

const MAPPING_HEADER = ["Your code (as it appears in WHONET)", "AMRSS code", "AMRSS name"];

/** Every code in one category, as the reference sheet lists it. */
function referenceRows(category: CodeCategory): Array<[string, string]> {
  if (category === "organism") return ORGANISMS.map((entry) => [entry.code, entry.name]);
  if (category === "specimen") return SPECIMEN_TYPES.map((entry) => [entry.code, entry.name]);
  return ANTIBIOTICS.map((entry) => [entry.code, entry.name]);
}

function nameOf(category: CodeCategory, code: string): string {
  if (category === "organism") return organismLabel(code);
  if (category === "specimen") return specimenLabel(code);
  return antibioticLabel(code);
}

/** Whether a code is one AMRSS holds, aliases applied. */
export function isKnownCode(category: CodeCategory, code: string): boolean {
  const token = code.trim();
  if (!token) return false;
  if (category === "organism") return lookupOrganism(canonicalOrganismCode(token)) !== null;
  if (category === "specimen") return lookupSpecimen(canonicalSpecimenCode(token)) !== null;
  return lookupAntibiotic(canonicalAntibioticCode(token)) !== null;
}

/**
 * The code book as a workbook.
 *
 * Two sheets per category, deliberately: a **mapping** sheet that is filled in
 * and re-imported, and a **reference** sheet listing every code AMRSS holds.
 * They are separate so the import never has to guess which rows were meant as
 * mappings — it reads the mapping sheets and ignores the rest — and so a
 * laboratory can sort or filter the reference without disturbing its work.
 *
 * `unmappedCodes` seeds the mapping sheets with the codes the laboratory's own
 * file used that AMRSS could not name. That is the whole job, already listed:
 * the laboratory opens the workbook and finds its outstanding gaps waiting in
 * the first column, rather than having to transcribe them from a screen.
 */
export function codebookWorkbook(
  mappings: CodeMappings,
  unmappedCodes: Partial<Record<CodeCategory, string[]>> = {},
): Buffer {
  const sheets: Sheet[] = [];

  for (const definition of CODE_CATEGORIES) {
    const existing = mappings[definition.category] ?? {};
    const outstanding = (unmappedCodes[definition.category] ?? []).filter(
      (code) => !(code in existing),
    );

    const rows: (string | number | null)[][] = [
      ...Object.entries(existing).map(([local, canonical]) => [
        local,
        canonical,
        nameOf(definition.category, canonical),
      ]),
      // The gaps, with the answer column left blank for the laboratory to fill.
      ...outstanding.map((code) => [code, "", ""]),
    ];

    sheets.push({
      name: definition.sheet,
      header: MAPPING_HEADER,
      rows,
      columnWidths: [38, 16, 46],
    });
  }

  for (const definition of CODE_CATEGORIES) {
    sheets.push({
      name: `${definition.sheet} (all codes)`,
      header: ["AMRSS code", `${definition.heading} name`],
      rows: referenceRows(definition.category).map(([code, name]) => [code, name]),
      columnWidths: [16, 52],
    });
  }

  sheets.push({
    name: "How to use this",
    header: ["", ""],
    rows: [
      ["What this workbook is", "Every code AMRSS understands, and the local codes mapped onto them."],
      ["", ""],
      [
        "To map a code",
        "Find the sheet for its category — Organisms, Specimen types or Antimicrobials — and add a row.",
      ],
      [
        "First column",
        "The code exactly as it appears in your WHONET file, including its capitalisation.",
      ],
      [
        "Second column",
        "The AMRSS code it means. The matching “(all codes)” sheet lists every one, with its name.",
      ],
      ["Third column", "Left for you. It is filled in on export and ignored on import."],
      ["", ""],
      [
        "Categories are separate",
        "WHONET keeps organism, specimen and antimicrobial codes in different lists, and so does this "
          + "workbook. A code on the Organisms sheet can only ever mean an organism.",
      ],
      [
        "To remove a mapping",
        "Delete its row, or clear the AMRSS code. Importing this workbook replaces the mappings "
          + "held for the categories its sheets cover.",
      ],
      [
        "Nothing is guessed",
        "A row naming a code AMRSS does not hold is reported back to you and not applied.",
      ],
    ],
    columnWidths: [26, 96],
  });

  return buildWorkbook(sheets);
}

export interface CodebookImport {
  mappings: CodeMappings;
  /** How many mappings each category gained or changed. */
  applied: Record<CodeCategory, number>;
  /** Rows that named something AMRSS does not hold, in the words the laboratory
   * needs to fix them. */
  problems: string[];
  /** Sheets present in the file that were not one of the mapping sheets. */
  ignoredSheets: string[];
}

/**
 * Read a code book back.
 *
 * Only the mapping sheets are read. A row is applied when its second column
 * names a code AMRSS holds; a row naming something unknown is reported rather
 * than stored, because a mapping onto a code that does not exist would fail
 * silently on every row that used it.
 *
 * The result replaces the mappings for the categories the workbook covers, and
 * leaves the others alone. That is what a laboratory means by re-uploading the
 * book — a row deleted in Excel is a mapping removed — while a workbook trimmed
 * down to one sheet does not wipe out the other two.
 */
export function readCodebookWorkbook(buffer: Buffer, current: CodeMappings): CodebookImport {
  const workbook = readWorkbook(buffer);
  const mappings: CodeMappings = {
    organism: { ...current.organism },
    specimen: { ...current.specimen },
    antibiotic: { ...current.antibiotic },
  };
  const applied: Record<CodeCategory, number> = { organism: 0, specimen: 0, antibiotic: 0 };
  const problems: string[] = [];
  const used = new Set<string>();

  for (const definition of CODE_CATEGORIES) {
    const sheetName = workbook.sheetNames.find(
      (name) => name.trim().toLowerCase() === definition.sheet.toLowerCase(),
    );
    if (!sheetName) continue;
    used.add(sheetName);

    const rows = workbook.sheet(sheetName);
    const fresh: Record<string, string> = {};

    for (const [offset, row] of rows.slice(1).entries()) {
      const local = (row[0] ?? "").trim();
      const canonical = (row[1] ?? "").trim();
      if (!local && !canonical) continue;

      const line = offset + 2;
      if (!local) {
        problems.push(`${definition.sheet}, row ${line}: no code in the first column.`);
        continue;
      }
      // A blank answer is the laboratory saying "not this one yet", not an
      // error: the export seeds the sheet with exactly these.
      if (!canonical) continue;

      if (!isKnownCode(definition.category, canonical)) {
        problems.push(
          `${definition.sheet}, row ${line}: ${canonical} is not an AMRSS ${definition.heading.toLowerCase()} code. `
            + `The “${definition.sheet} (all codes)” sheet lists the ones that are.`,
        );
        continue;
      }
      if (local.toLowerCase() === canonical.toLowerCase()) {
        // Mapping a code onto itself is a no-op that looks like a mapping. Left
        // out so the count on screen means what it says.
        continue;
      }
      fresh[local] = canonical;
    }

    // Replacing rather than merging is what makes a deleted row a removal.
    const before = mappings[definition.category];
    const changed = Object.entries(fresh).filter(([key, value]) => before[key] !== value).length;
    const removed = Object.keys(before).filter((key) => !(key in fresh)).length;
    mappings[definition.category] = fresh;
    applied[definition.category] = changed + removed;
  }

  return {
    mappings,
    applied,
    problems,
    ignoredSheets: workbook.sheetNames.filter((name) => !used.has(name)),
  };
}

/**
 * The codes this laboratory's own file uses that AMRSS cannot name.
 *
 * Read straight off the data rather than off the validation report, because the
 * export exists precisely to be opened before validation has been looked at:
 * the point is that the gaps are already in the workbook when it opens.
 */
export function unmappedCodes(
  records: Array<{
    organismCode: string | null;
    specimenTypeCode: string | null;
    readings: Array<{ antibioticCode: string; canonicalCode: string }>;
  }>,
  mappings: CodeMappings,
): Record<CodeCategory, string[]> {
  const found: Record<CodeCategory, Set<string>> = {
    organism: new Set(),
    specimen: new Set(),
    antibiotic: new Set(),
  };

  const consider = (category: CodeCategory, code: string | null): void => {
    const token = (code ?? "").trim();
    if (!token) return;
    if (mappings[category][token]) return;
    if (isKnownCode(category, token)) return;
    found[category].add(token);
  };

  for (const record of records) {
    consider("organism", record.organismCode);
    consider("specimen", record.specimenTypeCode);
    for (const reading of record.readings) consider("antibiotic", reading.canonicalCode);
  }

  return {
    organism: [...found.organism].sort(),
    specimen: [...found.specimen].sort(),
    antibiotic: [...found.antibiotic].sort(),
  };
}

/** A one-line summary of what an import did, for the message on screen. */
export function describeImport(result: CodebookImport): string {
  const parts = CODE_CATEGORIES.filter((d) => result.applied[d.category] > 0).map(
    (d) => `${result.applied[d.category]} ${d.heading.toLowerCase()} mapping(s)`,
  );
  if (parts.length === 0) return "The workbook changed no mappings.";
  return `Updated ${parts.join(", ")}.`;
}
