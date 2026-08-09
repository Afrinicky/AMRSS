import Link from "next/link";
import { notFound } from "next/navigation";

import { BreakdownPanel, GroupRow, dimensionTitle } from "@/components/breakdown";
import { ClinicalFraming, FreshnessBanner, MethodologyDisclosure } from "@/components/context-panels";
import { PeriodFilter } from "@/components/period-filter";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Organism detail" };

/**
 * One organism in depth (SDD 11.2, Organism Explorer).
 *
 * The list view answers "which organisms and from where". This answers the
 * follow-up: what still works against this one, and does the answer change by
 * specimen, setting, age or district.
 *
 * Breakdowns are computed for a single agent, because a susceptibility rate
 * without one is not a statistic. Which agent is being broken down is stated at
 * the top of the section rather than left implicit — the commonest way for a
 * drill-down to mislead is for the reader to attribute the strata to the wrong
 * drug.
 */
export default async function OrganismDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ organismId: string }>;
  searchParams: Promise<{
    antibiotic_id?: string;
    care_setting?: string;
    date_from?: string;
    date_to?: string;
  }>;
}) {
  const profile = await requireProfile();
  const { organismId } = await params;
  const query = await searchParams;

  let detail;
  try {
    detail = await api.organismDetail(organismId, {
      antibiotic_id: query.antibiotic_id,
      care_setting: query.care_setting,
      date_from: query.date_from,
      date_to: query.date_to,
    });
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) notFound();
    throw caught;
  }

  const reportable = detail.agents.filter((agent) => agent.state === "reportable");

  return (
    <Shell profile={profile} current="/organisms">
      <PageHeading
        title={detail.organism.name}
        description={`Every agent tested against this organism, and how the picture changes across specimen, setting, age and district.`}
        aside={
          <>
            <BannerFigure
              label="Eligible isolates"
              value={detail.antibiogram_eligible_count.toLocaleString()}
              detail={`of ${detail.isolate_count.toLocaleString()} in period`}
            />
            <BannerFigure
              label="Agents reported"
              value={reportable.length}
              detail={`of ${detail.agents.length} tested`}
            />
          </>
        }
      />

      <div className="space-y-6">
        <FreshnessBanner freshness={detail.freshness} />

        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <Link href="/organisms" className="font-medium text-brand-700">
            ← All organisms
          </Link>
          <Link href="/antibiogram" className="text-ink-muted hover:text-ink">
            Full antibiogram
          </Link>
        </nav>

        <PeriodFilter
          careSetting={query.care_setting}
          dateFrom={query.date_from}
          dateTo={query.date_to}
        />

        <section aria-labelledby="agents-heading">
          <h2 id="agents-heading" className="heading-rule mb-1 text-lg font-semibold text-ink">
            Susceptibility by agent
          </h2>
          <p className="mb-3 max-w-3xl text-sm text-ink-muted">
            Agents are listed in dictionary order, never ranked by susceptibility. Ranking would
            make a broad-spectrum agent the headline for most organisms — a de facto prescribing
            prompt, which AMRSS does not give, and one that works against stewardship.
          </p>
          <div className="rounded-[--radius-card] border border-line bg-surface p-4">
            <ul>
              {detail.agents.map((agent) => (
                <GroupRow
                  key={agent.key}
                  group={agent}
                  minimumIsolates={detail.minimum_isolates}
                />
              ))}
            </ul>
          </div>
        </section>

        {detail.breakdown_antibiotic ? (
          <section aria-labelledby="breakdown-heading">
            <h2
              id="breakdown-heading"
              className="heading-rule mb-1 text-lg font-semibold text-ink"
            >
              Where the picture differs
            </h2>
            <p className="mb-3 max-w-3xl text-sm text-ink-muted">
              Every figure below is susceptibility to{" "}
              <strong className="font-medium text-ink">
                {detail.breakdown_antibiotic.name}
              </strong>{" "}
              specifically. Splitting a total into strata makes each one smaller, so groups that
              fall under the reporting threshold are marked rather than reported — a fragment of
              a figure has not cleared the bar just because the whole did.
            </p>
            <div className="grid gap-4 lg:grid-cols-2">
              {detail.breakdowns.map((breakdown) => (
                <BreakdownPanel
                  key={breakdown.dimension}
                  title={dimensionTitle(breakdown.dimension)}
                  description={breakdown.description}
                  groups={breakdown.groups}
                  minimumIsolates={detail.minimum_isolates}
                />
              ))}
            </div>
          </section>
        ) : (
          <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-6 text-center text-sm text-ink-muted">
            No agent reaches {detail.minimum_isolates} interpretable results against this
            organism, so no breakdown can be reported.
          </p>
        )}

        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
          Want the same view over time?{" "}
          <Link
            href={`/trends?organism_id=${detail.organism.id}${
              detail.breakdown_antibiotic ? `&antibiotic_id=${detail.breakdown_antibiotic.id}` : ""
            }`}
            className="font-medium text-brand-700"
          >
            Plot this organism on the trends page
          </Link>
          .
        </p>

        <MethodologyDisclosure methodology={detail.methodology} />
        <ClinicalFraming text={detail.clinical_framing} />
      </div>
    </Shell>
  );
}
