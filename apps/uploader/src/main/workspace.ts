/**
 * The one place the laboratory's data is held while the application runs.
 *
 * Read the file, apply the corrections overlay, validate, interpret, analyse —
 * in that order, once — and everything the interface shows is a view of the same
 * result. The grid, the validation queue, the dashboard and the batch cannot
 * disagree about how many isolates there are, because there is only one answer
 * and they all read it.
 *
 * Reloading is cheap and happens whenever WHONET writes to the file, so what is
 * on screen is what is in the laboratory's database, not what was there when the
 * application opened. Every reload invalidates the sign-off: data that changed
 * after somebody approved it has not been approved.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import {
  type AnalysedIsolate,
  type AnalysisFilters,
  analyse,
  antibiogram,
  antibioticProfiles,
  applyFilters,
  dashboard,
  demographicBreakdown,
  departmentFrequency,
  filterOptions,
  forAnalysis,
  organismFrequency,
  phenotypes,
  resistanceTrend,
  siteFrequency,
  specimenFrequency,
  volumeTrend,
  wardFrequency,
} from "../core/analytics";
import { applyCorrections, type AppliedDataset, type CorrectionBook } from "../core/corrections";
import { BreakpointIndex, coverageReport, type CoverageReport } from "../core/interpret";
import type { LocalStore, UploaderState } from "../core/store";
import { setupComplete } from "../core/store";
import { type ValidationReport, validate } from "../core/validation";
import { readDataset, type WhonetDataset } from "../core/whonet";

export interface WorkspaceSnapshot {
  loaded: boolean;
  /** Why the data could not be read, where it could not. */
  problem: string | null;
  path: string | null;
  readAt: string | null;
  fileModifiedMs: number | null;
  recordCount: number;
  excludedCount: number;
  excludedByReason: Record<string, number>;
  correctionCount: number;
  fingerprint: string;
  breakpoints: {
    loaded: boolean;
    version: string | null;
    label: string | null;
    source: string;
    syncedAt: string | null;
    criteria: number;
  };
  coverage: CoverageReport | null;
  validation: ValidationReport | null;
}

export class Workspace {
  private dataset: WhonetDataset | null = null;
  private applied: AppliedDataset | null = null;
  private isolates: AnalysedIsolate[] = [];
  private report: ValidationReport | null = null;
  private coverage: CoverageReport | null = null;
  private index = new BreakpointIndex({
    version: null,
    label: null,
    effectiveFrom: null,
    source: "none",
    syncedAt: null,
    criteria: [],
  });
  private problem: string | null = null;
  private fingerprintValue = "empty";

  constructor(private readonly store: LocalStore) {}

  get appliedDataset(): AppliedDataset | null {
    return this.applied;
  }

  get analysedIsolates(): AnalysedIsolate[] {
    return this.isolates;
  }

  get validation(): ValidationReport | null {
    return this.report;
  }

  get breakpointIndex(): BreakpointIndex {
    return this.index;
  }

  get fingerprint(): string {
    return this.fingerprintValue;
  }

  /**
   * Re-read everything.
   *
   * Errors are captured rather than thrown: a WHONET file that is momentarily
   * locked by WHONET itself is an ordinary event on a laboratory workstation,
   * and it should show as a status line, not as a crash.
   */
  reload(state: UploaderState = this.store.read()): WorkspaceSnapshot {
    this.index = new BreakpointIndex(this.store.readBreakpoints());
    this.problem = null;

    if (!state.whonetDatabasePath || !state.profile) {
      this.reset("No WHONET file has been selected yet. Open Setup to choose one.");
      return this.snapshot();
    }
    if (!existsSync(state.whonetDatabasePath)) {
      this.reset(
        `The WHONET file is no longer at ${state.whonetDatabasePath}. If it moved, choose it again in Setup.`,
      );
      return this.snapshot();
    }

    try {
      this.dataset = readDataset(state.whonetDatabasePath, state.profile, {
        includeUntestedIsolates: state.includeUntestedIsolates,
      });
    } catch (error) {
      this.reset(`The WHONET file could not be read: ${(error as Error).message}`);
      return this.snapshot();
    }

    const corrections: CorrectionBook = this.store.readCorrections();
    this.applied = applyCorrections(this.dataset, corrections);
    this.report = validate(this.applied, { breakpoints: this.index });
    this.isolates = analyse(this.applied.records, this.index);
    this.coverage = coverageReport(this.applied.records, this.index);
    this.fingerprintValue = computeFingerprint(this.applied, corrections);

    return this.snapshot();
  }

  private reset(problem: string): void {
    this.dataset = null;
    this.applied = null;
    this.isolates = [];
    this.report = null;
    this.coverage = null;
    this.problem = problem;
    this.fingerprintValue = "empty";
  }

  snapshot(): WorkspaceSnapshot {
    const excludedByReason: Record<string, number> = {};
    for (const entry of this.applied?.excluded ?? []) {
      excludedByReason[entry.reason] = (excludedByReason[entry.reason] ?? 0) + 1;
    }

    const set = this.index.set;
    return {
      loaded: this.applied !== null,
      problem: this.problem,
      path: this.dataset?.path ?? null,
      readAt: this.dataset?.readAt ?? null,
      fileModifiedMs: this.dataset?.fileModifiedMs ?? null,
      recordCount: this.applied?.records.length ?? 0,
      excludedCount: this.applied?.excluded.length ?? 0,
      excludedByReason,
      correctionCount: this.applied?.correctionCount ?? 0,
      fingerprint: this.fingerprintValue,
      breakpoints: {
        loaded: this.index.loaded,
        version: set.version,
        label: set.label,
        source: set.source,
        syncedAt: set.syncedAt,
        criteria: set.criteria.length,
      },
      coverage: this.coverage,
      validation: this.report,
    };
  }

  /** Isolates after the filter bar, ready for any analysis view. */
  filtered(filters: AnalysisFilters): AnalysedIsolate[] {
    return applyFilters(this.isolates, filters);
  }

  analytics(state: UploaderState, filters: AnalysisFilters) {
    const scoped = this.filtered(filters);
    return {
      options: state.analysis,
      filters,
      available: filterOptions(this.isolates),
      summary: dashboard(scoped, state.analysis),
      demographics: demographicBreakdown(scoped),
      specimens: specimenFrequency(scoped),
      sites: siteFrequency(scoped),
      wards: wardFrequency(scoped).slice(0, 15),
      departments: departmentFrequency(scoped).slice(0, 15),
      organisms: organismFrequency(scoped, state.analysis),
      volume: volumeTrend(scoped),
      phenotypes: phenotypes(scoped, state.analysis),
      isolatesInScope: scoped.length,
      isolatesAnalysed: forAnalysis(scoped, state.analysis).length,
    };
  }

  antibiogram(state: UploaderState, filters: AnalysisFilters) {
    return antibiogram(this.filtered(filters), state.analysis);
  }

  antibiotics(state: UploaderState, filters: AnalysisFilters) {
    return antibioticProfiles(this.filtered(filters), state.analysis);
  }

  trend(
    state: UploaderState,
    filters: AnalysisFilters,
    antibioticCode: string,
    bucket: "month" | "quarter",
  ) {
    return {
      resistance: resistanceTrend(this.filtered(filters), antibioticCode, state.analysis, bucket),
      volume: volumeTrend(this.filtered(filters), bucket),
    };
  }
}

/**
 * A fingerprint over the data as it currently stands.
 *
 * It covers the file's modification time and size, the record count, and the
 * corrections overlay — everything a person's sign-off is a statement about. If
 * any of it changes, the approval no longer applies, which is the whole reason
 * the value exists.
 */
function computeFingerprint(applied: AppliedDataset, corrections: CorrectionBook): string {
  return createHash("sha256")
    .update(applied.path)
    .update(String(applied.fileModifiedMs))
    .update(String(applied.fileSizeBytes))
    .update(String(applied.records.length))
    .update(JSON.stringify(corrections))
    .digest("hex")
    .slice(0, 32);
}

export { setupComplete };
