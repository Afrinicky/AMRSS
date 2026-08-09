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
}: {
  organisms: OrganismSites[];
  total: number;
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
                  <text
                    x={0}
                    y={top + GROUP_HEIGHT - 9}
                    fontSize="12.5"
                    fontStyle="italic"
                    fontWeight="600"
                    fill="var(--color-ink)"
                  >
                    {row.name}
                  </text>
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
