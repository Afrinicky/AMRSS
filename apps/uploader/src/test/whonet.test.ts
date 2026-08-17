import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import Database from "better-sqlite3";

import {
  detectProfile,
  matchAntibioticColumns,
  readIsolates,
  summariseResultEncoding,
} from "../core/whonet";

const workspace = mkdtempSync(join(tmpdir(), "amrss-whonet-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

/**
 * A synthetic file shaped like a WHONET export: identifier columns present,
 * agents encoded as CODE_METHOD+POTENCY.
 *
 * This validates the reader's handling of a plausible layout. It is not a
 * substitute for validating the profile against a real facility export, which
 * remains a deployment prerequisite.
 */
function makeWhonetFile(name: string, rows: Array<Record<string, unknown>>): string {
  const path = join(workspace, name);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE isolates (
      PATIENT_ID   TEXT,
      LAST_NAME    TEXT,
      FIRST_NAME   TEXT,
      DATE_BIRTH   TEXT,
      SEX          TEXT,
      AGE          INTEGER,
      WARD         TEXT,
      WARD_TYPE    TEXT,
      SPEC_NUM     TEXT,
      SPEC_DATE    TEXT,
      SPEC_TYPE    TEXT,
      ORGANISM     TEXT,
      AMP_ND10     TEXT,
      CIP_ND5      TEXT,
      MEM_NM       TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO isolates
      (PATIENT_ID, LAST_NAME, FIRST_NAME, DATE_BIRTH, SEX, AGE, WARD, WARD_TYPE,
       SPEC_NUM, SPEC_DATE, SPEC_TYPE, ORGANISM, AMP_ND10, CIP_ND5, MEM_NM)
    VALUES
      (@PATIENT_ID, @LAST_NAME, @FIRST_NAME, @DATE_BIRTH, @SEX, @AGE, @WARD, @WARD_TYPE,
       @SPEC_NUM, @SPEC_DATE, @SPEC_TYPE, @ORGANISM, @AMP_ND10, @CIP_ND5, @MEM_NM)
  `);
  for (const row of rows) {
    insert.run({
      PATIENT_ID: null,
      LAST_NAME: null,
      FIRST_NAME: null,
      DATE_BIRTH: null,
      SEX: null,
      AGE: null,
      WARD: null,
      WARD_TYPE: null,
      SPEC_NUM: null,
      SPEC_DATE: null,
      SPEC_TYPE: null,
      ORGANISM: null,
      AMP_ND10: null,
      CIP_ND5: null,
      MEM_NM: null,
      ...row,
    });
  }
  db.close();
  return path;
}

const SAMPLE = [
  {
    PATIENT_ID: "H-001",
    LAST_NAME: "Mensah",
    FIRST_NAME: "Ama",
    DATE_BIRTH: "1992-03-03",
    SEX: "F",
    AGE: 34,
    WARD: "3B",
    WARD_TYPE: "in",
    SPEC_NUM: "L-1",
    SPEC_DATE: "2026-07-15",
    SPEC_TYPE: "ur",
    ORGANISM: "eco",
    AMP_ND10: "R",
    CIP_ND5: "S",
    MEM_NM: "S",
  },
  {
    PATIENT_ID: "H-002",
    LAST_NAME: "Owusu",
    FIRST_NAME: "Kofi",
    SEX: "M",
    AGE: 7,
    WARD_TYPE: "out",
    SPEC_NUM: "L-2",
    SPEC_DATE: "15/07/2026",
    SPEC_TYPE: "bl",
    ORGANISM: "sau",
    AMP_ND10: "S",
  },
];

test("detection finds the isolate table and maps the required fields", () => {
  const path = makeWhonetFile("detect.sqlite", SAMPLE);
  const detection = detectProfile(path);

  assert.equal(detection.table, "isolates");
  assert.deepEqual(detection.unmappedRequired, []);
  assert.equal(detection.profile?.patientIdentifier, "PATIENT_ID");
  assert.equal(detection.profile?.specimenDate, "SPEC_DATE");
  assert.equal(detection.profile?.organism, "ORGANISM");
  assert.equal(detection.profile?.careSetting, "WARD_TYPE");
});

test("detection reports identifier columns so the facility can see what is readable", () => {
  const path = makeWhonetFile("identifiers.sqlite", SAMPLE);
  const detection = detectProfile(path);

  // These are read locally and never transmitted, but the confirmation screen
  // should show that the uploader can see them.
  for (const column of ["LAST_NAME", "FIRST_NAME", "DATE_BIRTH", "WARD", "PATIENT_ID"]) {
    assert.ok(
      detection.identifyingColumnsPresent.includes(column),
      `expected ${column} to be reported`,
    );
  }
});

test("detection refuses to produce a profile when a required field is missing", () => {
  const path = join(workspace, "incomplete.sqlite");
  const db = new Database(path);
  db.exec("CREATE TABLE isolates (SPEC_DATE TEXT, ORGANISM TEXT, SPEC_TYPE TEXT)");
  db.close();

  const detection = detectProfile(path);

  // Guessing would produce an uploader that works at one site and silently
  // misreads everywhere else.
  assert.equal(detection.profile, null);
  assert.deepEqual(detection.unmappedRequired, ["patientIdentifier"]);
});

test("agent columns are parsed into codes and methods", () => {
  const matched = matchAntibioticColumns(
    ["PATIENT_ID", "AMP_ND10", "CIP_ND5", "MEM_NM", "SPEC_DATE"],
    "^([A-Z]{3})_(N[DME])([0-9.]*)$",
  );

  assert.deepEqual(
    matched.map((entry) => `${entry.code}:${entry.methodCode}`),
    ["AMP:ND", "CIP:ND", "MEM:NM"],
  );
});

test("reading returns source isolates with their results", () => {
  const path = makeWhonetFile("read.sqlite", SAMPLE);
  const profile = detectProfile(path).profile!;
  const isolates = readIsolates(path, profile);

  assert.equal(isolates.length, 2);
  const first = isolates[0]!;
  assert.equal(first.patientIdentifier, "H-001");
  assert.equal(first.organismCode, "eco");
  assert.equal(first.results.length, 3);
  // Only agents with a recorded value; the second row has one.
  assert.equal(isolates[1]!.results.length, 1);
});

test("both ISO and day-first date formats are parsed", () => {
  const path = makeWhonetFile("dates.sqlite", SAMPLE);
  const profile = detectProfile(path).profile!;
  const isolates = readIsolates(path, profile);

  for (const isolate of isolates) {
    assert.equal(isolate.specimenDate.toISOString().slice(0, 10), "2026-07-15");
  }
});

test("a row with no usable date is skipped rather than coerced to today", () => {
  const path = makeWhonetFile("baddate.sqlite", [
    ...SAMPLE,
    { PATIENT_ID: "H-003", SPEC_DATE: "not-a-date", SPEC_TYPE: "ur", ORGANISM: "eco" },
    { PATIENT_ID: "H-004", SPEC_DATE: null, SPEC_TYPE: "ur", ORGANISM: "eco" },
  ]);
  const profile = detectProfile(path).profile!;

  assert.equal(readIsolates(path, profile).length, 2);
});

test("a row missing the patient identifier is skipped", () => {
  // Without it the isolate cannot be deduplicated, so it would distort any
  // antibiogram it entered.
  const path = makeWhonetFile("nopatient.sqlite", [
    ...SAMPLE,
    { PATIENT_ID: null, SPEC_DATE: "2026-07-15", SPEC_TYPE: "ur", ORGANISM: "eco" },
  ]);
  const profile = detectProfile(path).profile!;

  assert.equal(readIsolates(path, profile).length, 2);
});

test("incremental reads honour the since date", () => {
  const path = makeWhonetFile("since.sqlite", [
    { PATIENT_ID: "H-1", SPEC_DATE: "2026-01-01", SPEC_TYPE: "ur", ORGANISM: "eco", AMP_ND10: "20" },
    { PATIENT_ID: "H-2", SPEC_DATE: "2026-07-15", SPEC_TYPE: "ur", ORGANISM: "eco", AMP_ND10: "18" },
  ]);
  const profile = detectProfile(path).profile!;

  const recent = readIsolates(path, profile, { since: new Date(Date.UTC(2026, 5, 1)) });
  assert.equal(recent.length, 1);
  assert.equal(recent[0]!.patientIdentifier, "H-2");
});

test("the database is opened read-only", () => {
  // The facility's WHONET file is their clinical record. The uploader must never
  // be capable of altering it.
  const path = makeWhonetFile("readonly.sqlite", SAMPLE);
  const profile = detectProfile(path).profile!;
  readIsolates(path, profile);

  const db = new Database(path, { readonly: true });
  const count = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM isolates").get();
  db.close();
  assert.equal(count?.n, 2);
});

// --- Behaviours validated against a real Ghanaian WHONET export -------------
//
// That file carried 337 AST values, every one a raw millimetre zone diameter,
// and 75 of 183 rows were culture-negative. Both cases previously produced
// silent, wrong results, so both are pinned here.

test("a raw zone diameter is carried as a measurement, not read as a category", () => {
  const path = makeWhonetFile("zones.sqlite", [
    {
      PATIENT_ID: "H-1",
      SPEC_DATE: "2026-07-15",
      SPEC_TYPE: "ur",
      ORGANISM: "eco",
      CIP_ND5: "14",
      AMP_ND10: "6",
    },
  ]);
  const profile = detectProfile(path).profile!;
  const [isolate] = readIsolates(path, profile);

  const cip = isolate!.results.find((r) => r.antibioticCode === "CIP")!;
  assert.equal(cip.result, "PI", "a measurement awaits interpretation");
  assert.equal(cip.zoneDiameterMm, 14);
  assert.equal(cip.testMethod, "disk_diffusion");
});

test("an interpreted category is still read as a category", () => {
  const path = makeWhonetFile("cats.sqlite", [
    { PATIENT_ID: "H-1", SPEC_DATE: "2026-07-15", SPEC_TYPE: "ur", ORGANISM: "eco", CIP_ND5: "R" },
  ]);
  const profile = detectProfile(path).profile!;
  const [isolate] = readIsolates(path, profile);

  assert.equal(isolate!.results[0]!.result, "R");
  assert.equal(isolate!.results[0]!.zoneDiameterMm, null);
});

test("pending interpretation is distinct from not interpretable", () => {
  // "good data awaiting a breakpoint" and "the test produced nothing usable"
  // must not collapse into one state, or the recoverable panel is hidden.
  const path = makeWhonetFile("mixed.sqlite", [
    {
      PATIENT_ID: "H-1",
      SPEC_DATE: "2026-07-15",
      SPEC_TYPE: "ur",
      ORGANISM: "eco",
      CIP_ND5: "18",
      AMP_ND10: "contaminated",
    },
  ]);
  const profile = detectProfile(path).profile!;
  const results = readIsolates(path, profile)[0]!.results;

  assert.equal(results.find((r) => r.antibioticCode === "CIP")!.result, "PI");
  assert.equal(results.find((r) => r.antibioticCode === "AMP")!.result, "NI");
});

test("culture-negative rows never become isolates", () => {
  const path = makeWhonetFile("nogrowth.sqlite", [
    ...SAMPLE,
    { PATIENT_ID: "H-9", SPEC_DATE: "2026-07-15", SPEC_TYPE: "ur", ORGANISM: "xxx" },
  ]);
  const profile = detectProfile(path).profile!;

  // Admitting them would invent an organism called "xxx" and inflate workload.
  assert.equal(readIsolates(path, profile).length, 2);
});

test("the result encoding of a file can be summarised before uploading", () => {
  const path = makeWhonetFile("encoding.sqlite", [
    { PATIENT_ID: "H-1", SPEC_DATE: "2026-07-15", SPEC_TYPE: "ur", ORGANISM: "eco", CIP_ND5: "14" },
    { PATIENT_ID: "H-2", SPEC_DATE: "2026-07-15", SPEC_TYPE: "ur", ORGANISM: "eco", CIP_ND5: "S" },
  ]);
  const profile = detectProfile(path).profile!;

  assert.deepEqual(summariseResultEncoding(path, profile), {
    categorical: 1,
    quantitative: 1,
    unreadable: 0,
  });
});

test("no-significant-growth is excluded alongside no-growth", () => {
  // Both name no organism: xxx grew nothing, xsg grew only flora the laboratory
  // judged insignificant. Either would invent an organism if admitted.
  const path = makeWhonetFile("nsg.sqlite", [
    ...SAMPLE,
    { PATIENT_ID: "H-8", SPEC_DATE: "2026-07-15", SPEC_TYPE: "ur", ORGANISM: "xsg" },
    { PATIENT_ID: "H-9", SPEC_DATE: "2026-07-15", SPEC_TYPE: "ur", ORGANISM: "XXX" },
    { PATIENT_ID: "H-10", SPEC_DATE: "2026-07-15", SPEC_TYPE: "ur", ORGANISM: "No Significant Growth" },
  ]);
  const profile = detectProfile(path).profile!;

  assert.equal(readIsolates(path, profile).length, 2);
});

test("agent codes with compound potencies are captured", () => {
  // A real export encoded co-trimoxazole as SXT_ND1_2. An earlier pattern
  // allowed only digits and dots in the potency, so the most-used agent in that
  // laboratory was silently dropped from every antibiogram.
  const matched = matchAntibioticColumns(
    ["SXT_ND1_2", "SXT_ND5_2", "AXS_ND", "CTX_NE", "CRB_ND100", "WARD_TYPE", "SPEC_REAS"],
    "^([A-Z]{3})_(N[DME])([0-9._]*)$",
  );

  assert.deepEqual(
    matched.map((entry) => `${entry.code}:${entry.methodCode}`),
    ["SXT:ND", "SXT:ND", "AXS:ND", "CTX:NE", "CRB:ND"],
  );
});

test("non-agent columns are never mistaken for agents", () => {
  const matched = matchAntibioticColumns(
    ["PATIENT_ID", "WARD_TYPE", "SPEC_REAS", "DATE_DATA", "BETA_LACT", "ESBL", "AFRO_GRAM"],
    "^([A-Z]{3})_(N[DME])([0-9._]*)$",
  );

  assert.deepEqual(matched, []);
});
