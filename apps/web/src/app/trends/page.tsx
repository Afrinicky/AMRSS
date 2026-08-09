import { ClinicalFraming, FreshnessBanner } from "@/components/context-panels";
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
    organism_id?: string;
    antibiotic_id?: string;
    bucket?: string;
    care_setting?: string;
    date_from?: string;
    date_to?: string;
  }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;

  const reference = await api.reference();
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

        <form className="grid grid-cols-1 items-end gap-3 rounded-[--radius-card] border border-line bg-surface p-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Organism" id="organism_id">
            <select
              id="organism_id"
              name="organism_id"
              defaultValue={organismId}
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              {organisms.map((organism) => (
                <option key={organism.id} value={organism.id}>
                  {organism.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Antimicrobial agent" id="antibiotic_id">
            <select
              id="antibiotic_id"
              name="antibiotic_id"
              defaultValue={antibioticId}
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              {antibiotics.map((antibiotic) => (
                <option key={antibiotic.id} value={antibiotic.id}>
                  {antibiotic.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Period" id="bucket">
            <select
              id="bucket"
              name="bucket"
              defaultValue={bucket}
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              {BUCKETS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Care setting" id="care_setting">
            <select
              id="care_setting"
              name="care_setting"
              defaultValue={params.care_setting ?? ""}
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="">All settings</option>
              <option value="IPD">Inpatient</option>
              <option value="OPD">Outpatient</option>
            </select>
          </Field>

          <button
            type="submit"
            className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 sm:w-auto"
          >
            Show trend
          </button>
        </form>

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
              <TrendChart
                points={trend.points}
                minimumIsolates={trend.minimum_isolates}
                organism={trend.organism.name}
                antibiotic={trend.antibiotic.name}
              />
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

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label
        htmlFor={id}
        className="block text-xs font-medium uppercase tracking-wide text-ink-muted"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
