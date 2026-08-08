import type { Freshness } from "@/lib/api";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatPeriod(freshness: Freshness): string {
  if (!freshness.coverage_start || !freshness.coverage_end) return "period unavailable";
  return `${formatDate(freshness.coverage_start)} – ${formatDate(freshness.coverage_end)}`;
}

/**
 * Required on every analytical view (SDD 4.2).
 *
 * AMRSS is only ever as current as its most recent accepted upload, and this
 * banner is what stops the interface implying otherwise. Coverage is stated as a
 * fraction of active facilities, because "71% susceptible" means something
 * different when 14 of 18 laboratories contributed than when all 18 did.
 */
export function FreshnessBanner({ freshness }: { freshness: Freshness }) {
  const items = [
    { label: "Data last updated", value: formatDate(freshness.data_last_updated) },
    { label: "Coverage period", value: formatPeriod(freshness) },
    {
      label: "Facilities contributing",
      value: `${freshness.facilities_contributing} / ${freshness.facilities_expected}`,
    },
    { label: "Latest submission", value: formatDate(freshness.latest_facility_submission) },
    {
      label: "Completeness",
      value:
        freshness.completeness_percent === null
          ? "—"
          : `${freshness.completeness_percent.toFixed(0)}%`,
    },
  ];

  return (
    <section
      aria-label="Data freshness and coverage"
      className="rounded-[--radius-card] border border-brand-300/50 bg-brand-50 px-4 py-3"
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item) => (
          <div key={item.label}>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-brand-900/70">
              {item.label}
            </dt>
            <dd className="tabular mt-0.5 text-sm font-semibold text-brand-900">{item.value}</dd>
          </div>
        ))}
      </dl>
      {freshness.is_stale ? (
        <p className="mt-3 border-t border-brand-300/40 pt-2 text-xs font-medium text-sir-i">
          No upload has been accepted in over a month. These figures may not reflect current
          resistance patterns.
        </p>
      ) : null}
    </section>
  );
}

/**
 * Persistent and non-dismissible on any page showing susceptibility data
 * (SDD 11.3). There is deliberately no close control: the framing is a condition
 * of displaying the data, not a notice to be acknowledged once and cleared.
 */
export function ClinicalFraming({ text }: { text: string }) {
  return (
    <p
      role="note"
      className="rounded-[--radius-card] border border-line bg-surface px-4 py-3 text-sm text-ink-muted"
    >
      {text}
    </p>
  );
}

export function QualityExclusionNotice({
  facilitiesExcluded,
  isolatesExcluded,
  note,
}: {
  facilitiesExcluded: number;
  isolatesExcluded: number;
  note: string;
}) {
  if (facilitiesExcluded === 0) {
    return (
      <p className="text-xs text-ink-muted">
        No facilities are currently excluded from this verified aggregate on quality grounds.
      </p>
    );
  }
  return (
    <div className="rounded-[--radius-card] border border-sir-i/40 bg-sir-i/5 px-4 py-3">
      <p className="text-sm font-medium text-ink">
        {facilitiesExcluded} facility
        {facilitiesExcluded === 1 ? "" : "ies"} excluded on quality grounds
      </p>
      <p className="mt-1 text-xs text-ink-muted">
        {note} {isolatesExcluded.toLocaleString()} isolate
        {isolatesExcluded === 1 ? "" : "s"} are not counted in these figures.
      </p>
    </div>
  );
}

/**
 * "How was this calculated?" (SDD 5.9).
 *
 * A `<details>` element rather than a modal: it works without JavaScript, it
 * prints, and it can be linked to. Content is a projection of the provenance the
 * engine recorded, so it cannot drift away from what actually happened.
 */
export function MethodologyDisclosure({ methodology }: { methodology: Record<string, unknown> }) {
  const versions = (methodology.methodology_versions ?? []) as Array<{
    component: string;
    version: string;
    description: string;
    provisional: boolean;
  }>;
  const provisional = Boolean(methodology.provisional_methodology_in_use);

  const sections: Array<[string, unknown]> = [
    ["Surveillance period", methodology.surveillance_period],
    ["Aggregation level", methodology.aggregation_level],
    ["Participating facilities", methodology.participating_facilities],
    ["Inclusion criteria", methodology.inclusion_criteria],
    ["Deduplication", methodology.deduplication],
    ["Isolate counts", methodology.isolate_counts],
    ["Reporting threshold", methodology.reporting_threshold],
    ["Suppression", methodology.suppression],
    ["Quality gating", methodology.quality_gating],
    ["AST interpretation standard", methodology.ast_interpretation_standard],
    ["Definition of % susceptible", methodology.susceptibility_definition],
    ["Limitations", methodology.limitations],
  ];

  return (
    <details className="rounded-[--radius-card] border border-line bg-surface">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-brand-700">
        How was this calculated?
      </summary>
      <div className="space-y-4 border-t border-line px-4 py-4 text-sm">
        {provisional ? (
          <p className="rounded border border-sir-i/40 bg-sir-i/5 px-3 py-2 text-xs text-ink">
            One or more methodology parameters are <strong>provisional</strong>, pending sign-off
            of the open questions in the design document. Figures computed under a provisional
            rule may change when it is confirmed.
          </p>
        ) : null}

        <dl className="space-y-3">
          {sections.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                {label}
              </dt>
              <dd className="mt-0.5 text-ink">{renderValue(value)}</dd>
            </div>
          ))}
        </dl>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Methodology versions applied
          </h3>
          <ul className="mt-1 space-y-1">
            {versions.map((entry) => (
              <li key={entry.component} className="text-xs text-ink">
                <span className="font-medium">{entry.component}</span> · {entry.version}
                {entry.provisional ? (
                  <span className="ml-1 text-sir-i">(provisional)</span>
                ) : null}
                <span className="block text-ink-muted">{entry.description}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}

function renderValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) {
    return (
      <ul className="list-disc space-y-0.5 pl-5">
        {value.map((entry, index) => (
          <li key={index}>{renderValue(entry)}</li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    return (
      <ul className="space-y-0.5">
        {Object.entries(value as Record<string, unknown>).map(([key, nested]) => (
          <li key={key} className="text-xs">
            <span className="text-ink-muted">{key.replaceAll("_", " ")}: </span>
            <span className="tabular">{renderValue(nested)}</span>
          </li>
        ))}
      </ul>
    );
  }
  return String(value);
}
