/**
 * Local state: the facility salt, the confirmed WHONET profile, and the upload
 * log.
 *
 * The salt is the single most sensitive artefact the uploader holds. It never
 * leaves the machine, and if it is lost the facility's historical linkage keys
 * cannot be regenerated — repeat isolates from a patient would stop linking to
 * their earlier ones and quietly start counting as separate patients. That
 * irrecoverability is the property that makes the key genuinely irreversible
 * (ADR-0004), so salt backup is an explicit, documented facility responsibility
 * rather than something the software can silently paper over.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ColumnProfile } from "./whonet";
import { saltFingerprint } from "./deidentify";

const SALT_BYTES = 32;

export interface UploadLogEntry {
  timestamp: string;
  batchId: string | null;
  recordCount: number;
  status: string;
  checksum: string;
  coverageStart: string;
  coverageEnd: string;
  message: string;
  /** Chained hash over the previous entry, making silent edits detectable
   * (SDD 8.2 item 11). Not tamper-proof — a determined local administrator can
   * rewrite the whole chain — but tamper-evident, which is what the requirement
   * asks for. */
  chain: string;
}

export interface UploaderState {
  facilityCode: string | null;
  apiUrl: string;
  saltFingerprint: string | null;
  profile: ColumnProfile | null;
  whonetDatabasePath: string | null;
  whonetConfigVersion: string | null;
  astBreakpointStandard: string | null;
  uploadSchedule: "weekly" | "fortnightly" | "monthly" | "custom";
  uploadIntervalDays: number | null;
  lastSyncAt: string | null;
  sentRecordHashes: string[];
  log: UploadLogEntry[];
}

const EMPTY_STATE: UploaderState = {
  facilityCode: null,
  apiUrl: "http://localhost:8000",
  saltFingerprint: null,
  profile: null,
  whonetDatabasePath: null,
  whonetConfigVersion: null,
  astBreakpointStandard: null,
  uploadSchedule: "weekly",
  uploadIntervalDays: null,
  lastSyncAt: null,
  sentRecordHashes: [],
  log: [],
};

export class LocalStore {
  private readonly statePath: string;
  private readonly saltPath: string;

  constructor(private readonly directory: string) {
    this.statePath = join(directory, "uploader-state.json");
    this.saltPath = join(directory, "facility.amrss-salt");
  }

  read(): UploaderState {
    if (!existsSync(this.statePath)) return { ...EMPTY_STATE };
    return { ...EMPTY_STATE, ...JSON.parse(readFileSync(this.statePath, "utf8")) };
  }

  write(state: UploaderState): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }

  hasSalt(): boolean {
    return existsSync(this.saltPath);
  }

  /**
   * Load the facility salt, creating it on first run.
   *
   * Written with owner-only permissions. A salt readable by every account on a
   * shared facility computer would let anyone who also obtained the transmitted
   * keys mount an offline search against a small patient-identifier space.
   */
  loadOrCreateSalt(): Buffer {
    if (existsSync(this.saltPath)) {
      const salt = readFileSync(this.saltPath);
      if (salt.length !== SALT_BYTES) {
        throw new Error(
          `The facility salt file at ${this.saltPath} is the wrong size. Do not delete it — ` +
            `restore it from your backup, because linkage keys computed with a different salt ` +
            `will not match records already submitted.`,
        );
      }
      return salt;
    }

    mkdirSync(this.directory, { recursive: true });
    const salt = randomBytes(SALT_BYTES);
    writeFileSync(this.saltPath, salt, { mode: 0o600 });
    try {
      chmodSync(this.saltPath, 0o600);
    } catch {
      /* filesystems without POSIX permissions (some Windows volumes) */
    }
    return salt;
  }

  /** Detect a salt that has been replaced between runs.
   *
   * Silently continuing would break deduplication with no visible error: the
   * same patients would produce new keys and start counting as distinct people.
   */
  verifySalt(state: UploaderState, salt: Buffer): void {
    const fingerprint = saltFingerprint(salt);
    if (state.saltFingerprint && state.saltFingerprint !== fingerprint) {
      throw new Error(
        "The facility salt has changed since the last upload. Linkage keys computed with " +
          "this salt will not match previously submitted records, so patient-level " +
          "deduplication will be wrong. Restore the original salt file from backup, or " +
          "contact the regional Data Steward before uploading.",
      );
    }
  }

  appendLog(state: UploaderState, entry: Omit<UploadLogEntry, "chain">): UploaderState {
    const previous = state.log.at(-1)?.chain ?? "genesis";
    const chain = createHash("sha256")
      .update(previous)
      .update(JSON.stringify(entry))
      .digest("hex");
    return { ...state, log: [...state.log, { ...entry, chain }] };
  }
}

/** Recompute the chain to detect edited or removed entries. */
export function verifyLog(log: UploadLogEntry[]): { valid: boolean; firstBrokenIndex: number } {
  let previous = "genesis";
  for (const [index, entry] of log.entries()) {
    const { chain, ...rest } = entry;
    const expected = createHash("sha256")
      .update(previous)
      .update(JSON.stringify(rest))
      .digest("hex");
    if (expected !== chain) return { valid: false, firstBrokenIndex: index };
    previous = chain;
  }
  return { valid: true, firstBrokenIndex: -1 };
}

/** Days until the next upload is due, negative when overdue (SDD 8.2 item 14). */
export function daysUntilDue(state: UploaderState, now: Date = new Date()): number | null {
  if (!state.lastSyncAt) return null;
  const interval =
    state.uploadSchedule === "weekly"
      ? 7
      : state.uploadSchedule === "fortnightly"
        ? 14
        : state.uploadSchedule === "monthly"
          ? 31
          : (state.uploadIntervalDays ?? 7);
  const elapsed = (now.getTime() - new Date(state.lastSyncAt).getTime()) / 86_400_000;
  return Math.round(interval - elapsed);
}
