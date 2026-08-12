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
 * The framing around all of it is firm by design: this is regional surveillance
 * evidence to weigh alongside local guidelines, stewardship advice and the
 * patient in front of you — never a prescription on its own.
 */

export function EmpiricGuidance({
  empiric,
  siteLabel,
  sterileSite,
}: {
  empiric: EmpiricResponse;
  siteLabel: string;
  sterileSite: boolean;
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

  return (
    <div className="space-y-6">
      <GuidanceCaveat />

      {sterileSite ? (
        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
          This is a normally sterile site. A growth here usually represents true infection rather
          than colonisation, which is worth weighing when interpreting these figures.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <CoveragePanel coverage={coverage} totalIsolates={total_isolates} siteLabel={siteLabel} />
        <PrevalencePanel prevalence={prevalence} siteLabel={siteLabel} />
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
 * The headline answer: which single agent covers the most cases at this site,
 * ranked best-first. This is the number a prescriber reaches for when the
 * organism is not yet known, so it leads and is given the most weight on the
 * page — a bar for the estimate and, underneath, the working it rests on.
 */
function CoveragePanel({
  coverage,
  totalIsolates,
  siteLabel,
}: {
  coverage: EmpiricResponse["coverage"];
  totalIsolates: number;
  siteLabel: string;
}) {
  return (
    <section className="min-w-0 lg:col-span-3 rounded-[--radius-card] border border-line bg-surface p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">Best empiric coverage</h2>
        <span className="tabular text-[11px] text-ink-muted">
          across {totalIsolates.toLocaleString()} isolates
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Estimated share of {siteLabel} cases each agent would cover, not knowing the organism.
      </p>

      {coverage.length === 0 ? (
        <p className="mt-4 border-t border-line pt-4 text-xs text-ink-muted">
          No agent reaches the reporting threshold across enough of this site&rsquo;s organisms to
          estimate coverage.
        </p>
      ) : (
        <ol className="mt-4 space-y-2.5 border-t border-line pt-4">
          {coverage.map((entry, index) => (
            <li key={entry.antibiotic.id}>
              <div className="flex items-baseline gap-2">
                <span className="tabular w-4 shrink-0 text-xs text-ink-muted">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {entry.antibiotic.name}
                </span>
                <span className="tabular shrink-0 text-sm font-semibold text-ink">
                  {entry.coverage_percent.toFixed(0)}%
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 pl-6">
                <CoverageBar percent={entry.coverage_percent} />
                <span className="tabular shrink-0 text-[11px] text-ink-muted">
                  ~{entry.isolates_covered.toLocaleString()} covered ·{" "}
                  {entry.organisms_contributing} organism
                  {entry.organisms_contributing === 1 ? "" : "s"}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The other half of the empiric question: which organisms is the patient most
 * likely to have? Commonest-first, with each organism's share of the site, so a
 * prescriber can see what the coverage figures are weighted towards.
 */
function PrevalencePanel({
  prevalence,
  siteLabel,
}: {
  prevalence: EmpiricResponse["prevalence"];
  siteLabel: string;
}) {
  return (
    <section className="min-w-0 lg:col-span-2 rounded-[--radius-card] border border-line bg-surface p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-ink">Commonly isolated</h2>
      <p className="mt-1 text-xs text-ink-muted">Organisms most often grown from {siteLabel}.</p>

      <ul className="mt-4 space-y-2.5 border-t border-line pt-4">
        {prevalence.map((share) => (
          <li key={share.organism.id}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-sm italic text-ink">
                {share.organism.name}
              </span>
              <span className="tabular shrink-0 text-sm font-medium text-ink">
                {share.percent_of_site.toFixed(0)}%
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <PrevalenceBar percent={share.percent_of_site} fungal={share.organism_kingdom === "fungi"} />
              <span className="tabular shrink-0 text-[11px] text-ink-muted">
                {share.isolate_count.toLocaleString()}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The working underneath the two headline panels: for each organism, the agents
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

/** Empiric coverage: length is the estimate, colour a redundant band cue. Higher
 *  bands than S/I/R here — an empiric target is usually 80%+ coverage. */
function CoverageBar({ percent }: { percent: number }) {
  const tone =
    percent >= 80
      ? "var(--color-sir-s)"
      : percent >= 60
        ? "var(--color-sir-i)"
        : "var(--color-sir-r)";
  return (
    <span aria-hidden className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted">
      <span
        className="block h-full rounded-full"
        style={{ width: `${Math.max(2, percent)}%`, backgroundColor: tone }}
      />
    </span>
  );
}

/** Prevalence share. Neutral brand tone for bacteria, a distinct tone for fungi
 *  so a fungal pathogen at a site is not mistaken for a bacterial one. */
function PrevalenceBar({ percent, fungal }: { percent: number; fungal: boolean }) {
  const tone = fungal ? "var(--color-sir-i)" : "var(--color-brand-600)";
  return (
    <span aria-hidden className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted">
      <span
        className="block h-full rounded-full"
        style={{ width: `${Math.max(2, percent)}%`, backgroundColor: tone }}
      />
    </span>
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
