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

import type { AntibioticProfile, OrganismSites, SpecimenCount, TrendPoint } from "@/lib/api";

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
                <a href={`/antibiotics/${profile.antibiotic.id}`}>
                  <text
                    x={LABEL_WIDTH - VALUE_GUTTER}
                    y={y + ROW_HEIGHT / 2}
                    textAnchor="end"
                    dominantBaseline="central"
                    fontSize="12"
                    fill="var(--color-brand-700)"
                    style={{ textDecoration: "underline" }}
                  >
                    {profile.antibiotic.name}
                  </text>
                </a>

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
 * Bar fill for the organism figure.
 *
 * Deep blue from the multi-series family, never the clinical palette. These bars
 * are counts of isolates, not susceptibility categories, and drawing them in the
 * brand green or in any of the S/I/R hues would invite a reader scanning the
 * page to see a clinical judgement where none is being made. Blue carries no
 * severity reading in this system, which is precisely why it is correct here.
 *
 * One hue throughout rather than one per site: every bar measures the same
 * thing, so varying the colour would imply a distinction that does not exist.
 */
const COUNT_FILL = "var(--color-series-1)";

function humanise(site: string): string {
  const spaced = site.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const GROUP_HEIGHT = 30;
const BAR_HEIGHT = 22;
const BAR_GAP = 5;
const SITE_INDENT = 14;
/** Room for "1,308 (30%)" beyond the end of the longest bar. */
const COUNT_GUTTER = 116;

type Row =
  | { kind: "organism"; key: string; name: string; count: number; percent: number }
  | {
      kind: "site";
      key: string;
      label: string;
      count: number;
      percent: number;
      withheld: boolean;
    };

/**
 * Organisms and the sites of infection they were recovered from.
 *
 * One bar per site, grouped under the organism it belongs to. Bars are measured
 * against a single scale across the whole figure rather than renormalised within
 * each organism, so a site with twelve isolates cannot be drawn the same length
 * as one with three hundred — the comparison a reader makes by eye is the
 * comparison the data supports.
 *
 * *E. coli* recovered almost entirely from urine is a different clinical problem
 * from *E. coli* appearing in blood, which is why the sites are listed rather
 * than collapsed into the organism total.
 */
export function OrganismSiteChart({
  organisms,
  total,
  scaleMax,
}: {
  organisms: OrganismSites[];
  total: number;
  /** Largest site count the scale must accommodate.
   *
   * Supplied by the caller when the figure is split across several charts —
   * bacteria and fungi, say. Without it each chart would renormalise to its own
   * largest bar and a 38-isolate fungal site would be drawn the same length as a
   * 318-isolate bacterial one, directly contradicting the caption. */
  scaleMax?: number;
}) {
  if (organisms.length === 0) {
    return (
      <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-6 text-center text-sm text-ink-muted">
        No organism reaches the reporting threshold in this period.
      </p>
    );
  }

  const rows: Row[] = [];
  for (const organism of organisms) {
    rows.push({
      kind: "organism",
      key: organism.organism.id,
      name: organism.organism.name,
      count: organism.isolate_count,
      percent: organism.percent_of_total,
    });
    for (const site of organism.sites) {
      rows.push({
        kind: "site",
        key: `${organism.organism.id}:${site.infection_site}`,
        label: humanise(site.infection_site),
        count: site.isolate_count,
        percent: site.percent_of_organism,
        withheld: false,
      });
    }
    if (organism.withheld_isolates > 0) {
      rows.push({
        kind: "site",
        key: `${organism.organism.id}:withheld`,
        label: "Site withheld (too few isolates)",
        count: organism.withheld_isolates,
        percent: Math.round((100 * organism.withheld_isolates) / organism.isolate_count),
        withheld: true,
      });
    }
  }

  const plotWidth = 440;
  // One scale for the whole figure. Renormalising per organism would make a
  // twelve-isolate site look like a three-hundred-isolate one.
  const maximum = Math.max(
    scaleMax ?? 0,
    ...rows.filter((row) => row.kind === "site").map((row) => row.count),
    1,
  );
  const height = rows.reduce(
    (running, row) => running + (row.kind === "organism" ? GROUP_HEIGHT : BAR_HEIGHT + BAR_GAP),
    0,
  );
  const hasWithheld = organisms.some((organism) => organism.withheld_isolates > 0);

  let y = 0;
  return (
    <figure className="rounded-[--radius-card] border border-line bg-surface p-4">
      <figcaption className="mb-2 text-sm font-medium text-ink">
        Organisms isolated and their sites of infection{" "}
        <span className="tabular font-normal text-ink-muted">(n = {total.toLocaleString()})</span>
      </figcaption>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${LABEL_WIDTH + plotWidth + COUNT_GUTTER} ${height}`}
          width="100%"
          style={{ minWidth: 640, maxWidth: "100%" }}
          role="img"
          aria-label={`Isolate counts for ${organisms.length} organisms, listed by site of infection, ${total} isolates in total`}
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

          {rows.map((row) => {
            const top = y;
            y += row.kind === "organism" ? GROUP_HEIGHT : BAR_HEIGHT + BAR_GAP;

            if (row.kind === "organism") {
              return (
                <g key={row.key}>
                  {/* Linked inside the SVG so the organism name is the
                      affordance a reader already looks at, rather than a
                      separate "details" column they have to find. */}
                  <a href={`/organisms/${row.key}`}>
                    <text
                      x={0}
                      y={top + GROUP_HEIGHT - 9}
                      fontSize="12.5"
                      fontStyle="italic"
                      fontWeight="600"
                      fill="var(--color-brand-700)"
                      style={{ textDecoration: "underline" }}
                    >
                      {row.name}
                    </text>
                  </a>
                  <text
                    x={LABEL_WIDTH + plotWidth + COUNT_GUTTER}
                    y={top + GROUP_HEIGHT - 9}
                    textAnchor="end"
                    fontSize="11"
                    fill="var(--color-ink-muted)"
                  >
                    {row.count.toLocaleString()} isolates ({row.percent.toFixed(0)}%)
                  </text>
                  <line
                    x1={0}
                    x2={LABEL_WIDTH + plotWidth + COUNT_GUTTER}
                    y1={top + GROUP_HEIGHT - 4}
                    y2={top + GROUP_HEIGHT - 4}
                    stroke="var(--color-line)"
                    strokeWidth="1"
                  />
                </g>
              );
            }

            const width = (row.count / maximum) * plotWidth;
            return (
              <g key={row.key}>
                <text
                  x={LABEL_WIDTH - VALUE_GUTTER}
                  y={top + BAR_HEIGHT / 2}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize="11.5"
                  fill={row.withheld ? "var(--color-insufficient-ink)" : "var(--color-ink)"}
                >
                  {row.label}
                </text>
                <rect
                  x={LABEL_WIDTH + SITE_INDENT}
                  y={top}
                  width={Math.max(2, width)}
                  height={BAR_HEIGHT}
                  fill={row.withheld ? "url(#withheld-hatch)" : COUNT_FILL}
                  stroke={row.withheld ? "var(--color-line)" : "none"}
                  strokeWidth="0.5"
                  rx="2"
                />
                <text
                  x={LABEL_WIDTH + SITE_INDENT + Math.max(2, width) + VALUE_GUTTER}
                  y={top + BAR_HEIGHT / 2}
                  dominantBaseline="central"
                  fontSize="11"
                  fill="var(--color-ink)"
                >
                  {row.count.toLocaleString()} ({row.percent.toFixed(0)}%)
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <p className="mt-3 text-center text-xs text-ink-muted">
        Percentages are of the organism&rsquo;s own isolates. Bars share one scale across the
        whole figure.
        {hasWithheld
          ? " Hatched bars are isolates whose site fell below the reporting threshold and is withheld."
          : ""}
      </p>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-brand-700">
          View as table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="banded w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th scope="col" className="px-3 py-2 font-medium">Organism</th>
                <th scope="col" className="px-3 py-2 font-medium">Site of infection</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Isolates</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">% of organism</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {organisms.map((organism) => (
                <tr key={organism.organism.id} className="border-b border-line last:border-0">
                  <th scope="row" className="px-3 py-1.5 text-left align-top font-normal italic">
                    {organism.organism.name}
                    <span className="ml-1 not-italic text-ink-muted">
                      ({organism.isolate_count.toLocaleString()})
                    </span>
                  </th>
                  <td className="px-3 py-1.5">
                    {organism.sites.map((site) => (
                      <div key={site.infection_site}>{humanise(site.infection_site)}</div>
                    ))}
                    {organism.withheld_isolates > 0 ? (
                      <div className="text-ink-muted">Withheld</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {organism.sites.map((site) => (
                      <div key={site.infection_site}>{site.isolate_count.toLocaleString()}</div>
                    ))}
                    {organism.withheld_isolates > 0 ? (
                      <div className="text-ink-muted">
                        {organism.withheld_isolates.toLocaleString()}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5 text-right text-ink-muted">
                    {organism.sites.map((site) => (
                      <div key={site.infection_site}>{site.percent_of_organism.toFixed(0)}%</div>
                    ))}
                    {organism.withheld_isolates > 0 ? <div>&mdash;</div> : null}
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

/**
 * Where the isolates came from.
 *
 * Single-hue bars: these are counts of one thing, not categories being compared,
 * so varying the colour would imply a distinction that does not exist.
 *
 * The hue is --color-count, a deeper and bluer crimson than the clinical red for
 * Resistant. Nothing clinical is encoded here, and keeping the two reds visibly
 * apart is what stops a tall bar from reading as a resistance finding.
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
                  fill="var(--color-count)"
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

/**
 * Susceptibility over time, as a step-and-point series.
 *
 * Steps rather than a smooth line, and points rather than a continuous stroke,
 * because each value is a discrete bucket aggregate — not a sampled signal. A
 * curve drawn between two quarterly figures implies the intervening weeks were
 * measured, and they were not.
 *
 * Buckets below the reporting threshold are drawn as a visible gap with the
 * isolate count shown beneath. A line that closes over an insufficient bucket
 * would assert continuity the data does not support, which is the single
 * easiest way to make a trend chart lie.
 */
export function TrendChart({
  points,
  minimumIsolates,
  organism,
  antibiotic,
}: {
  points: TrendPoint[];
  minimumIsolates: number;
  organism: string;
  antibiotic: string;
}) {
  const reportable = points.filter((point) => point.sufficient);
  if (reportable.length === 0) {
    return (
      <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-6 text-center text-sm text-ink-muted">
        No period in this range reaches {minimumIsolates} interpretable isolates, so no
        susceptibility rate can be reported for {organism} and {antibiotic}.
      </p>
    );
  }

  const plotWidth = 760;
  const plotHeight = 190;
  const left = 46;
  const top = 12;
  const bottom = top + plotHeight;
  const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;
  const x = (index: number) => left + (points.length > 1 ? index * step : plotWidth / 2);
  const y = (percent: number) => bottom - (percent / 100) * plotHeight;

  // Segments break wherever a bucket is insufficient, so the stroke is not one
  // path with a hole in it but several paths with real gaps between them.
  const segments: { index: number; point: TrendPoint }[][] = [];
  let run: { index: number; point: TrendPoint }[] = [];
  points.forEach((point, index) => {
    if (point.sufficient && point.susceptible_percent !== null) {
      run.push({ index, point });
    } else if (run.length > 0) {
      segments.push(run);
      run = [];
    }
  });
  if (run.length > 0) segments.push(run);

  // The final period's label is centred on the last point, so the box needs
  // half a label's width beyond the plot or it is clipped at the right edge.
  const totalWidth = left + plotWidth + 44;
  const totalHeight = bottom + 46;

  return (
    <figure className="rounded-[--radius-card] border border-line bg-surface p-4">
      <figcaption className="mb-2 text-sm font-medium text-ink">
        Percent susceptible over time — <em>{organism}</em> against {antibiotic}
      </figcaption>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${totalWidth} ${totalHeight}`}
          width="100%"
          style={{ minWidth: 620, maxWidth: "100%" }}
          role="img"
          aria-label={`Percent susceptible for ${organism} against ${antibiotic} across ${points.length} periods`}
        >
          {[0, 25, 50, 75, 100].map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--color-line)"
                strokeWidth="1"
              />
              <text
                x={left - 8}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="central"
                fontSize="10"
                fill="var(--color-ink-muted)"
              >
                {tick}%
              </text>
            </g>
          ))}

          {/* Confidence intervals as a band, drawn beneath the series. The
              interval is the honest width of each estimate; a bare point implies
              a precision that a 40-isolate bucket does not have. */}
          {segments.map((segment, s) => {
            const upper = segment
              .filter(({ point }) => point.confidence_upper !== null)
              .map(({ index, point }) => `${x(index)},${y(point.confidence_upper as number)}`);
            const lower = segment
              .filter(({ point }) => point.confidence_lower !== null)
              .map(({ index, point }) => `${x(index)},${y(point.confidence_lower as number)}`)
              .reverse();
            if (upper.length === 0 || lower.length === 0) return null;
            return (
              <polygon
                key={`band-${s}`}
                points={[...upper, ...lower].join(" ")}
                fill="var(--color-series-1)"
                opacity="0.14"
              />
            );
          })}

          {segments.map((segment, s) => (
            <polyline
              key={`line-${s}`}
              points={segment
                .map(({ index, point }) => `${x(index)},${y(point.susceptible_percent as number)}`)
                .join(" ")}
              fill="none"
              stroke="var(--color-series-1)"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          ))}

          {points.map((point, index) => {
            if (!point.sufficient || point.susceptible_percent === null) {
              // The gap is annotated, not hidden: a reader must be able to tell
              // "no isolates" from "too few to report".
              return (
                <g key={point.label}>
                  <line
                    x1={x(index)}
                    x2={x(index)}
                    y1={top}
                    y2={bottom}
                    stroke="var(--color-insufficient-ink)"
                    strokeWidth="1"
                    strokeDasharray="2 3"
                    opacity="0.5"
                  />
                  <text
                    x={x(index)}
                    y={bottom + 26}
                    textAnchor="middle"
                    fontSize="9"
                    fill="var(--color-insufficient-ink)"
                  >
                    n={point.isolate_count}
                  </text>
                </g>
              );
            }
            return (
              <g key={point.label}>
                <circle
                  cx={x(index)}
                  cy={y(point.susceptible_percent)}
                  r="3.5"
                  fill="var(--color-surface)"
                  stroke="var(--color-series-1)"
                  strokeWidth="2"
                />
                {/* n travels with every point. A percentage without it is not a
                    statistic (SDD 11.3). */}
                <text
                  x={x(index)}
                  y={bottom + 26}
                  textAnchor="middle"
                  fontSize="9"
                  fill="var(--color-ink-muted)"
                >
                  n={point.isolate_count}
                </text>
              </g>
            );
          })}

          {points.map((point, index) => (
            <text
              key={`label-${point.label}`}
              x={x(index)}
              y={bottom + 14}
              textAnchor="middle"
              fontSize="10"
              fill="var(--color-ink)"
            >
              {point.label}
            </text>
          ))}
        </svg>
      </div>

      <ul className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-ink-muted">
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-0.5 w-4 rounded-full"
            style={{ backgroundColor: "var(--color-series-1)" }}
          />
          Percent susceptible
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-3 rounded-sm"
            style={{ backgroundColor: "var(--color-series-1)", opacity: 0.14 }}
          />
          95% confidence interval
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-3 w-0 border-l border-dashed border-insufficient-ink"
          />
          Below {minimumIsolates} isolates — not reported
        </li>
      </ul>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-brand-700">
          View as table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="banded w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th scope="col" className="px-3 py-2 font-medium">Period</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">%S</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">95% CI</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">n</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {points.map((point) => (
                <tr key={point.label} className="border-b border-line last:border-0">
                  <th scope="row" className="px-3 py-1.5 text-left font-normal">
                    {point.label}
                  </th>
                  <td className="px-3 py-1.5 text-right">
                    {point.sufficient && point.susceptible_percent !== null
                      ? `${point.susceptible_percent.toFixed(0)}%`
                      : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right text-ink-muted">
                    {point.confidence_lower !== null && point.confidence_upper !== null
                      ? `${point.confidence_lower.toFixed(0)}–${point.confidence_upper.toFixed(0)}`
                      : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right">{point.isolate_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
