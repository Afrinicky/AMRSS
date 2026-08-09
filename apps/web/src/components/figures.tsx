/**
 * Report figures, drawn as inline SVG.
 *
 * No charting library. These are simple bar geometries, and a dependency would
 * buy nothing while costing a client bundle, a Content-Security-Policy exception
 * and a rendering path that only runs in the browser. Server-rendered SVG prints,
 * survives a slow facility connection, and needs no JavaScript at all.
 *
 * Accessibility is not an afterthought here: a chart that only communicates
 * through colour and length excludes part of any clinical audience. Every
 * segment carries its numeric value, and each chart is backed by a real table
 * exposed to assistive technology.
 */

import type { AntibioticProfile, SpecimenCount } from "@/lib/api";

const ROW_HEIGHT = 26;
const ROW_GAP = 6;
// Wide enough for the longest agent names in the dictionary
// ("Trimethoprim-sulfamethoxazole", "Piperacillin-tazobactam"), which were
// being clipped at a narrower value.
const LABEL_WIDTH = 200;
// Room for a four-digit n plus its prefix; regional counts reach five figures.
const N_GUTTER = 62;
const VALUE_GUTTER = 8;

/**
 * Horizontal 100% stacked bar per agent: susceptible, intermediate, resistant.
 *
 * Uses the clinical palette directly — this is the one place a bar *is* the
 * susceptibility category, so semantic colour is correct rather than decorative.
 */
export function AntibioticProfileChart({
  profiles,
  period,
}: {
  profiles: AntibioticProfile[];
  period: string;
}) {
  if (profiles.length === 0) {
    return (
      <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-6 text-center text-sm text-ink-muted">
        No agent has enough interpretable results to chart in this period.
      </p>
    );
  }

  const plotWidth = 620;
  const height = profiles.length * (ROW_HEIGHT + ROW_GAP);
  const totalWidth = LABEL_WIDTH + plotWidth + N_GUTTER;

  return (
    <figure className="rounded-[--radius-card] border border-line bg-surface p-4">
      <figcaption className="sr-only">
        Percentage susceptible, intermediate and resistant for each antimicrobial agent, {period}
      </figcaption>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${totalWidth} ${height + 26}`}
          width="100%"
          style={{ minWidth: 700, maxWidth: "100%" }}
          role="img"
          aria-label={`Susceptibility profile for ${profiles.length} antimicrobial agents`}
        >
          {profiles.map((profile, index) => {
            const y = index * (ROW_HEIGHT + ROW_GAP);
            const s = (profile.susceptible_percent / 100) * plotWidth;
            const i = (profile.intermediate_percent / 100) * plotWidth;
            const r = Math.max(0, plotWidth - s - i);

            const segments = [
              { width: s, fill: "var(--color-sir-s)", value: profile.susceptible_percent },
              { width: i, fill: "var(--color-sir-i)", value: profile.intermediate_percent },
              { width: r, fill: "var(--color-sir-r)", value: profile.resistant_percent },
            ];

            let x = LABEL_WIDTH;
            return (
              <g key={profile.antibiotic.id}>
                <text
                  x={LABEL_WIDTH - VALUE_GUTTER}
                  y={y + ROW_HEIGHT / 2}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize="12"
                  fill="var(--color-ink)"
                >
                  {profile.antibiotic.name}
                </text>

                {segments.map((segment, position) => {
                  const start = x;
                  x += segment.width;
                  // A value is printed only where its own segment can hold it;
                  // otherwise the labels of adjacent slim segments overlap and
                  // the chart becomes less readable than no label at all.
                  const showValue = segment.width >= 26 && segment.value >= 1;
                  return (
                    <g key={position}>
                      <rect
                        x={start}
                        y={y}
                        width={Math.max(0, segment.width)}
                        height={ROW_HEIGHT}
                        fill={segment.fill}
                      />
                      {showValue ? (
                        <text
                          x={start + segment.width / 2}
                          y={y + ROW_HEIGHT / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize="11"
                          fontWeight="600"
                          fill="#ffffff"
                        >
                          {segment.value.toFixed(0)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}

                {/* n sits outside the bar: it qualifies the whole row, and a
                    percentage without it is not a statistic (SDD 11.3). */}
                <text
                  x={LABEL_WIDTH + plotWidth + VALUE_GUTTER}
                  y={y + ROW_HEIGHT / 2}
                  dominantBaseline="central"
                  fontSize="10"
                  fill="var(--color-ink-muted)"
                >
                  n={profile.interpretable}
                </text>
              </g>
            );
          })}

          {[0, 25, 50, 75, 100].map((tick) => (
            <text
              key={tick}
              x={LABEL_WIDTH + (tick / 100) * plotWidth}
              y={height + 14}
              textAnchor="middle"
              fontSize="10"
              fill="var(--color-ink-muted)"
            >
              {tick}%
            </text>
          ))}
        </svg>
      </div>

      <Legend />

      {/* The same numbers as a table, for screen readers and for anyone who
          needs the exact values rather than the shape. */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-brand-700">
          View as table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="banded w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th scope="col" className="px-3 py-2 font-medium">Agent</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">%S</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">%I</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">%R</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">n</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Organisms</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {profiles.map((profile) => (
                <tr key={profile.antibiotic.id} className="border-b border-line last:border-0">
                  <th scope="row" className="px-3 py-1.5 text-left font-normal">
                    {profile.antibiotic.name}
                  </th>
                  <td className="px-3 py-1.5 text-right">{profile.susceptible_percent}</td>
                  <td className="px-3 py-1.5 text-right">{profile.intermediate_percent}</td>
                  <td className="px-3 py-1.5 text-right">{profile.resistant_percent}</td>
                  <td className="px-3 py-1.5 text-right">{profile.interpretable}</td>
                  <td className="px-3 py-1.5 text-right text-ink-muted">
                    {profile.organism_count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function Legend() {
  const items = [
    { label: "Susceptible", fill: "var(--color-sir-s)" },
    { label: "Intermediate", fill: "var(--color-sir-i)" },
    { label: "Resistant", fill: "var(--color-sir-r)" },
  ];
  return (
    <ul className="mt-3 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-ink-muted">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-3 rounded-sm"
            style={{ backgroundColor: item.fill }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Where the isolates came from.
 *
 * Single-hue bars: these are counts of one thing, not categories being compared,
 * so varying the colour would imply a distinction that does not exist. Brand
 * green is correct here precisely because nothing clinical is being encoded.
 */
export function SpecimenDistributionChart({
  specimens,
  total,
}: {
  specimens: SpecimenCount[];
  total: number;
}) {
  if (specimens.length === 0) {
    return (
      <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-6 text-center text-sm text-ink-muted">
        No specimen type reaches the reporting threshold in this period.
      </p>
    );
  }

  const plotWidth = 420;
  const maximum = Math.max(...specimens.map((entry) => entry.isolate_count));
  const height = specimens.length * (ROW_HEIGHT + ROW_GAP);

  return (
    <figure className="rounded-[--radius-card] border border-line bg-surface p-4">
      <figcaption className="mb-2 text-sm font-medium text-ink">
        Specimen types yielding isolates{" "}
        <span className="tabular font-normal text-ink-muted">(n = {total.toLocaleString()})</span>
      </figcaption>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${LABEL_WIDTH + plotWidth + 110} ${height}`}
          width="100%"
          style={{ minWidth: 520, maxWidth: "100%" }}
          role="img"
          aria-label={`Isolate counts across ${specimens.length} specimen types, ${total} isolates in total`}
        >
          {specimens.map((entry, index) => {
            const y = index * (ROW_HEIGHT + ROW_GAP);
            const width = maximum > 0 ? (entry.isolate_count / maximum) * plotWidth : 0;
            return (
              <g key={entry.specimen_type.id}>
                <text
                  x={LABEL_WIDTH - VALUE_GUTTER}
                  y={y + ROW_HEIGHT / 2}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize="12"
                  fill="var(--color-ink)"
                >
                  {entry.specimen_type.name}
                </text>
                <rect
                  x={LABEL_WIDTH}
                  y={y}
                  width={Math.max(2, width)}
                  height={ROW_HEIGHT}
                  fill="var(--color-brand-600)"
                  rx="2"
                />
                <text
                  x={LABEL_WIDTH + Math.max(2, width) + VALUE_GUTTER}
                  y={y + ROW_HEIGHT / 2}
                  dominantBaseline="central"
                  fontSize="11"
                  fill="var(--color-ink)"
                >
                  {entry.isolate_count.toLocaleString()} ({entry.percent_of_total.toFixed(0)}%)
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}
