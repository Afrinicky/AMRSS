import type { Antibiogram } from "@/lib/api";

/**
 * Empiric-therapy support for one infection site.
 *
 * The clinician's question is "an infection of this site, no culture yet — what
 * is most likely to work?", so unlike the antibiogram (which lists agents in a
 * fixed order on purpose), this ranks each organism's agents by how susceptible
 * they were. That ranking is a prescribing prompt, which is exactly what the
 * clinician asked for and exactly why the framing around it has to be firm: it
 * is regional surveillance evidence to weigh alongside local guidelines and
 * stewardship advice, and it knows nothing of the patient in front of you.
 */

export function EmpiricGuidance({
  antibiogram,
  siteLabel,
  sterileSite,
}: {
  antibiogram: Antibiogram;
  siteLabel: string;
  sterileSite: boolean;
}) {
  const antibioticName = new Map(antibiogram.antibiotics.map((a) => [a.id, a.name]));
  // Most-isolated organisms first: the pathogens a prescriber is most likely to
  // be treating at this site.
  const organisms = [...antibiogram.rows].sort((a, b) => b.isolate_count - a.isolate_count);

  return (
    <div className="space-y-6">
      <GuidanceCaveat />

      {sterileSite ? (
        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
          This is a normally sterile site. A growth here usually represents true infection rather
          than colonisation, which is worth weighing when interpreting these figures.
        </p>
      ) : null}

      {organisms.length === 0 ? (
        <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-6 text-center text-sm text-ink-muted">
          No organism from {siteLabel} reaches the reporting threshold in this period, so no
          susceptibility can be shown.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
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
      )}

      <p className="text-xs text-ink-muted">
        Percent susceptible is the share of tested isolates the laboratory reported as susceptible,
        with its isolate count (n). Combinations below the reporting threshold, and laboratories
        whose quality status is not current, are excluded — so a highly active agent with a small n
        should be read with more caution than the percentage alone suggests.
      </p>
    </div>
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
