import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import Database from "better-sqlite3";

import { detectProfile, matchAntibioticColumns, readIsolates } from "../core/whonet";

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
    matched.map((entry) => `${entry.code}:${entry.method}`),
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
    { PATIENT_ID: "H-1", SPEC_DATE: "2026-01-01", SPEC_TYPE: "ur", ORGANISM: "eco" },
    { PATIENT_ID: "H-2", SPEC_DATE: "2026-07-15", SPEC_TYPE: "ur", ORGANISM: "eco" },
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
