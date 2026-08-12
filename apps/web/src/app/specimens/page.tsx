import { ClinicalFraming, FreshnessBanner, formatPeriod } from "@/components/context-panels";
import { FigureDownload } from "@/components/figure-download";
import { SpecimenDistributionChart } from "@/components/figures";
import { PublicShell } from "@/components/public-shell";
import { PublicUnavailable } from "@/components/public-unavailable";
import { publicApi } from "@/lib/public-api";

export const revalidate = 600; // 10 min; see PUBLIC_REVALIDATE_SECONDS
// Raise the per-invocation limit from the Hobby default (10s) so a runtime
// ISR revalidation has room to wait out a cold start or a heavy antibiogram
// computing on the free tier, rather than timing out and baking the fallback.
export const maxDuration = 60;
export const metadata = { title: "Specimens" };

export default async function PublicSpecimensPage() {
  let explorer;
  try {
    explorer = await publicApi.specimens();
  } catch {
    return <PublicUnavailable current="/specimens" />;
  }
  const period = formatPeriod(explorer.freshness);

  return (
    <PublicShell current="/specimens">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Specimens</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Which specimen types yielded the isolates. A picture drawn largely from urine describes
            a different clinical setting than one drawn from blood.
          </p>
        </div>

        <FreshnessBanner freshness={explorer.freshness} />

        <FigureDownload
          title="Specimen distribution"
          period={period}
          allowExcel={false}
          data={{
            columns: [
              "Specimen type",
              "Infection site",
              "Sterile site",
              "Isolates (n)",
              "% of total",
            ],
            rows: explorer.specimens.map((specimen) => [
              specimen.specimen_type.name,
              specimen.infection_site,
              specimen.sterile_site ? "yes" : "no",
              specimen.isolate_count,
              specimen.percent_of_total.toFixed(1),
            ]),
          }}
        >
          <SpecimenDistributionChart
            specimens={explorer.specimens}
            total={explorer.total_isolates}
          />
        </FigureDownload>

        <ClinicalFraming text={explorer.clinical_framing} />
      </div>
    </PublicShell>
  );
}
