/**
 * De-identification.
 *
 * This is the component that handles raw patient data, and the reason the whole
 * offline uploader exists. Its logic is deliberately open and auditable
 * (SDD 8.4): a facility should be able to read this file and satisfy itself that
 * nothing identifying leaves the building.
 *
 * Two properties matter above all:
 *
 * 1. **The output is built by construction, not by subtraction.** A de-identified
 *    record is assembled field by field from an allow-list. Nothing is "removed"
 *    from a source record, because a removal step that misses a field ships that
 *    field. An unrecognised source column simply has nowhere to go.
 * 2. **The linkage key is irreversible.** It is derived with a memory-hard KDF
 *    from a salt that never leaves the facility (ADR-0004).
 */

import { createHash, scryptSync, timingSafeEqual } from "node:crypto";

export type AgeBand = "<5" | "5-14" | "15-44" | "45-64" | "65+" | "unknown";
export type Sex = "male" | "female" | "unknown";
export type CareSetting = "IPD" | "OPD" | "unknown";
export type SirResult = "S" | "I" | "R" | "SDD" | "NS" | "NI" | "PI";

/** A row as read from the facility's WHONET database. Contains identifiers. */
export interface SourceIsolate {
  patientIdentifier: string;
  specimenDate: Date;
  sex: string | null;
  ageYears: number | null;
  dateOfBirth: Date | null;
  careSetting: string | null;
  organismCode: string;
  specimenTypeCode: string;
  specimenNumber: string | null;
  results: Array<{
    antibioticCode: string;
    result: string | null;
    micValue: number | null;
    micOperator: string | null;
    zoneDiameterMm: number | null;
    testMethod: string | null;
  }>;
}

/**
 * What actually leaves the facility. Compare against SDD 3.1.
 *
 * **Surveillance-relevant fields only.** Facilities configure WHONET however
 * suits them, and real exports carry 55–81 columns: laboratory and institution
 * codes, requesting department, ward, specimen reason, free-text comments,
 * data-entry dates, local flags. None of that contributes to a pattern, a trend
 * or an antibiogram, so none of it is transmitted.
 *
 * What survives is exactly what an antibiogram is computed from — the organism,
 * the site of infection (via specimen type), age band, sex, care setting, and
 * the susceptibility results — plus the linkage key that makes
 * first-isolate deduplication possible.
 *
 * The filtering is structural rather than a cleanup pass: this interface *is*
 * the allow-list. A field with no property here has no route out of the
 * building, whatever a facility's WHONET happens to contain.
 */
export interface DeidentifiedIsolate {
  source_record_hash: string;
  patient_linkage_key: string;
  specimen_date: string;
  age_band: AgeBand;
  age_exact_years?: number;
  sex: Sex;
  care_setting: CareSetting;
  organism_code: string;
  organism_kingdom: "bacteria" | "fungi";
  specimen_type_code: string;
  ast_results: Array<{
    antibiotic_code: string;
    result: SirResult;
    mic_value?: number;
    mic_operator?: string;
    zone_diameter_mm?: number;
    test_method?: string;
  }>;
}

export interface DeidentificationOptions {
  /** Facility-local, never transmitted. */
  salt: Buffer;
  facilityCode: string;
  /** Organism codes known to be fungal, from the canonical dictionary. */
  fungalOrganismCodes: ReadonlySet<string>;
  /**
   * Exact age travels only where the regional block has formally approved it.
   * SDD 13.2 is unresolved, so this defaults to false and the field is omitted
   * entirely rather than sent as null.
   */
  retainExactAge?: boolean;
}

/** Argon2id is specified in ADR-0004; scrypt is the memory-hard KDF available in
 * Node's standard library without a native dependency, and is configured here to
 * comparable cost. The choice is recorded in the linkage_hash methodology
 * version, so a change is a migration event rather than a silent difference. */
const KDF_COST = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;

export function computeLinkageKey(patientIdentifier: string, salt: Buffer): string {
  const normalised = patientIdentifier.trim().toUpperCase();
  if (normalised === "") {
    throw new Error("Cannot compute a linkage key from an empty patient identifier");
  }
  return scryptSync(normalised, salt, KEY_LENGTH, KDF_COST).toString("hex");
}

/**
 * Identifies the source record so the same row is not ingested twice across
 * incremental uploads.
 *
 * Derived from the linkage key rather than the raw patient identifier: this
 * value is transmitted, so building it from an identifier would ship a hash of
 * that identifier under a different name — salted only by facility code, which
 * is public. That would undo the protection the linkage key provides.
 */
export function computeSourceRecordHash(
  linkageKey: string,
  specimenNumber: string | null,
  specimenDate: Date,
  organismCode: string,
): string {
  return createHash("sha256")
    .update(
      [
        linkageKey,
        specimenNumber?.trim().toUpperCase() ?? "",
        toIsoDate(specimenDate),
        organismCode.trim().toLowerCase(),
      ].join("|"),
    )
    .digest("hex");
}

export function bandAge(ageYears: number | null, dateOfBirth: Date | null, on: Date): AgeBand {
  const age = ageYears ?? (dateOfBirth ? yearsBetween(dateOfBirth, on) : null);
  if (age === null || Number.isNaN(age) || age < 0 || age > 130) return "unknown";
  if (age < 5) return "<5";
  if (age < 15) return "5-14";
  if (age < 45) return "15-44";
  if (age < 65) return "45-64";
  return "65+";
}

function yearsBetween(from: Date, to: Date): number {
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  const monthDelta = to.getUTCMonth() - from.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && to.getUTCDate() < from.getUTCDate())) {
    years -= 1;
  }
  return years;
}

export function normaliseSex(value: string | null): Sex {
  const token = value?.trim().toLowerCase() ?? "";
  if (["m", "male", "1"].includes(token)) return "male";
  if (["f", "female", "2"].includes(token)) return "female";
  return "unknown";
}

export function normaliseCareSetting(value: string | null): CareSetting {
  const token = value?.trim().toLowerCase() ?? "";
  if (["i", "in", "ipd", "inpatient", "ip", "admitted"].includes(token)) return "IPD";
  if (["o", "out", "opd", "outpatient", "op", "ambulatory"].includes(token)) return "OPD";
  return "unknown";
}

/**
 * Map a laboratory's recorded interpretation onto the AMRSS vocabulary.
 *
 * Anything not recognised becomes "NI" (not interpretable) rather than being
 * dropped. Discarding it would silently shrink the denominator and make the
 * transmitted counts irreconcilable with the laboratory's own records.
 */
export function normaliseResult(value: string | null): SirResult | null {
  const token = value?.trim().toUpperCase() ?? "";
  if (token === "") return null;
  if (token === "S" || token === "SUSCEPTIBLE") return "S";
  if (token === "I" || token === "INTERMEDIATE") return "I";
  if (token === "R" || token === "RESISTANT") return "R";
  if (token === "SDD") return "SDD";
  if (token === "NS" || token === "NONSUSCEPTIBLE" || token === "NON-SUSCEPTIBLE") return "NS";
  if (token === "PI") return "PI";
  return "NI";
}

export function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Build the transmittable record.
 *
 * Note what this function cannot do: there is no path by which a field of
 * `source` reaches the return value unless it is named here. Patient name,
 * hospital number, address, ward, and attending clinician have no destination.
 */
export function deidentify(
  source: SourceIsolate,
  options: DeidentificationOptions,
): DeidentifiedIsolate {
  const linkageKey = computeLinkageKey(source.patientIdentifier, options.salt);
  const organismCode = source.organismCode.trim().toLowerCase();

  const record: DeidentifiedIsolate = {
    source_record_hash: computeSourceRecordHash(
      linkageKey,
      source.specimenNumber,
      source.specimenDate,
      organismCode,
    ),
    patient_linkage_key: linkageKey,
    specimen_date: toIsoDate(source.specimenDate),
    age_band: bandAge(source.ageYears, source.dateOfBirth, source.specimenDate),
    sex: normaliseSex(source.sex),
    care_setting: normaliseCareSetting(source.careSetting),
    organism_code: organismCode,
    organism_kingdom: options.fungalOrganismCodes.has(organismCode) ? "fungi" : "bacteria",
    specimen_type_code: source.specimenTypeCode.trim().toLowerCase(),
    ast_results: [],
  };

  if (options.retainExactAge && source.ageYears !== null) {
    record.age_exact_years = source.ageYears;
  }

  const seen = new Set<string>();
  for (const entry of source.results) {
    const code = entry.antibioticCode.trim().toUpperCase();
    const result = normaliseResult(entry.result);
    // An agent that was never set up is absent, not "not interpretable". Only a
    // recorded-but-unusable value becomes NI.
    if (result === null || code === "" || seen.has(code)) continue;
    seen.add(code);

    record.ast_results.push({
      antibiotic_code: code,
      result,
      ...(entry.micValue !== null ? { mic_value: entry.micValue } : {}),
      ...(entry.micOperator ? { mic_operator: entry.micOperator } : {}),
      ...(entry.zoneDiameterMm !== null ? { zone_diameter_mm: entry.zoneDiameterMm } : {}),
      ...(entry.testMethod ? { test_method: entry.testMethod } : {}),
    });
  }

  return record;
}

/**
 * Fields that must never appear in a transmitted payload (SDD 3.1).
 *
 * Checked against the serialised payload before it is sent — a belt-and-braces
 * assertion over the allow-list construction above. If a future change ever
 * introduces a path for one of these, the upload fails loudly at the facility
 * rather than succeeding quietly on the network.
 */
export const FORBIDDEN_KEYS = [
  "patient_name",
  "patientname",
  "last_name",
  "first_name",
  "lastname",
  "firstname",
  "patient_id",
  "patientid",
  "hospital_number",
  "hospitalnumber",
  "phone",
  "telephone",
  "address",
  "next_of_kin",
  "date_of_birth",
  "dateofbirth",
  "dob",
  "ward",
  "bed",
  "clinician",
  "doctor",
  "attending",
  "nhis",
  "national_id",
] as const;

export function assertNoDirectIdentifiers(payload: unknown): void {
  const offenders = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      const normalised = key.toLowerCase().replaceAll(/[^a-z]/g, "");
      if (FORBIDDEN_KEYS.some((forbidden) => normalised === forbidden.replaceAll("_", ""))) {
        offenders.add(key);
      }
      walk(value);
    }
  };

  walk(payload);

  if (offenders.size > 0) {
    throw new Error(
      `Refusing to transmit: the payload contains field(s) that may identify a patient — ` +
        `${[...offenders].join(", ")}. This is a defect in the uploader; report it before ` +
        `attempting to send again.`,
    );
  }
}

/** Confirm a salt file has not been swapped or corrupted between runs.
 *
 * A changed salt silently produces different linkage keys for the same patients,
 * which would break deduplication without any visible error — repeat isolates
 * would quietly start counting as distinct patients.
 */
export function saltFingerprint(salt: Buffer): string {
  return createHash("sha256").update(salt).digest("hex").slice(0, 16);
}

export function saltMatchesFingerprint(salt: Buffer, expected: string): boolean {
  const actual = Buffer.from(saltFingerprint(salt));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}
