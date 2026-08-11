import { EmptyState, ScrollTable } from "@/components/admin";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Dictionary stewardship" };

/**
 * The code-mapping queue (SDD 3.4).
 *
 * Every facility configures WHONET differently. A local code that maps to
 * nothing does not fail loudly — the records carrying it are simply held out of
 * every aggregate, which is the correct behaviour and also an invisible one.
 * This page is what makes it visible.
 *
 * Ordered by how many records carry the code rather than alphabetically: a code
 * on four hundred isolates is holding four hundred isolates out of the
 * antibiogram, and one appearing twice is not. Triage by impact.
 */
export default async function MappingsPage({
  searchParams,
}: {
  searchParams: Promise<{ mapping_status?: string }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;

  const mappings = await api.mappings({ mapping_status: params.mapping_status ?? "proposed" });
  const heldRecords = mappings.reduce((sum, m) => sum + m.observed_record_count, 0);

  return (
    <Shell profile={profile} current="/console/admin">
      <PageHeading
        title="Dictionary stewardship"
        description="Local WHONET codes submitted by facilities, awaiting a mapping onto the canonical dictionary."
        aside={
          <>
            <BannerFigure label="Codes in queue" value={mappings.length} />
            <BannerFigure
              label="Records held"
              value={heldRecords.toLocaleString()}
              detail="Out of every aggregate until mapped"
            />
          </>
        }
      />

      <div className="space-y-6">
        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-sm text-ink-muted">
          A mapping is not a formality. Without this layer a future national antibiogram would
          silently combine incompatible local codes — one facility&rsquo;s{" "}
          <code className="rounded bg-surface px-1 text-xs">STA</code> meaning{" "}
          <em>Staphylococcus aureus</em> and another&rsquo;s meaning{" "}
          <em>Staphylococcus</em> species, added together as though they were the same organism.
          New mappings stay proposed, and the records carrying them stay out of every aggregate,
          until a data steward approves them.
        </p>

        {mappings.length === 0 ? (
          <EmptyState>
            Nothing is waiting for review. Every local code submitted so far has been mapped.
          </EmptyState>
        ) : (
          <ScrollTable>
            <caption className="sr-only">
              Proposed code mappings, most-used code first
            </caption>
            <thead>
              <tr className="border-b border-line text-left">
                <th scope="col" className="px-3 py-2 font-medium">Local code</th>
                <th scope="col" className="px-3 py-2 font-medium">As labelled locally</th>
                <th scope="col" className="px-3 py-2 font-medium">Type</th>
                <th scope="col" className="px-3 py-2 font-medium">Facility</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Records held</th>
                <th scope="col" className="px-3 py-2 font-medium">Proposed mapping</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((mapping) => (
                <tr key={mapping.id} className="border-b border-line last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-medium text-ink">
                    <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs">
                      {mapping.local_code}
                    </code>
                  </th>
                  <td className="px-3 py-2">{mapping.local_label ?? "—"}</td>
                  <td className="px-3 py-2 text-ink-muted">
                    {mapping.entity_type.replace(/_/g, " ")}
                  </td>
                  <td className="px-3 py-2 text-ink-muted">{mapping.facility_name}</td>
                  <td className="tabular px-3 py-2 text-right">
                    {mapping.observed_record_count.toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    {mapping.canonical_code ? (
                      <code className="rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-700">
                        {mapping.canonical_code}
                      </code>
                    ) : (
                      <span className="text-xs text-accent-strong">No suggestion</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </div>
    </Shell>
  );
}
