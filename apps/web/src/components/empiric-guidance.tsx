import { EmpiricFigure } from "@/components/figures";
import { FigureDownload } from "@/components/figure-download";
import type { EmpiricResponse } from "@/lib/api";

/**
 * Empiric-therapy support for one infection site.
 *
 * The clinician's question is "an infection of this site, no culture yet — what
 * do I start?", and the honest answer has two parts this view leads with. First,
 * which organisms is the patient most likely to have — the prevalence at the
 * site. Second, and the one a prescriber actually acts on: not knowing the
 * organism, which single agent covers the most cases? That is the weighted
 * coverage (WISCA) — each organism's susceptibility weighted by how often it is
 * isolated here — so an agent that is excellent against a rare bug but blind to
 * the common one ranks below one that is merely good against what usually walks
 * in. The per-organism antibiogram is kept underneath as the working, for the
 * reader who wants to see where a coverage number comes from.
 *
 * The whole figure travels: the download beside it produces an Excel workbook
 * with the coverage chart embedded and a sheet each for coverage, prevalence and
 * the per-organism detail — the form a stewardship committee or a paper needs.
 *
 * The framing around all of it is firm by design: this is regional surveillance
 * evidence to weigh alongside local guidelines, stewardship advice and the
 * patient in front of you — never a prescription on its own.
 */

export function EmpiricGuidance({
  empiric,
  siteLabel,
  sterileSite,
  period,
}: {
  empiric: EmpiricResponse;
  siteLabel: string;
  sterileSite: boolean;
  /** Coverage period, stamped into every downloaded figure and sheet. */
  period?: string;
}) {
  const { prevalence, coverage, antibiogram, total_isolates } = empiric;
  const antibioticName = new Map(antibiogram.antibiotics.map((a) => [a.id, a.name]));
  // Most-isolated organisms first: the pathogens a prescriber is most likely to
  // be treating at this site.
  const organisms = [...antibiogram.rows].sort((a, b) => b.isolate_count - a.isolate_count);

  if (total_isolates === 0) {
    return (
      <div className="space-y-6">
        <GuidanceCaveat />
        <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-6 text-center text-sm text-ink-muted">
          No organism from {siteLabel} reaches the reporting threshold in this period, so no empiric
          guidance can be shown.
        </p>
      </div>
    );
  }

  // The workbook the download builds: the coverage table is the primary sheet,
  // with prevalence and the per-organism detail alongside it, and the chart is
  // embedded as an image. Full rankings here, not the figure's top-ten.
  const coverageData = {
    columns: ["Antimicrobial", "Estimated coverage %", "Isolates covered (est.)", "Organisms contributing"],
    rows: coverage.map((entry) => [
      entry.antibiotic.name,
      entry.coverage_percent.toFixed(1),
      entry.isolates_covered,
      entry.organisms_contributing,
    ]),
  };
  const prevalenceData = {
    columns: ["Organism", "Kingdom", "Isolates", "% of site"],
    rows: prevalence.map((share) => [
      share.organism.name,
      share.organism_kingdom === "fungi" ? "Fungi" : "Bacteria",
      share.isolate_count,
      share.percent_of_site.toFixed(1),
    ]),
  };
  const byOrganismData = {
    columns: ["Organism", "Antimicrobial", "Susceptible %", "Interpretable (n)"],
    rows: organisms.flatMap((row) =>
      row.cells
        .filter((cell) => cell.state === "reportable")
        .sort((a, b) => (b.susceptible_percent ?? 0) - (a.susceptible_percent ?? 0))
        .map((cell) => [
          row.organism.name,
          antibioticName.get(cell.antibiotic_id) ?? cell.antibiotic_id,
          cell.susceptible_percent === null ? null : cell.susceptible_percent.toFixed(1),
          cell.interpretable,
        ]),
    ),
  };

  return (
    <div className="space-y-6">
      <GuidanceCaveat />

      {sterileSite ? (
        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
          This is a normally sterile site. A growth here usually represents true infection rather
          than colonisation, which is worth weighing when interpreting these figures.
        </p>
      ) : null}

      <div className="flex justify-end">
        <FigureDownload
          title={`Empiric guidance — ${siteLabel}`}
          period={period}
          data={coverageData}
          extraSheets={[
            { name: "Prevalence", data: prevalenceData },
            { name: "By organism", data: byOrganismData },
          ]}
        >
          <EmpiricFigure
            coverage={coverage}
            prevalence={prevalence}
            siteLabel={siteLabel}
            totalIsolates={total_isolates}
          />
        </FigureDownload>
      </div>

      <OrganismDetail organisms={organisms} antibioticName={antibioticName} siteLabel={siteLabel} />

      <p className="text-xs text-ink-muted">
        Coverage is a weighted-incidence estimate (WISCA): each organism&rsquo;s percent susceptible
        weighted by how often it is isolated at this site. Where a combination is below the reporting
        threshold it is counted as not covered rather than guessed, so a coverage figure is a floor,
        not a promise. Percent susceptible is the share of tested isolates reported as susceptible,
        with its interpretable count (n); laboratories whose quality status is not current are
        excluded throughout.
      </p>
    </div>
  );
}

/**
 * The working underneath the headline figure: for each organism, the agents
 * ranked by how susceptible its isolates were. This is where a prescriber checks
 * "if it is this bug, what works?" and sees the per-organism rates the coverage
 * estimate is built from.
 */
function OrganismDetail({
  organisms,
  antibioticName,
  siteLabel,
}: {
  organisms: EmpiricResponse["antibiogram"]["rows"];
  antibioticName: Map<string, string>;
  siteLabel: string;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-ink">By organism</h2>
      <p className="mt-1 text-xs text-ink-muted">
        If the organism is known, the agents ranked by percent susceptible for each — the per-bug
        detail behind the coverage estimate above.
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {organisms.map((row) => {
          const ranked = row.cells
            .filter((cell) => cell.state === "reportable" && cell.susceptible_percent !== null)
            .sort((a, b) => (b.susceptible_percent ?? 0) - (a.susceptible_percent ?? 0));

          return (
            <article
              key={row.organism.id}
              className="min-w-0 rounded-[--radius-card] border border-line bg-surface p-4"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-medium italic text-ink">{row.organism.name}</h3>
                <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-ink-muted">
                  {row.organism_kingdom === "fungi" ? "Fungal" : "Bacterial"}
                </span>
              </div>
              <p className="tabular mt-1 text-xs text-ink-muted">
                {row.isolate_count.toLocaleString()} isolates from {siteLabel}
              </p>

              {ranked.length > 0 ? (
                <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
                  {ranked.map((cell) => {
                    const percent = cell.susceptible_percent ?? 0;
                    return (
                      <li key={cell.antibiotic_id} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs text-ink">
                          {antibioticName.get(cell.antibiotic_id)}
                        </span>
                        <SusceptibilityBar percent={percent} />
                        <span className="tabular w-24 shrink-0 text-right text-xs text-ink">
                          {percent.toFixed(0)}%
                          <span className="ml-1 text-ink-muted">n={cell.interpretable}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-3 border-t border-line pt-3 text-xs text-ink-muted">
                  No agent reaches the reporting threshold for this organism at this site.
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The line that must never be missed. Prominent by design: this is the one page
 * that ranks agents by likelihood of working, and a ranked list read without
 * its caveats is a prescription the data was never meant to write.
 */
function GuidanceCaveat() {
  return (
    <div className="rounded-[--radius-card] border border-sir-i/40 bg-sir-i/5 px-4 py-3">
      <p className="text-sm font-medium text-ink">Guidance, not a prescription</p>
      <p className="mt-1 text-xs text-ink-muted">
        These are regional susceptibility figures for the organisms commonly isolated from this
        site — evidence to inform an empiric choice before a culture result is available. Weigh
        them against local and national treatment guidelines and antimicrobial stewardship advice.
        They do not account for the individual patient: allergies, severity, pregnancy, renal
        function, where a drug reaches in the body, prior antibiotics, or the local formulary.
        Where a culture and sensitivity result exists, it takes precedence over this.
      </p>
    </div>
  );
}

/** Length encodes the value; colour is a redundant cue for the S/I/R bands. */
function SusceptibilityBar({ percent }: { percent: number }) {
  const tone =
    percent >= 70
      ? "var(--color-sir-s)"
      : percent >= 50
        ? "var(--color-sir-i)"
        : "var(--color-sir-r)";
  return (
    <span aria-hidden className="h-2 w-20 shrink-0 overflow-hidden rounded-full bg-surface-muted">
      <span
        className="block h-full rounded-full"
        style={{ width: `${Math.max(2, percent)}%`, backgroundColor: tone }}
      />
    </span>
  );
}
