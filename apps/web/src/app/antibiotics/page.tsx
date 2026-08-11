import { ClinicalFraming, FreshnessBanner, formatPeriod } from "@/components/context-panels";
import { FigureDownload } from "@/components/figure-download";
import { AntibioticProfileChart } from "@/components/figures";
import { PublicShell } from "@/components/public-shell";
import { PublicUnavailable } from "@/components/public-unavailable";
import { publicApi } from "@/lib/public-api";

export const revalidate = 3600; // one hour; see PUBLIC_REVALIDATE_SECONDS
export const metadata = { title: "Antibiotics" };

export default async function PublicAntibioticsPage() {
  let explorer;
  try {
    explorer = await publicApi.antibiotics();
  } catch {
    return <PublicUnavailable current="/antibiotics" />;
  }
  const period = formatPeriod(explorer.freshness);

  return (
    <PublicShell current="/antibiotics">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Antibiotics</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Overall susceptibility to each antimicrobial agent, pooled across organisms in the
            region.
          </p>
        </div>

        <FreshnessBanner freshness={explorer.freshness} />

        <p className="rounded-[--radius-card] border border-sir-i/40 bg-sir-i/5 px-4 py-2.5 text-xs text-ink">
          {explorer.pooling_caveat}
        </p>

        <FigureDownload
          title="Susceptibility by antimicrobial agent"
          period={period}
          allowExcel={false}
          data={{
            columns: [
              "Antimicrobial",
              "Susceptible %",
              "Intermediate %",
              "Resistant %",
              "Interpretable (n)",
              "Tested (n)",
              "Organisms",
            ],
            rows: explorer.profiles.map((entry) => [
              entry.antibiotic.name,
              entry.susceptible_percent.toFixed(1),
              entry.intermediate_percent.toFixed(1),
              entry.resistant_percent.toFixed(1),
              entry.interpretable,
              entry.tested,
              entry.organism_count,
            ]),
          }}
        >
          <AntibioticProfileChart profiles={explorer.profiles} period={period} />
        </FigureDownload>

        <ClinicalFraming text={explorer.clinical_framing} />
      </div>
    </PublicShell>
  );
}
