/**
 * The public surveillance API client.
 *
 * Everything here is the regional aggregate anyone may read, so there is no
 * cookie, no token, and — this is the point — no reason for a page built on it
 * to be rendered fresh per request. Each call is cached for an hour and the
 * pages that use it are statically generated, so they are served from the edge
 * the instant a visitor arrives and never wait on the surveillance service.
 * A background revalidation once an hour is the only thing that ever touches it,
 * and no visitor waits on that.
 *
 * The response shapes are the same the signed-in client uses — the public
 * endpoints return the identical regional aggregate — so the types are shared
 * rather than duplicated.
 */

import type {
  Antibiogram,
  AntibioticExplorer,
  OrganismExplorer,
  Reference,
  SpecimenExplorer,
  Trend,
} from "@/lib/api";

/** Ten minutes. The figures change only when a laboratory uploads, and every
 *  page states the true data date in its freshness banner, so this much
 *  edge-cache staleness is invisible — and it doubles as a self-heal: if a page
 *  was ever built while the API was unreachable and cached the "being prepared"
 *  fallback, the next visit after this window regenerates it with real data. */
export const PUBLIC_REVALIDATE_SECONDS = 600;

function publicApiUrl(): string {
  return process.env.AMRSS_API_URL ?? "http://localhost:8000";
}

async function publicGet<T>(path: string): Promise<T> {
  const url = `${publicApiUrl()}/api/v1/public${path}`;

  // Retry, because of when this runs. These pages are pre-rendered at build and
  // re-rendered on revalidation, and at either moment the free-tier API may be
  // asleep and take most of a minute to wake. A single attempt would give up on
  // a waking service and bake the fallback for a whole revalidation window; a
  // few attempts across a couple of minutes wait it out and capture real data.
  const attempts = 3;
  // Long enough that a single attempt can absorb a full cold start rather than
  // giving up just as the instance is about to answer.
  const perAttemptTimeoutMs = 55_000;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        next: { revalidate: PUBLIC_REVALIDATE_SECONDS },
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(perAttemptTimeoutMs),
      });
      if (response.ok) return (await response.json()) as T;
      lastError = new Error(`Public API ${path} responded ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 6_000 * (attempt + 1)));
    }
  }

  throw lastError;
}

function queryString(params?: Record<string, string | undefined>): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}

/** An infection site and the specimen types that feed it, from the dictionary. */
export interface InfectionSite {
  site: string;
  sterile_site: boolean;
  specimen_type_ids: string[];
}

export const publicApi = {
  antibiogram: () => publicGet<Antibiogram>("/antibiogram"),
  organisms: () => publicGet<OrganismExplorer>("/organisms"),
  antibiotics: () => publicGet<AntibioticExplorer>("/antibiotics"),
  specimens: () => publicGet<SpecimenExplorer>("/specimens"),
  reference: () => publicGet<Reference>("/reference"),
  trend: (params: Record<string, string | undefined>) =>
    publicGet<Trend>(`/trend${queryString(params)}`),
  empiricSites: () => publicGet<{ sites: InfectionSite[] }>("/empiric/sites"),
  // The empiric evidence for a site is the antibiogram over that site's
  // specimens — the same Antibiogram shape, scoped to the site.
  empiric: (site: string) => publicGet<Antibiogram>(`/empiric?site=${encodeURIComponent(site)}`),
};
