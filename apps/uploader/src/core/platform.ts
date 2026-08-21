/**
 * The surveillance platform, as the desktop application sees it.
 *
 * The uploader began as one job — read WHONET, check it, send it — and the
 * console in a browser did everything else. That split is wrong for the people
 * it puts on either side of it. A regional administrator visiting a laboratory
 * has the desktop application in front of them and their own work in a browser
 * tab they cannot always open; a facility administrator adding a colleague's
 * account has to leave the software they were already signed into. The duties
 * do not change with the window they are performed in, so they are performed
 * here too.
 *
 * What this module is *not* is a second implementation of any rule. Every
 * function below is one HTTP call to the same endpoint the web console uses,
 * and every decision about what the caller may do is the server's. The desktop
 * consoles hide controls the account cannot use, which is a courtesy; the
 * refusal that matters happens at the API, exactly as it does for the browser.
 *
 * Shapes are declared in this file rather than shared with the API, because
 * they cross a network boundary: snake_case in, camelCase out, and a field the
 * server stops sending shows up as a compile error here rather than as an
 * `undefined` on a screen somebody is administering accounts from.
 */

import type { PlatformResult, SessionManager } from "./session";

/* ------------------------------------------------------------------ *
 * Accounts.
 * ------------------------------------------------------------------ */

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
  /** Whether *this* caller may act on this account. The server computes it, so
   * the console offers the actions that will succeed rather than teaching the
   * rules by refusal. */
  editable: boolean;
}

export interface RoleOption {
  value: string;
  label: string;
  description: string;
  /** "facility", "block" or "optional" — which selector the form should show. */
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
  /** The caller's own role, so a console can say why the list stops where it
   * does rather than simply appearing short. */
  grantingAs: string;
}

/* ------------------------------------------------------------------ *
 * Geography and enrollment.
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Submissions and stewardship.
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * The client.
 * ------------------------------------------------------------------ */

/** Turn `{a_b: 1}` into `{aB: 1}` one level deep, which is all these shapes
 * need. Written out rather than pulled in as a dependency: the uploader ships
 * to laboratory workstations and every package in it is one more thing to
 * vouch for. */
function camel<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
  }
  return out as T;
}

function camelAll<T>(rows: unknown): T[] {
  return Array.isArray(rows) ? rows.map((row) => camel<T>(row as Record<string, unknown>)) : [];
}

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export class PlatformClient {
  constructor(
    private readonly session: SessionManager,
    private readonly apiUrl: () => string,
  ) {}

  private get<T>(path: string): Promise<PlatformResult<T>> {
    return this.session.request<T>(this.apiUrl(), `/api/v1${path}`);
  }

  private send<T>(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<PlatformResult<T>> {
    return this.session.request<T>(this.apiUrl(), `/api/v1${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /* ---- Accounts ---- */

  async users(): Promise<PlatformResult<PlatformUser[]>> {
    const result = await this.get<unknown>("/admin/users");
    return result.ok
      ? { ok: true, status: result.status, data: camelAll<PlatformUser>(result.data) }
      : result;
  }

  async userOptions(): Promise<PlatformResult<UserOptions>> {
    const result = await this.get<Record<string, unknown>>("/admin/users/options");
    if (!result.ok) return result;
    const body = result.data;
    return {
      ok: true,
      status: result.status,
      data: {
        roles: camelAll<RoleOption>(body.roles),
        facilities: camelAll<ScopeOption>(body.facilities),
        blocks: camelAll<ScopeOption>(body.blocks),
        grantingAs: String(body.granting_as ?? ""),
      },
    };
  }

  createUser(input: {
    email: string;
    username?: string | null;
    fullName: string;
    role: string;
    password: string;
    facilityId?: string | null;
    regionalBlockId?: string | null;
  }): Promise<PlatformResult<unknown>> {
    return this.send("POST", "/admin/users", {
      email: input.email,
      username: input.username || null,
      full_name: input.fullName,
      role: input.role,
      password: input.password,
      facility_id: input.facilityId || null,
      regional_block_id: input.regionalBlockId || null,
    });
  }

  updateUser(
    userId: string,
    patch: {
      email?: string;
      username?: string | null;
      fullName?: string;
      isActive?: boolean;
    },
  ): Promise<PlatformResult<unknown>> {
    const body: Record<string, unknown> = {};
    if (patch.email !== undefined) body.email = patch.email;
    if (patch.username !== undefined) body.username = patch.username;
    if (patch.fullName !== undefined) body.full_name = patch.fullName;
    if (patch.isActive !== undefined) body.is_active = patch.isActive;
    return this.send("PATCH", `/admin/users/${userId}`, body);
  }

  /**
   * Move an account to a different role.
   *
   * Its own endpoint rather than a field on the update, and the console follows
   * suit. Handing one person national authority over every region is a
   * different kind of act from correcting a surname, and it should not happen
   * because a form resubmitted a select box alongside one.
   */
  changeRole(
    userId: string,
    input: {
      role: string;
      facilityId?: string | null;
      regionalBlockId?: string | null;
      reason?: string;
    },
  ): Promise<PlatformResult<unknown>> {
    return this.send("POST", `/admin/users/${userId}/role`, {
      role: input.role,
      facility_id: input.facilityId || null,
      regional_block_id: input.regionalBlockId || null,
      reason: input.reason ?? "",
    });
  }

  resetPassword(userId: string, password: string): Promise<PlatformResult<unknown>> {
    return this.send("POST", `/admin/users/${userId}/reset-password`, { password });
  }

  unlockUser(userId: string): Promise<PlatformResult<unknown>> {
    return this.send("POST", `/admin/users/${userId}/unlock`);
  }

  deleteUser(userId: string, confirm: string): Promise<PlatformResult<unknown>> {
    return this.send("POST", `/admin/users/${userId}/delete`, { confirm });
  }

  /* ---- Geography ---- */

  async blocks(): Promise<PlatformResult<PlatformBlock[]>> {
    const result = await this.get<unknown>("/admin/blocks");
    return result.ok
      ? { ok: true, status: result.status, data: camelAll<PlatformBlock>(result.data) }
      : result;
  }

  createBlock(input: {
    code: string;
    name: string;
    governingBody: string;
    whonetConfigStandard?: string | null;
    districts: string[];
  }): Promise<PlatformResult<unknown>> {
    return this.send("POST", "/admin/blocks", {
      code: input.code,
      name: input.name,
      governing_body: input.governingBody,
      whonet_config_standard: input.whonetConfigStandard || null,
      districts: input.districts,
    });
  }

  async districts(regionalBlockId?: string | null): Promise<PlatformResult<PlatformDistrict[]>> {
    const result = await this.get<unknown>(
      `/admin/districts${query({ regional_block_id: regionalBlockId })}`,
    );
    return result.ok
      ? { ok: true, status: result.status, data: camelAll<PlatformDistrict>(result.data) }
      : result;
  }

  createDistrict(regionalBlockId: string, name: string): Promise<PlatformResult<unknown>> {
    return this.send(
      "POST",
      `/admin/districts${query({ regional_block_id: regionalBlockId, name })}`,
    );
  }

  /* ---- Facilities ---- */

  async facilities(filters: {
    regionalBlockId?: string | null;
    status?: string | null;
  } = {}): Promise<PlatformResult<PlatformFacility[]>> {
    const result = await this.get<unknown>(
      `/admin/facilities${query({
        regional_block_id: filters.regionalBlockId,
        facility_status: filters.status,
      })}`,
    );
    return result.ok
      ? { ok: true, status: result.status, data: camelAll<PlatformFacility>(result.data) }
      : result;
  }

  enrollFacility(input: {
    code: string;
    name: string;
    districtId: string;
    whonetConfigVersion?: string | null;
  }): Promise<PlatformResult<unknown>> {
    return this.send("POST", "/admin/facilities", {
      code: input.code,
      name: input.name,
      district_id: input.districtId,
      whonet_config_version: input.whonetConfigVersion || null,
    });
  }

  transitionFacility(
    facilityId: string,
    target: string,
    reason: string,
  ): Promise<PlatformResult<unknown>> {
    return this.send("POST", `/admin/facilities/${facilityId}/transition`, { target, reason });
  }

  /**
   * Permit — or withdraw — one facility's departure from the national
   * breakpoint table.
   *
   * National authority only. The console shows the control to nobody else, and
   * the API refuses it regardless of what the console shows.
   */
  setBreakpointOverride(
    facilityId: string,
    granted: boolean,
    reason: string,
  ): Promise<PlatformResult<unknown>> {
    return this.send("POST", `/admin/facilities/${facilityId}/breakpoint-override`, {
      granted,
      reason,
    });
  }

  /* ---- Submissions ---- */

  async batches(status?: string | null): Promise<PlatformResult<PlatformBatch[]>> {
    const result = await this.get<unknown>(
      `/ingestion/batches${query({ batch_status: status, limit: 100 })}`,
    );
    return result.ok
      ? { ok: true, status: result.status, data: camelAll<PlatformBatch>(result.data) }
      : result;
  }

  transitionBatch(
    batchId: string,
    target: string,
    reason: string,
  ): Promise<PlatformResult<unknown>> {
    return this.send("POST", `/ingestion/batches/${batchId}/transition`, { target, reason });
  }

  async mappings(status?: string | null): Promise<PlatformResult<PlatformMapping[]>> {
    const result = await this.get<unknown>(`/admin/mappings${query({ mapping_status: status })}`);
    return result.ok
      ? { ok: true, status: result.status, data: camelAll<PlatformMapping>(result.data) }
      : result;
  }

  reviewMapping(
    mappingId: string,
    approve: boolean,
    note: string,
  ): Promise<PlatformResult<unknown>> {
    return this.send("POST", `/admin/mappings/${mappingId}/review`, {
      status: approve ? "approved" : "rejected",
      note,
    });
  }

  /* ---- Accountability ---- */

  async audit(filters: { action?: string | null; limit?: number } = {}): Promise<
    PlatformResult<{ entries: AuditEntry[]; total: number }>
  > {
    const result = await this.get<Record<string, unknown>>(
      `/admin/audit${query({ action: filters.action, limit: filters.limit ?? 100 })}`,
    );
    if (!result.ok) return result;
    return {
      ok: true,
      status: result.status,
      data: {
        entries: camelAll<AuditEntry>(result.data.entries),
        total: Number(result.data.total ?? 0),
      },
    };
  }

  /* ---- Surveillance, as the console shows it ---- */
  //
  // Passed through unshaped. These are the platform's own analytics — computed
  // over every facility that contributes, not over the WHONET file on this
  // machine — and the desktop application draws them from the same endpoints
  // the dashboard does. Reshaping them here would be a second place for a
  // percentage to go wrong.

  surveillance<T>(path: string, params: Record<string, unknown> = {}): Promise<PlatformResult<T>> {
    return this.get<T>(
      `/surveillance/${path}${query(params as Record<string, string | number | null>)}`,
    );
  }

  /** What this account may do to breakpoints, for the facility in question. */
  breakpointAuthority(facilityId?: string | null): Promise<
    PlatformResult<{
      may_publish_national: boolean;
      may_grant_override: boolean;
      may_edit_locally: boolean;
      facility_override_granted: boolean;
      refusal: string;
      source: string;
    }>
  > {
    return this.get(`/breakpoints/authority${query({ facility_id: facilityId })}`);
  }
}
