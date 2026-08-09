import {
  ClinicalFraming,
  FreshnessBanner,
  formatPeriod,
} from "@/components/context-panels";
import { AntibioticProfileChart, SpecimenDistributionChart } from "@/components/figures";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Report figures" };

/**
 * The summary figures an AMR report opens with — the whole-panel view, before
 * the organism-by-organism detail of the antibiogram.
 */
export default async function FiguresPage({
  searchParams,
}: {
  searchParams: Promise<{ care_setting?: string; date_from?: string; date_to?: string }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;

  const figures = await api.figures({
    care_setting: params.care_setting,
    date_from: params.date_from,
    date_to: params.date_to,
  });

  const period = formatPeriod(figures.freshness);

  return (
    <Shell profile={profile} current="/figures">
      <PageHeading
        title="Report figures"
        description="Whole-panel summaries: how each agent is performing overall, and where the isolates came from."
        aside={
          <>
            <BannerFigure
              label="Agents charted"
              value={figures.antibiotic_profiles.length}
              detail={`n ≥ ${figures.minimum_isolates} each`}
            />
            <BannerFigure
              label="Isolates"
              value={figures.total_isolates.toLocaleString()}
              detail="In the selected period"
            />
          </>
        }
      />

      <div className="space-y-6">
        <FreshnessBanner freshness={figures.freshness} />

        <section aria-labelledby="profile-heading">
          <h2 id="profile-heading" className="heading-rule mb-1 text-lg font-semibold text-ink">
            Antimicrobial resistance and susceptibility patterns
          </h2>
          <p className="mb-3 max-w-3xl text-sm text-ink-muted">
            Agents are ordered least-susceptible first, so the ones that have stopped working
            appear at the top. Only agents with at least {figures.minimum_isolates} interpretable
            results are charted.
          </p>

          {/* The caveat sits with the chart, not in a footnote: a pooled bar is
              easy to read as an organism-specific fact. */}
          <p className="mb-3 rounded-[--radius-card] border border-sir-i/40 bg-sir-i/5 px-4 py-2.5 text-xs text-ink">
            {figures.pooling_caveat}
          </p>

          <AntibioticProfileChart profiles={figures.antibiotic_profiles} period={period} />
        </section>

        <section aria-labelledby="specimen-heading">
          <h2 id="specimen-heading" className="heading-rule mb-1 text-lg font-semibold text-ink">
            Specimen provenance
          </h2>
          <p className="mb-3 max-w-3xl text-sm text-ink-muted">
            Which specimen types produced the isolates behind these figures. A pattern drawn
            largely from urine describes a different clinical picture than one drawn from blood.
          </p>
          <SpecimenDistributionChart
            specimens={figures.specimen_distribution}
            total={figures.total_isolates}
          />
        </section>

        <ClinicalFraming text={figures.clinical_framing} />
      </div>
    </Shell>
  );
}
