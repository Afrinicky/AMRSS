/**
 * The path a laboratory's file actually travels: read, correct, validate,
 * analyse, and only then upload.
 *
 * The fixtures here are shaped from the two real Ghanaian WHONET exports the
 * uploader was validated against — the same gaps, in the same proportions: a
 * blank specimen type beside a numeric specimen code, a specimen date a year
 * behind the entry date, cultures that grew nothing, and susceptibility values
 * recorded as millimetres with no interpretation anywhere in the file.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import Database from "better-sqlite3";

import {
  analyse,
  antibiogram,
  antibioticProfiles,
  dashboard,
  firstIsolates,
  organismFrequency,
  phenotypes,
  resistanceTrend,
  siteFrequency,
} from "../core/analytics";
import {
  applyCorrections,
  correct,
  emptyCorrections,
  excludeRow,
  mapCode,
  restoreRow,
} from "../core/corrections";
import { BreakpointIndex } from "../core/interpret";
import { uploadableRecords, validate } from "../core/validation";
import { detectProfile, readDataset, toSourceIsolates } from "../core/whonet";
import { buildWorkbook } from "../core/xlsx";

const workspace = mkdtempSync(join(tmpdir(), "amrss-pipeline-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

const NOW = new Date("2026-08-17T00:00:00Z");

function makeFile(name: string): string {
  const path = join(workspace, name);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE Isolates (
      ROW_IDX     INTEGER PRIMARY KEY AUTOINCREMENT,
      PATIENT_ID  TEXT, LAST_NAME TEXT, FIRST_NAME TEXT, SEX TEXT, AGE TEXT,
      WARD TEXT, WARD_TYPE TEXT, DEPARTMENT TEXT,
      SPEC_NUM TEXT, SPEC_DATE TEXT, DATE_DATA TEXT, SPEC_TYPE TEXT, SPEC_CODE TEXT,
      ORGANISM TEXT, ORG_TYPE TEXT, COMMENT TEXT,
      CIP_ND5 TEXT, GEN_ND10 TEXT, FOX_ND30 TEXT, CTX_ND30 TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO Isolates
      (PATIENT_ID, LAST_NAME, FIRST_NAME, SEX, AGE, WARD, WARD_TYPE, DEPARTMENT,
       SPEC_NUM, SPEC_DATE, DATE_DATA, SPEC_TYPE, SPEC_CODE, ORGANISM, ORG_TYPE, COMMENT,
       CIP_ND5, GEN_ND10, FOX_ND30, CTX_ND30)
    VALUES (@PATIENT_ID, @LAST_NAME, @FIRST_NAME, @SEX, @AGE, @WARD, @WARD_TYPE, @DEPARTMENT,
            @SPEC_NUM, @SPEC_DATE, @DATE_DATA, @SPEC_TYPE, @SPEC_CODE, @ORGANISM, @ORG_TYPE, @COMMENT,
            @CIP_ND5, @GEN_ND10, @FOX_ND30, @CTX_ND30)
  `);

  const row = (overrides: Record<string, unknown>): void => {
    insert.run({
      PATIENT_ID: null, LAST_NAME: "PATIENT", FIRST_NAME: "A", SEX: "f", AGE: "34",
      WARD: "4e", WARD_TYPE: "out", DEPARTMENT: "opd",
      SPEC_NUM: null, SPEC_DATE: null, DATE_DATA: null, SPEC_TYPE: null, SPEC_CODE: null,
      ORGANISM: null, ORG_TYPE: "-", COMMENT: null,
      CIP_ND5: null, GEN_ND10: null, FOX_ND30: null, CTX_ND30: null,
      ...overrides,
    });
  };

  // Ordinary isolates, zone diameters only.
  row({ PATIENT_ID: "P-1", SPEC_NUM: "1", SPEC_DATE: "2026-02-03", SPEC_TYPE: "ur", SPEC_CODE: "11", ORGANISM: "eco", CIP_ND5: "30", GEN_ND10: "22", CTX_ND30: "12" });
  row({ PATIENT_ID: "P-2", SPEC_NUM: "2", SPEC_DATE: "2026-03-11", SPEC_TYPE: "ur", SPEC_CODE: "11", ORGANISM: "eco", CIP_ND5: "12", GEN_ND10: "9", CTX_ND30: "9" });
  row({ PATIENT_ID: "P-3", SPEC_NUM: "3", SPEC_DATE: "2026-04-02", SPEC_TYPE: "wd", SPEC_CODE: "21", ORGANISM: "sau", CIP_ND5: "26", FOX_ND30: "12" });
  // The same patient's second isolate of the same organism, later.
  row({ PATIENT_ID: "P-1", SPEC_NUM: "4", SPEC_DATE: "2026-05-06", SPEC_TYPE: "ur", SPEC_CODE: "11", ORGANISM: "eco", CIP_ND5: "10", GEN_ND10: "8", CTX_ND30: "8" });
  // No site of collection, but the numeric specimen code is there.
  row({ PATIENT_ID: "P-4", SPEC_NUM: "5", SPEC_DATE: "2026-05-09", SPEC_CODE: "11", ORGANISM: "kpn", CIP_ND5: "24", GEN_ND10: "20" });
  // Specimen date typed a year behind; the entry date is right.
  row({ PATIENT_ID: "P-5", SPEC_NUM: "6", SPEC_DATE: "1945-09-13", DATE_DATA: "2026-06-01", SPEC_TYPE: "bl", SPEC_CODE: "12", ORGANISM: "sau", CIP_ND5: "28", FOX_ND30: "24" });
  // No patient identifier at all.
  row({ SPEC_NUM: "7", SPEC_DATE: "2026-06-04", SPEC_TYPE: "ur", SPEC_CODE: "11", ORGANISM: "eco", CIP_ND5: "20" });
  // No growth, and no significant growth: neither is a surveillance record.
  row({ PATIENT_ID: "P-6", SPEC_NUM: "8", SPEC_DATE: "2026-06-06", SPEC_TYPE: "ur", SPEC_CODE: "11", ORGANISM: "xxx", ORG_TYPE: "o" });
  row({ PATIENT_ID: "P-7", SPEC_NUM: "9", SPEC_DATE: "2026-06-07", SPEC_TYPE: "ur", SPEC_CODE: "11", ORGANISM: "xsg", ORG_TYPE: "o" });
  // An organism with nothing tested against it.
  row({ PATIENT_ID: "P-8", SPEC_NUM: "10", SPEC_DATE: "2026-06-08", SPEC_TYPE: "st", SPEC_CODE: "41", ORGANISM: "can", ORG_TYPE: "f" });
  // A zone diameter no disk test produces.
  row({ PATIENT_ID: "P-9", SPEC_NUM: "11", SPEC_DATE: "2026-06-09", SPEC_TYPE: "ur", SPEC_CODE: "11", ORGANISM: "eco", CIP_ND5: "62" });
  // Only the entry date is recorded, as in a real export.
  row({ PATIENT_ID: "P-10", SPEC_NUM: "12", DATE_DATA: "2026-06-10", SPEC_TYPE: "ur", SPEC_CODE: "11", ORGANISM: "eco", CIP_ND5: "27", GEN_ND10: "21" });

  db.close();
  return path;
}

function load(path: string) {
  const detection = detectProfile(path);
  const dataset = readDataset(path, detection.profile!);
  return { detection, dataset };
}

const index = new BreakpointIndex({
  version: "TEST",
  label: "Test table",
  effectiveFrom: "2026-01-01",
  source: "local-import",
  syncedAt: null,
  criteria: [
    {
      organism_group: "Enterobacterales",
      agent_code: "CIP",
      method: "DISK",
      standard: "CLSI M100 Ed35",
      disk_susceptible_min: 26,
      disk_intermediate_min: 22,
      disk_intermediate_max: 25,
      disk_resistant_max: 21,
    },
    {
      organism_group: "Enterobacterales",
      agent_code: "CTX",
      method: "DISK",
      standard: "CLSI M100 Ed35",
      disk_susceptible_min: 26,
      disk_resistant_max: 22,
    },
    {
      organism_group: "Staphylococcus spp.",
      agent_code: "FOX",
      method: "DISK",
      standard: "CLSI M100 Ed35",
      disk_susceptible_min: 22,
      disk_resistant_max: 21,
    },
  ],
});

test("cultures that grew nothing, and isolates with nothing tested, are not surveillance records", () => {
  const { dataset } = load(makeFile("exclusions.sqlite"));

  const reasons = dataset.excluded.map((entry) => entry.reason);
  assert.equal(reasons.filter((reason) => reason === "no_organism").length, 2);
  assert.equal(reasons.filter((reason) => reason === "no_results").length, 1);
  // Excluded, not deleted: the count reconciles with WHONET's own record count.
  assert.equal(dataset.records.length + dataset.excluded.length, 12);
});

test("the numeric specimen code is learned from the file, not guessed", () => {
  const { dataset } = load(makeFile("codemap.sqlite"));
  assert.equal(dataset.specimenCodeMap["11"], "ur");
  assert.equal(dataset.specimenCodeMap["21"], "wd");
});

test("validation blocks what cannot be interpreted and only advises on the rest", () => {
  const { dataset } = load(makeFile("validate.sqlite"));
  const applied = applyCorrections(dataset, emptyCorrections());
  const report = validate(applied, { breakpoints: index, now: NOW });

  const codes = report.issues.map((issue) => issue.code);
  assert.ok(codes.includes("missing_specimen_type"));
  assert.ok(codes.includes("missing_patient_identifier"));
  assert.ok(codes.includes("specimen_date_implausible"));
  assert.ok(codes.includes("implausible_zone"));
  // Advisory, not blocking: a real laboratory legitimately has these.
  assert.ok(codes.includes("specimen_date_from_entry_column"));
  assert.equal(report.clearedToUpload, false);

  // Each blocking finding holds back its own record and nothing else.
  const blocked = new Set(report.blockedRowKeys);
  assert.equal(report.recordsReady, applied.records.length - blocked.size);
  assert.equal(uploadableRecords(applied, report).length, report.recordsReady);
});

test("a missing site of collection is offered the answer the file itself gives", () => {
  const { dataset } = load(makeFile("suggest.sqlite"));
  const applied = applyCorrections(dataset, emptyCorrections());
  const report = validate(applied, { breakpoints: index, now: NOW });

  const finding = report.issues.find((issue) => issue.code === "missing_specimen_type");
  assert.ok(finding);
  // Every other row with specimen code 11 in this file is urine, so that is the
  // suggestion — derived, not invented.
  assert.equal(finding!.suggestion?.value, "ur");
});

test("a correction fixes the record without touching the WHONET file", () => {
  const path = makeFile("correct.sqlite");
  const { dataset } = load(path);
  const target = dataset.records.find((record) => record.specimenTypeCode === null)!;

  const book = correct(emptyCorrections(), target, "specimenTypeCode", "ur", { by: "A. Scientist" });
  const applied = applyCorrections(dataset, book);
  const corrected = applied.records.find((record) => record.key === target.key)!;

  assert.equal(corrected.specimenTypeCode, "ur");
  assert.deepEqual(corrected.correctedFields, ["specimenTypeCode"]);
  assert.equal(applied.correctionCount, 1);

  const report = validate(applied, { breakpoints: index, now: NOW });
  assert.equal(
    report.issues.filter((issue) => issue.code === "missing_specimen_type").length,
    0,
  );

  // The file itself still says what it always said.
  const reread = load(path).dataset;
  assert.equal(reread.records.find((record) => record.key === target.key)!.specimenTypeCode, null);
});

test("a facility may hold a row out of the upload, and put it back", () => {
  const { dataset } = load(makeFile("exclude.sqlite"));
  const target = dataset.records[0]!;

  const excluded = applyCorrections(
    dataset,
    excludeRow(emptyCorrections(), target.key, "duplicate entry", "A. Scientist"),
  );
  assert.equal(excluded.records.length, dataset.records.length - 1);
  assert.ok(
    excluded.excluded.some(
      (entry) => entry.key === target.key && entry.reason === "excluded_by_facility",
    ),
  );

  const restored = applyCorrections(
    dataset,
    restoreRow(excludeRow(emptyCorrections(), target.key, "duplicate entry", null), target.key),
  );
  assert.equal(restored.records.length, dataset.records.length);
});

test("a local code mapping applies to every row that uses it", () => {
  const { dataset } = load(makeFile("mapping.sqlite"));
  const book = mapCode(emptyCorrections(), "specimen", "st", "gf");
  const applied = applyCorrections(dataset, book);

  assert.equal(
    applied.records.filter((record) => record.specimenTypeCode === "st").length,
    0,
  );
});

test("analysis counts one isolate per patient per organism, earliest first", () => {
  const { dataset } = load(makeFile("dedup.sqlite"));
  const applied = applyCorrections(dataset, emptyCorrections());
  const isolates = analyse(applied.records, index);

  const repeats = isolates.filter((isolate) => isolate.patientKey === "P-1");
  assert.equal(repeats.length, 2);

  const deduplicated = firstIsolates(isolates).filter((isolate) => isolate.patientKey === "P-1");
  assert.equal(deduplicated.length, 1);
  // The earlier specimen wins: it described the infection before treatment
  // shaped it.
  assert.equal(deduplicated[0]!.specimenDate, "2026-02-03");
});

test("the antibiogram is computed from interpretable results and marks thin cells", () => {
  const { dataset } = load(makeFile("antibiogram.sqlite"));
  const applied = applyCorrections(dataset, emptyCorrections());
  const isolates = analyse(applied.records, index);

  const table = antibiogram(isolates, { firstIsolateOnly: true, minimumIsolates: 30 });
  const coli = table.rows.find((row) => row.organismCode === "eco")!;
  const cip = coli.cells.CIP!;

  assert.equal(cip.interpretable > 0, true);
  assert.equal(cip.susceptible + cip.intermediate + cip.resistant, cip.interpretable);
  // Every cell in a file this small is below the reporting threshold, and says so.
  assert.equal(cip.belowThreshold, true);

  // An agent with no criterion in the table contributes measurements but no
  // percentage — pending is not susceptible.
  const gentamicin = coli.cells.GEN;
  assert.equal(gentamicin?.interpretable ?? 0, 0);
  assert.equal((gentamicin?.tested ?? 0) > 0, true);
});

test("the dashboard, sites and phenotypes read from the same isolates", () => {
  const { dataset } = load(makeFile("dashboard.sqlite"));
  const applied = applyCorrections(dataset, emptyCorrections());
  const isolates = analyse(applied.records, index);

  const summary = dashboard(isolates);
  assert.equal(summary.isolates, applied.records.length);
  assert.equal(summary.patients > 0, true);
  assert.equal(summary.organisms, new Set(isolates.map((i) => i.organismCode)).size);

  const sites = siteFrequency(isolates);
  assert.equal(sites.reduce((total, row) => total + row.count, 0), isolates.length);

  const organisms = organismFrequency(isolates);
  assert.ok((organisms[0]?.count ?? 0) > 0);

  // Cefoxitin-resistant S. aureus is flagged as presumptive MRSA, and only
  // among the S. aureus actually tested against it.
  const mrsa = phenotypes(isolates).find((entry) => entry.key === "mrsa")!;
  assert.equal(mrsa.eligible, 2);
  assert.equal(mrsa.isolates, 1);

  const profiles = antibioticProfiles(isolates);
  assert.ok(profiles.some((profile) => profile.code === "CIP"));
});

test("a resistance trend withholds percentages over too few results", () => {
  const { dataset } = load(makeFile("trend.sqlite"));
  const applied = applyCorrections(dataset, emptyCorrections());
  const isolates = analyse(applied.records, index);

  const trend = resistanceTrend(isolates, "CIP", { firstIsolateOnly: true, minimumIsolates: 30 });
  assert.ok(trend.length > 1);
  assert.ok(trend.every((point) => point.belowThreshold));
  // The counts are still there — only the published rate is withheld.
  assert.ok(trend.some((point) => point.interpretable > 0));
});

test("what reaches the batch carries no identifier, and only records that cleared validation", () => {
  const { dataset } = load(makeFile("batch.sqlite"));
  const applied = applyCorrections(dataset, emptyCorrections());
  const report = validate(applied, { breakpoints: index, now: NOW });
  const sources = toSourceIsolates(uploadableRecords(applied, report));

  assert.equal(sources.length, report.recordsReady);
  const serialised = JSON.stringify(sources);
  assert.equal(serialised.includes("PATIENT"), false);
  assert.equal(serialised.includes("4e"), false);
  // A measurement travels as a measurement, marked pending, so the server can
  // interpret it against its own table.
  assert.ok(sources.some((isolate) => isolate.results.some((result) => result.result === "PI")));
});

test("a workbook is a readable zip with one part per sheet", () => {
  const buffer = buildWorkbook([
    { name: "Results", header: ["Row", "Organism", "%"], rows: [[1, "Escherichia coli", 62.5]] },
    { name: "About", header: ["Field", "Value"], rows: [["Filters", "none"]] },
  ]);

  assert.equal(buffer.subarray(0, 2).toString("latin1"), "PK");
  const text = buffer.toString("latin1");
  assert.ok(text.includes("xl/worksheets/sheet1.xml"));
  assert.ok(text.includes("xl/worksheets/sheet2.xml"));
  assert.ok(text.includes("[Content_Types].xml"));
  // The end-of-central-directory record has to say how many entries there are,
  // or Excel refuses the file outright.
  assert.equal(buffer.readUInt16LE(buffer.length - 14), 7);
});
