import { SirCell } from "@/components/statistic";
import type { Antibiogram } from "@/lib/api";

/**
 * The antibiogram itself: percent-susceptible by organism and agent.
 *
 * Shared between the signed-in console and the public dashboard so the two can
 * never render the same figures differently. It presents whatever the caller was
 * given — the API decides suppression and scope before the data reaches here.
 */

const KINGDOM_HEADING = { bacteria: "Bacteria", fungi: "Fungi" } as const;

export function AntibiogramTable({
  antibiogram,
  period,
}: {
  antibiogram: Antibiogram;
  period: string;
}) {
  const kingdoms = ["bacteria", "fungi"] as const;

  return (
    <div className="space-y-6">
      <Legend
        minimumIsolates={antibiogram.minimum_isolates}
        smallCellThreshold={antibiogram.small_cell_threshold}
        suppressionApplied={antibiogram.suppression_applied}
      />

      {kingdoms.map((kingdom) => {
        const rows = antibiogram.rows.filter((row) => row.organism_kingdom === kingdom);
        if (rows.length === 0) return null;

        // Only agents actually tested in this kingdom, so the fungal table is not
        // mostly empty columns of antibacterials.
        const columns = antibiogram.antibiotics.filter((antibiotic) =>
          rows.some((row) =>
            row.cells.some(
              (cell) => cell.antibiotic_id === antibiotic.id && cell.state !== "not_tested",
            ),
          ),
        );

        return (
          <section key={kingdom} aria-labelledby={`${kingdom}-heading`}>
            <h2
              id={`${kingdom}-heading`}
              className="heading-rule mb-3 text-lg font-semibold text-ink"
            >
              {KINGDOM_HEADING[kingdom]}
            </h2>

            {/* The table scrolls inside its own container so the page body never
                scrolls sideways on a narrow screen. */}
            <div className="overflow-x-auto rounded-[--radius-card] border border-line bg-surface">
              <table className="banded w-full border-collapse text-sm">
                <caption className="sr-only">
                  Percent susceptible by organism and antimicrobial agent, {period}
                </caption>
                <thead>
                  <tr>
                    <th
                      scope="col"
                      className="sticky left-0 z-10 border border-line bg-surface-muted px-3 py-2 text-left font-medium text-ink"
                    >
                      Organism
                    </th>
                    <th
                      scope="col"
                      className="border border-line bg-surface-muted px-3 py-2 text-right font-medium text-ink"
                    >
                      Isolates
                    </th>
                    {columns.map((antibiotic) => (
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
                  {rows.map((row) => {
                    const byId = new Map(row.cells.map((cell) => [cell.antibiotic_id, cell]));
                    return (
                      <tr key={row.organism.id}>
                        <th
                          scope="row"
                          className="sticky left-0 z-10 border border-line bg-surface px-3 py-2 text-left font-medium italic text-ink"
                        >
                          {row.organism.name}
                        </th>
                        <td className="tabular border border-line px-3 py-2 text-right text-ink-muted">
                          {row.isolate_count.toLocaleString()}
                        </td>
                        {columns.map((antibiotic) => {
                          const cell = byId.get(antibiotic.id);
                          if (!cell) {
                            return (
                              <td
                                key={antibiotic.id}
                                className="insufficient-fill border border-line px-2 py-1.5 text-center"
                              >
                                <span className="text-[11px] text-insufficient-ink">Not tested</span>
                              </td>
                            );
                          }
                          return <SirCell key={antibiotic.id} cell={cell} period={period} />;
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function Legend({
  minimumIsolates,
  smallCellThreshold,
  suppressionApplied,
}: {
  minimumIsolates: number;
  smallCellThreshold: number;
  suppressionApplied: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[--radius-card] border border-line bg-surface px-4 py-3 text-xs text-ink-muted">
      <span className="font-medium text-ink">Reading this table</span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm"
          style={{ backgroundColor: "color-mix(in srgb, var(--color-sir-s) 40%, transparent)" }}
        />
        ≥70% susceptible
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm"
          style={{ backgroundColor: "color-mix(in srgb, var(--color-sir-i) 40%, transparent)" }}
        />
        50–69%
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm"
          style={{ backgroundColor: "color-mix(in srgb, var(--color-sir-r) 40%, transparent)" }}
        />
        &lt;50%
      </span>
      <span className="flex items-center gap-1.5">
        <span className="insufficient-fill inline-block size-3 rounded-sm border border-line" />
        Insufficient data (n &lt; {minimumIsolates})
        {suppressionApplied ? ` or withheld (n < ${smallCellThreshold})` : ""}
      </span>
      <span>Each cell shows percent susceptible and its isolate count.</span>
    </div>
  );
}
