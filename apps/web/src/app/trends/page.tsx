import { ClinicalFraming, FreshnessBanner, formatPeriod } from "@/components/context-panels";
import { FigureDownload } from "@/components/figure-download";
import { Field, FilterBar, filterControlClass, scopeParams } from "@/components/filter-bar";
import { TrendChart } from "@/components/figures";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { requireProfile } from "@/lib/session";
import type { Trend } from "@/lib/api";

export const metadata = { title: "Trends" };

const BUCKETS = [
  ["month", "Monthly"],
  ["quarter", "Quarterly"],
  ["week", "Weekly"],
] as const;

/**
 * Susceptibility over time for one organism-antibiotic pair (SDD 5.7, 11.2).
 *
 * A trend is the view most likely to be over-read: three points sloping
 * downwards look like a story whether or not the movement exceeds what
 * sampling variation alone would produce. Two things guard against that here —
 * every point carries its n and its confidence interval, and periods below the
 * reporting threshold are drawn as gaps rather than interpolated over.
 *
 * The page deliberately does not label any movement as a "signal". That
 * judgement belongs to the emerging-signal engine, which applies a versioned,
 * stated trigger; eyeballing a slope is not the same thing and must not be
 * dressed up as it.
 */
export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<{
    district_id?: string;
    facility_id?: string;
    organism_id?: string;
    antibiotic_id?: string;
    bucket?: string;
    care_setting?: string;
    date_from?: string;
    date_to?: string;
  }>;
}) {
  // These three are independent of each other and of the URL, so they run
  // together. The trend query below is the one call that genuinely depends on
  // another — it needs the reference list to know which organism and agent to
  // chart when the URL names none — so it stays sequential after them.
  const params = await searchParams;
  const [profile, scope, reference] = await Promise.all([
    requireProfile(),
    api.scope(),
    api.reference(),
  ]);
  const organisms = [...reference.organisms].sort((a, b) => a.name.localeCompare(b.name));
  const antibiotics = [...reference.antibiotics].sort((a, b) => a.name.localeCompare(b.name));

  const organismId = params.organism_id ?? organisms[0]?.id;
  const antibioticId = params.antibiotic_id ?? antibiotics[0]?.id;
  const bucket = params.bucket ?? "month";

  let trend: Trend | null = null;
  let error: string | null = null;

  if (organismId && antibioticId) {
    try {
      trend = await api.trend({
        organism_id: organismId,
        antibiotic_id: antibioticId,
        bucket,
        ...scopeParams(params),
        care_setting: params.care_setting,
        date_from: params.date_from,
        date_to: params.date_to,
      });
    } catch (caught) {
      // A pairing that was never tested is an ordinary outcome of exploring, not
      // a failure. Say so plainly rather than showing an error page.
      error =
        caught instanceof ApiError
          ? caught.message
          : "The trend could not be computed for this selection.";
    }
  }

  const reportable = trend?.points.filter((point) => point.sufficient) ?? [];
  const movement =
    reportable.length >= 2
      ? (reportable[reportable.length - 1].susceptible_percent ?? 0) -
        (reportable[0].susceptible_percent ?? 0)
      : null;

  return (
    <Shell profile={profile} current="/trends">
      <PageHeading
        title="Trends"
        description="Susceptibility over time for one organism and one agent, with the isolate count behind every point."
        aside={
          <>
            <BannerFigure
              label="Periods reported"
              value={reportable.length}
              detail={`of ${trend?.points.length ?? 0} in range`}
            />
            <BannerFigure
              label="Change across range"
              value={
                movement === null
                  ? "—"
                  : `${movement > 0 ? "+" : ""}${movement.toFixed(0)} pts`
              }
              detail="First to last reported period"
            />
          </>
        }
      />

      <div className="space-y-6">
        {trend ? <FreshnessBanner freshness={trend.freshness} /> : null}

        <FilterBar
          scope={scope}
          districtId={params.district_id}
          facilityId={params.facility_id}
          careSetting={params.care_setting}
          dateFrom={params.date_from}
          dateTo={params.date_to}
          submitLabel="Show trend"
          leading={
            <>
              <Field label="Organism" htmlFor="organism_id" className="lg:w-56">
                <select
                  id="organism_id"
                  name="organism_id"
                  defaultValue={organismId}
                  className={filterControlClass}
                >
                  {organisms.map((organism) => (
                    <option key={organism.id} value={organism.id}>
                      {organism.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Antimicrobial agent" htmlFor="antibiotic_id" className="lg:w-56">
                <select
                  id="antibiotic_id"
                  name="antibiotic_id"
                  defaultValue={antibioticId}
                  className={filterControlClass}
                >
                  {antibiotics.map((antibiotic) => (
                    <option key={antibiotic.id} value={antibiotic.id}>
                      {antibiotic.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Period" htmlFor="bucket" className="lg:w-36">
                <select
                  id="bucket"
                  name="bucket"
                  defaultValue={bucket}
                  className={filterControlClass}
                >
                  {BUCKETS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          }
        />

        {/* A shorter bucket cuts each period's n and pushes buckets below the
            reporting threshold. Said before the reader concludes the data
            disappeared. */}
        {bucket === "week" ? (
          <p className="rounded-[--radius-card] border border-sir-i/40 bg-sir-i/5 px-4 py-2.5 text-xs text-ink">
            Weekly periods divide the same isolates into far smaller groups, so many weeks will
            fall below the reporting threshold and appear as gaps. A shorter period does not
            reveal more detail here — it reports less.
          </p>
        ) : null}

        {error ? (
          <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-8 text-center text-sm text-ink-muted">
            {error}
          </p>
        ) : trend ? (
          <>
            <section aria-labelledby="trend-heading">
              <h2 id="trend-heading" className="heading-rule mb-1 text-lg font-semibold text-ink">
                Susceptibility over time
              </h2>
              <p className="mb-3 max-w-3xl text-sm text-ink-muted">
                Each point is the percent susceptible for that period, with its 95% confidence
                interval. Periods with fewer than {trend.minimum_isolates} interpretable isolates
                are shown as gaps rather than joined up — a line drawn through them would assert
                a continuity the data does not support.
              </p>
              <FigureDownload
                title={`${trend.organism.name} vs ${trend.antibiotic.name} — susceptibility trend`}
                period={formatPeriod(trend.freshness)}
                data={{
                  columns: [
                    "Period",
                    "Susceptible %",
                    "95% CI lower",
                    "95% CI upper",
                    "Interpretable (n)",
                    "Meets threshold",
                  ],
                  rows: trend.points.map((point) => [
                    point.label,
                    point.susceptible_percent === null
                      ? null
                      : point.susceptible_percent.toFixed(1),
                    point.confidence_lower === null ? null : point.confidence_lower.toFixed(1),
                    point.confidence_upper === null ? null : point.confidence_upper.toFixed(1),
                    point.isolate_count,
                    point.sufficient ? "yes" : "no",
                  ]),
                }}
              >
                <TrendChart
                  points={trend.points}
                  minimumIsolates={trend.minimum_isolates}
                  organism={trend.organism.name}
                  antibiotic={trend.antibiotic.name}
                />
              </FigureDownload>
            </section>

            {movement !== null ? (
              <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
                Susceptibility moved {movement > 0 ? "up" : "down"} by{" "}
                {Math.abs(movement).toFixed(0)} percentage points between the first and last
                reported period. Whether that constitutes an emerging-resistance signal is not a
                judgement made by eye: it is decided by a versioned, stated trigger, and any
                pairing that meets it appears on the{" "}
                <a href="/alerts" className="font-medium text-brand-700">
                  alerts page
                </a>
                . Movement between two points can equally be sampling variation, which is what
                the confidence intervals are there to show.
              </p>
            ) : null}

            <ClinicalFraming text={trend.clinical_framing} />
          </>
        ) : (
          <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-8 text-center text-sm text-ink-muted">
            Choose an organism and an agent to plot.
          </p>
        )}
      </div>
    </Shell>
  );
}
