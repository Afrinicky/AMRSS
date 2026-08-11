import { ClinicalFraming, FreshnessBanner } from "@/components/context-panels";
import { SpecimenDistributionChart } from "@/components/figures";
import { FilterBar, scopeParams } from "@/components/filter-bar";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Specimen explorer" };

/**
 * Which specimen types yielded the isolates (SDD 11.2).
 *
 * The sampling view. It answers a question the antibiogram cannot: whether the
 * surveillance picture rests on blood cultures or on urines. A region whose
 * isolates are overwhelmingly urinary has a different blind spot from one whose
 * isolates are overwhelmingly from wound swabs, and neither is visible in a
 * susceptibility table.
 *
 * Like the organism explorer, this page carries no susceptibility figure at all.
 */
export default async function SpecimensPage({
  searchParams,
}: {
  searchParams: Promise<{
    district_id?: string;
    facility_id?: string;
    care_setting?: string;
    date_from?: string;
    date_to?: string;
  }>;
}) {
  // Independent calls, run concurrently (see antibiogram/page.tsx).
  const params = await searchParams;
  const [profile, scope, explorer] = await Promise.all([
    requireProfile(),
    api.scope(),
    api.specimenExplorer({
      ...scopeParams(params),
      care_setting: params.care_setting,
      date_from: params.date_from,
      date_to: params.date_to,
    }),
  ]);

  // Sterility comes from the dictionary, not from matching site names. A growth
  // from blood or CSF carries weight a wound-swab growth does not, and the share
  // of sterile-site specimens is the quickest read on how much of this
  // surveillance picture rests on unambiguous infection.
  const sterilePercent = explorer.specimens
    .filter((entry) => entry.sterile_site)
    .reduce((sum, entry) => sum + entry.percent_of_total, 0);

  return (
    <Shell profile={profile} current="/specimens">
      <PageHeading
        title="Specimen explorer"
        description="Which specimen types the participating laboratories processed, and how many isolates each yielded."
        aside={
          <>
            <BannerFigure
              label="Specimen types"
              value={explorer.specimens.length}
              detail="Above the reporting threshold"
            />
            <BannerFigure
              label="Isolates"
              value={explorer.total_isolates.toLocaleString()}
              detail={`${sterilePercent.toFixed(0)}% from sterile sites`}
            />
          </>
        }
      />

      <div className="space-y-6">
        <FreshnessBanner freshness={explorer.freshness} />

        <FilterBar
          scope={scope}
          districtId={params.district_id}
          facilityId={params.facility_id}
          careSetting={params.care_setting}
          dateFrom={params.date_from}
          dateTo={params.date_to}
        />

        <section aria-labelledby="specimen-heading">
          <h2 id="specimen-heading" className="heading-rule mb-1 text-lg font-semibold text-ink">
            Specimen provenance
          </h2>
          <p className="mb-3 max-w-3xl text-sm text-ink-muted">
            Which specimen types produced the isolates behind every other figure in AMRSS. A
            pattern drawn largely from urine describes a different clinical picture than one
            drawn from blood, and neither the antibiogram nor the organism breakdown shows
            that on its own.
          </p>
          <SpecimenDistributionChart
            specimens={explorer.specimens}
            total={explorer.total_isolates}
          />
        </section>

        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
          Counts are isolates, not patients, so the first-isolate-per-patient rule that governs
          the antibiogram is not applied here — this describes laboratory workload, not a rate.
          {explorer.withheld_isolates > 0
            ? ` ${explorer.withheld_isolates.toLocaleString()} isolate${
                explorer.withheld_isolates === 1 ? " comes" : "s come"
              } from specimen types with too few isolates to report; they are counted in the
              total but not listed above.`
            : ""}
        </p>

        <ClinicalFraming text={explorer.clinical_framing} />
      </div>
    </Shell>
  );
}
