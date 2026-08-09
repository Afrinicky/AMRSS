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

import type { AntibioticProfile, OrganismSites } from "@/lib/api";

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
 * The site-of-infection palette.
 *
 * The multi-series family, never the clinical one. A site of infection carries
 * no severity, and a blood-culture segment drawn in the Resistant red would be
 * read as a resistance finding by anyone scanning the page. These hues are also
 * mutually distinct rather than a single-hue ramp, because the question the
 * chart answers is "which sites", not "how much" — categories, not magnitude.
 *
 * Colour is never the only encoding: every segment above a readable width
 * carries its count, each bar is annotated with its principal site, and the
 * whole figure is backed by a table.
 */
const SITE_FILLS = [
  "var(--color-series-4)",
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-5)",
  "var(--color-series-6)",
];
const SITE_OTHER_FILL = "var(--color-sir-nt)";

function siteFill(site: string, order: string[]): string {
  const index = order.indexOf(site);
  if (index < 0 || index >= SITE_FILLS.length) return SITE_OTHER_FILL;
  return SITE_FILLS[index];
}

function humanise(site: string): string {
  const spaced = site.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Organisms and the sites of infection they were recovered from.
 *
 * One bar per organism, segmented by site: the length says how many isolates of
 * that organism there were, and the segmentation says where in the body they
 * came from. Both readings matter — *E. coli* recovered almost entirely from
 * urine is a different clinical problem from *E. coli* appearing in blood, even
 * at the same total.
 *
 * Bars are scaled against the largest organism rather than each normalised to
 * 100%, so a reader cannot mistake a six-isolate organism for a dominant one.
 */
export function OrganismSiteChart({
  organisms,
  sites,
  total,
}: {
  organisms: OrganismSites[];
  sites: string[];
  total: number;
}) {
  if (organisms.length === 0) {
    return (
      <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-6 text-center text-sm text-ink-muted">
        No organism reaches the reporting threshold in this period.
      </p>
    );
  }

  const plotWidth = 440;
  const maximum = Math.max(...organisms.map((entry) => entry.isolate_count));
  const height = organisms.length * (ROW_HEIGHT + ROW_GAP);
  // Wide enough for the full annotation on a full-width bar — a five-figure
  // count plus "mostly Gastrointestinal tract", the longest site name in the
  // dictionary. A tighter gutter clipped it on the largest organism, which is
  // exactly the row a reader looks at first.
  const totalWidth = LABEL_WIDTH + plotWidth + 230;

  // Only the sites actually drawn, in the order the API listed them, so the
  // legend never advertises a category absent from the chart.
  const drawn = sites.filter((site) =>
    organisms.some((organism) => organism.sites.some((entry) => entry.infection_site === site)),
  );

  return (
    <figure className="rounded-[--radius-card] border border-line bg-surface p-4">
      <figcaption className="mb-2 text-sm font-medium text-ink">
        Organisms isolated and their sites of infection{" "}
        <span className="tabular font-normal text-ink-muted">(n = {total.toLocaleString()})</span>
      </figcaption>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${totalWidth} ${height}`}
          width="100%"
          style={{ minWidth: 760, maxWidth: "100%" }}
          role="img"
          aria-label={`Isolate counts for ${organisms.length} organisms, split by site of infection, ${total} isolates in total`}
        >
          <defs>
            <pattern
              id="withheld-hatch"
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" fill="var(--color-insufficient)" />
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="6"
                stroke="var(--color-insufficient-ink)"
                strokeWidth="1.5"
              />
            </pattern>
          </defs>

          {organisms.map((organism, index) => {
            const y = index * (ROW_HEIGHT + ROW_GAP);
            const barWidth =
              maximum > 0 ? (organism.isolate_count / maximum) * plotWidth : 0;

            let x = LABEL_WIDTH;
            return (
              <g key={organism.organism.id}>
                <text
                  x={LABEL_WIDTH - VALUE_GUTTER}
                  y={y + ROW_HEIGHT / 2}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize="12"
                  fontStyle="italic"
                  fill="var(--color-ink)"
                >
                  {organism.organism.name}
                </text>

                {organism.sites.map((entry) => {
                  const width =
                    organism.isolate_count > 0
                      ? (entry.isolate_count / organism.isolate_count) * barWidth
                      : 0;
                  const start = x;
                  x += width;
                  return (
                    <g key={entry.infection_site}>
                      <rect
                        x={start}
                        y={y}
                        width={Math.max(0, width)}
                        height={ROW_HEIGHT}
                        fill={siteFill(entry.infection_site, drawn)}
                      />
                      {width >= 24 ? (
                        <text
                          x={start + width / 2}
                          y={y + ROW_HEIGHT / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize="11"
                          fontWeight="600"
                          fill="#ffffff"
                        >
                          {entry.isolate_count}
                        </text>
                      ) : null}
                    </g>
                  );
                })}

                {/* Sites too small to report are drawn, not dropped. Omitting
                    them would leave a gap that reads as a rendering fault; a
                    neutral hatched block says the data exists and is withheld. */}
                {organism.withheld_isolates > 0 ? (
                  <rect
                    x={x}
                    y={y}
                    width={Math.max(
                      0,
                      (organism.withheld_isolates / organism.isolate_count) * barWidth,
                    )}
                    height={ROW_HEIGHT}
                    fill="url(#withheld-hatch)"
                    stroke="var(--color-line)"
                    strokeWidth="0.5"
                  />
                ) : null}

                {/* Total and principal site outside the bar: the count qualifies
                    the row, and naming the dominant site means the chart is read
                    correctly without decoding the legend. */}
                <text
                  x={LABEL_WIDTH + Math.max(2, barWidth) + VALUE_GUTTER}
                  y={y + ROW_HEIGHT / 2}
                  dominantBaseline="central"
                  fontSize="11"
                  fill="var(--color-ink-muted)"
                >
                  {organism.isolate_count.toLocaleString()}
                  {organism.principal_site ? ` · mostly ${humanise(organism.principal_site)}` : ""}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <ul className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-ink-muted">
        {drawn.map((site) => (
          <li key={site} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-3 rounded-sm"
              style={{ backgroundColor: siteFill(site, drawn) }}
            />
            {humanise(site)}
          </li>
        ))}
        {organisms.some((organism) => organism.withheld_isolates > 0) ? (
          <li className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="insufficient-fill inline-block size-3 rounded-sm border border-line"
            />
            Site withheld (too few isolates)
          </li>
        ) : null}
      </ul>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-brand-700">
          View as table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="banded w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th scope="col" className="px-3 py-2 font-medium">Organism</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Isolates</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">% of total</th>
                {drawn.map((site) => (
                  <th key={site} scope="col" className="px-3 py-2 text-right font-medium">
                    {humanise(site)}
                  </th>
                ))}
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Withheld
                </th>
              </tr>
            </thead>
            <tbody className="tabular">
              {organisms.map((organism) => {
                const bySite = new Map(
                  organism.sites.map((entry) => [entry.infection_site, entry.isolate_count]),
                );
                return (
                  <tr key={organism.organism.id} className="border-b border-line last:border-0">
                    <th scope="row" className="px-3 py-1.5 text-left font-normal italic">
                      {organism.organism.name}
                    </th>
                    <td className="px-3 py-1.5 text-right">
                      {organism.isolate_count.toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-right text-ink-muted">
                      {organism.percent_of_total.toFixed(0)}%
                    </td>
                    {drawn.map((site) => (
                      <td key={site} className="px-3 py-1.5 text-right">
                        {bySite.get(site)?.toLocaleString() ?? "—"}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right text-ink-muted">
                      {organism.withheld_isolates > 0
                        ? organism.withheld_isolates.toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
