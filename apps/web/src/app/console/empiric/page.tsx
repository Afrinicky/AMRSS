import Link from "next/link";

import { PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";
import { siteSlug } from "@/lib/sites";

export const metadata = { title: "Empiric guidance" };

export default async function ConsoleEmpiricIndex() {
  const [profile, sitesResponse] = await Promise.all([requireProfile(), api.empiricSites()]);
  const sites = sitesResponse.sites;

  return (
    <Shell profile={profile} current="/console/empiric">
      <PageHeading
        title="Empiric guidance by infection site"
        description="Which antimicrobials the data shows are most active against the organisms commonly isolated from a given site — to inform empiric therapy before a culture result."
      />

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sites.map((entry) => (
          <Link
            key={entry.site}
            href={`/console/empiric/${siteSlug(entry.site)}`}
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
    </Shell>
  );
}
