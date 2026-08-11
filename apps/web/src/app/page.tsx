import Link from "next/link";

import { ClinicalFraming, FreshnessBanner, formatPeriod } from "@/components/context-panels";
import { FigureDownload } from "@/components/figure-download";
import { AntibioticProfileChart } from "@/components/figures";
import { PublicShell } from "@/components/public-shell";
import { PublicUnavailable } from "@/components/public-unavailable";
import { publicApi } from "@/lib/public-api";

export const revalidate = 600; // 10 min; see PUBLIC_REVALIDATE_SECONDS

export const metadata = {
  title: "Regional antimicrobial resistance",
  description:
    "The public regional antimicrobial resistance picture — which organisms are being isolated and which agents still work against them.",
};

/**
 * The public front door.
 *
 * Statically generated and served from the edge, so it opens instantly for
 * anyone, whatever state the surveillance service is in — the whole reason the
 * public dashboard is split from the signed-in console. It shows the regional
 * aggregate and nothing finer, and points the people who do more than read
 * towards a login.
 */
export default async function PublicOverviewPage() {
  let antibiogram, antibiotics;
  try {
    [antibiogram, antibiotics] = await Promise.all([
      publicApi.antibiogram(),
      publicApi.antibiotics(),
    ]);
  } catch {
    return <PublicUnavailable current="/" />;
  }

  const period = formatPeriod(antibiogram.freshness);
  const topOrganisms = antibiogram.rows.slice(0, 6);
  const antibioticName = new Map(antibiogram.antibiotics.map((a) => [a.id, a.name]));

  return (
    <PublicShell current="/">
      <div className="space-y-6">
        <section className="brand-gradient brand-edge-bottom culture-field overflow-hidden rounded-[--radius-card]">
          <div className="px-4 py-8 sm:px-8">
            <h1 className="max-w-3xl text-2xl font-semibold tracking-tight text-on-brand sm:text-3xl">
              Regional antimicrobial resistance
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-on-brand-muted">
              Which organisms are being isolated across contributing laboratories, and which
              antimicrobials still work against them. Updated as laboratories report.
            </p>
            <dl className="mt-6 flex flex-wrap gap-x-10 gap-y-4">
              <HeroFigure
                label="Isolates in period"
                value={antibiogram.raw_isolate_count.toLocaleString()}
                detail={`${antibiogram.antibiogram_eligible_count.toLocaleString()} antibiogram-eligible`}
              />
              <HeroFigure
                label="Organisms reported"
                value={String(antibiogram.rows.length)}
                detail={`${antibiogram.antibiotics.length} agents`}
              />
              <HeroFigure
                label="Contributing laboratories"
                value={String(antibiogram.freshness.facilities_contributing)}
                detail={`of ${antibiogram.freshness.facilities_expected} expected`}
              />
              <HeroFigure
                label="Reporting threshold"
                value={`n ≥ ${antibiogram.minimum_isolates}`}
                detail="before a combination is reported"
              />
            </dl>
          </div>
        </section>

        <FreshnessBanner freshness={antibiogram.freshness} />

        <section aria-labelledby="agents-heading">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="agents-heading" className="heading-rule text-lg font-semibold text-ink">
              Susceptibility by antimicrobial agent
            </h2>
            <Link href="/antibiotics" className="text-sm font-medium text-brand-700">
              Explore agents →
            </Link>
          </div>
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
              ],
              rows: antibiotics.profiles.map((entry) => [
                entry.antibiotic.name,
                entry.susceptible_percent.toFixed(1),
                entry.intermediate_percent.toFixed(1),
                entry.resistant_percent.toFixed(1),
                entry.interpretable,
              ]),
            }}
          >
            <AntibioticProfileChart profiles={antibiotics.profiles} period={period} />
          </FigureDownload>
        </section>

        <section aria-labelledby="organisms-heading">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="organisms-heading" className="heading-rule text-lg font-semibold text-ink">
              Most frequently isolated organisms
            </h2>
            <Link href="/antibiogram" className="text-sm font-medium text-brand-700">
              Full antibiogram →
            </Link>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {topOrganisms.map((row) => {
              const reportable = row.cells.filter((cell) => cell.state === "reportable");
              const excerpt = reportable.slice(0, 4);
              return (
                <article
                  key={row.organism.id}
                  className="min-w-0 rounded-[--radius-card] border border-line bg-surface p-4"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="font-medium italic text-ink">{row.organism.name}</h3>
                    <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-ink-muted">
                      {row.organism_kingdom === "fungi" ? "Fungal" : "Bacterial"}
                    </span>
                  </div>
                  <p className="tabular mt-1 text-xs text-ink-muted">
                    {row.isolate_count.toLocaleString()} antibiogram-eligible isolates
                  </p>
                  {excerpt.length > 0 ? (
                    <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
                      {excerpt.map((cell) => (
                        <li key={cell.antibiotic_id} className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs text-ink">
                            {antibioticName.get(cell.antibiotic_id)}
                          </span>
                          <SusceptibilityBar percent={cell.susceptible_percent ?? 0} />
                          <span className="tabular w-16 text-right text-xs text-ink">
                            {(cell.susceptible_percent ?? 0).toFixed(0)}%
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 border-t border-line pt-3 text-xs text-ink-muted">
                      No combination reaches the reporting threshold in this period.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <ClinicalFraming text={antibiogram.clinical_framing} />
      </div>
    </PublicShell>
  );
}

function HeroFigure({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div>
      <dt className="accent-text text-xs font-medium uppercase tracking-wide">{label}</dt>
      <dd className="tabular mt-0.5 text-2xl font-semibold text-on-brand">{value}</dd>
      <dd className="text-xs text-on-brand-muted">{detail}</dd>
    </div>
  );
}

function SusceptibilityBar({ percent }: { percent: number }) {
  const tone =
    percent >= 70
      ? "var(--color-sir-s)"
      : percent >= 50
        ? "var(--color-sir-i)"
        : "var(--color-sir-r)";
  return (
    <span aria-hidden className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-surface-muted">
      <span
        className="block h-full rounded-full"
        style={{ width: `${Math.max(2, percent)}%`, backgroundColor: tone }}
      />
    </span>
  );
}
