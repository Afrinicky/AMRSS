import {
  ClinicalFraming,
  FreshnessBanner,
  MethodologyDisclosure,
  QualityExclusionNotice,
  formatPeriod,
} from "@/components/context-panels";
import { PageHeading, Shell } from "@/components/shell";
import { SirCell } from "@/components/statistic";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Antibiogram" };

const KINGDOM_HEADING = {
  bacteria: "Bacterial isolates",
  fungi: "Fungal and yeast isolates",
} as const;

export default async function AntibiogramPage({
  searchParams,
}: {
  searchParams: Promise<{ care_setting?: string; date_from?: string; date_to?: string }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;

  const antibiogram = await api.antibiogram({
    care_setting: params.care_setting,
    date_from: params.date_from,
    date_to: params.date_to,
  });

  const period = formatPeriod(antibiogram.freshness);
  const kingdoms = ["bacteria", "fungi"] as const;

  return (
    <Shell profile={profile} current="/antibiogram">
      <PageHeading
        title="Antibiogram"
        description={`Percent susceptible by organism and agent. Combinations with fewer than ${antibiogram.minimum_isolates} antibiogram-eligible isolates are not reported as a percentage.`}
      />

      <div className="space-y-6">
        <FreshnessBanner freshness={antibiogram.freshness} />

        <form className="flex flex-wrap items-end gap-3 rounded-[--radius-card] border border-line bg-surface p-4">
          <div>
            <label
              htmlFor="care_setting"
              className="block text-xs font-medium uppercase tracking-wide text-ink-muted"
            >
              Care setting
            </label>
            <select
              id="care_setting"
              name="care_setting"
              defaultValue={params.care_setting ?? ""}
              className="mt-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="">All settings</option>
              <option value="IPD">Inpatient</option>
              <option value="OPD">Outpatient</option>
            </select>
          </div>
          <div>
            <label
              htmlFor="date_from"
              className="block text-xs font-medium uppercase tracking-wide text-ink-muted"
            >
              From
            </label>
            <input
              id="date_from"
              name="date_from"
              type="date"
              defaultValue={params.date_from ?? ""}
              className="mt-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>
          <div>
            <label
              htmlFor="date_to"
              className="block text-xs font-medium uppercase tracking-wide text-ink-muted"
            >
              To
            </label>
            <input
              id="date_to"
              name="date_to"
              type="date"
              defaultValue={params.date_to ?? ""}
              className="mt-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>
          <button
            type="submit"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Apply
          </button>
        </form>

        <QualityExclusionNotice
          facilitiesExcluded={antibiogram.quality_exclusion.facilities_excluded}
          isolatesExcluded={antibiogram.quality_exclusion.isolates_excluded}
          note={antibiogram.quality_exclusion.note}
        />

        <Legend
          minimumIsolates={antibiogram.minimum_isolates}
          smallCellThreshold={antibiogram.small_cell_threshold}
          suppressionApplied={antibiogram.suppression_applied}
        />

        {kingdoms.map((kingdom) => {
          const rows = antibiogram.rows.filter((row) => row.organism_kingdom === kingdom);
          if (rows.length === 0) return null;

          // Only show agents actually tested in this kingdom, so the fungal table
          // is not mostly empty columns of antibacterials.
          const columns = antibiogram.antibiotics.filter((antibiotic) =>
            rows.some((row) =>
              row.cells.some(
                (cell) => cell.antibiotic_id === antibiotic.id && cell.state !== "not_tested",
              ),
            ),
          );

          return (
            <section key={kingdom} aria-labelledby={`${kingdom}-heading`}>
              <h2 id={`${kingdom}-heading`} className="mb-3 text-lg font-semibold text-ink">
                {KINGDOM_HEADING[kingdom]}
              </h2>

              {/* The table scrolls inside its own container so the page body
                  never scrolls sideways on a narrow facility screen. */}
              <div className="overflow-x-auto rounded-[--radius-card] border border-line bg-surface">
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">
                    Percent susceptible by organism and antimicrobial agent, {period}
                  </caption>
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        className="sticky left-0 z-10 border border-line bg-surface-muted px-3 py-2 text-left font-medium text-ink"
                      >
                        Organism
                      </th>
                      <th
                        scope="col"
                        className="border border-line bg-surface-muted px-3 py-2 text-right font-medium text-ink"
                      >
                        Isolates
                      </th>
                      {columns.map((antibiotic) => (
                        <th
                          key={antibiotic.id}
                          scope="col"
                          className="border border-line bg-surface-muted px-2 py-2 text-center text-xs font-medium text-ink"
                        >
                          <span className="block">{antibiotic.code}</span>
                          <span className="block font-normal text-ink-muted">
                            {antibiotic.name}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const byId = new Map(row.cells.map((cell) => [cell.antibiotic_id, cell]));
                      return (
                        <tr key={row.organism.id}>
                          <th
                            scope="row"
                            className="sticky left-0 z-10 border border-line bg-surface px-3 py-2 text-left font-medium italic text-ink"
                          >
                            {row.organism.name}
                          </th>
                          <td className="tabular border border-line px-3 py-2 text-right text-ink-muted">
                            {row.isolate_count.toLocaleString()}
                          </td>
                          {columns.map((antibiotic) => {
                            const cell = byId.get(antibiotic.id);
                            if (!cell) {
                              return (
                                <td
                                  key={antibiotic.id}
                                  className="insufficient-fill border border-line px-2 py-1.5 text-center"
                                >
                                  <span className="text-[11px] text-insufficient-ink">
                                    Not tested
                                  </span>
                                </td>
                              );
                            }
                            return (
                              <SirCell key={antibiotic.id} cell={cell} period={period} />
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}

        <MethodologyDisclosure methodology={antibiogram.methodology} />
        <ClinicalFraming text={antibiogram.clinical_framing} />
      </div>
    </Shell>
  );
}

function Legend({
  minimumIsolates,
  smallCellThreshold,
  suppressionApplied,
}: {
  minimumIsolates: number;
  smallCellThreshold: number;
  suppressionApplied: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[--radius-card] border border-line bg-surface px-4 py-3 text-xs text-ink-muted">
      <span className="font-medium text-ink">Reading this table</span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm"
          style={{ backgroundColor: "color-mix(in srgb, var(--color-sir-s) 40%, transparent)" }}
        />
        ≥70% susceptible
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm"
          style={{ backgroundColor: "color-mix(in srgb, var(--color-sir-i) 40%, transparent)" }}
        />
        50–69%
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm"
          style={{ backgroundColor: "color-mix(in srgb, var(--color-sir-r) 40%, transparent)" }}
        />
        &lt;50%
      </span>
      <span className="flex items-center gap-1.5">
        <span className="insufficient-fill inline-block size-3 rounded-sm border border-line" />
        Insufficient data (n &lt; {minimumIsolates})
        {suppressionApplied ? ` or withheld (n < ${smallCellThreshold})` : ""}
      </span>
      <span>Each cell shows percent susceptible and its isolate count.</span>
    </div>
  );
}
