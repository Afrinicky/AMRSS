import { ClinicalFraming, FreshnessBanner, formatPeriod } from "@/components/context-panels";
import { FigureDownload } from "@/components/figure-download";
import { OrganismSiteChart } from "@/components/figures";
import { PublicShell } from "@/components/public-shell";
import { PublicUnavailable } from "@/components/public-unavailable";
import { publicApi } from "@/lib/public-api";

export const revalidate = 600; // 10 min; see PUBLIC_REVALIDATE_SECONDS
export const metadata = { title: "Organisms" };

const KINGDOM_HEADING = { bacteria: "Bacteria", fungi: "Fungi" } as const;

export default async function PublicOrganismsPage() {
  let explorer;
  try {
    explorer = await publicApi.organisms();
  } catch {
    return <PublicUnavailable current="/organisms" />;
  }
  const period = formatPeriod(explorer.freshness);
  const kingdoms = ["bacteria", "fungi"] as const;
  const scaleMax = Math.max(
    1,
    ...explorer.organisms.flatMap((organism) => organism.sites.map((site) => site.isolate_count)),
  );

  return (
    <PublicShell current="/organisms">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Organisms</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Which organisms were isolated across the region, and the sites of infection they came
            from.
          </p>
        </div>

        <FreshnessBanner freshness={explorer.freshness} />

        {kingdoms.map((kingdom) => {
          const rows = explorer.organisms.filter(
            (organism) => organism.organism_kingdom === kingdom,
          );
          if (rows.length === 0) return null;
          return (
            <section key={kingdom} aria-labelledby={`${kingdom}-heading`}>
              <h2
                id={`${kingdom}-heading`}
                className="heading-rule mb-3 text-lg font-semibold text-ink"
              >
                {KINGDOM_HEADING[kingdom]}
              </h2>
              <FigureDownload
                title={`Organisms by infection site — ${KINGDOM_HEADING[kingdom]}`}
                period={period}
                allowExcel={false}
                data={{
                  columns: [
                    "Organism",
                    "Infection site",
                    "Isolates (n)",
                    "% of organism",
                    "Organism total (n)",
                    "% of all isolates",
                  ],
                  rows: rows.flatMap((organism) =>
                    organism.sites.map((site) => [
                      organism.organism.name,
                      site.infection_site,
                      site.isolate_count,
                      site.percent_of_organism.toFixed(1),
                      organism.isolate_count,
                      organism.percent_of_total.toFixed(1),
                    ]),
                  ),
                }}
              >
                <OrganismSiteChart
                  organisms={rows}
                  total={explorer.total_isolates}
                  scaleMax={scaleMax}
                />
              </FigureDownload>
            </section>
          );
        })}

        <ClinicalFraming text={explorer.clinical_framing} />
      </div>
    </PublicShell>
  );
}
