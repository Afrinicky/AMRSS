/**
 * Signing in — online, and when the line is down.
 *
 * One account signs into both halves of AMRSS. The uploader authenticates
 * against the same API the web console does, with the same username and
 * password, and there is no second set of credentials to issue, rotate or
 * forget.
 *
 * The complication is that a laboratory does not stop working when its internet
 * does. In the settings this software is built for, connectivity is intermittent
 * by default — and a uploader that cannot open without a working link is a
 * uploader nobody enters data into. So sign-in has two paths:
 *
 * - **Online.** Credentials go to the API. On success the profile is cached
 *   along with a verifier for the password — never the password — so the same
 *   person can get back in offline.
 * - **Offline.** The password is checked against that verifier locally. It grants
 *   everything that happens on this machine: the grid, validation, corrections,
 *   analysis. It cannot upload, because uploading needs the network by
 *   definition, and the interface says so rather than failing at the last step.
 *
 * Offline sign-in expires. An account deactivated centrally must stop working
 * here too, and the only way an offline machine can honour that is to insist on
 * seeing the server periodically — `offlineGraceDays`, thirty by default.
 *
 * The verifier is scrypt over the password with a per-installation random salt.
 * It is not a second password store to be managed: it can only answer "is this
 * the password that last worked against the server", and it is written with
 * owner-only permissions beside the facility salt.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KDF_COST = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;

export interface Profile {
  email: string;
  username: string | null;
  fullName: string;
  role: string;
  facilityId: string | null;
  regionalBlockId: string | null;
  permissions: string[];
  mustChangePassword: boolean;
}

export interface CredentialRecord {
  identifier: string;
  kdfSalt: string;
  verifier: string;
  profile: Profile;
  /** The last time this password was accepted by the server. Offline sign-in is
   * measured from here. */
  lastOnlineAt: string;
  apiUrl: string;
}

export interface Session {
  profile: Profile;
  identifier: string;
  mode: "online" | "offline";
  signedInAt: string;
  /** How long this offline session may still be used, in days. Null online. */
  offlineDaysRemaining: number | null;
}

export type SignInOutcome =
  | { ok: true; session: Session; message: string }
  | { ok: false; code: SignInFailure; message: string };

export type SignInFailure =
  | "no_api_url"
  | "bad_credentials"
  | "locked"
  | "offline_no_cache"
  | "offline_expired"
  | "offline_wrong_password"
  | "no_api_here"
  | "server_error";

export const ROLE_LABELS: Record<string, string> = {
  clinician: "Clinician",
  laboratory_staff: "Laboratory staff",
  facility_administrator: "Facility administrator",
  data_steward: "Data steward",
  regional_amr_administrator: "Regional AMR administrator",
  auditor: "Auditor",
  system_administrator: "System administrator",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.replaceAll("_", " ");
}

/**
 * Tidy an address into the API's base.
 *
 * Two paths are removed because people paste them and neither can be right.
 * `/api/v1/...` is the endpoint rather than the base, and the console's own
 * sign-in path is what a browser's address bar is showing when someone copies
 * from it. Any *other* path is left alone: a deployment may legitimately host
 * the API under a prefix, and silently truncating that would break it.
 */
export function normaliseApiUrl(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  return trimmed
    .replace(/\/api\/v1(\/.*)?$/i, "")
    .replace(/\/(console|signin|sign-in|login|dashboard)(\/.*)?$/i, "")
    .replace(/\/+$/, "");
}

/** Hosts that serve the AMRSS *dashboard*. Pasting one into the uploader is the
 * commonest setup mistake there is: it is the address a laboratory sees every
 * day, and the API — a separate service, because a 64 MB batch cannot go
 * through a serverless function — is the one nobody has in front of them. */
const DASHBOARD_HOST = /(^|\.)(vercel\.app|netlify\.app|pages\.dev)$/i;

export function looksLikeDashboardAddress(value: string): boolean {
  const raw = (value ?? "").trim();
  if (/\/(console|signin|sign-in|dashboard)(\/|$)/i.test(raw)) return true;
  try {
    return DASHBOARD_HOST.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether an address can be reached from a laboratory workstation.
 *
 * The default in a fresh installation used to be `http://localhost:8000`, which
 * is a developer's API and not anybody's server. Signing in against it fails
 * inside fetch, the handler rejects, and the button appears to do nothing at
 * all — the exact failure this check exists to name.
 */
export function apiUrlProblem(apiUrl: string): string | null {
  const url = normaliseApiUrl(apiUrl);
  if (url === "") {
    return "No API address is configured. Enter your AMRSS server address to sign in.";
  }
  if (!/^https?:\/\//i.test(url)) {
    return `"${url}" is not a web address. It should start with https:// — for example https://amrss-api.example.org.`;
  }
  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(url)) {
    return (
      `"${url}" is this computer, not the surveillance server. Enter the address your ` +
      `regional administrator gave you — for example https://amrss-api.example.org.`
    );
  }
  if (looksLikeDashboardAddress(apiUrl)) {
    return (
      `"${apiUrl.trim()}" is the AMRSS dashboard you open in a browser, not the API the ` +
      `uploader submits to. They are two different services. The API address usually ends ` +
      `in .onrender.com — your regional Data Steward has it, and it is the AMRSS_API_URL ` +
      `setting on the dashboard's own deployment.`
    );
  }
  return null;
}

/** The message for an address that answers but has no AMRSS API behind it —
 * the dashboard, a company home page, a proxy. Distinguished from a wrong
 * password, which is the user's problem to fix, and from an unreachable server,
 * which is nobody's. */
export function noApiHereMessage(apiUrl: string, status: number): string {
  const base = `${normaliseApiUrl(apiUrl)} answered ${status}, but there is no AMRSS API there.`;
  if (looksLikeDashboardAddress(apiUrl)) {
    return (
      `${base} That address is the dashboard you open in a browser; the uploader needs the ` +
      `API address, which is a different service and usually ends in .onrender.com.`
    );
  }
  return (
    `${base} Check the address with your regional Data Steward — it is the same one the ` +
    `dashboard is configured with as AMRSS_API_URL.`
  );
}

export interface FetchOptions {
  timeoutMs?: number;
}

/** Every network call the uploader makes goes through here, so a laboratory on
 * a slow link waits a stated amount of time and then gets a stated answer. */
export async function apiFetch(
  apiUrl: string,
  path: string,
  init: RequestInit = {},
  options: FetchOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    return await fetch(`${normaliseApiUrl(apiUrl)}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export class CredentialStore {
  private readonly path: string;

  constructor(private readonly directory: string) {
    this.path = join(directory, "credentials.json");
  }

  read(): CredentialRecord | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as CredentialRecord;
    } catch {
      // A corrupt cache must not lock a laboratory out of its own software; it
      // simply means the next sign-in has to happen online.
      return null;
    }
  }

  write(record: CredentialRecord): void {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.path, JSON.stringify(record, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* filesystems without POSIX permissions (some Windows volumes) */
    }
  }

  clear(): void {
    if (existsSync(this.path)) writeFileSync(this.path, "null", { mode: 0o600 });
  }
}

export function makeVerifier(password: string): { kdfSalt: string; verifier: string } {
  const salt = randomBytes(16);
  return {
    kdfSalt: salt.toString("hex"),
    verifier: scryptSync(password, salt, KEY_LENGTH, KDF_COST).toString("hex"),
  };
}

export function verifyPassword(password: string, record: CredentialRecord): boolean {
  const expected = Buffer.from(record.verifier, "hex");
  const actual = scryptSync(password, Buffer.from(record.kdfSalt, "hex"), KEY_LENGTH, KDF_COST);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function daysSince(iso: string, now: Date = new Date()): number {
  return (now.getTime() - new Date(iso).getTime()) / 86_400_000;
}

function toProfile(body: Record<string, unknown>): Profile {
  return {
    email: String(body.email ?? ""),
    username: (body.username as string | null) ?? null,
    fullName: String(body.full_name ?? body.email ?? "AMRSS user"),
    role: String(body.role ?? "laboratory_staff"),
    facilityId: (body.facility_id as string | null) ?? null,
    regionalBlockId: (body.regional_block_id as string | null) ?? null,
    permissions: Array.isArray(body.permissions) ? (body.permissions as string[]) : [],
    mustChangePassword: Boolean(body.must_change_password),
  };
}

/**
 * The signed-in state of the application.
 *
 * Tokens live here and nowhere else: in memory, in the main process, for the
 * length of the session. They are never written to disk and never handed to the
 * renderer, so neither a stolen state file nor a compromised renderer yields a
 * usable credential. The password is held for the same reason and the same
 * duration — it is what lets an offline session upgrade itself the moment the
 * link comes back, without asking someone to type it again.
 */
export class SessionManager {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private password: string | null = null;
  private session: Session | null = null;

  constructor(private readonly credentials: CredentialStore) {}

  get current(): Session | null {
    return this.session;
  }

  get isOnline(): boolean {
    return this.session?.mode === "online";
  }

  get token(): string | null {
    return this.accessToken;
  }

  signOut(): void {
    this.accessToken = null;
    this.refreshToken = null;
    this.password = null;
    this.session = null;
  }

  async signIn(
    apiUrl: string,
    identifier: string,
    password: string,
    options: { offlineGraceDays: number } = { offlineGraceDays: 30 },
  ): Promise<SignInOutcome> {
    const problem = apiUrlProblem(apiUrl);
    const cached = this.credentials.read();

    if (problem) {
      // Without a usable address there is no online path at all. An installation
      // that has signed in before can still work offline; a fresh one cannot,
      // and the message says which of the two this is.
      return cached
        ? this.signInOffline(identifier, password, cached, options.offlineGraceDays, problem)
        : { ok: false, code: "no_api_url", message: problem };
    }

    let response: Response;
    try {
      response = await apiFetch(apiUrl, "/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The API reads this key as an identifier and matches it against either
        // an email address or a username, so one box accepts both.
        body: JSON.stringify({ identifier, password }),
      });
    } catch (error) {
      const reason =
        (error as Error).name === "AbortError"
          ? `The server at ${normaliseApiUrl(apiUrl)} did not answer in time.`
          : `The server at ${normaliseApiUrl(apiUrl)} could not be reached.`;
      return cached
        ? this.signInOffline(identifier, password, cached, options.offlineGraceDays, reason)
        : {
            ok: false,
            code: "offline_no_cache",
            message:
              `${reason} This computer has not signed in successfully before, so there is no ` +
              `offline record to check your password against. Connect to the internet and sign in once.`,
          };
    }

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (response.status === 423) {
      return {
        ok: false,
        code: "locked",
        message:
          (body.detail as string) ??
          "This account is temporarily locked after repeated failed attempts. Try again in 15 minutes.",
      };
    }
    if (response.status === 401) {
      return {
        ok: false,
        code: "bad_credentials",
        message: (body.detail as string) ?? "That username or password was not accepted.",
      };
    }
    // A 404 or 405 here is not a server fault: the address is pointing at
    // something that is not this API. Saying "the server answered 404" sends a
    // laboratory to check its password; naming the likely cause sends them to
    // the one field that is actually wrong.
    if (response.status === 404 || response.status === 405) {
      return {
        ok: false,
        code: "no_api_here",
        message: noApiHereMessage(apiUrl, response.status),
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        code: "server_error",
        message:
          (body.detail as string) ??
          `The server answered ${response.status}. Try again, or contact your regional Data Steward.`,
      };
    }

    this.accessToken = String(body.access_token ?? "");
    this.refreshToken = (body.refresh_token as string | null) ?? null;
    this.password = password;

    const profile = await this.fetchProfile(apiUrl);
    if (!profile) {
      return {
        ok: false,
        code: "server_error",
        message: "Signed in, but the server did not return your profile. Try again.",
      };
    }

    const verifier = makeVerifier(password);
    this.credentials.write({
      identifier: identifier.trim().toLowerCase(),
      kdfSalt: verifier.kdfSalt,
      verifier: verifier.verifier,
      profile,
      lastOnlineAt: new Date().toISOString(),
      apiUrl: normaliseApiUrl(apiUrl),
    });

    this.session = {
      profile,
      identifier: identifier.trim(),
      mode: "online",
      signedInAt: new Date().toISOString(),
      offlineDaysRemaining: null,
    };

    return { ok: true, session: this.session, message: `Signed in as ${profile.fullName}.` };
  }

  private signInOffline(
    identifier: string,
    password: string,
    cached: CredentialRecord,
    graceDays: number,
    reason: string,
  ): SignInOutcome {
    if (cached.identifier !== identifier.trim().toLowerCase()) {
      return {
        ok: false,
        code: "offline_no_cache",
        message:
          `${reason} Only ${cached.identifier} can sign in on this computer while it is ` +
          `offline — that is the account that last signed in online here.`,
      };
    }

    if (!verifyPassword(password, cached)) {
      return {
        ok: false,
        code: "offline_wrong_password",
        message: `${reason} The password does not match the one last used on this computer.`,
      };
    }

    const elapsed = daysSince(cached.lastOnlineAt);
    if (elapsed > graceDays) {
      return {
        ok: false,
        code: "offline_expired",
        message:
          `${reason} This computer last reached the server ${Math.floor(elapsed)} days ago, and ` +
          `offline sign-in is limited to ${graceDays} days. Connect to the internet and sign in ` +
          `once to continue working offline.`,
      };
    }

    this.password = password;
    this.session = {
      profile: cached.profile,
      identifier: cached.identifier,
      mode: "offline",
      signedInAt: new Date().toISOString(),
      offlineDaysRemaining: Math.max(0, Math.floor(graceDays - elapsed)),
    };

    return {
      ok: true,
      session: this.session,
      message:
        `${reason} You are signed in offline as ${cached.profile.fullName}. Everything on this ` +
        `computer works; uploading resumes when the connection does.`,
    };
  }

  /**
   * Promote an offline session once the link returns.
   *
   * Called by the connectivity monitor, not by a person. The password is already
   * in memory from the offline sign-in, so this is silent when it succeeds and
   * leaves the offline session untouched when it does not.
   */
  async upgradeIfPossible(apiUrl: string): Promise<boolean> {
    if (!this.session || this.session.mode === "online" || !this.password) return false;
    const outcome = await this.signIn(apiUrl, this.session.identifier, this.password);
    return outcome.ok && outcome.session.mode === "online";
  }

  private async fetchProfile(apiUrl: string): Promise<Profile | null> {
    if (!this.accessToken) return null;
    try {
      const response = await apiFetch(apiUrl, "/api/v1/auth/me", {
        headers: { authorization: `Bearer ${this.accessToken}` },
      });
      if (!response.ok) return null;
      return toProfile((await response.json()) as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  /** Re-mint the access token from the refresh token. Called when a request
   * comes back 401 mid-session rather than on a timer. */
  async refresh(apiUrl: string): Promise<boolean> {
    if (!this.refreshToken) return false;
    try {
      const response = await apiFetch(apiUrl, "/api/v1/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: this.refreshToken }),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as Record<string, unknown>;
      this.accessToken = String(body.access_token ?? "");
      this.refreshToken = (body.refresh_token as string | null) ?? this.refreshToken;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A one-hop code that opens the web console as this same person.
   *
   * The laboratory works in two places on one machine, and asking for the same
   * password twice teaches people to type it into whatever asks. The code is
   * valid for ninety seconds and is exchanged by the console itself.
   */
  async webConsoleUrl(apiUrl: string, webUrl: string): Promise<string | null> {
    if (!this.accessToken || !webUrl.trim()) return null;
    try {
      const response = await apiFetch(apiUrl, "/api/v1/auth/handoff", {
        method: "POST",
        headers: { authorization: `Bearer ${this.accessToken}` },
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { code?: string };
      if (!body.code) return null;
      const base = webUrl.trim().replace(/\/+$/, "");
      return `${base}/console/signin/handoff?code=${encodeURIComponent(body.code)}`;
    } catch {
      return null;
    }
  }
}

/** A liveness probe for the status indicator. Cheap, unauthenticated, and
 * deliberately not the login endpoint: a failed probe must mean "the network or
 * the server is down", never "your password is wrong". */
export async function probeConnectivity(
  apiUrl: string,
  timeoutMs = 8_000,
): Promise<{ online: boolean; latencyMs: number | null; detail: string }> {
  if (apiUrlProblem(apiUrl)) {
    return { online: false, latencyMs: null, detail: "No server address configured." };
  }
  const started = Date.now();
  try {
    const response = await apiFetch(apiUrl, "/health", { method: "GET" }, { timeoutMs });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        online: false,
        latencyMs,
        detail: `The server answered ${response.status}.`,
      };
    }
    return { online: true, latencyMs, detail: "Connected to the surveillance platform." };
  } catch (error) {
    return {
      online: false,
      latencyMs: null,
      detail:
        (error as Error).name === "AbortError"
          ? "The server did not answer in time."
          : "No connection to the surveillance platform.",
    };
  }
}
