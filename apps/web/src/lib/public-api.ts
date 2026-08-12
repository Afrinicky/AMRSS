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
  EmpiricResponse,
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

  // One attempt, with a budget wide enough to absorb a slow response but capped
  // safely under the host's per-invocation limit (60s on Vercel, which every
  // public page raises to via `export const maxDuration = 60`). A single long
  // attempt beats several short ones here: the thing that makes a response slow
  // on the free tier is a cold start or a heavy antibiogram computing on a
  // fraction of a CPU, and that is one wait to sit through, not a transient blip
  // to retry past. The `prebuild` warm-up wakes the API before the build so
  // build-time fetches land warm; at runtime the heartbeat keeps it warm. If the
  // fetch still fails, the page catches and renders its unavailable state, and
  // ISR heals it on the next revalidation once the API answers again.
  const timeoutMs = 50_000;
  const response = await fetch(url, {
    next: { revalidate: PUBLIC_REVALIDATE_SECONDS },
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Public API ${path} responded ${response.status}`);
  }
  return (await response.json()) as T;
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
  // The empiric evidence for a site: organism prevalence and WISCA coverage
  // over that site's specimens, plus the per-organism antibiogram behind them.
  empiric: (site: string) =>
    publicGet<EmpiricResponse>(`/empiric?site=${encodeURIComponent(site)}`),
};
