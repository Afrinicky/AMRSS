import Link from "next/link";

import { PublicShell } from "@/components/public-shell";
import { PublicUnavailable } from "@/components/public-unavailable";
import { publicApi } from "@/lib/public-api";
import { siteSlug } from "@/lib/sites";

export const revalidate = 600; // 10 min; see PUBLIC_REVALIDATE_SECONDS
// Raise the per-invocation limit from the Hobby default (10s) so a runtime
// ISR revalidation has room to wait out a cold start or a heavy antibiogram
// computing on the free tier, rather than timing out and baking the fallback.
export const maxDuration = 60;
export const metadata = {
  title: "Empiric guidance by infection site",
  description:
    "For a given site of infection, which antimicrobials the regional data shows are most active against the organisms commonly isolated there — to inform empiric therapy before a culture result.",
};

export default async function EmpiricIndexPage() {
  let sites;
  try {
    sites = (await publicApi.empiricSites()).sites;
  } catch {
    return <PublicUnavailable current="/empiric" />;
  }

  return (
    <PublicShell current="/empiric">
      <div className="space-y-6">
        <section className="brand-gradient brand-edge-bottom culture-field overflow-hidden rounded-[--radius-card]">
          <div className="px-4 py-8 sm:px-8">
            <h1 className="max-w-3xl text-2xl font-semibold tracking-tight text-on-brand sm:text-3xl">
              Empiric guidance by infection site
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-on-brand-muted">
              Before a culture result is back, which antimicrobials does the regional data show are
              most active against the organisms commonly isolated from a given site? Choose a site
              to see the evidence — to weigh alongside local guidelines and stewardship advice.
            </p>
          </div>
        </section>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sites.map((entry) => (
            <Link
              key={entry.site}
              href={`/empiric/${siteSlug(entry.site)}`}
              className="group rounded-[--radius-card] border border-line bg-surface p-4 transition-colors hover:border-brand-600"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium capitalize text-ink group-hover:text-brand-700">
                  {entry.site}
                </span>
                <span aria-hidden className="text-brand-600">
                  →
                </span>
              </div>
              {entry.sterile_site ? (
                <span className="mt-1 inline-block rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-ink-muted">
                  Normally sterile site
                </span>
              ) : null}
            </Link>
          ))}
        </div>

        <p className="text-xs text-ink-muted">
          These pages present regional surveillance evidence to inform empiric therapy. They are not
          a prescription and do not account for the individual patient; where a culture and
          sensitivity result exists, it takes precedence.
        </p>
      </div>
    </PublicShell>
  );
}
