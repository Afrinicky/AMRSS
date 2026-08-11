import { EmptyState, ScrollTable, formatDate } from "@/components/admin";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Regional blocks" };

/**
 * Regional block management (SDD 9.3, ADR-0002).
 *
 * A block is a row, never a special case in code. Nothing in AMRSS names a
 * region — the first block was created through this same mechanism, and the
 * second is an afternoon of data entry rather than a release. A test enforces
 * that no region name appears in application source.
 */
export default async function BlocksPage() {
  const profile = await requireProfile();
  const blocks = await api.blocks();

  const districts = blocks.reduce((sum, b) => sum + b.district_count, 0);
  const facilities = blocks.reduce((sum, b) => sum + b.facility_count, 0);

  return (
    <Shell profile={profile} current="/console/admin">
      <PageHeading
        title="Regional blocks"
        description="Governed surveillance blocks and their districts. Adding one is an administrative action, never a code change."
        aside={
          <>
            <BannerFigure label="Blocks" value={blocks.length} detail={`${districts} districts`} />
            <BannerFigure label="Facilities" value={facilities} detail="Across all blocks" />
          </>
        }
      />

      <div className="space-y-6">
        {blocks.length === 0 ? (
          <EmptyState>
            No regional block exists yet. A block needs a code, a name, a governing body and at
            least one district before any laboratory can be enrolled into it.
          </EmptyState>
        ) : (
          <ScrollTable>
            <caption className="sr-only">Regional blocks and their coverage</caption>
            <thead>
              <tr className="border-b border-line text-left">
                <th scope="col" className="px-3 py-2 font-medium">Block</th>
                <th scope="col" className="px-3 py-2 font-medium">Code</th>
                <th scope="col" className="px-3 py-2 font-medium">Governing body</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Districts</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Facilities</th>
                <th scope="col" className="px-3 py-2 font-medium">WHONET standard</th>
                <th scope="col" className="px-3 py-2 font-medium">Activated</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((block) => (
                <tr key={block.id} className="border-b border-line last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-medium text-ink">
                    {block.name}
                  </th>
                  <td className="px-3 py-2">
                    <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs">
                      {block.code}
                    </code>
                  </td>
                  <td className="px-3 py-2 text-ink-muted">{block.governing_body}</td>
                  <td className="tabular px-3 py-2 text-right">{block.district_count}</td>
                  <td className="tabular px-3 py-2 text-right">{block.facility_count}</td>
                  <td className="px-3 py-2 text-ink-muted">
                    {/* Uploads declaring a different version are flagged, not
                        silently accepted or rejected (SDD 3.5). */}
                    {block.whonet_config_standard ?? (
                      <span className="text-accent-strong">Not set</span>
                    )}
                  </td>
                  <td className="tabular px-3 py-2 text-ink-muted">
                    {formatDate(block.activated_on)}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}

        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
          Enrolling a further region is a configuration and onboarding exercise: create the block
          and its districts, enrol its laboratories, load its methodology. No schema change and no
          release are involved, which is the property the architecture exists to preserve.
        </p>
      </div>
    </Shell>
  );
}
