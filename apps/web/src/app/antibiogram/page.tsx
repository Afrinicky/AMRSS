import { AntibiogramTable } from "@/components/antibiogram-table";
import {
  ClinicalFraming,
  FreshnessBanner,
  MethodologyDisclosure,
  formatPeriod,
} from "@/components/context-panels";
import { FigureDownload } from "@/components/figure-download";
import { PublicShell } from "@/components/public-shell";
import { PublicUnavailable } from "@/components/public-unavailable";
import { publicApi } from "@/lib/public-api";

export const revalidate = 3600; // one hour; see PUBLIC_REVALIDATE_SECONDS
export const metadata = { title: "Antibiogram" };

export default async function PublicAntibiogramPage() {
  let antibiogram;
  try {
    antibiogram = await publicApi.antibiogram();
  } catch {
    return <PublicUnavailable current="/antibiogram" />;
  }
  const period = formatPeriod(antibiogram.freshness);
  const agentName = new Map(antibiogram.antibiotics.map((a) => [a.id, a.name]));

  // The whole matrix as a downloadable table: one row per organism × agent,
  // with the percentage and its denominator, and nothing where a cell was
  // withheld — the same shape a reader would want to cite or re-tabulate.
  const csvRows = antibiogram.rows.flatMap((row) =>
    row.cells
      .filter((cell) => cell.state === "reportable")
      .map((cell) => [
        row.organism.name,
        agentName.get(cell.antibiotic_id) ?? cell.antibiotic_id,
        cell.susceptible_percent === null ? null : cell.susceptible_percent.toFixed(1),
        cell.interpretable,
      ]),
  );

  return (
    <PublicShell current="/antibiogram">
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">Antibiogram</h1>
            <p className="mt-1 max-w-2xl text-sm text-ink-muted">
              Percent susceptible by organism and agent. Combinations with fewer than{" "}
              {antibiogram.minimum_isolates} antibiogram-eligible isolates are not reported as a
              percentage.
            </p>
          </div>
        </div>

        <FreshnessBanner freshness={antibiogram.freshness} />

        <div className="flex justify-end">
          <FigureDownload
            title="Regional antibiogram"
            period={period}
            allowExcel={false}
            image={false}
            data={{
              columns: ["Organism", "Antimicrobial", "Susceptible %", "Interpretable (n)"],
              rows: csvRows,
            }}
          >
            {/* The table below is the figure; the menu offers its data. */}
            <span className="sr-only">Regional antibiogram data</span>
          </FigureDownload>
        </div>

        <AntibiogramTable antibiogram={antibiogram} period={period} />

        <MethodologyDisclosure methodology={antibiogram.methodology} />
        <ClinicalFraming text={antibiogram.clinical_framing} />
      </div>
    </PublicShell>
  );
}
