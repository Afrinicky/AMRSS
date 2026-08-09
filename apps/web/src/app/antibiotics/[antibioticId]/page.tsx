import Link from "next/link";
import { notFound } from "next/navigation";

import { BreakdownPanel, GroupRow, dimensionTitle } from "@/components/breakdown";
import { ClinicalFraming, FreshnessBanner, MethodologyDisclosure } from "@/components/context-panels";
import { PeriodFilter } from "@/components/period-filter";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Antibiotic detail" };

/**
 * One agent in depth (SDD 11.2, Antibiotic Explorer).
 *
 * This is the page that makes the pooled bar on the explorer interpretable.
 * "Ampicillin, 30% susceptible" across everything tested is close to
 * meaningless on its own — organisms differ in intrinsic susceptibility, so the
 * pooled figure is shaped as much by which organisms happened to be isolated as
 * by any resistance trend. The per-organism list is the real answer, and it
 * leads the page for that reason.
 */
export default async function AntibioticDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ antibioticId: string }>;
  searchParams: Promise<{ care_setting?: string; date_from?: string; date_to?: string }>;
}) {
  const profile = await requireProfile();
  const { antibioticId } = await params;
  const query = await searchParams;

  let detail;
  try {
    detail = await api.antibioticDetail(antibioticId, {
      care_setting: query.care_setting,
      date_from: query.date_from,
      date_to: query.date_to,
    });
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) notFound();
    throw caught;
  }

  const reportable = detail.organisms.filter((group) => group.state === "reportable");
  const working = reportable.filter(
    (group) => (group.susceptible_percent ?? 0) >= 70,
  ).length;

  return (
    <Shell profile={profile} current="/antibiotics">
      <PageHeading
        title={detail.antibiotic.name}
        description="Which organisms this agent still works against, and how that varies across specimen, setting, age and district."
        aside={
          <>
            <BannerFigure
              label="Organisms reported"
              value={reportable.length}
              detail={`of ${detail.organisms.length} tested against`}
            />
            <BannerFigure
              label="At or above 70%"
              value={working}
              detail="Susceptible, of those reported"
            />
          </>
        }
      />

      <div className="space-y-6">
        <FreshnessBanner freshness={detail.freshness} />

        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <Link href="/antibiotics" className="font-medium text-brand-700">
            ← All agents
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

        <section aria-labelledby="organisms-heading">
          <h2 id="organisms-heading" className="heading-rule mb-1 text-lg font-semibold text-ink">
            Susceptibility by organism
          </h2>
          {/* The caveat sits with the figure it qualifies, not in a footnote. */}
          <p className="mb-3 rounded-[--radius-card] border border-sir-i/40 bg-sir-i/5 px-4 py-2.5 text-xs text-ink">
            {detail.pooling_caveat}
          </p>
          <div className="rounded-[--radius-card] border border-line bg-surface p-4">
            <ul>
              {detail.organisms.map((group) => (
                <GroupRow
                  key={group.key}
                  group={group}
                  minimumIsolates={detail.minimum_isolates}
                />
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="breakdown-heading">
          <h2 id="breakdown-heading" className="heading-rule mb-1 text-lg font-semibold text-ink">
            Where the picture differs
          </h2>
          <p className="mb-3 max-w-3xl text-sm text-ink-muted">
            These strata pool every organism tested against{" "}
            <strong className="font-medium text-ink">{detail.antibiotic.name}</strong>, so a
            difference between two districts can reflect a different organism mix rather than
            different resistance. Read them alongside the per-organism list above, not instead of
            it.
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

        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
          Want this agent over time?{" "}
          <Link
            href={`/trends?antibiotic_id=${detail.antibiotic.id}`}
            className="font-medium text-brand-700"
          >
            Plot it on the trends page
          </Link>{" "}
          against a chosen organism — a trend pooled across organisms would move whenever the
          specimen mix moved, which is not a resistance finding.
        </p>

        <MethodologyDisclosure methodology={detail.methodology} />
        <ClinicalFraming text={detail.clinical_framing} />
      </div>
    </Shell>
  );
}
