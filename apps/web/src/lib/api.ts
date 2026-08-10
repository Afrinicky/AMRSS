/**
 * Server-side AMRSS API client.
 *
 * Every call happens on the server and the access token lives in an httpOnly
 * cookie, so the browser never holds it and no surveillance response passes
 * through client-side JavaScript that a browser extension or XSS could read.
 */

import { cookies } from "next/headers";

export const SESSION_COOKIE = "amrss_session";

/**
 * Where the surveillance API lives, read per request rather than at module load.
 *
 * Read at call time so a container image built once can be pointed at a
 * different API by configuration. This is only reliable because `next.config`
 * declares no `env:` block — that setting inlines values into the bundle during
 * `next build`, which previously baked the localhost fallback into the image and
 * made the deployment's own setting inert.
 */
export function apiUrl(): string {
  return process.env.AMRSS_API_URL ?? "http://localhost:8000";
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  const response = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    // Surveillance figures change on every accepted upload; a cached antibiogram
    // would quietly contradict the freshness banner shown beside it.
    cache: "no-store",
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = readDetail(body.detail) ?? detail;
    } catch {
      /* response carried no JSON body */
    }
    throw new ApiError(response.status, detail);
  }

  // A 204 carries no body, and calling .json() on one throws. The password
  // change is the first endpoint here to answer that way, and every caller of
  // it failed with a parse error that read as "the password could not be
  // changed" — after the password had in fact been changed.
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/**
 * Read an API error's `detail`, which is not always a string.
 *
 * The refusals worth explaining are exactly the structured ones: a blocked
 * activation carries the list of missing paperwork, and a rejected breakpoint
 * import carries every problem it found. Reading only the string form dropped
 * those and left the caller with the bare status text — "Conflict" in place of
 * "activation requires an MOU execution date".
 */
function readDetail(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map(readDetail).filter(Boolean);
    return parts.length > 0 ? parts.join("; ") : null;
  }
  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : null;
    // FastAPI's own validation errors use `msg`.
    const fallback = typeof record.msg === "string" ? record.msg : null;
    const extra = ["missing", "problems"]
      .map((key) => (Array.isArray(record[key]) ? readDetail(record[key]) : null))
      .filter(Boolean)
      .join("; ");
    const head = message ?? fallback;
    if (head && extra) return `${head} (${extra})`;
    return head ?? (extra || null);
  }
  return null;
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function login(
  email: string,
  password: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const response = await fetch(`${apiUrl()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      typeof body.detail === "string" ? body.detail : "Sign-in failed",
    );
  }
  return response.json();
}

export const api = {
  profile: () => request<Profile>("/api/v1/auth/me"),
  antibiogram: (params?: Record<string, string | undefined>) =>
    request<Antibiogram>(`/api/v1/surveillance/antibiogram${queryString(params)}`),
  alerts: (params?: Record<string, string | undefined>) =>
    request<AlertsPayload>(`/api/v1/surveillance/alerts${queryString(params)}`),
  coverage: () => request<Coverage>("/api/v1/surveillance/coverage"),
  reference: () => request<Reference>("/api/v1/surveillance/reference"),
  scope: () => request<Scope>("/api/v1/surveillance/scope"),
  antibioticExplorer: (params?: Record<string, string | undefined>) =>
    request<AntibioticExplorer>(`/api/v1/surveillance/antibiotics${queryString(params)}`),
  organismExplorer: (params?: Record<string, string | undefined>) =>
    request<OrganismExplorer>(`/api/v1/surveillance/organisms${queryString(params)}`),
  organismDetail: (id: string, params?: Record<string, string | undefined>) =>
    request<OrganismDetail>(`/api/v1/surveillance/organisms/${id}${queryString(params)}`),
  antibioticDetail: (id: string, params?: Record<string, string | undefined>) =>
    request<AntibioticDetail>(`/api/v1/surveillance/antibiotics/${id}${queryString(params)}`),
  specimenExplorer: (params?: Record<string, string | undefined>) =>
    request<SpecimenExplorer>(`/api/v1/surveillance/specimens${queryString(params)}`),

  // Administration. Every one of these is permission-gated at the API; the
  // console only ever hides links, never enforces (SDD 7).
  blocks: () => request<Block[]>("/api/v1/admin/blocks"),
  districts: (params?: Record<string, string | undefined>) =>
    request<DistrictRef[]>(`/api/v1/admin/districts${queryString(params)}`),
  facilities: (params?: Record<string, string | undefined>) =>
    request<AdminFacility[]>(`/api/v1/admin/facilities${queryString(params)}`),
  mappings: (params?: Record<string, string | undefined>) =>
    request<CodeMapping[]>(`/api/v1/admin/mappings${queryString(params)}`),
  methodologyVersions: () => request<MethodologyVersionRow[]>("/api/v1/admin/methodology"),
  dictionarySummary: () => request<DictionarySummary>("/api/v1/admin/dictionary/summary"),
  createDistrict: (regionalBlockId: string, name: string) =>
    send<DistrictRef>(
      `/api/v1/admin/districts${queryString({ regional_block_id: regionalBlockId, name })}`,
      "POST",
    ),
  enrollFacility: (payload: FacilityEnrollment) =>
    send<AdminFacility>("/api/v1/admin/facilities", "POST", payload),
  updateFacility: (facilityId: string, payload: Partial<FacilityEnrollment>) =>
    send<AdminFacility>(`/api/v1/admin/facilities/${facilityId}`, "PATCH", payload),
  transitionFacility: (facilityId: string, target: FacilityStatus, reason: string) =>
    send<AdminFacility>(`/api/v1/admin/facilities/${facilityId}/transition`, "POST", {
      target,
      reason,
    }),
  users: () => request<AdminUser[]>("/api/v1/admin/users"),
  userScopeOptions: () => request<UserScopeOptions>("/api/v1/admin/users/options"),
  createUser: (payload: UserCreate) => send<AdminUser>("/api/v1/admin/users", "POST", payload),
  updateUser: (userId: string, payload: UserUpdate) =>
    send<AdminUser>(`/api/v1/admin/users/${userId}`, "PATCH", payload),
  resetUserPassword: (userId: string, password: string) =>
    send<AdminUser>(`/api/v1/admin/users/${userId}/reset-password`, "POST", { password }),
  unlockUser: (userId: string) =>
    send<AdminUser>(`/api/v1/admin/users/${userId}/unlock`, "POST"),
  changeOwnPassword: (current_password: string, new_password: string) =>
    send<void>("/api/v1/auth/change-password", "POST", { current_password, new_password }),
  auditTrail: (params?: Record<string, string | undefined>) =>
    request<AuditPage>(`/api/v1/admin/audit${queryString(params)}`),
  qualityDashboard: (params?: Record<string, string | undefined>) =>
    request<QualityDashboard>(`/api/v1/quality/dashboard${queryString(params)}`),
  reports: () => request<ReportSummary[]>("/api/v1/reports"),
  comparison: (params?: Record<string, string | undefined>) =>
    request<Comparison>(`/api/v1/surveillance/comparison${queryString(params)}`),
  trend: (params: Record<string, string | undefined>) =>
    request<Trend>(`/api/v1/surveillance/trend${queryString(params)}`),
};

function queryString(params?: Record<string, string | undefined>): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}

// ---- Response shapes -------------------------------------------------------

export interface Profile {
  /** True while the account uses a password an administrator set. */
  must_change_password?: boolean;
  email: string;
  full_name: string;
  role: string;
  facility_id: string | null;
  regional_block_id: string | null;
  permissions: string[];
}

export interface DictionaryRef {
  id: string;
  code: string;
  name: string;
}

export interface Freshness {
  data_last_updated: string | null;
  coverage_start: string | null;
  coverage_end: string | null;
  facilities_contributing: number;
  facilities_expected: number;
  latest_facility_submission: string | null;
  completeness_percent: number | null;
  is_stale: boolean;
}

/** `state` is authoritative. A cell that is not "reportable" carries no
 * percentage and no counts — the API withholds them rather than trusting the
 * client to hide them. */
export type CellState = "reportable" | "below_threshold" | "suppressed" | "not_tested";

export interface Cell {
  antibiotic_id: string;
  state: CellState;
  susceptible_percent: number | null;
  resistant_percent: number | null;
  tested: number | null;
  interpretable: number | null;
  confidence_lower: number | null;
  confidence_upper: number | null;
  uncertainty_cue: boolean;
}

export interface AntibiogramRow {
  organism: DictionaryRef;
  organism_kingdom: "bacteria" | "fungi";
  isolate_count: number;
  cells: Cell[];
}

export interface Antibiogram {
  aggregation_level: string;
  rows: AntibiogramRow[];
  antibiotics: DictionaryRef[];
  freshness: Freshness;
  quality_exclusion: {
    facilities_excluded: number;
    isolates_excluded: number;
    note: string;
  };
  raw_isolate_count: number;
  antibiogram_eligible_count: number;
  minimum_isolates: number;
  small_cell_threshold: number;
  suppression_applied: boolean;
  pending_interpretation_count: number;
  methodology: Record<string, unknown>;
  clinical_framing: string;
}

export interface Signal {
  organism: DictionaryRef;
  antibiotic: DictionaryRef;
  baseline_start: string;
  baseline_end: string;
  baseline_susceptible_percent: number;
  baseline_n: number;
  current_start: string;
  current_end: string;
  current_susceptible_percent: number;
  current_n: number;
  change_percentage_points: number;
  status_label: string;
}

export interface BelowThresholdAlert {
  organism: DictionaryRef;
  antibiotic: DictionaryRef;
  non_susceptible_count: number;
  isolates: number;
  first_seen: string;
  last_seen: string;
  facility_count: number;
  caveat: string;
}

export interface AlertsPayload {
  emerging_signals: Signal[];
  below_threshold_alerts: BelowThresholdAlert[];
  freshness: Freshness;
  note: string;
}

export interface FacilityReporting {
  facility_id: string;
  facility_name: string;
  district_name: string;
  schedule: string;
  expected_interval_days: number;
  last_accepted_upload_at: string | null;
  days_since_last_upload: number | null;
  is_overdue: boolean;
  quality_verified: boolean;
}

export interface Coverage {
  enrolled_facilities: number;
  active_facilities: number;
  reporting_this_week: number;
  reporting_this_month: number;
  overdue_facilities: number;
  isolates_this_month: number;
  districts_covered: number;
  districts_total: number;
  facilities_excluded_by_quality: number;
  facilities: FacilityReporting[];
}

export interface ScopeDistrict {
  id: string;
  name: string;
  /** Null where the caller may not see facilities. A count is a smaller
   * disclosure than a roster, but it is still one. */
  facility_count: number | null;
}

export interface ScopeFacility {
  id: string;
  code: string;
  name: string;
  district_id: string;
}

/** The geography a caller may filter by. Mirrors what the API will accept, so a
 * selector never offers a choice that would be refused. */
export interface Scope {
  districts: ScopeDistrict[];
  facilities: ScopeFacility[];
  can_select_facility: boolean;
  pinned_facility_id: string | null;
}

export interface Reference {
  organisms: Array<{
    id: string;
    code: string;
    name: string;
    kingdom: string;
    gram_stain: string | null;
    special_importance: boolean;
  }>;
  antibiotics: Array<{
    id: string;
    code: string;
    name: string;
    class: string;
    target_kingdom: string;
    who_aware_category: string | null;
    display_order: number;
  }>;
  specimen_types: Array<{
    id: string;
    code: string;
    name: string;
    infection_site: string;
    sterile_site: boolean;
  }>;
}

export interface TrendPoint {
  label: string;
  bucket_start: string;
  bucket_end: string;
  susceptible_percent: number | null;
  isolate_count: number;
  sufficient: boolean;
  confidence_lower: number | null;
  confidence_upper: number | null;
}

export interface Trend {
  organism: DictionaryRef;
  antibiotic: DictionaryRef;
  bucket: string;
  minimum_isolates: number;
  points: TrendPoint[];
  freshness: Freshness;
  clinical_framing: string;
}

export interface AntibioticProfile {
  antibiotic: DictionaryRef;
  susceptible_percent: number;
  intermediate_percent: number;
  resistant_percent: number;
  tested: number;
  interpretable: number;
  organism_count: number;
}

export interface AntibioticExplorer {
  profiles: AntibioticProfile[];
  minimum_isolates: number;
  freshness: Freshness;
  pooling_caveat: string;
  clinical_framing: string;
}

export interface SiteCount {
  infection_site: string;
  isolate_count: number;
  percent_of_organism: number;
}

export interface OrganismSites {
  organism: DictionaryRef;
  organism_kingdom: "bacteria" | "fungi";
  isolate_count: number;
  percent_of_total: number;
  principal_site: string | null;
  sites: SiteCount[];
  withheld_isolates: number;
}

export interface SpecimenCount {
  specimen_type: DictionaryRef;
  infection_site: string;
  sterile_site: boolean;
  isolate_count: number;
  percent_of_total: number;
}

export interface SpecimenExplorer {
  specimens: SpecimenCount[];
  total_isolates: number;
  withheld_isolates: number;
  freshness: Freshness;
  clinical_framing: string;
}

export interface OrganismExplorer {
  organisms: OrganismSites[];
  total_isolates: number;
  infection_sites: string[];
  freshness: Freshness;
  clinical_framing: string;
}

// ---- Administration --------------------------------------------------------

export type FacilityStatus =
  | "pending"
  | "under_verification"
  | "active"
  | "suspended"
  | "inactive"
  | "retired";

export interface Block {
  id: string;
  code: string;
  name: string;
  governing_body: string;
  status: string;
  activated_on: string | null;
  whonet_config_standard: string | null;
  district_count: number;
  facility_count: number;
}

export interface AdminFacility {
  id: string;
  code: string;
  name: string;
  district_id: string;
  district_name: string;
  regional_block_id: string;
  status: FacilityStatus;
  whonet_config_version: string | null;
  upload_schedule: string;
  upload_interval_days: number | null;
  mou_signed_on: string | null;
  mou_reference: string | null;
  enrollment_notes: string | null;
  last_accepted_upload_at: string | null;
  qc_status: string;
  eqa_status: string;
  available_transitions: FacilityStatus[];
  blocking_activation: string[];
}

export interface AdminUser {
  id: string;
  email: string;
  full_name: string;
  role: string;
  facility_id: string | null;
  facility_name: string | null;
  regional_block_id: string | null;
  is_active: boolean;
  last_login_at: string | null;
  /** Inside an automatic lockout window. Distinct from inactive, which is a
   * decision somebody made. */
  is_locked: boolean;
  must_change_password: boolean;
  permissions: string[];
  /** Whether this caller may act on this account at all. */
  editable: boolean;
}

export interface UserScopeOptions {
  roles: string[];
  facilities: Array<{ id: string; name: string }>;
  blocks: Array<{ id: string; name: string }>;
}

export interface UserCreate {
  email: string;
  full_name: string;
  role: string;
  password: string;
  facility_id?: string | null;
  regional_block_id?: string | null;
}

export interface UserUpdate {
  full_name?: string;
  role?: string;
  facility_id?: string | null;
  regional_block_id?: string | null;
  is_active?: boolean;
}

export interface DistrictRef {
  id: string;
  name: string;
  regional_block_id: string;
  facility_count: number;
}

/** What a laboratory supplies when it enrols. Everything past the first three
 * fields can arrive later — but a facility cannot be activated without an MOU
 * date and a WHONET configuration version, and the console says so. */
export interface FacilityEnrollment {
  code: string;
  name: string;
  district_id: string;
  whonet_config_version?: string | null;
  upload_schedule?: string;
  upload_interval_days?: number | null;
  mou_signed_on?: string | null;
  mou_reference?: string | null;
  enrollment_notes?: string | null;
}

export interface CodeMapping {
  id: string;
  facility_id: string;
  facility_name: string;
  entity_type: string;
  local_code: string;
  local_label: string | null;
  canonical_code: string | null;
  status: string;
  observed_record_count: number;
  review_note: string | null;
}

export interface MethodologyVersionRow {
  id: string;
  component: string;
  version: string;
  description: string;
  effective_from: string;
  is_provisional: boolean;
  regional_block_id: string | null;
  parameter_keys: string[];
  entry_count: number | null;
}

export interface DictionarySummary {
  organisms: number;
  organisms_of_special_importance: number;
  organisms_without_clsi_groups: number;
  antibiotics: number;
  specimen_types: number;
  pending_mappings: number;
}

export interface AuditEntry {
  id: string;
  occurred_at: string;
  actor_label: string;
  actor_role: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  source_ip: string | null;
  note: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
  actions: string[];
}

// ---- Quality (SDD 6.5) -----------------------------------------------------

export interface TierState {
  status: string;
  valid_until: string | null;
  days_remaining: number | null;
  source_date: string | null;
}

export interface QualityProfile {
  facility_id: string;
  facility_code: string;
  facility_name: string;
  district_name: string;
  enrollment_status: string;
  whonet_config_version: string | null;
  qc: TierState;
  eqa: TierState;
  contributes_to_verified_aggregate: boolean;
  exclusion_reasons: string[];
  last_accepted_upload_at: string | null;
  expires_within_days: number | null;
}

export interface QualityDashboard {
  facilities: QualityProfile[];
  contributing: number;
  excluded: number;
  expiring_soon: number;
  expiry_warning_days: number;
  qc_validity_days: number;
  eqa_validity_days: number;
  gating_note: string;
}

// ---- Drill-downs (SDD 11.2) ------------------------------------------------

/** Mirrors the antibiogram cell states on purpose: one vocabulary, learned once. */
export type GroupState = "reportable" | "below_threshold" | "suppressed";

export interface BreakdownGroup {
  key: string;
  label: string;
  state: GroupState;
  susceptible_percent: number | null;
  resistant_percent: number | null;
  interpretable: number | null;
  confidence_lower: number | null;
  confidence_upper: number | null;
  isolate_count: number;
}

export interface Breakdown {
  dimension: string;
  description: string;
  groups: BreakdownGroup[];
}

export interface OrganismDetail {
  organism: DictionaryRef;
  organism_kingdom: "bacteria" | "fungi";
  isolate_count: number;
  antibiogram_eligible_count: number;
  agents: BreakdownGroup[];
  breakdown_antibiotic: DictionaryRef | null;
  breakdowns: Breakdown[];
  minimum_isolates: number;
  small_cell_threshold: number;
  suppression_applied: boolean;
  freshness: Freshness;
  methodology: Record<string, unknown>;
  clinical_framing: string;
}

export interface AntibioticDetail {
  antibiotic: DictionaryRef;
  organisms: BreakdownGroup[];
  breakdowns: Breakdown[];
  minimum_isolates: number;
  small_cell_threshold: number;
  suppression_applied: boolean;
  freshness: Freshness;
  pooling_caveat: string;
  methodology: Record<string, unknown>;
  clinical_framing: string;
}

// ---- Reports (SDD 9.7) -----------------------------------------------------

export interface ReportSummary {
  id: string;
  title: string;
  period: "monthly" | "quarterly" | "annual" | "ad_hoc";
  period_start: string;
  period_end: string;
  generated_at: string;
  organism_count: number;
  isolate_count: number;
  facilities_contributing: number;
  facilities_excluded: number;
  notes: string | null;
  formats: string[];
}

// ---- Comparison heat map (SDD 11.2) ----------------------------------------

export interface MatrixRow {
  key: string;
  label: string;
  isolate_count: number;
  cells: BreakdownGroup[];
}

export interface Comparison {
  dimension: "district" | "facility";
  organism: DictionaryRef | null;
  antibiotics: DictionaryRef[];
  rows: MatrixRow[];
  minimum_isolates: number;
  small_cell_threshold: number;
  suppression_applied: boolean;
  freshness: Freshness;
  methodology: Record<string, unknown>;
  comparison_caveat: string;
  clinical_framing: string;
}
