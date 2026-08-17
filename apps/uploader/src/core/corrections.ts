/**
 * Corrections a facility makes here, without touching its WHONET file.
 *
 * The validation queue finds gaps — a specimen with no site of collection, a
 * date typed as 2025 when the whole batch is 2026, an organism code the
 * dictionary does not know — and they have to be fixed *before* the data is
 * uploaded, not argued about afterwards. Fixing them means writing something
 * down somewhere, and there are only two places it can go.
 *
 * It does not go into the WHONET database. WHONET owns that file, is often
 * writing to it at the same moment, and a laboratory's primary record must not
 * be edited by a surveillance client — the file is opened read-only everywhere
 * in this application, and that is a property worth keeping absolute.
 *
 * So corrections live here, keyed by the row they correct, as an overlay
 * applied on every read. Three consequences, all deliberate:
 *
 * - The laboratory's original value is never lost; the overlay records both.
 * - Re-reading the file after WHONET updates it re-applies the same overlay.
 * - If the laboratory later fixes the row in WHONET itself, the overlay agrees
 *   with it and simply stops mattering.
 */

import type { WhonetDataset, WhonetRecord } from "./whonet";
import { asDate } from "./whonet";
import { canonicalOrganismCode, canonicalSpecimenCode, careSettingOf } from "./dictionary";

/** Fields a facility may correct. Deliberately short: these are the fields
 * surveillance depends on, and the ones the validation queue raises. Free-text
 * clinical content is not correctable here — it is the laboratory's record. */
export const CORRECTABLE_FIELDS = [
  "specimenDate",
  "specimenTypeCode",
  "organismCode",
  "sex",
  "ageYears",
  "careSettingRaw",
  "patientIdentifier",
  "specimenNumber",
] as const;

export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

export interface FieldCorrection {
  field: CorrectableField;
  /** The corrected value, as text. Null clears a value back to absent. */
  value: string | null;
  /** What the file said, kept so the change is reviewable and reversible. */
  originalValue: string | null;
  note: string | null;
  at: string;
  by: string | null;
}

export interface RowCorrection {
  fields: Partial<Record<CorrectableField, FieldCorrection>>;
  /** A row the facility has decided is not surveillance data — a duplicate
   * entry, a test record. Held out of the upload with the reason recorded. */
  excluded?: { reason: string; at: string; by: string | null };
}

/**
 * Local codes mapped onto canonical ones.
 *
 * Separate from row corrections because they are a statement about the
 * laboratory's configuration rather than about one specimen: mapping `bx` to
 * tissue once fixes every biopsy in the file, and every biopsy entered next
 * month.
 */
export interface CodeMappings {
  organism: Record<string, string>;
  specimen: Record<string, string>;
  antibiotic: Record<string, string>;
}

export interface CorrectionBook {
  rows: Record<string, RowCorrection>;
  mappings: CodeMappings;
}

export const EMPTY_CORRECTIONS: CorrectionBook = {
  rows: {},
  mappings: { organism: {}, specimen: {}, antibiotic: {} },
};

export function emptyCorrections(): CorrectionBook {
  return { rows: {}, mappings: { organism: {}, specimen: {}, antibiotic: {} } };
}

export interface AppliedRecord extends WhonetRecord {
  /** Fields changed by the overlay, for the "edited" marker in the grid. */
  correctedFields: CorrectableField[];
}

export interface AppliedDataset extends Omit<WhonetDataset, "records" | "excluded"> {
  records: AppliedRecord[];
  excluded: Array<{
    key: string;
    rowIndex: number;
    reason: WhonetDataset["excluded"][number]["reason"] | "excluded_by_facility";
    note?: string;
  }>;
  correctionCount: number;
}

/** Apply the overlay. Pure: the dataset it is given is never mutated, so the
 * raw read can be kept and the overlay re-applied when it changes. */
export function applyCorrections(dataset: WhonetDataset, book: CorrectionBook): AppliedDataset {
  const records: AppliedRecord[] = [];
  const excluded: AppliedDataset["excluded"] = [...dataset.excluded];
  let correctionCount = 0;

  for (const record of dataset.records) {
    const correction = book.rows[record.key];
    if (correction?.excluded) {
      excluded.push({
        key: record.key,
        rowIndex: record.rowIndex,
        reason: "excluded_by_facility",
        note: correction.excluded.reason,
      });
      continue;
    }

    const applied = correction ? applyToRecord(record, correction) : { ...record, correctedFields: [] };
    correctionCount += applied.correctedFields.length;
    records.push(applyMappings(applied, book.mappings));
  }

  return { ...dataset, records, excluded, correctionCount };
}

function applyToRecord(record: WhonetRecord, correction: RowCorrection): AppliedRecord {
  const next: AppliedRecord = { ...record, correctedFields: [] };

  for (const field of CORRECTABLE_FIELDS) {
    const entry = correction.fields[field];
    if (!entry) continue;
    const value = entry.value;

    switch (field) {
      case "specimenDate": {
        const parsed = value ? asDate(value) : null;
        // A correction that cannot be parsed as a date is not applied: the
        // validation queue will still show the row as missing a date, which is
        // the honest outcome, rather than the row silently keeping a bad value.
        if (parsed) {
          next.specimenDate = parsed;
          next.specimenDateSource = "specimen";
          next.correctedFields.push(field);
        }
        break;
      }
      case "ageYears": {
        const parsed = value === null || value === "" ? null : Number(value);
        next.ageYears = parsed !== null && Number.isFinite(parsed) ? parsed : null;
        next.correctedFields.push(field);
        break;
      }
      case "careSettingRaw": {
        next.careSettingRaw = value;
        next.careSetting = careSettingOf(value);
        next.correctedFields.push(field);
        break;
      }
      case "organismCode": {
        next.organismCode = value ? value.trim().toLowerCase() : null;
        next.correctedFields.push(field);
        break;
      }
      case "specimenTypeCode": {
        next.specimenTypeCode = value ? value.trim().toLowerCase() : null;
        next.correctedFields.push(field);
        break;
      }
      default: {
        next[field] = value;
        next.correctedFields.push(field);
      }
    }
  }

  return next;
}

/** Facility code mappings, applied after row corrections so an explicit
 * correction on one row always beats the blanket mapping. */
function applyMappings(record: AppliedRecord, mappings: CodeMappings): AppliedRecord {
  const organism = record.organismCode
    ? (mappings.organism[record.organismCode] ?? record.organismCode)
    : null;
  const specimen = record.specimenTypeCode
    ? (mappings.specimen[record.specimenTypeCode] ?? record.specimenTypeCode)
    : null;

  const readings = record.readings.map((reading) => {
    const mapped =
      mappings.antibiotic[reading.antibioticCode] ?? mappings.antibiotic[reading.canonicalCode];
    return mapped ? { ...reading, canonicalCode: mapped.toUpperCase() } : reading;
  });

  return {
    ...record,
    organismCode: organism ? canonicalOrganismCode(organism) : null,
    specimenTypeCode: specimen ? canonicalSpecimenCode(specimen) : null,
    readings,
  };
}

/** Record a correction, keeping what the file originally said. */
export function correct(
  book: CorrectionBook,
  record: WhonetRecord,
  field: CorrectableField,
  value: string | null,
  options: { note?: string | null; by?: string | null } = {},
): CorrectionBook {
  const existing = book.rows[record.key] ?? { fields: {} };
  const original = existing.fields[field]?.originalValue ?? originalValue(record, field);

  return {
    ...book,
    rows: {
      ...book.rows,
      [record.key]: {
        ...existing,
        fields: {
          ...existing.fields,
          [field]: {
            field,
            value,
            originalValue: original,
            note: options.note ?? null,
            at: new Date().toISOString(),
            by: options.by ?? null,
          },
        },
      },
    },
  };
}

export function clearCorrection(
  book: CorrectionBook,
  rowKey: string,
  field: CorrectableField,
): CorrectionBook {
  const existing = book.rows[rowKey];
  if (!existing) return book;
  const { [field]: _removed, ...rest } = existing.fields;
  const rows = { ...book.rows, [rowKey]: { ...existing, fields: rest } };
  if (Object.keys(rest).length === 0 && !existing.excluded) delete rows[rowKey];
  return { ...book, rows };
}

export function excludeRow(
  book: CorrectionBook,
  rowKey: string,
  reason: string,
  by: string | null,
): CorrectionBook {
  const existing = book.rows[rowKey] ?? { fields: {} };
  return {
    ...book,
    rows: {
      ...book.rows,
      [rowKey]: { ...existing, excluded: { reason, at: new Date().toISOString(), by } },
    },
  };
}

export function restoreRow(book: CorrectionBook, rowKey: string): CorrectionBook {
  const existing = book.rows[rowKey];
  if (!existing) return book;
  const rows = { ...book.rows };
  if (Object.keys(existing.fields).length === 0) delete rows[rowKey];
  else rows[rowKey] = { fields: existing.fields };
  return { ...book, rows };
}

export function mapCode(
  book: CorrectionBook,
  entity: keyof CodeMappings,
  from: string,
  to: string,
): CorrectionBook {
  const key = entity === "antibiotic" ? from.trim().toUpperCase() : from.trim().toLowerCase();
  const value = entity === "antibiotic" ? to.trim().toUpperCase() : to.trim().toLowerCase();
  return {
    ...book,
    mappings: { ...book.mappings, [entity]: { ...book.mappings[entity], [key]: value } },
  };
}

export function unmapCode(
  book: CorrectionBook,
  entity: keyof CodeMappings,
  from: string,
): CorrectionBook {
  const key = entity === "antibiotic" ? from.trim().toUpperCase() : from.trim().toLowerCase();
  const { [key]: _removed, ...rest } = book.mappings[entity];
  return { ...book, mappings: { ...book.mappings, [entity]: rest } };
}

function originalValue(record: WhonetRecord, field: CorrectableField): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}
