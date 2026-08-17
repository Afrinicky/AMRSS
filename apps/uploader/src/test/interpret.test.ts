import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BreakpointIndex,
  type BreakpointCriterion,
  categoriseDisk,
  categoriseMic,
  coverageReport,
  interpretReading,
  parseBreakpointCsv,
  selectCriterion,
  siteQualifiers,
} from "../core/interpret";
import type { AgentColumn, WhonetReading, WhonetRecord } from "../core/whonet";
import { readReading } from "../core/whonet";

const DISK: AgentColumn = {
  column: "CIP_ND5",
  code: "CIP",
  canonicalCode: "CIP",
  methodCode: "ND",
  method: "disk_diffusion",
  potency: "5",
};

const MIC: AgentColumn = {
  column: "MEM_NM",
  code: "MEM",
  canonicalCode: "MEM",
  methodCode: "NM",
  method: "mic",
  potency: null,
};

function criterion(overrides: Partial<BreakpointCriterion>): BreakpointCriterion {
  return {
    organism_group: "Enterobacterales",
    agent_code: "CIP",
    method: "DISK",
    standard: "CLSI M100 Ed35",
    disk_susceptible_min: 26,
    disk_intermediate_min: 22,
    disk_intermediate_max: 25,
    disk_resistant_max: 21,
    ...overrides,
  };
}

function index(...criteria: BreakpointCriterion[]): BreakpointIndex {
  return new BreakpointIndex({
    version: "TEST-1",
    label: "Test table",
    effectiveFrom: "2026-01-01",
    source: "local-import",
    syncedAt: null,
    criteria,
  });
}

function reading(raw: string, agent: AgentColumn = DISK): WhonetReading {
  return readReading(raw, agent)!;
}

test("a zone diameter becomes a category using the loaded table", () => {
  const table = index(criterion({}));

  assert.equal(interpretReading(reading("30"), "eco", "ur", table).category, "S");
  assert.equal(interpretReading(reading("24"), "eco", "ur", table).category, "I");
  assert.equal(interpretReading(reading("12"), "eco", "ur", table).category, "R");
});

test("with no breakpoint table nothing is interpreted, and the reason says so", () => {
  const empty = index();
  const result = interpretReading(reading("30"), "eco", "ur", empty);

  // A measurement with no table is pending, never guessed and never "NI":
  // loading a table later must be able to recover it.
  assert.equal(result.category, "PI");
  assert.equal(result.reason, "no_breakpoint_table");
  assert.equal(result.origin, "none");
});

test("a combination the table does not cover stays pending rather than uninterpretable", () => {
  const table = index(criterion({ agent_code: "AMP" }));
  const result = interpretReading(reading("30"), "eco", "ur", table);

  assert.equal(result.category, "PI");
  assert.equal(result.reason, "no_criterion");
});

test("a category the laboratory recorded is kept, and disagreement is reported", () => {
  // The table would call 30 mm susceptible; the laboratory wrote R. Their
  // reading stands, and the disagreement is surfaced rather than resolved.
  const table = index(criterion({}));
  const recorded = { ...reading("30"), recordedCategory: "R", quantitative: false, raw: "R" };
  const withMeasurement: WhonetReading = { ...reading("30"), recordedCategory: "R" };

  assert.equal(interpretReading(recorded, "eco", "ur", table).category, "R");
  const conflict = interpretReading(withMeasurement, "eco", "ur", table);
  assert.equal(conflict.category, "R");
  assert.equal(conflict.origin, "laboratory");
  assert.equal(conflict.conflictsWithRecorded, true);
});

test("an implausible zone is refused rather than categorised", () => {
  // 62 mm is off the plate. Interpreting it would launder a transcription error
  // into a clinical category.
  const table = index(criterion({}));
  const result = interpretReading(reading("62"), "eco", "ur", table);

  assert.equal(result.category, "PI");
  assert.equal(result.reason, "implausible_measurement");
});

test("a species criterion beats the family criterion", () => {
  const table = index(
    criterion({ organism_group: "Enterobacterales", disk_susceptible_min: 26 }),
    criterion({
      organism_group: "Escherichia coli",
      disk_susceptible_min: 31,
      disk_intermediate_min: 26,
      disk_intermediate_max: 30,
      disk_resistant_max: 25,
    }),
  );

  const selected = selectCriterion(table, "CIP", "disk_diffusion", "eco", "ur");
  assert.equal(selected?.organism_group, "Escherichia coli");
  // 30 mm is susceptible under the family criterion and not under the species
  // one; the more specific answer is the one that applies.
  assert.equal(interpretReading(reading("30"), "eco", "ur", table).category, "I");
});

test("a site-qualified criterion applies only to that site", () => {
  const table = index(
    criterion({ organism_group: "Escherichia coli", disk_susceptible_min: 26 }),
    criterion({ organism_group: "Escherichia coli", site: "uti", disk_susceptible_min: 16 }),
  );

  assert.equal(selectCriterion(table, "CIP", "disk_diffusion", "eco", "ur")?.site, "uti");
  assert.equal(selectCriterion(table, "CIP", "disk_diffusion", "eco", "bl")?.site, undefined);
  assert.deepEqual(siteQualifiers("csf"), ["meningitis"]);
});

test("an off-scale MIC is only categorised when every consistent value agrees", () => {
  const bounds = criterion({
    agent_code: "MEM",
    method: "MIC",
    mic_susceptible_max: 1,
    mic_intermediate_min: 2,
    mic_intermediate_max: 4,
    mic_resistant_min: 8,
    disk_susceptible_min: null,
    disk_intermediate_min: null,
    disk_intermediate_max: null,
    disk_resistant_max: null,
  });

  // "<=1" is susceptible: every value at or below 1 is.
  assert.equal(categoriseMic(1, "<=", bounds).category, "S");
  // "<=4" is not: the true MIC could be 2, which is intermediate.
  assert.equal(categoriseMic(4, "<=", bounds).category, null);
  assert.equal(categoriseMic(4, "<=", bounds).reason, "off_scale_ambiguous");
  // ">=8" is resistant whatever the true value is.
  assert.equal(categoriseMic(8, ">=", bounds).category, "R");

  const table = index(bounds);
  assert.equal(interpretReading(reading("0.5", MIC), "eco", "bl", table).category, "S");
  assert.equal(interpretReading(reading("16", MIC), "eco", "bl", table).category, "R");
});

test("a susceptible-only criterion reports non-susceptible rather than nothing", () => {
  const susceptibleOnly = criterion({
    disk_susceptible_min: 20,
    disk_intermediate_min: null,
    disk_intermediate_max: null,
    disk_resistant_max: null,
  });

  assert.equal(categoriseDisk(25, susceptibleOnly), "S");
  assert.equal(categoriseDisk(12, susceptibleOnly), "NS");
});

test("coverage reports what the table cannot yet interpret, most frequent first", () => {
  const table = index(criterion({}));
  const records = [
    record("eco", "ur", [reading("30"), reading("12", MIC)]),
    record("sau", "wd", [reading("30")]),
    record("sau", "wd", [reading("28")]),
  ];

  const report = coverageReport(records, table);
  assert.equal(report.measurements, 4);
  assert.equal(report.interpreted, 1);
  assert.equal(report.pending, 3);
  assert.equal(report.uncovered[0]?.combination.startsWith("sau"), true);
  assert.equal(report.uncovered[0]?.measurements, 2);
});

test("the breakpoint template CSV parses, comments and all", () => {
  const csv = [
    "# A comment line, as the template ships with",
    "organism_group,agent_code,method,standard,disk_susceptible_min,disk_resistant_max",
    "Enterobacterales,CIP,DISK,CLSI M100 Ed35,26,21",
    "Staphylococcus spp.,FOX,DISK,CLSI M100 Ed35,22,21",
    "",
  ].join("\n");

  const parsed = parseBreakpointCsv(csv);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.criteria.length, 2);
  assert.equal(parsed.criteria[0]?.agent_code, "CIP");
  assert.equal(parsed.criteria[0]?.disk_susceptible_min, "26");
});

test("a CSV missing a required column is refused with the reason", () => {
  const parsed = parseBreakpointCsv("organism_group,method\nEnterobacterales,DISK");
  assert.equal(parsed.criteria.length, 0);
  assert.equal(parsed.problems[0], "missing required column: agent_code");
});

function record(
  organismCode: string,
  specimenTypeCode: string,
  readings: WhonetReading[],
): WhonetRecord {
  return {
    key: `${organismCode}-${specimenTypeCode}-${readings.length}`,
    rowIndex: 1,
    patientIdentifier: "P-1",
    specimenNumber: "1",
    specimenDate: new Date("2026-02-01T00:00:00Z"),
    specimenDateSource: "specimen",
    dateEntered: null,
    sex: "f",
    ageYears: 30,
    dateOfBirth: null,
    careSettingRaw: "out",
    careSetting: "OPD",
    ward: null,
    department: null,
    institution: null,
    laboratory: null,
    patientType: null,
    organismCode,
    organismType: null,
    specimenTypeCode,
    specimenNumericCode: null,
    specimenReason: null,
    betaLactamase: null,
    esbl: null,
    comment: null,
    readings,
    raw: {},
  };
}
