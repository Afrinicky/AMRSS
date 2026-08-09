import Link from "next/link";

import {
  ClinicalFraming,
  FreshnessBanner,
  MethodologyDisclosure,
} from "@/components/context-panels";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { requireProfile } from "@/lib/session";
import type { BreakdownGroup, Comparison } from "@/lib/api";

export const metadata = { title: "Geographic comparison" };

/**
 * Susceptibility across districts or facilities, agent by agent (SDD 11.2).
 *
 * A matrix rather than a map. AMRSS holds no district boundary geometry, and
 * positioning laboratories on invented coordinates would misrepresent where
 * they are — a map that is wrong about geography is worse than a grid that is
 * honest about it. The matrix carries the same finding: which geography differs,
 * and on what. A choropleth can be layered onto this endpoint unchanged once
 * boundaries are supplied.
 *
 * The finding it exists for: an agent that works regionally but has collapsed
 * in one district is invisible in a pooled figure. That is the thing a regional
 * team needs and cannot get from the antibiogram.
 *
 * What it must never become is a league table. Differences here reflect the
 * organisms and specimens each geography happens to submit at least as much as
 * any difference in resistance, and a laboratory that fears being ranked
 * reports less. Nothing is ordered by performance, and the caveat is on the
 * page rather than in a footnote.
 */
export default async function ComparisonPage({
  searchParams,
}: {
  searchParams: Promise<{
    dimension?: string;
    organism_id?: string;
    care_setting?: string;
    date_from?: string;
    date_to?: string;
  }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;

  const canCompareFacilities = profile.permissions.includes("surveillance:view_cross_facility");
  const dimension =
    params.dimension === "facility" && canCompareFacilities ? "facility" : "district";

  const reference = await api.reference();
  const organisms = [...reference.organisms].sort((a, b) => a.name.localeCompare(b.name));

  let comparison: Comparison | null = null;
  let error: string | null = null;
  try {
    comparison = await api.comparison({
      dimension,
      organism_id: params.organism_id,
      care_setting: params.care_setting,
      date_from: params.date_from,
      date_to: params.date_to,
    });
  } catch (caught) {
    error =
      caught instanceof ApiError
        ? caught.message
        : "The comparison could not be computed for this selection.";
  }

  const reportableCells =
    comparison?.rows.reduce(
      (total, row) => total + row.cells.filter((cell) => cell.state === "reportable").length,
      0,
    ) ?? 0;

  return (
    <Shell profile={profile} current="/comparison">
      <PageHeading
        title="Geographic comparison"
        description="Where the resistance picture differs across the block, agent by agent."
        aside={
          <>
            <BannerFigure
              label={dimension === "facility" ? "Facilities" : "Districts"}
              value={comparison?.rows.length ?? "—"}
              detail={`${comparison?.antibiotics.length ?? 0} agents`}
            />
            <BannerFigure
              label="Reportable cells"
              value={reportableCells}
              detail={`n ≥ ${comparison?.minimum_isolates ?? "—"} each`}
            />
          </>
        }
      />

      <div className="space-y-6">
        {comparison ? <FreshnessBanner freshness={comparison.freshness} /> : null}

        <form className="grid grid-cols-1 items-end gap-3 rounded-[--radius-card] border border-line bg-surface p-4 sm:grid-cols-2 lg:flex lg:flex-wrap">
          <div className="lg:w-44">
            <label
              htmlFor="dimension"
              className="block text-xs font-medium uppercase tracking-wide text-ink-muted"
            >
              Compare
            </label>
            <select
              id="dimension"
              name="dimension"
              defaultValue={dimension}
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="district">Districts</option>
              {/* Offered only where the API would allow it. A facility option
                  that always returns 403 teaches nothing. */}
              {canCompareFacilities ? <option value="facility">Facilities</option> : null}
            </select>
          </div>

          <div className="lg:w-64">
            <label
              htmlFor="organism_id"
              className="block text-xs font-medium uppercase tracking-wide text-ink-muted"
            >
              Organism
            </label>
            <select
              id="organism_id"
              name="organism_id"
              defaultValue={params.organism_id ?? ""}
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="">All organisms pooled</option>
              {organisms.map((organism) => (
                <option key={organism.id} value={organism.id}>
                  {organism.name}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:w-44">
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
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="">All settings</option>
              <option value="IPD">Inpatient</option>
              <option value="OPD">Outpatient</option>
            </select>
          </div>

          <button
            type="submit"
            className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 sm:w-auto"
          >
            Compare
          </button>
        </form>

        {comparison ? (
          <p className="rounded-[--radius-card] border border-sir-i/40 bg-sir-i/5 px-4 py-3 text-sm text-ink">
            {comparison.comparison_caveat}
          </p>
        ) : null}

        {!comparison?.organism ? (
          <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
            Every organism is pooled in this view, so a district that submits mostly urines will
            look different from one submitting mostly blood cultures whatever its resistance.
            Choose an organism above for a comparison that holds that constant.
          </p>
        ) : null}

        {error ? (
          <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-8 text-center text-sm text-ink-muted">
            {error}
          </p>
        ) : comparison && comparison.rows.length > 0 ? (
          <>
            <Legend minimumIsolates={comparison.minimum_isolates} />
            <HeatMap comparison={comparison} />
          </>
        ) : (
          <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-8 text-center text-sm text-ink-muted">
            No {dimension} reaches the reporting threshold for this selection.
          </p>
        )}

        {comparison ? (
          <>
            <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
              A cell needs {comparison.minimum_isolates} interpretable results before it carries a
              percentage, and groups under {comparison.small_cell_threshold} isolates are withheld
              entirely. Splitting a regional total across geographies and agents makes most cells
              small, so a sparse grid is the expected shape — it is a statement about volume, not
              about resistance. For the whole-block picture, see the{" "}
              <Link href="/antibiogram" className="font-medium text-brand-700">
                antibiogram
              </Link>
              .
            </p>
            <MethodologyDisclosure methodology={comparison.methodology} />
            <ClinicalFraming text={comparison.clinical_framing} />
          </>
        ) : null}
      </div>
    </Shell>
  );
}

/**
 * The grid.
 *
 * Colour uses the clinical palette because each cell *is* a susceptibility
 * figure — the one place semantic colour is correct rather than decorative. It
 * is a redundant cue, never the only one: every reportable cell prints its
 * percentage and its n, and withheld cells state why.
 */
function HeatMap({ comparison }: { comparison: Comparison }) {
  return (
    <div className="overflow-x-auto rounded-[--radius-card] border border-line bg-surface">
      <table className="banded w-full border-collapse text-sm">
        <caption className="sr-only">
          Percent susceptible by {comparison.dimension} and antimicrobial agent
          {comparison.organism ? ` for ${comparison.organism.name}` : ", all organisms pooled"}
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-10 border border-line bg-surface-muted px-3 py-2 text-left font-medium text-ink"
            >
              {comparison.dimension === "facility" ? "Facility" : "District"}
            </th>
            <th
              scope="col"
              className="border border-line bg-surface-muted px-3 py-2 text-right font-medium text-ink"
            >
              Isolates
            </th>
            {comparison.antibiotics.map((antibiotic) => (
              <th
                key={antibiotic.id}
                scope="col"
                className="border border-line bg-surface-muted px-2 py-2 text-center text-xs font-medium text-ink"
              >
                <span className="block">{antibiotic.code}</span>
                <span className="block font-normal text-ink-muted">{antibiotic.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <tr key={row.key}>
              <th
                scope="row"
                className="sticky left-0 z-10 border border-line bg-surface px-3 py-2 text-left font-medium text-ink"
              >
                {row.label}
              </th>
              <td className="tabular border border-line px-3 py-2 text-right text-ink-muted">
                {row.isolate_count.toLocaleString()}
              </td>
              {row.cells.map((cell) => (
                <HeatCell key={cell.key} cell={cell} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeatCell({ cell }: { cell: BreakdownGroup }) {
  const percent = cell.susceptible_percent;

  if (cell.state !== "reportable" || percent === null) {
    return (
      <td className="insufficient-fill border border-line px-2 py-1.5 text-center">
        <span className="text-[11px] text-insufficient-ink">
          {cell.state === "suppressed" ? "Withheld" : "Insufficient"}
        </span>
      </td>
    );
  }

  const tone =
    percent >= 70 ? "var(--color-sir-s)" : percent >= 50 ? "var(--color-sir-i)" : "var(--color-sir-r)";

  return (
    <td
      className="border border-line px-2 py-1.5 text-center"
      style={{ backgroundColor: `color-mix(in srgb, ${tone} 40%, transparent)` }}
    >
      <span className="tabular block text-sm font-semibold text-ink">{percent.toFixed(0)}%</span>
      {/* n travels with the percentage. A heat map of bare colours invites the
          eye to compare cells whose denominators differ by an order of
          magnitude (SDD 11.3). */}
      <span className="tabular block text-[11px] text-ink-muted">n={cell.interpretable}</span>
    </td>
  );
}

function Legend({ minimumIsolates }: { minimumIsolates: number }) {
  const bands = [
    ["≥70% susceptible", "var(--color-sir-s)"],
    ["50–69%", "var(--color-sir-i)"],
    ["<50%", "var(--color-sir-r)"],
  ] as const;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[--radius-card] border border-line bg-surface px-4 py-3 text-xs text-ink-muted">
      <span className="font-medium text-ink">Reading this grid</span>
      {bands.map(([label, colour]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-3 rounded-sm"
            style={{ backgroundColor: `color-mix(in srgb, ${colour} 40%, transparent)` }}
          />
          {label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="insufficient-fill inline-block size-3 rounded-sm border border-line" />
        Insufficient (n &lt; {minimumIsolates}) or withheld
      </span>
      <span>Each cell shows percent susceptible and its isolate count.</span>
    </div>
  );
}
