import Link from "next/link";

import {
  ClinicalFraming,
  FreshnessBanner,
  formatPeriod,
} from "@/components/context-panels";
import { PageHeading, Shell } from "@/components/shell";
import { StatTile } from "@/components/statistic";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

/**
 * The clinician-facing default view.
 *
 * Deliberately not a dense analytics wall. It answers "what are we seeing now?"
 * — the most common organisms, the agents that still work against them, and any
 * signal worth a second look — and routes into deeper exploration from there
 * (SDD 11.2).
 */
export default async function OverviewPage() {
  const profile = await requireProfile();
  const [antibiogram, alerts] = await Promise.all([api.antibiogram(), api.alerts()]);

  const period = formatPeriod(antibiogram.freshness);
  const topOrganisms = antibiogram.rows.slice(0, 6);
  const antibioticName = new Map(antibiogram.antibiotics.map((a) => [a.id, a.name]));

  return (
    <Shell profile={profile} current="/">
      <PageHeading
        title="Regional resistance overview"
        description="Current susceptibility patterns across contributing laboratories in this regional block."
      />

      <div className="space-y-6">
        <FreshnessBanner freshness={antibiogram.freshness} />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Isolates in period"
            value={antibiogram.raw_isolate_count.toLocaleString()}
            detail={`${antibiogram.antibiogram_eligible_count.toLocaleString()} eligible after first-isolate deduplication`}
          />
          <StatTile
            label="Organisms reported"
            value={antibiogram.rows.length}
            detail={`${antibiogram.rows.filter((r) => r.organism_kingdom === "fungi").length} fungal`}
          />
          <StatTile
            label="Emerging signals"
            value={alerts.emerging_signals.length}
            detail="Require expert review"
            tone={alerts.emerging_signals.length > 0 ? "attention" : "neutral"}
          />
          <StatTile
            label="Reporting threshold"
            value={`n ≥ ${antibiogram.minimum_isolates}`}
            detail="Minimum isolates before a combination is reported"
          />
        </div>

        {alerts.emerging_signals.length > 0 ? (
          <section aria-labelledby="signals-heading">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 id="signals-heading" className="text-lg font-semibold text-ink">
                Current resistance signals
              </h2>
              <Link href="/alerts" className="text-sm font-medium text-brand-700">
                View all alerts →
              </Link>
            </div>
            <ul className="space-y-3">
              {alerts.emerging_signals.slice(0, 3).map((signal) => (
                <li
                  key={`${signal.organism.id}-${signal.antibiotic.id}`}
                  className="rounded-[--radius-card] border border-sir-r/30 bg-sir-r/5 p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium text-ink">
                      <em>{signal.organism.name}</em> — {signal.antibiotic.name}
                    </p>
                    <span className="rounded-full bg-sir-r/10 px-2.5 py-0.5 text-xs font-medium text-sir-r">
                      {signal.status_label}
                    </span>
                  </div>
                  <p className="tabular mt-2 text-sm text-ink-muted">
                    Susceptibility fell from {signal.baseline_susceptible_percent.toFixed(0)}% (n=
                    {signal.baseline_n}) to {signal.current_susceptible_percent.toFixed(0)}% (n=
                    {signal.current_n}) —{" "}
                    <strong className="text-sir-r">
                      {signal.change_percentage_points.toFixed(0)} percentage points
                    </strong>
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="organisms-heading">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 id="organisms-heading" className="text-lg font-semibold text-ink">
              Most frequently isolated organisms
            </h2>
            <Link href="/antibiogram" className="text-sm font-medium text-brand-700">
              Full antibiogram →
            </Link>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {topOrganisms.map((row) => {
              // Agents are shown in the antibiogram's own dictionary order, never
              // ranked by susceptibility. Leading with "highest susceptibility"
              // would make a broad-spectrum agent the headline for most organisms
              // — a de facto prescribing prompt, which v1 must not give
              // (SDD 5.8), and one that works against stewardship.
              const reportable = row.cells.filter((cell) => cell.state === "reportable");
              const excerpt = reportable.slice(0, 4);

              return (
                <article
                  key={row.organism.id}
                  className="rounded-[--radius-card] border border-line bg-surface p-4"
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
                    <div className="mt-3 border-t border-line pt-3">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                        Percent susceptible
                      </p>
                      <ul className="mt-2 space-y-1.5">
                        {excerpt.map((cell) => (
                          <li key={cell.antibiotic_id} className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs text-ink">
                              {antibioticName.get(cell.antibiotic_id)}
                            </span>
                            <SusceptibilityBar percent={cell.susceptible_percent ?? 0} />
                            <span className="tabular w-20 text-right text-xs text-ink">
                              {(cell.susceptible_percent ?? 0).toFixed(0)}%
                              <span className="ml-1 text-ink-muted">n={cell.interpretable}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2 text-[11px] text-ink-muted">
                        {reportable.length} agent{reportable.length === 1 ? "" : "s"} reported ·{" "}
                        {period}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-3 border-t border-line pt-3 text-xs text-ink-muted">
                      No combination for this organism reaches the reporting threshold in the
                      selected period.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <ClinicalFraming text={antibiogram.clinical_framing} />
      </div>
    </Shell>
  );
}

/** Length encodes the value; colour is a redundant cue, never the only one. */
function SusceptibilityBar({ percent }: { percent: number }) {
  const tone =
    percent >= 70 ? "var(--color-sir-s)" : percent >= 50 ? "var(--color-sir-i)" : "var(--color-sir-r)";
  return (
    <span aria-hidden className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-muted">
      <span
        className="block h-full rounded-full"
        style={{ width: `${Math.max(2, percent)}%`, backgroundColor: tone }}
      />
    </span>
  );
}
