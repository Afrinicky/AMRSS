import { notFound } from "next/navigation";

import { FreshnessBanner, formatPeriod } from "@/components/context-panels";
import { EmpiricGuidance } from "@/components/empiric-guidance";
import { PublicShell } from "@/components/public-shell";
import { PublicUnavailable } from "@/components/public-unavailable";
import { SiteTabs } from "@/components/site-tabs";
import type { InfectionSite } from "@/lib/public-api";
import { publicApi } from "@/lib/public-api";
import { siteSlug } from "@/lib/sites";

export const revalidate = 600; // 10 min; see PUBLIC_REVALIDATE_SECONDS
// Raise the per-invocation limit from the Hobby default (10s) so a runtime
// ISR revalidation has room to wait out a cold start or a heavy antibiogram
// computing on the free tier, rather than timing out and baking the fallback.
export const maxDuration = 60;

// Pre-build one page per infection site, so each opens instantly from the edge.
export async function generateStaticParams() {
  try {
    const { sites } = await publicApi.empiricSites();
    return sites.map((entry) => ({ site: siteSlug(entry.site) }));
  } catch {
    // The API being unreachable at build must not fail the build; the pages are
    // generated on demand instead, and the fetch below still guards itself.
    return [];
  }
}

export async function generateMetadata({ params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  const match = await siteFor(site);
  return { title: match ? `Empiric guidance — ${match.site}` : "Empiric guidance" };
}

async function siteFor(slug: string): Promise<InfectionSite | null> {
  const { sites } = await publicApi.empiricSites();
  return sites.find((entry) => siteSlug(entry.site) === slug) ?? null;
}

export default async function EmpiricSitePage({
  params,
}: {
  params: Promise<{ site: string }>;
}) {
  const { site: slug } = await params;

  let sites: InfectionSite[];
  let match: InfectionSite | undefined;
  try {
    sites = (await publicApi.empiricSites()).sites;
    match = sites.find((entry) => siteSlug(entry.site) === slug);
  } catch {
    return <PublicUnavailable current="/empiric" />;
  }
  if (!match) notFound();

  let empiric;
  try {
    empiric = await publicApi.empiric(match.site);
  } catch {
    return <PublicUnavailable current="/empiric" />;
  }

  const antibiogram = empiric.antibiogram;
  const period = formatPeriod(antibiogram.freshness);

  return (
    <PublicShell current="/empiric">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight capitalize text-ink">
            {match.site}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Organisms commonly isolated from {match.site} in the region, and how susceptible they
            were — agents ranked by likelihood of activity to inform an empiric choice.
          </p>
        </div>

        <SiteTabs sites={sites} current={match.site} />

        <FreshnessBanner freshness={antibiogram.freshness} />

        <EmpiricGuidance
          empiric={empiric}
          siteLabel={match.site}
          sterileSite={match.sterile_site}
          period={period}
        />
      </div>
    </PublicShell>
  );
}
