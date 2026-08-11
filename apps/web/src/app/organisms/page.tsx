import {
  ClinicalFraming,
  FreshnessBanner,
} from "@/components/context-panels";
import { OrganismSiteChart } from "@/components/figures";
import { FilterBar, scopeParams } from "@/components/filter-bar";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Organism explorer" };

/**
 * Which organisms were isolated, and from which sites of infection (SDD 11.2).
 *
 * The provenance view. It carries no susceptibility figure at all, deliberately:
 * this page describes the specimen mix behind every other figure in the system,
 * and mixing a rate into it would invite the two to be read as one statement.
 *
 * Site of infection is derived from specimen type rather than collected
 * separately (SDD 3.1), so the two can never disagree.
 */
export default async function OrganismsPage({
  searchParams,
}: {
  searchParams: Promise<{
    district_id?: string;
    facility_id?: string;
    care_setting?: string;
    organism_kingdom?: string;
    date_from?: string;
    date_to?: string;
  }>;
}) {
  // Independent calls, run concurrently: the data query reads from the URL, not
  // from the profile or scope, so there is no reason to wait for one before
  // starting the next (see antibiogram/page.tsx).
  const params = await searchParams;
  const [profile, scope, explorer] = await Promise.all([
    requireProfile(),
    api.scope(),
    api.organismExplorer({
      ...scopeParams(params),
      care_setting: params.care_setting,
      organism_kingdom: params.organism_kingdom,
      date_from: params.date_from,
      date_to: params.date_to,
    }),
  ]);

  // One scale across both kingdom charts. Left to renormalise per chart, a
  // 38-isolate Candida bar would be drawn the length of a 318-isolate E. coli
  // one, which is exactly the misreading the shared scale exists to prevent.
  const scaleMax = Math.max(
    1,
    ...explorer.organisms.flatMap((organism) =>
      organism.sites.map((site) => site.isolate_count),
    ),
  );
  const kingdoms = ["bacteria", "fungi"] as const;
  const KINGDOM_HEADING = {
    bacteria: "Bacterial isolates",
    fungi: "Fungal and yeast isolates",
  } as const;

  return (
    <Shell profile={profile} current="/organisms">
      <PageHeading
        title="Organism explorer"
        description="Which organisms the participating laboratories recovered, and the sites of infection they came from."
        aside={
          <>
            <BannerFigure
              label="Organisms"
              value={explorer.organisms.length}
              detail="Above the reporting threshold"
            />
            <BannerFigure
              label="Isolates"
              value={explorer.total_isolates.toLocaleString()}
              detail={`across ${explorer.infection_sites.length} site${
                explorer.infection_sites.length === 1 ? "" : "s"
              }`}
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

        {kingdoms.map((kingdom) => {
          const rows = explorer.organisms.filter(
            (organism) => organism.organism_kingdom === kingdom,
          );
          if (rows.length === 0) return null;

          return (
            <section key={kingdom} aria-labelledby={`${kingdom}-heading`}>
              <h2
                id={`${kingdom}-heading`}
                className="heading-rule mb-1 text-lg font-semibold text-ink"
              >
                {KINGDOM_HEADING[kingdom]}
              </h2>
              <p className="mb-3 max-w-3xl text-sm text-ink-muted">
                Each organism is listed with the sites it was recovered from, one bar per
                site. Bars share a single scale across the whole figure, so a site with a
                dozen isolates is never drawn the length of one with three hundred.
              </p>
              <OrganismSiteChart
                organisms={rows}
                total={explorer.total_isolates}
                scaleMax={scaleMax}
              />
            </section>
          );
        })}

        {explorer.organisms.length === 0 ? (
          <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-8 text-center text-sm text-ink-muted">
            No organism reaches the reporting threshold in this period.
          </p>
        ) : null}

        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
          Counts are isolates, not patients. This figure describes what the laboratories
          processed and from which sites — the provenance of the surveillance picture, not a
          rate — so the first-isolate-per-patient rule that governs the antibiogram is not
          applied here. Organisms and sites contributing too few isolates to report are
          withheld rather than shown.
        </p>

        <ClinicalFraming text={explorer.clinical_framing} />
      </div>
    </Shell>
  );
}
