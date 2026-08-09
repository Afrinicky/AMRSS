/**
 * Shared rendering for the drill-down strata.
 *
 * The single rule these components exist to hold: a stratum that did not clear
 * its thresholds shows a stated reason, never a number and never nothing.
 * Omitting it would make an incomplete breakdown look complete; showing a
 * percentage would republish a fragment of a figure as though it had passed the
 * bar on its own.
 */

import type { BreakdownGroup } from "@/lib/api";

const STATE_LABEL: Record<BreakdownGroup["state"], string> = {
  reportable: "",
  below_threshold: "Too few results to report",
  suppressed: "Withheld — group too small",
};

/**
 * A susceptibility bar for one stratum.
 *
 * Length encodes the value and colour is a redundant cue, never the only one —
 * the number sits beside it either way. The clinical palette is correct here:
 * this bar *is* a susceptibility figure, unlike the count bars elsewhere.
 */
export function GroupRow({
  group,
  minimumIsolates,
}: {
  group: BreakdownGroup;
  minimumIsolates: number;
}) {
  const percent = group.susceptible_percent;
  const reportable = group.state === "reportable" && percent !== null;

  const tone =
    percent === null
      ? "var(--color-sir-nt)"
      : percent >= 70
        ? "var(--color-sir-s)"
        : percent >= 50
          ? "var(--color-sir-i)"
          : "var(--color-sir-r)";

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2 last:border-0">
      <span className="min-w-0 flex-1 basis-48 truncate text-sm text-ink">{group.label}</span>

      {reportable ? (
        <>
          <span
            aria-hidden
            className="h-2 w-28 shrink-0 overflow-hidden rounded-full bg-surface-muted"
          >
            <span
              className="block h-full rounded-full"
              style={{ width: `${percent}%`, backgroundColor: tone }}
            />
          </span>
          <span className="tabular shrink-0 text-sm font-medium text-ink">
            {percent.toFixed(0)}%
          </span>
          {/* The interval travels with the estimate. A bare point implies a
              precision a 30-isolate stratum does not have. */}
          <span className="tabular shrink-0 text-xs text-ink-muted">
            {group.confidence_lower !== null && group.confidence_upper !== null
              ? `${group.confidence_lower.toFixed(0)}–${group.confidence_upper.toFixed(0)}`
              : ""}
          </span>
          <span className="tabular shrink-0 text-xs text-ink-muted">n={group.interpretable}</span>
        </>
      ) : (
        <>
          <span className="insufficient-fill shrink-0 rounded px-2 py-0.5 text-xs text-insufficient-ink">
            {STATE_LABEL[group.state]}
            {group.state === "below_threshold" ? ` (n < ${minimumIsolates})` : ""}
          </span>
          {/* Isolate count still shown for a below-threshold stratum: the
              stratum exists, and knowing it holds 12 isolates rather than 2 is
              what tells a reader whether it is nearly reportable. Suppressed
              strata release nothing — the count is the leak. */}
          {group.state === "below_threshold" ? (
            <span className="tabular shrink-0 text-xs text-ink-muted">
              {group.isolate_count} isolates
            </span>
          ) : null}
        </>
      )}
    </li>
  );
}

export function BreakdownPanel({
  title,
  description,
  groups,
  minimumIsolates,
}: {
  title: string;
  description: string;
  groups: BreakdownGroup[];
  minimumIsolates: number;
}) {
  if (groups.length === 0) return null;

  return (
    <section className="min-w-0 rounded-[--radius-card] border border-line bg-surface p-4">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{description}</p>
      <ul className="mt-3">
        {groups.map((group) => (
          <GroupRow key={group.key} group={group} minimumIsolates={minimumIsolates} />
        ))}
      </ul>
    </section>
  );
}

const DIMENSION_TITLE: Record<string, string> = {
  specimen_type: "By specimen type",
  care_setting: "By care setting",
  age_band: "By age band",
  district: "By district",
  facility: "By facility",
};

export function dimensionTitle(dimension: string): string {
  return DIMENSION_TITLE[dimension] ?? dimension.replace(/_/g, " ");
}
