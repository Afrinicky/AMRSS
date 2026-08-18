/**
 * The renderer's view of the main process.
 *
 * The shapes are declared here rather than imported from `../core`, because the
 * IPC boundary is a serialisation boundary: what crosses it is JSON, and typing
 * it separately is what makes an accidental change to a core type show up as a
 * compile error on this side instead of as an undefined at the bench.
 *
 * Note what is *not* in any of these types: no salt, no access token, no
 * password, no linkage key. The renderer is never given them.
 */

export type Severity = "blocking" | "advisory";
export type Category = "S" | "SDD" | "I" | "R" | "NS" | "PI" | "NI";

export interface SessionInfo {
  fullName: string;
  role: string;
  roleLabel: string;
  email: string;
  username: string | null;
  facilityId: string | null;
  permissions: string[];
  mustChangePassword: boolean;
  mode: "online" | "offline";
  offlineDaysRemaining: number | null;
  signedInAt: string;
}

export interface Connectivity {
  online: boolean;
  checkedAt: string | null;
  latencyMs: number | null;
  detail: string;
}

export interface ValidationIssue {
  rowKey: string;
  rowIndex: number;
  severity: Severity;
  code: string;
  field: string | null;
  message: string;
  currentValue: string | null;
  suggestion: { value: string; rationale: string } | null;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  blocking: number;
  advisory: number;
  blockedRowKeys: string[];
  recordsExamined: number;
  recordsReady: number;
  byCode: Array<{ code: string; severity: Severity; count: number; rows: number }>;
  clearedToUpload: boolean;
  checkedAt: string;
}

export interface CoverageReport {
  measurements: number;
  interpreted: number;
  laboratoryReported: number;
  pending: number;
  notInterpretable: number;
  coveragePercent: number;
  conflicts: number;
  uncovered: Array<{ combination: string; measurements: number }>;
}

export interface WorkspaceSnapshot {
  loaded: boolean;
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

export interface Schedule {
  mode: "manual" | "automatic";
  frequency: "hourly" | "daily" | "weekly" | "monthly" | "interval";
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
  intervalHours: number;
  requireValidation: boolean;
  requireValidatedSignOff: boolean;
  retryMinutes: number;
  description: string;
  nextRunAt: string | null;
}

export interface Status {
  uploaderVersion: string;
  session: SessionInfo | null;
  connectivity: Connectivity;
  facility: { code: string | null; name: string | null };
  apiUrl: string;
  webUrl: string;
  setupComplete: boolean;
  schedule: Schedule;
  realtime: { enabled: boolean; pollSeconds: number };
  connectivitySettings: {
    pollSeconds: number;
    audibleAlert: boolean;
    alertIntervalSeconds: number;
  };
  analysis: { firstIsolateOnly: boolean; minimumIsolates: number };
  approval: {
    approvedAt: string;
    approvedBy: string | null;
    recordCount: number;
    blockingAtApproval: number;
  } | null;
  approvalCurrent: boolean;
  gate: { allowed: boolean; reason: string | null; code: string };
  daysUntilDue: number | null;
  lastSyncAt: string | null;
  workspace: WorkspaceSnapshot;
  logIntegrity: { valid: boolean; firstBrokenIndex: number };
  uploadCount: number;
}

export interface Settings {
  facilityCode: string | null;
  facilityName: string | null;
  apiUrl: string;
  webUrl: string;
  whonetDatabasePath: string | null;
  whonetConfigVersion: string | null;
  astBreakpointStandard: string | null;
  schedule: Schedule;
  realtime: { enabled: boolean; pollSeconds: number };
  connectivity: { pollSeconds: number; audibleAlert: boolean; alertIntervalSeconds: number };
  analysis: { firstIsolateOnly: boolean; minimumIsolates: number };
  offlineGraceDays: number;
  includeUntestedIsolates: boolean;
  log: UploadLogEntry[];
  hasSalt: boolean;
  stateDirectory: string;
  profile: Record<string, unknown> | null;
}

export interface UploadLogEntry {
  timestamp: string;
  batchId: string | null;
  recordCount: number;
  status: string;
  checksum: string;
  coverageStart: string;
  coverageEnd: string;
  message: string;
  trigger?: string;
}

export interface GridCell {
  value: string | null;
  alternate?: string | null;
  tone?: Category;
}

export interface GridResponse {
  columns: Array<{ key: string; label: string; kind: string; detail?: string }>;
  rows: Array<{
    key: string;
    rowIndex: number;
    cells: Record<string, GridCell>;
    blocking: number;
    advisory: number;
    correctedFields: string[];
  }>;
  total: number;
  page: number;
  pageSize: number;
  mode: "interpretations" | "values";
  breakpointsLoaded: boolean;
  breakpointLabel: string | null;
}

export interface RecordDetail {
  record: {
    key: string;
    rowIndex: number;
    organismCode: string | null;
    organismName: string | null;
    specimenTypeCode: string | null;
    specimenName: string | null;
    values: Record<string, string | null>;
  };
  issues: ValidationIssue[];
  corrections: Record<
    string,
    { value: string | null; originalValue: string | null; at: string; by: string | null }
  >;
  excluded: boolean;
  organismOptions: Array<{ code: string; name: string }>;
  specimenOptions: Array<{ code: string; name: string }>;
}

export interface CountRow {
  key: string;
  label: string;
  count: number;
  percent: number;
}

export interface SusceptibilityCell {
  tested: number;
  interpretable: number;
  susceptible: number;
  intermediate: number;
  resistant: number;
  susceptiblePercent: number | null;
  resistantPercent: number | null;
  belowThreshold: boolean;
}

export interface Antibiogram {
  antibiotics: Array<{ code: string; name: string; antimicrobialClass: string }>;
  rows: Array<{
    organismCode: string;
    organismName: string;
    isolates: number;
    cells: Record<string, SusceptibilityCell>;
  }>;
  isolateCount: number;
  minimumIsolates: number;
  firstIsolateOnly: boolean;
}

export interface PhenotypeCount {
  key: string;
  label: string;
  description: string;
  isolates: number;
  eligible: number;
  percent: number | null;
}

export interface Overview {
  options: { firstIsolateOnly: boolean; minimumIsolates: number };
  filters: AnalysisFilters;
  available: {
    organisms: Array<{ code: string; name: string; count: number }>;
    specimens: Array<{ code: string; name: string; count: number }>;
    sites: string[];
    wards: string[];
    departments: string[];
    antibiotics: Array<{ code: string; name: string }>;
    months: string[];
  };
  summary: {
    isolates: number;
    firstIsolates: number;
    patients: number;
    organisms: number;
    antibiotics: number;
    results: number;
    interpretable: number;
    pending: number;
    coveragePercent: number;
    resistantPercent: number | null;
    coverageStart: string | null;
    coverageEnd: string | null;
    topOrganisms: CountRow[];
    topSites: CountRow[];
    careSetting: CountRow[];
    monthlyVolume: Array<{ bucket: string; isolates: number; patients: number }>;
    phenotypes: PhenotypeCount[];
  };
  demographics: { sex: CountRow[]; ageBands: CountRow[]; careSetting: CountRow[] };
  specimens: CountRow[];
  sites: CountRow[];
  wards: CountRow[];
  departments: CountRow[];
  organisms: CountRow[];
  volume: Array<{ bucket: string; isolates: number; patients: number }>;
  phenotypes: PhenotypeCount[];
  isolatesInScope: number;
  isolatesAnalysed: number;
}

export interface AntibioticProfile {
  code: string;
  name: string;
  antimicrobialClass: string;
  cell: SusceptibilityCell;
  organismCount: number;
}

export interface TrendResponse {
  resistance: Array<{
    bucket: string;
    isolates: number;
    interpretable: number;
    resistant: number;
    resistantPercent: number | null;
    belowThreshold: boolean;
  }>;
  volume: Array<{ bucket: string; isolates: number; patients: number }>;
}

export interface AnalysisFilters {
  dateFrom?: string | null;
  dateTo?: string | null;
  careSetting?: string | null;
  organismCode?: string | null;
  specimenTypeCode?: string | null;
  infectionSite?: string | null;
  ward?: string | null;
  department?: string | null;
  sex?: string | null;
  ageBand?: string | null;
}

export interface Outcome {
  ok: boolean;
  message: string;
  [key: string]: unknown;
}

export interface DetectionResult {
  profile: Record<string, unknown> | null;
  table: string | null;
  availableTables: string[];
  availableColumns: string[];
  unmappedRequired: string[];
  identifyingColumnsPresent: string[];
  agentColumns: Array<{ column: string; code: string; canonicalCode: string; method: string }>;
  recordCount: number;
}

export interface Bridge {
  status(): Promise<Status>;
  settings(): Promise<Settings>;
  saveSettings(patch: Record<string, unknown>): Promise<Status>;
  openStateFolder(): Promise<Outcome>;
  apiUrlProblem(url: string): Promise<string | null>;

  signIn(input: {
    identifier: string;
    password: string;
  }): Promise<Outcome & { status: Status; code: string; detail?: string }>;
  testConnection(url: string): Promise<Outcome & { detail?: string }>;
  signOut(): Promise<Status>;
  openWebConsole(): Promise<Outcome>;

  chooseWhonetFile(): Promise<{
    path: string;
    detection: DetectionResult | null;
    error?: string;
  } | null>;
  confirmWhonetFile(input: { path: string; profile: unknown }): Promise<Status>;

  reload(): Promise<Status>;
  grid(request: Record<string, unknown>): Promise<GridResponse>;
  record(rowKey: string): Promise<RecordDetail | null>;

  validationReport(): Promise<ValidationReport | null>;
  correct(input: {
    rowKey: string;
    field: string;
    value: string | null;
    note?: string;
  }): Promise<Outcome>;
  clearCorrection(input: { rowKey: string; field: string }): Promise<Outcome>;
  excludeRow(input: { rowKey: string; reason: string }): Promise<Outcome>;
  restoreRow(input: { rowKey: string }): Promise<Outcome>;
  mappings(): Promise<{
    organism: Record<string, string>;
    specimen: Record<string, string>;
    antibiotic: Record<string, string>;
  }>;
  mapCode(input: { entity: string; from: string; to: string }): Promise<Outcome>;
  unmapCode(input: { entity: string; from: string }): Promise<Outcome>;
  approve(): Promise<Outcome>;

  overview(filters: AnalysisFilters): Promise<Overview>;
  antibiogram(filters: AnalysisFilters): Promise<Antibiogram>;
  antibiotics(filters: AnalysisFilters): Promise<AntibioticProfile[]>;
  trend(input: {
    filters: AnalysisFilters;
    antibioticCode: string;
    bucket: "month" | "quarter";
  }): Promise<TrendResponse>;

  breakpointStatus(): Promise<WorkspaceSnapshot["breakpoints"]>;
  syncBreakpoints(): Promise<Outcome>;
  importBreakpoints(): Promise<Outcome>;

  prepareUpload(): Promise<{
    ok: boolean;
    message?: string;
    summary?: {
      isolateCount: number;
      skippedAsAlreadySent: number;
      coverageStart: string;
      coverageEnd: string;
      organismCount: number;
      resultCount: number;
      qcStatus: string;
      compressedBytes: number;
    };
    checksum?: string;
    gate: { allowed: boolean; reason: string | null; code: string };
  }>;
  sendUpload(): Promise<
    Outcome & { batchStatus?: string; findings?: Array<{ code: string; severity: string; message: string }> }
  >;

  exportGrid(input: { mode: string }): Promise<Outcome>;
  exportValidation(): Promise<Outcome>;
  exportAntibiogram(filters: AnalysisFilters): Promise<Outcome>;
  exportAnalytics(filters: AnalysisFilters): Promise<Outcome>;
  exportTrend(input: {
    filters: AnalysisFilters;
    antibioticCode: string;
    bucket: string;
  }): Promise<Outcome>;
  exportHistory(): Promise<Outcome>;

  onStatus(listener: (payload: Status) => void): () => void;
  onData(listener: (payload: { snapshot: WorkspaceSnapshot; trigger: string }) => void): () => void;
  onSchedule(
    listener: (payload: { ran: boolean; at: string; reason: string | null; code: string }) => void,
  ): () => void;
  onOpenConnectionSettings(listener: () => void): () => void;
}

declare global {
  interface Window {
    amrss: Bridge;
  }
}

export const api: Bridge = window.amrss;
