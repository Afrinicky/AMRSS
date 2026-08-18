/**
 * Local state: the facility salt, the confirmed WHONET profile, the corrections
 * overlay, the cached breakpoint table, and the upload log.
 *
 * The salt is the single most sensitive artefact the uploader holds. It never
 * leaves the machine, and if it is lost the facility's historical linkage keys
 * cannot be regenerated — repeat isolates from a patient would stop linking to
 * their earlier ones and quietly start counting as separate patients. That
 * irrecoverability is the property that makes the key genuinely irreversible
 * (ADR-0004), so salt backup is an explicit, documented facility responsibility
 * rather than something the software can silently paper over.
 *
 * Everything else here is recoverable and is kept in separate files by size and
 * by lifetime: settings change rarely and are small, the corrections overlay is
 * edited constantly, and a breakpoint table is hundreds of rows that would
 * otherwise be rewritten on every settings change.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type CorrectionBook, emptyCorrections } from "./corrections";
import { type AnalysisOptions, DEFAULT_ANALYSIS_OPTIONS } from "./analytics";
import { type BreakpointSet, EMPTY_BREAKPOINTS } from "./interpret";
import type { TestingMethodPreference } from "./breakpoints";
import { type DeploymentDefaults, NO_DEPLOYMENT } from "./deployment";
import { DEFAULT_SCHEDULE, type SyncSchedule, type ValidationApproval } from "./schedule";
import type { ColumnProfile } from "./whonet";

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
  /** "manual" or "automatic", so a facility can see which runs it made itself. */
  trigger?: string;
  /** Chained hash over the previous entry, making silent edits detectable
   * (SDD 8.2 item 11). Not tamper-proof — a determined local administrator can
   * rewrite the whole chain — but tamper-evident, which is what the requirement
   * asks for. */
  chain: string;
}

/** How closely the uploader follows WHONET's file. */
export interface RealtimeSettings {
  /** Watch the file and reload when WHONET writes to it. */
  enabled: boolean;
  /** How often to check, in seconds. A file watcher catches most changes
   * immediately; the poll is the backstop for network drives and for editors
   * that replace rather than write. */
  pollSeconds: number;
}

export interface ConnectivitySettings {
  pollSeconds: number;
  /** Sound the periodic alert while offline. On by default: a laboratory that
   * has silently dropped off the network for a week is the failure this exists
   * to prevent. */
  audibleAlert: boolean;
  alertIntervalSeconds: number;
}

export interface UploaderState {
  facilityCode: string | null;
  facilityName: string | null;
  apiUrl: string;
  /** The web console, for the "open the dashboard" handoff. */
  webUrl: string;
  saltFingerprint: string | null;
  profile: ColumnProfile | null;
  whonetDatabasePath: string | null;
  whonetConfigVersion: string | null;
  astBreakpointStandard: string | null;
  /** Whether this laboratory reads zone diameters, MICs, or both. Set once
   * during configuration; governs which criteria are imported, exported and
   * counted as coverage. */
  testingMethod: TestingMethodPreference;
  schedule: SyncSchedule;
  realtime: RealtimeSettings;
  connectivity: ConnectivitySettings;
  analysis: AnalysisOptions;
  /** Days a laboratory may keep working offline before it must reach the
   * server again. */
  offlineGraceDays: number;
  /** Keep isolates that name an organism but carry no susceptibility result. */
  includeUntestedIsolates: boolean;
  approval: ValidationApproval | null;
  lastSyncAt: string | null;
  lastAutomaticRunAt: string | null;
  setupCompletedAt: string | null;
  sentRecordHashes: string[];
  log: UploadLogEntry[];
  /* Retained for files written by earlier versions, so a facility upgrading
   * does not lose its schedule. Read once and folded into `schedule`. */
  uploadSchedule?: "weekly" | "fortnightly" | "monthly" | "custom";
  uploadIntervalDays?: number | null;
}

const EMPTY_STATE: UploaderState = {
  facilityCode: null,
  facilityName: null,
  // Deliberately blank rather than a localhost default. A default that points at
  // a developer's machine produces a sign-in that fails inside fetch and a
  // button that looks broken; an empty field produces a setup screen that asks
  // for the address.
  apiUrl: "",
  webUrl: "",
  saltFingerprint: null,
  profile: null,
  whonetDatabasePath: null,
  whonetConfigVersion: null,
  astBreakpointStandard: null,
  // Most laboratories run disks routinely and MICs for confirmation, so the
  // default keeps both rather than hiding half a table behind a setting nobody
  // was asked about.
  testingMethod: "both",
  schedule: DEFAULT_SCHEDULE,
  realtime: { enabled: true, pollSeconds: 30 },
  connectivity: { pollSeconds: 30, audibleAlert: true, alertIntervalSeconds: 60 },
  analysis: DEFAULT_ANALYSIS_OPTIONS,
  offlineGraceDays: 30,
  includeUntestedIsolates: false,
  approval: null,
  lastSyncAt: null,
  lastAutomaticRunAt: null,
  setupCompletedAt: null,
  sentRecordHashes: [],
  log: [],
};

export class LocalStore {
  private readonly statePath: string;
  private readonly saltPath: string;
  private readonly correctionsPath: string;
  private readonly breakpointsPath: string;

  /**
   * `defaults` is what the installer was built with: where the service lives,
   * and — where an installer was prepared for one facility — which facility.
   * They fill anything nobody has set here, so a fresh installation is already
   * pointed at the right place and the person signing in is asked for nothing
   * but their username and password.
   */
  constructor(
    private readonly directory: string,
    private readonly defaults: DeploymentDefaults = NO_DEPLOYMENT,
  ) {
    this.statePath = join(directory, "uploader-state.json");
    this.saltPath = join(directory, "facility.amrss-salt");
    this.correctionsPath = join(directory, "corrections.json");
    this.breakpointsPath = join(directory, "breakpoints.json");
  }

  read(): UploaderState {
    if (!existsSync(this.statePath)) {
      return {
        ...EMPTY_STATE,
        apiUrl: this.defaults.apiUrl,
        webUrl: this.defaults.webUrl,
        facilityCode: this.defaults.facilityCode,
        facilityName: this.defaults.facilityName,
      };
    }
    let stored: Partial<UploaderState> = {};
    try {
      stored = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<UploaderState>;
    } catch {
      // A settings file damaged by a crash or a full disk must not stop the
      // application from opening: the deployment defaults are usable and the
      // setup screen asks for the rest.
      return {
        ...EMPTY_STATE,
        apiUrl: this.defaults.apiUrl,
        webUrl: this.defaults.webUrl,
        facilityCode: this.defaults.facilityCode,
        facilityName: this.defaults.facilityName,
      };
    }

    return migrate({
      ...EMPTY_STATE,
      ...stored,
      // Deployment values are a floor, not an override: an administrator who
      // has pointed this installation somewhere else keeps that setting.
      apiUrl: (stored.apiUrl ?? "").trim() || this.defaults.apiUrl,
      webUrl: (stored.webUrl ?? "").trim() || this.defaults.webUrl,
      facilityCode: stored.facilityCode ?? this.defaults.facilityCode,
      facilityName: stored.facilityName ?? this.defaults.facilityName,
      // Nested objects are merged rather than replaced, so a file written by an
      // earlier version keeps the new defaults instead of arriving undefined.
      schedule: { ...DEFAULT_SCHEDULE, ...(stored.schedule ?? {}) },
      realtime: { ...EMPTY_STATE.realtime, ...(stored.realtime ?? {}) },
      connectivity: { ...EMPTY_STATE.connectivity, ...(stored.connectivity ?? {}) },
      analysis: { ...DEFAULT_ANALYSIS_OPTIONS, ...(stored.analysis ?? {}) },
    });
  }

  write(state: UploaderState): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }

  readCorrections(): CorrectionBook {
    if (!existsSync(this.correctionsPath)) return emptyCorrections();
    try {
      const stored = JSON.parse(readFileSync(this.correctionsPath, "utf8")) as CorrectionBook;
      return {
        rows: stored.rows ?? {},
        mappings: {
          organism: stored.mappings?.organism ?? {},
          specimen: stored.mappings?.specimen ?? {},
          antibiotic: stored.mappings?.antibiotic ?? {},
        },
      };
    } catch {
      return emptyCorrections();
    }
  }

  writeCorrections(book: CorrectionBook): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.correctionsPath, JSON.stringify(book, null, 2), "utf8");
  }

  readBreakpoints(): BreakpointSet {
    if (!existsSync(this.breakpointsPath)) return EMPTY_BREAKPOINTS;
    try {
      return JSON.parse(readFileSync(this.breakpointsPath, "utf8")) as BreakpointSet;
    } catch {
      return EMPTY_BREAKPOINTS;
    }
  }

  writeBreakpoints(set: BreakpointSet): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.breakpointsPath, JSON.stringify(set), "utf8");
  }

  get stateDirectory(): string {
    return this.directory;
  }

  get deployment(): DeploymentDefaults {
    return this.defaults;
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
    const fingerprint = saltFingerprintOf(salt);
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

function saltFingerprintOf(salt: Buffer): string {
  return createHash("sha256").update(salt).digest("hex").slice(0, 16);
}

/** Fold settings written by an earlier version into their current shape. */
function migrate(state: UploaderState): UploaderState {
  if (!state.uploadSchedule) return state;

  const legacyIntervalHours =
    state.uploadSchedule === "weekly"
      ? 7 * 24
      : state.uploadSchedule === "fortnightly"
        ? 14 * 24
        : state.uploadSchedule === "monthly"
          ? 31 * 24
          : (state.uploadIntervalDays ?? 7) * 24;

  const { uploadSchedule: _schedule, uploadIntervalDays: _interval, ...rest } = state;
  return {
    ...rest,
    schedule: {
      ...state.schedule,
      // The earlier setting was a reminder interval, not an automatic sender, so
      // the mode stays manual: upgrading software must not start transmitting on
      // a schedule nobody agreed to.
      mode: state.schedule.mode,
      frequency: state.schedule.frequency === "weekly" ? "interval" : state.schedule.frequency,
      intervalHours: legacyIntervalHours,
    },
  };
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
  const interval = intervalDays(state.schedule);
  const elapsed = (now.getTime() - new Date(state.lastSyncAt).getTime()) / 86_400_000;
  return Math.round(interval - elapsed);
}

function intervalDays(schedule: SyncSchedule): number {
  switch (schedule.frequency) {
    case "hourly":
      return 1 / 24;
    case "interval":
      return Math.max(1, schedule.intervalHours) / 24;
    case "daily":
      return 1;
    case "weekly":
      return 7;
    case "monthly":
      return 31;
  }
}

export function setupComplete(state: UploaderState): boolean {
  return Boolean(
    state.facilityCode &&
      state.apiUrl &&
      state.whonetDatabasePath &&
      state.profile &&
      existsSync(state.whonetDatabasePath),
  );
}
