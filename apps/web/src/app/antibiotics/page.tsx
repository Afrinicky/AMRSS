import {
  ClinicalFraming,
  FreshnessBanner,
  formatPeriod,
} from "@/components/context-panels";
import { AntibioticProfileChart } from "@/components/figures";
import { PeriodFilter } from "@/components/period-filter";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Antibiotic explorer" };

/**
 * Overall resistance and susceptibility per agent (SDD 11.2).
 *
 * The agent-first view: how each antimicrobial is performing across everything
 * it was tested against. It answers "what still works at all", which is a
 * stewardship and formulary question. The organism-specific answer — the one
 * that governs treatment of a particular infection — is the antibiogram, and
 * the caveat on this page says so rather than leaving the reader to infer it.
 */
export default async function AntibioticsPage({
  searchParams,
}: {
  searchParams: Promise<{ care_setting?: string; date_from?: string; date_to?: string }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;

  const explorer = await api.antibioticExplorer({
    care_setting: params.care_setting,
    date_from: params.date_from,
    date_to: params.date_to,
  });

  const period = formatPeriod(explorer.freshness);
  const failing = explorer.profiles.filter((entry) => entry.susceptible_percent < 50).length;

  return (
    <Shell profile={profile} current="/antibiotics">
      <PageHeading
        title="Antibiotic explorer"
        description="Resistance and susceptibility patterns for each antimicrobial agent, pooled across the organisms it was tested against."
        aside={
          <>
            <BannerFigure
              label="Agents charted"
              value={explorer.profiles.length}
              detail={`n ≥ ${explorer.minimum_isolates} each`}
            />
            <BannerFigure
              label="Below 50% susceptible"
              value={failing}
              detail="Agents in this period"
            />
          </>
        }
      />

      <div className="space-y-6">
        <FreshnessBanner freshness={explorer.freshness} />

        <PeriodFilter
          careSetting={params.care_setting}
          dateFrom={params.date_from}
          dateTo={params.date_to}
        />

        <section aria-labelledby="profile-heading">
          <h2 id="profile-heading" className="heading-rule mb-1 text-lg font-semibold text-ink">
            Antimicrobial resistance and susceptibility patterns
          </h2>
          <p className="mb-3 max-w-3xl text-sm text-ink-muted">
            Agents are ordered least-susceptible first, so the ones that have stopped working
            appear at the top. Only agents with at least {explorer.minimum_isolates} interpretable
            results are charted.
          </p>

          {/* The caveat sits with the chart, not in a footnote: a pooled bar is
              easy to read as an organism-specific fact. */}
          <p className="mb-3 rounded-[--radius-card] border border-sir-i/40 bg-sir-i/5 px-4 py-2.5 text-xs text-ink">
            {explorer.pooling_caveat}
          </p>

          <AntibioticProfileChart profiles={explorer.profiles} period={period} />
        </section>

        <ClinicalFraming text={explorer.clinical_framing} />
      </div>
    </Shell>
  );
}
