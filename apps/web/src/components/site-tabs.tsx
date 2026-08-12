import Link from "next/link";

import type { InfectionSite } from "@/lib/public-api";
import { siteSlug } from "@/lib/sites";

/** The row of infection sites, as links between the empiric pages. */
export function SiteTabs({
  sites,
  current,
  basePath = "/empiric",
}: {
  sites: InfectionSite[];
  current?: string;
  basePath?: string;
}) {
  return (
    <nav aria-label="Infection sites" className="scroll-row -mx-1 flex gap-2 overflow-x-auto px-1">
      {sites.map((entry) => {
        const active = entry.site === current;
        return (
          <Link
            key={entry.site}
            href={`${basePath}/${siteSlug(entry.site)}`}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              active
                ? "border-brand-600 bg-brand-600 text-white"
                : "border-line bg-surface text-ink-muted hover:text-ink"
            }`}
          >
            {entry.site}
          </Link>
        );
      })}
    </nav>
  );
}
