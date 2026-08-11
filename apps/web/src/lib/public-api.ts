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

/** One hour. The figures change only when a laboratory uploads, and every page
 *  states the true data date in its freshness banner, so an hour of edge-cache
 *  staleness is invisible and buys instant loads. */
export const PUBLIC_REVALIDATE_SECONDS = 3600;

function publicApiUrl(): string {
  return process.env.AMRSS_API_URL ?? "http://localhost:8000";
}

async function publicGet<T>(path: string): Promise<T> {
  const response = await fetch(`${publicApiUrl()}/api/v1/public${path}`, {
    next: { revalidate: PUBLIC_REVALIDATE_SECONDS },
    headers: { "content-type": "application/json" },
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

export const publicApi = {
  antibiogram: () => publicGet<Antibiogram>("/antibiogram"),
  organisms: () => publicGet<OrganismExplorer>("/organisms"),
  antibiotics: () => publicGet<AntibioticExplorer>("/antibiotics"),
  specimens: () => publicGet<SpecimenExplorer>("/specimens"),
  reference: () => publicGet<Reference>("/reference"),
  trend: (params: Record<string, string | undefined>) =>
    publicGet<Trend>(`/trend${queryString(params)}`),
};
