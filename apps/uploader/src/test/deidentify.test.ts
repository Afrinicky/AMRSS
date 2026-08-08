import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  assertNoDirectIdentifiers,
  bandAge,
  computeLinkageKey,
  computeSourceRecordHash,
  deidentify,
  normaliseCareSetting,
  normaliseResult,
  normaliseSex,
  saltFingerprint,
  saltMatchesFingerprint,
  type SourceIsolate,
} from "../core/deidentify";
import { buildBatch } from "../core/payload";

const SALT = Buffer.from("0".repeat(64), "hex");
const OTHER_SALT = Buffer.from("1".repeat(64), "hex");
const FUNGI = new Set(["cal", "cgl"]);

function source(overrides: Partial<SourceIsolate> = {}): SourceIsolate {
  return {
    patientIdentifier: "HOSP-00123",
    specimenDate: new Date(Date.UTC(2026, 6, 15)),
    sex: "F",
    ageYears: 34,
    dateOfBirth: new Date(Date.UTC(1992, 2, 3)),
    careSetting: "IPD",
    organismCode: "ECO",
    specimenTypeCode: "UR",
    specimenNumber: "LAB-9001",
    results: [
      {
        antibioticCode: "CIP",
        result: "R",
        micValue: null,
        micOperator: null,
        zoneDiameterMm: 12,
        testMethod: "disk",
      },
    ],
    ...overrides,
  };
}

const options = { salt: SALT, facilityCode: "TEST-001", fungalOrganismCodes: FUNGI };

test("the linkage key is stable for the same patient and salt", () => {
  assert.equal(computeLinkageKey("HOSP-1", SALT), computeLinkageKey("HOSP-1", SALT));
});

test("the linkage key is insensitive to case and surrounding whitespace", () => {
  assert.equal(computeLinkageKey("  hosp-1 ", SALT), computeLinkageKey("HOSP-1", SALT));
});

test("different salts produce unrelated keys for the same patient", () => {
  assert.notEqual(computeLinkageKey("HOSP-1", SALT), computeLinkageKey("HOSP-1", OTHER_SALT));
});

test("the linkage key does not contain the patient identifier", () => {
  const key = computeLinkageKey("HOSP-00123", SALT);
  assert.ok(!key.includes("00123"));
  assert.match(key, /^[0-9a-f]{64}$/);
});

test("an empty patient identifier is refused rather than hashed to a shared key", () => {
  // Hashing "" would give every unidentified isolate the same linkage key, and
  // deduplication would then collapse unrelated patients into one.
  assert.throws(() => computeLinkageKey("   ", SALT), /empty patient identifier/);
});

test("the source record hash is derived from the linkage key, not the raw identifier", () => {
  // The hash is transmitted. Building it from the identifier would ship a hash
  // of that identifier salted only by public information.
  const viaKey = computeSourceRecordHash(
    computeLinkageKey("HOSP-1", SALT),
    "LAB-1",
    new Date(Date.UTC(2026, 0, 1)),
    "eco",
  );
  const viaOtherSalt = computeSourceRecordHash(
    computeLinkageKey("HOSP-1", OTHER_SALT),
    "LAB-1",
    new Date(Date.UTC(2026, 0, 1)),
    "eco",
  );
  assert.notEqual(viaKey, viaOtherSalt);
});

test("age is banded, and exact age is omitted unless explicitly approved", () => {
  const record = deidentify(source({ ageYears: 34 }), options);
  assert.equal(record.age_band, "15-44");
  assert.equal("age_exact_years" in record, false);

  const withExact = deidentify(source({ ageYears: 34 }), { ...options, retainExactAge: true });
  assert.equal(withExact.age_exact_years, 34);
});

test("age bands cover the boundaries", () => {
  const on = new Date(Date.UTC(2026, 0, 1));
  assert.equal(bandAge(4, null, on), "<5");
  assert.equal(bandAge(5, null, on), "5-14");
  assert.equal(bandAge(14, null, on), "5-14");
  assert.equal(bandAge(15, null, on), "15-44");
  assert.equal(bandAge(44, null, on), "15-44");
  assert.equal(bandAge(45, null, on), "45-64");
  assert.equal(bandAge(64, null, on), "45-64");
  assert.equal(bandAge(65, null, on), "65+");
  assert.equal(bandAge(null, null, on), "unknown");
  assert.equal(bandAge(-1, null, on), "unknown");
  assert.equal(bandAge(200, null, on), "unknown");
});

test("age is derived from date of birth when no age column exists", () => {
  const record = deidentify(
    source({ ageYears: null, dateOfBirth: new Date(Date.UTC(1960, 0, 1)) }),
    options,
  );
  assert.equal(record.age_band, "65+");
});

test("the date of birth itself never appears in the output", () => {
  const record = deidentify(source(), options);
  assert.equal(JSON.stringify(record).includes("1992"), false);
});

test("the output carries no field outside the permitted set", () => {
  const record = deidentify(source(), options);
  assert.deepEqual(Object.keys(record).sort(), [
    "age_band",
    "ast_results",
    "care_setting",
    "organism_code",
    "organism_kingdom",
    "patient_linkage_key",
    "sex",
    "source_record_hash",
    "specimen_date",
    "specimen_type_code",
  ]);
});

test("an unexpected source field has nowhere to go", () => {
  // Construction is by allow-list, so extra input is inert rather than leaked.
  const contaminated = {
    ...source(),
    patientName: "Ama Mensah",
    ward: "Ward 3B",
    phone: "0244000000",
  } as SourceIsolate;

  const serialised = JSON.stringify(deidentify(contaminated, options));
  assert.equal(serialised.includes("Mensah"), false);
  assert.equal(serialised.includes("Ward"), false);
  assert.equal(serialised.includes("0244000000"), false);
});

test("fungal organisms are classified from the dictionary", () => {
  assert.equal(deidentify(source({ organismCode: "CAL" }), options).organism_kingdom, "fungi");
  assert.equal(deidentify(source({ organismCode: "ECO" }), options).organism_kingdom, "bacteria");
});

test("sex and care setting are normalised from common WHONET encodings", () => {
  assert.equal(normaliseSex("M"), "male");
  assert.equal(normaliseSex("female"), "female");
  assert.equal(normaliseSex("2"), "female");
  assert.equal(normaliseSex("unknown-value"), "unknown");
  assert.equal(normaliseSex(null), "unknown");

  assert.equal(normaliseCareSetting("in"), "IPD");
  assert.equal(normaliseCareSetting("OUTPATIENT"), "OPD");
  assert.equal(normaliseCareSetting("clinic"), "unknown");
});

test("an unrecognised result becomes not-interpretable rather than being dropped", () => {
  // Dropping it would shrink the denominator and make transmitted counts
  // irreconcilable with the laboratory's own records.
  assert.equal(normaliseResult("S"), "S");
  assert.equal(normaliseResult("resistant"), "R");
  assert.equal(normaliseResult("SDD"), "SDD");
  assert.equal(normaliseResult("*contaminated*"), "NI");
  assert.equal(normaliseResult(""), null);
  assert.equal(normaliseResult(null), null);
});

test("an agent that was never set up is absent, not not-interpretable", () => {
  const record = deidentify(
    source({
      results: [
        {
          antibioticCode: "CIP",
          result: null,
          micValue: null,
          micOperator: null,
          zoneDiameterMm: null,
          testMethod: null,
        },
      ],
    }),
    options,
  );
  assert.equal(record.ast_results.length, 0);
});

test("a repeated agent on one isolate is kept once", () => {
  const record = deidentify(
    source({
      results: [
        { antibioticCode: "CIP", result: "R", micValue: null, micOperator: null, zoneDiameterMm: null, testMethod: null },
        { antibioticCode: "cip", result: "S", micValue: null, micOperator: null, zoneDiameterMm: null, testMethod: null },
      ],
    }),
    options,
  );
  assert.equal(record.ast_results.length, 1);
});

test("the identifier guard catches a forbidden field anywhere in the payload", () => {
  assert.throws(
    () => assertNoDirectIdentifiers({ isolates: [{ ok: 1, patient_name: "X" }] }),
    /may identify a patient/,
  );
  assert.throws(
    () => assertNoDirectIdentifiers({ a: { b: [{ dateOfBirth: "1990-01-01" }] } }),
    /may identify a patient/,
  );
  assert.doesNotThrow(() => assertNoDirectIdentifiers({ isolates: [{ age_band: "15-44" }] }));
});

test("a built batch passes the identifier guard and compresses to a checksummed body", () => {
  const batch = buildBatch("TEST-001", [source(), source({ patientIdentifier: "HOSP-2" })], options);

  assert.equal(batch.summary.isolateCount, 2);
  assert.match(batch.checksum, /^[0-9a-f]{64}$/);
  assert.equal(batch.recordHashes.length, 2);
  assert.equal(batch.summary.coverageStart, "2026-07-15");
});

test("records already accepted are not resent", () => {
  const first = buildBatch("TEST-001", [source()], options);
  const again = () =>
    buildBatch("TEST-001", [source()], {
      ...options,
      alreadySent: new Set(first.recordHashes),
    });

  assert.throws(again, /Nothing new to send/);
});

test("a salt fingerprint detects a replaced salt file", () => {
  const salt = randomBytes(32);
  assert.ok(saltMatchesFingerprint(salt, saltFingerprint(salt)));
  assert.equal(saltMatchesFingerprint(randomBytes(32), saltFingerprint(salt)), false);
});
