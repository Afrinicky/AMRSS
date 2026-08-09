/**
 * Server-side AMRSS API client.
 *
 * Every call happens on the server and the access token lives in an httpOnly
 * cookie, so the browser never holds it and no surveillance response passes
 * through client-side JavaScript that a browser extension or XSS could read.
 */

import { cookies } from "next/headers";

const API_URL = process.env.AMRSS_API_URL ?? "http://localhost:8000";
export const SESSION_COOKIE = "amrss_session";

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

  const response = await fetch(`${API_URL}${path}`, {
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
      detail = typeof body.detail === "string" ? body.detail : detail;
    } catch {
      /* response carried no JSON body */
    }
    throw new ApiError(response.status, detail);
  }

  return (await response.json()) as T;
}

export async function login(
  email: string,
  password: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const response = await fetch(`${API_URL}/api/v1/auth/login`, {
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
  antibioticExplorer: (params?: Record<string, string | undefined>) =>
    request<AntibioticExplorer>(`/api/v1/surveillance/antibiotics${queryString(params)}`),
  organismExplorer: (params?: Record<string, string | undefined>) =>
    request<OrganismExplorer>(`/api/v1/surveillance/organisms${queryString(params)}`),
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

export interface OrganismExplorer {
  organisms: OrganismSites[];
  total_isolates: number;
  infection_sites: string[];
  freshness: Freshness;
  clinical_framing: string;
}
