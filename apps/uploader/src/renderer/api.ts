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
  regionalBlockId: string | null;
  permissions: string[];
  mustChangePassword: boolean;
  /** What this account may do to breakpoints, resolved by the server at
   * sign-in. The permission list cannot answer it on its own: local editing
   * also depends on a grant recorded against the facility. */
  breakpoints: BreakpointStanding;
  mode: "online" | "offline";
  offlineDaysRemaining: number | null;
  signedInAt: string;
}

export interface BreakpointStanding {
  source: "national" | "facility";
  mayEditLocally: boolean;
  mayPublishNational: boolean;
  mayGrantOverride: boolean;
  refusal: string;
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
  /** Whether this laboratory reads zones, MICs, or both. */
  testingMethod: "disk" | "mic" | "both";
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

/** One breakpoint as the editable table shows it. */
export interface BreakpointTableRow {
  key: string;
  organismGroup: string;
  agentCode: string;
  agentName: string;
  method: string;
  scope: string;
  susceptible: string;
  intermediate: string;
  resistant: string;
  source: string;
  comment: string;
}

/** One row of the table as CLSI prints it. */
export interface CatalogueRow {
  key: string;
  agentCode: string;
  agentName: string;
  qualifier: string;
  susceptible: string;
  sdd: string;
  intermediate: string;
  resistant: string;
  comment: string;
  /** No threshold typed yet — a place for a number rather than a number. */
  placeholder: boolean;
  values: {
    susceptible: string;
    sddMin: string;
    sddMax: string;
    intermediateMin: string;
    intermediateMax: string;
    resistant: string;
    diskContent: string;
    site: string;
    route: string;
    dosageNote: string;
    comment: string;
    standard: string;
    tableReference: string;
  };
  advisories: string[];
}

export interface CatalogueSection {
  organismGroup: string;
  tableReference: string;
  classes: Array<{ label: string; rows: CatalogueRow[] }>;
  rowCount: number;
  /** How many of this group's rows state thresholds. */
  filled: number;
}

export interface Completeness {
  rows: number;
  filled: number;
  placeholders: number;
  percent: number;
}

export interface Catalogue {
  method: "DISK" | "MIC";
  unit: string;
  loaded: boolean;
  edition: string;
  /** The table's name alone, without the "— synced from…" suffix. */
  editionLabel: string;
  criteria: number;
  shown: number;
  sections: CatalogueSection[];
  onlyUnderOtherMethod: string[];
  organismGroups: string[];
  testingMethod: "disk" | "mic" | "both";
  /** How much of the whole table states thresholds. */
  completeness: Completeness;
  /** The same, over the rows currently shown. */
  shownCompleteness: Completeness;
  /** No thresholds anywhere: a blueprint nobody has started filling in. */
  blueprint: boolean;
  /** Where the table came from, so the page can say whose it is. */
  source: string;
  /** Whether this account may change it here, and why not when it may not. */
  editable: boolean;
  editRefusal: string;
}

export interface BreakpointTable {
  description: string;
  total: number;
  matched: number;
  offset: number;
  rows: BreakpointTableRow[];
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

/* --- The platform, for the administrator consoles ------------------------- */

/** Every platform call answers in this shape: never a thrown error, always a
 * sentence, and the data only when there is data. */
export interface PlatformReply<T> {
  ok: boolean;
  message: string;
  data?: T;
}

export interface PlatformUser {
  id: string;
  email: string;
  username: string | null;
  fullName: string;
  role: string;
  facilityId: string | null;
  facilityName: string | null;
  regionalBlockId: string | null;
  isActive: boolean;
  isLocked: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  permissions: string[];
  editable: boolean;
}

export interface RoleOption {
  value: string;
  label: string;
  description: string;
  scope: "facility" | "block" | "optional";
}

export interface ScopeOption {
  id: string;
  name: string;
}

export interface UserOptions {
  roles: RoleOption[];
  facilities: ScopeOption[];
  blocks: ScopeOption[];
  grantingAs: string;
}

export interface PlatformBlock {
  id: string;
  code: string;
  name: string;
  governingBody: string;
  status: string;
  activatedOn: string | null;
  whonetConfigStandard: string | null;
  districtCount: number;
  facilityCount: number;
}

export interface PlatformDistrict {
  id: string;
  name: string;
  regionalBlockId: string;
  facilityCount: number;
}

export interface PlatformFacility {
  id: string;
  code: string;
  name: string;
  districtId: string;
  districtName: string;
  regionalBlockId: string;
  status: string;
  whonetConfigVersion: string | null;
  uploadSchedule: string;
  lastAcceptedUploadAt: string | null;
  qcStatus: string;
  eqaStatus: string;
  availableTransitions: string[];
  blockingActivation: string[];
  breakpointOverrideGranted: boolean;
  breakpointOverrideNote: string | null;
  breakpointOverrideGrantedAt: string | null;
}

export interface PlatformBatch {
  id: string;
  facilityCode: string;
  status: string;
  uploadedAt: string;
  isolateCount: number;
  coverageStart: string | null;
  coverageEnd: string | null;
  findingCount: number;
  availableTransitions: string[];
}

export interface PlatformMapping {
  id: string;
  entityType: string;
  facilityCode: string;
  sourceCode: string;
  proposedName: string | null;
  status: string;
  observedCount: number;
}

export interface AuditEntry {
  id: string;
  recordedAt: string;
  action: string;
  entity: string;
  entityId: string | null;
  actor: string;
  note: string | null;
  sourceIp: string | null;
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
  importBreakpoints(): Promise<Outcome & { problems?: string[] }>;
  suppliedBreakpoints(): Promise<{ available: boolean; label: string }>;
  loadSuppliedBreakpoints(): Promise<Outcome & { problems?: string[] }>;
  blueprints(): Promise<Array<{ edition: string; label: string }>>;
  loadBlueprint(input: { edition?: string }): Promise<Outcome & { problems?: string[] }>;
  newBreakpointEdition(input: { edition: string }): Promise<Outcome>;
  exportBreakpoints(input: { format?: "csv" | "xlsx" }): Promise<Outcome>;
  breakpointTable(request: {
    search?: string;
    method?: string;
    offset?: number;
    limit?: number;
  }): Promise<BreakpointTable>;
  breakpointCatalogue(request: {
    method?: "DISK" | "MIC";
    search?: string;
    organismGroup?: string;
  }): Promise<Catalogue>;
  setBreakpointCell(input: {
    key: string;
    method: "DISK" | "MIC";
    field: string;
    value: string;
  }): Promise<Outcome & { problems?: string[] }>;
  saveBreakpoint(input: {
    criterion: Record<string, unknown>;
    replacing?: string;
  }): Promise<Outcome & { problems?: string[] }>;
  removeBreakpoint(input: { key: string }): Promise<Outcome>;

  exportMappings(): Promise<Outcome>;
  importMappings(): Promise<Outcome & { problems?: string[] }>;

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

  platformUsers(): Promise<PlatformReply<PlatformUser[]>>;
  platformUserOptions(): Promise<PlatformReply<UserOptions>>;
  platformCreateUser(input: {
    email: string;
    username?: string | null;
    fullName: string;
    role: string;
    password: string;
    facilityId?: string | null;
    regionalBlockId?: string | null;
  }): Promise<PlatformReply<unknown>>;
  platformUpdateUser(input: {
    userId: string;
    patch: { email?: string; username?: string | null; fullName?: string; isActive?: boolean };
  }): Promise<PlatformReply<unknown>>;
  platformChangeRole(input: {
    userId: string;
    role: string;
    facilityId?: string | null;
    regionalBlockId?: string | null;
    reason?: string;
  }): Promise<PlatformReply<unknown>>;
  platformResetPassword(input: {
    userId: string;
    password: string;
  }): Promise<PlatformReply<unknown>>;
  platformUnlockUser(input: { userId: string }): Promise<PlatformReply<unknown>>;
  platformDeleteUser(input: { userId: string; confirm: string }): Promise<PlatformReply<unknown>>;

  platformBlocks(): Promise<PlatformReply<PlatformBlock[]>>;
  platformCreateBlock(input: {
    code: string;
    name: string;
    governingBody: string;
    whonetConfigStandard?: string | null;
    districts: string[];
  }): Promise<PlatformReply<unknown>>;
  platformDistricts(input?: {
    regionalBlockId?: string | null;
  }): Promise<PlatformReply<PlatformDistrict[]>>;
  platformCreateDistrict(input: {
    regionalBlockId: string;
    name: string;
  }): Promise<PlatformReply<unknown>>;

  platformFacilities(input?: {
    regionalBlockId?: string | null;
    status?: string | null;
  }): Promise<PlatformReply<PlatformFacility[]>>;
  platformEnrollFacility(input: {
    code: string;
    name: string;
    districtId: string;
    whonetConfigVersion?: string | null;
  }): Promise<PlatformReply<unknown>>;
  platformTransitionFacility(input: {
    facilityId: string;
    target: string;
    reason: string;
  }): Promise<PlatformReply<unknown>>;
  platformSetBreakpointOverride(input: {
    facilityId: string;
    granted: boolean;
    reason: string;
  }): Promise<PlatformReply<unknown>>;

  platformBatches(input?: { status?: string | null }): Promise<PlatformReply<PlatformBatch[]>>;
  platformTransitionBatch(input: {
    batchId: string;
    target: string;
    reason: string;
  }): Promise<PlatformReply<unknown>>;
  platformMappings(input?: { status?: string | null }): Promise<PlatformReply<PlatformMapping[]>>;
  platformReviewMapping(input: {
    mappingId: string;
    approve: boolean;
    note: string;
  }): Promise<PlatformReply<unknown>>;
  platformAudit(input?: {
    action?: string | null;
    limit?: number;
  }): Promise<PlatformReply<{ entries: AuditEntry[]; total: number }>>;
  platformSurveillance<T>(input: {
    path: string;
    params?: Record<string, unknown>;
  }): Promise<PlatformReply<T>>;
  platformBreakpointAuthority(input?: {
    facilityId?: string | null;
  }): Promise<PlatformReply<{
    may_publish_national: boolean;
    may_grant_override: boolean;
    may_edit_locally: boolean;
    facility_override_granted: boolean;
    refusal: string;
    source: string;
  }>>;

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
