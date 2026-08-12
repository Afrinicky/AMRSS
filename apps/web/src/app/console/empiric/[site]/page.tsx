import { notFound } from "next/navigation";

import { FreshnessBanner, formatPeriod } from "@/components/context-panels";
import { EmpiricGuidance } from "@/components/empiric-guidance";
import { SiteTabs } from "@/components/site-tabs";
import { PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";
import { siteSlug } from "@/lib/sites";

export const metadata = { title: "Empiric guidance" };

export default async function ConsoleEmpiricSite({
  params,
}: {
  params: Promise<{ site: string }>;
}) {
  const { site: slug } = await params;
  const [profile, sitesResponse] = await Promise.all([requireProfile(), api.empiricSites()]);
  const sites = sitesResponse.sites;
  const match = sites.find((entry) => siteSlug(entry.site) === slug);
  if (!match) notFound();

  const empiric = await api.empiric({ site: match.site });
  const period = formatPeriod(empiric.antibiogram.freshness);

  return (
    <Shell profile={profile} current="/console/empiric">
      <PageHeading
        title={match.site}
        description={`Organisms commonly isolated from ${match.site}, and how susceptible they were — agents ranked by likelihood of activity to inform an empiric choice. ${period}.`}
      />

      <div className="mt-6 space-y-6">
        <SiteTabs sites={sites} current={match.site} basePath="/console/empiric" />
        <FreshnessBanner freshness={empiric.antibiogram.freshness} />
        <EmpiricGuidance
          empiric={empiric}
          siteLabel={match.site}
          sterileSite={match.sterile_site}
        />
      </div>
    </Shell>
  );
}
