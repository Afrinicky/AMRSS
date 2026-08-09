import { ClinicalFraming, FreshnessBanner } from "@/components/context-panels";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Alerts and signals" };

/**
 * Structurally separated from the antibiogram (SDD 5.2, 5.4).
 *
 * Everything on this page is below the reporting threshold or based on a
 * windowed comparison. Keeping it on its own page, with its own framing, is what
 * stops a small-number observation drifting into a table that implies it was
 * statistically qualified.
 */
export default async function AlertsPage() {
  const profile = await requireProfile();
  const alerts = await api.alerts();

  return (
    <Shell profile={profile} current="/alerts">
      <PageHeading
        title="Alerts and emerging signals"
        description={alerts.note}
        aside={
          <>
            <BannerFigure
              label="Emerging signals"
              value={alerts.emerging_signals.length}
              detail="Require expert review"
            />
            <BannerFigure
              label="Below threshold"
              value={alerts.below_threshold_alerts.length}
              detail="Watched organisms"
            />
          </>
        }
      />

      <div className="space-y-6">
        <FreshnessBanner freshness={alerts.freshness} />

        <section aria-labelledby="signals-heading">
          <h2 id="signals-heading" className="heading-rule mb-1 text-lg font-semibold text-ink">
            Emerging resistance signals
          </h2>
          <p className="mb-4 max-w-3xl text-sm text-ink-muted">
            A signal is raised when susceptibility falls by a defined margin between two
            non-overlapping time windows, each of which independently met the minimum isolate
            count. AMRSS does not determine outbreaks — that judgment belongs to laboratory and
            public-health review.
          </p>

          {alerts.emerging_signals.length === 0 ? (
            <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-6 text-center text-sm text-ink-muted">
              No organism–agent combination currently meets the signal threshold.
            </p>
          ) : (
            <ul className="space-y-3">
              {alerts.emerging_signals.map((signal) => (
                <li
                  key={`${signal.organism.id}-${signal.antibiotic.id}`}
                  className="rounded-[--radius-card] border border-sir-r/30 bg-surface p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-medium text-ink">
                      <em>{signal.organism.name}</em> — {signal.antibiotic.name}
                    </h3>
                    <span className="rounded-full bg-sir-r/10 px-2.5 py-0.5 text-xs font-medium text-sir-r">
                      {signal.status_label}
                    </span>
                  </div>

                  <dl className="tabular mt-3 grid gap-4 sm:grid-cols-3">
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-ink-muted">
                        Baseline window
                      </dt>
                      <dd className="mt-0.5 text-ink">
                        {signal.baseline_susceptible_percent.toFixed(0)}% susceptible
                        <span className="block text-xs text-ink-muted">
                          n = {signal.baseline_n} · {signal.baseline_start} to{" "}
                          {signal.baseline_end}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-ink-muted">
                        Current window
                      </dt>
                      <dd className="mt-0.5 text-ink">
                        {signal.current_susceptible_percent.toFixed(0)}% susceptible
                        <span className="block text-xs text-ink-muted">
                          n = {signal.current_n} · {signal.current_start} to {signal.current_end}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-ink-muted">Change</dt>
                      <dd className="mt-0.5 font-semibold text-sir-r">
                        {signal.change_percentage_points.toFixed(1)} percentage points
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="below-threshold-heading">
          <h2 id="below-threshold-heading" className="heading-rule mb-1 text-lg font-semibold text-ink">
            Organisms of special importance below the reporting threshold
          </h2>
          <p className="mb-4 max-w-3xl text-sm text-ink-muted">
            Non-susceptible results in watched organisms, shown even where there are too few
            isolates to report a rate. These are detections for situational awareness, not
            susceptibility percentages.
          </p>

          {alerts.below_threshold_alerts.length === 0 ? (
            <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-6 text-center text-sm text-ink-muted">
              No below-threshold detections in watched organisms for this period.
            </p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {alerts.below_threshold_alerts.map((alert) => (
                <li
                  key={`${alert.organism.id}-${alert.antibiotic.id}`}
                  className="rounded-[--radius-card] border border-sir-i/30 bg-surface p-4"
                >
                  <h3 className="font-medium text-ink">
                    <em>{alert.organism.name}</em> — {alert.antibiotic.name}
                  </h3>
                  <p className="tabular mt-1.5 text-sm text-ink">
                    {alert.non_susceptible_count} non-susceptible of {alert.isolates} isolate
                    {alert.isolates === 1 ? "" : "s"}
                  </p>
                  <p className="tabular mt-1 text-xs text-ink-muted">
                    {alert.facility_count} facility
                    {alert.facility_count === 1 ? "" : "ies"} · first seen {alert.first_seen} ·
                    last seen {alert.last_seen}
                  </p>
                  <p className="mt-2 border-t border-line pt-2 text-xs text-ink-muted">
                    {alert.caveat}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <ClinicalFraming text="Susceptibility data reflect regional surveillance patterns and support clinical decision-making; they do not replace individualized clinical judgment." />
      </div>
    </Shell>
  );
}
