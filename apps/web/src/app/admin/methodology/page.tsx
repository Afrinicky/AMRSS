import { EmptyState, ScrollTable, formatDate } from "@/components/admin";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";
import type { MethodologyVersionRow } from "@/lib/api";

export const metadata = { title: "Methodology versions" };

const COMPONENT_LABEL: Record<string, string> = {
  antibiogram: "Antibiogram thresholds",
  deduplication: "Deduplication",
  suppression: "Small-cell suppression",
  emerging_signal_trigger: "Emerging signal trigger",
  phenotype_flags: "Phenotype flags",
  ast_breakpoints: "AST breakpoints",
};

const COMPONENT_NOTE: Record<string, string> = {
  antibiogram: "The n below which a combination is not reported as a percentage (CLSI M39).",
  deduplication: "The first-isolate-per-patient window and its scope.",
  suppression: "The cell size below which counts are withheld to prevent re-identification.",
  emerging_signal_trigger: "The change in susceptibility that raises a signal for review.",
  phenotype_flags: "Screening-level rules. Never confirmatory mechanism detection.",
  ast_breakpoints: "The laboratory's licensed CLSI table, loaded rather than shipped.",
};

/**
 * Methodology versions (SDD 5.9, ADR-0003).
 *
 * No threshold, window length or trigger value appears as a literal anywhere in
 * the analytics engine — every one is read from here, and the version that
 * supplied it is stamped onto the result. This page exists so that a number
 * computed today stays explicable after the rule behind it is tuned: an
 * epidemiologist disputing a figure can see exactly which rule set produced it
 * and when that set took effect.
 */
export default async function MethodologyPage() {
  const profile = await requireProfile();
  const versions = await api.methodologyVersions();

  const byComponent = new Map<string, MethodologyVersionRow[]>();
  for (const version of versions) {
    byComponent.set(version.component, [...(byComponent.get(version.component) ?? []), version]);
  }

  const provisional = versions.filter((v) => v.is_provisional).length;
  const breakpoints = versions.find((v) => v.component === "ast_breakpoints");

  return (
    <Shell profile={profile} current="/admin">
      <PageHeading
        title="Methodology versions"
        description="Every rule that shapes a published figure, with the date it took effect. No threshold is hardcoded anywhere in the engine."
        aside={
          <>
            <BannerFigure label="Rule sets" value={versions.length} />
            <BannerFigure
              label="Provisional"
              value={provisional}
              detail="Awaiting formal approval"
            />
          </>
        }
      />

      <div className="space-y-6">
        {/* The single most consequential piece of configuration in the system,
            and the one most likely to be missing. Called out rather than left
            as one row among many. */}
        {breakpoints ? (
          <div className="rounded-[--radius-card] border border-brand-600/40 bg-brand-50 px-4 py-3">
            <p className="text-sm font-medium text-ink">
              Breakpoint table loaded: {breakpoints.version}
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              {breakpoints.entry_count?.toLocaleString() ?? "No"} criteria, effective from{" "}
              {formatDate(breakpoints.effective_from)}. Zone diameters and MICs are interpreted
              against this table; measurements it does not cover stay pending rather than being
              guessed at.
            </p>
          </div>
        ) : (
          <div className="rounded-[--radius-card] border border-accent-strong/45 bg-accent/10 px-4 py-3">
            <p className="text-sm font-medium text-ink">No breakpoint table is loaded</p>
            <p className="mt-1 text-xs text-ink-muted">
              Zone diameters and MIC values are being stored but cannot be interpreted, so they
              contribute to no susceptibility rate and the antibiogram will look far emptier than
              the data behind it. AMRSS ships no breakpoint values — CLSI tables are copyrighted
              and a single mistyped threshold turns an R into an S on a real patient&rsquo;s
              report — so each laboratory imports its own licensed copy.
            </p>
          </div>
        )}

        {versions.length === 0 ? (
          <EmptyState>No methodology version has been recorded yet.</EmptyState>
        ) : (
          [...byComponent.entries()].map(([component, rows]) => (
            <section key={component} aria-labelledby={`${component}-heading`}>
              <h2
                id={`${component}-heading`}
                className="heading-rule mb-1 text-lg font-semibold text-ink"
              >
                {COMPONENT_LABEL[component] ?? component}
              </h2>
              {COMPONENT_NOTE[component] ? (
                <p className="mb-3 max-w-3xl text-sm text-ink-muted">
                  {COMPONENT_NOTE[component]}
                </p>
              ) : null}
              <ScrollTable>
                <thead>
                  <tr className="border-b border-line text-left">
                    <th scope="col" className="px-3 py-2 font-medium">Version</th>
                    <th scope="col" className="px-3 py-2 font-medium">Effective from</th>
                    <th scope="col" className="px-3 py-2 font-medium">Scope</th>
                    <th scope="col" className="px-3 py-2 font-medium">Parameters</th>
                    <th scope="col" className="px-3 py-2 font-medium">State</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.id} className="border-b border-line last:border-0">
                      <th scope="row" className="px-3 py-2 text-left font-medium text-ink">
                        {row.version}
                        {/* Rows arrive newest-effective first, so the first one
                            is the set currently in force. */}
                        {index === 0 ? (
                          <span className="ml-2 rounded-full border border-brand-600/40 bg-brand-600/10 px-2 py-0.5 text-[11px] font-normal text-brand-700">
                            In force
                          </span>
                        ) : null}
                        <span className="mt-0.5 block text-xs font-normal text-ink-muted">
                          {row.description}
                        </span>
                      </th>
                      <td className="tabular px-3 py-2 text-ink-muted">
                        {formatDate(row.effective_from)}
                      </td>
                      <td className="px-3 py-2 text-ink-muted">
                        {row.regional_block_id ? "Block-specific" : "All blocks"}
                      </td>
                      <td className="px-3 py-2 text-xs text-ink-muted">
                        {row.entry_count !== null
                          ? `${row.entry_count.toLocaleString()} entries`
                          : row.parameter_keys.join(", ")}
                      </td>
                      <td className="px-3 py-2">
                        {row.is_provisional ? (
                          <span className="whitespace-nowrap rounded-full border border-accent-strong/45 bg-accent/15 px-2.5 py-0.5 text-xs text-ink">
                            Provisional
                          </span>
                        ) : (
                          <span className="whitespace-nowrap rounded-full border border-line bg-surface-muted px-2.5 py-0.5 text-xs text-ink-muted">
                            Approved
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
            </section>
          ))
        )}

        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
          A provisional rule set computes figures normally but has not been formally approved by
          the regional AMR team. It is shown as provisional wherever its numbers appear, rather
          than being treated as settled. Superseded versions are never deleted: a figure
          published under an earlier rule set has to stay explicable after the rule changes.
        </p>
      </div>
    </Shell>
  );
}
