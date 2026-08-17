import { EmptyState, ScrollTable, formatDate } from "@/components/admin";
import { Modal } from "@/components/modal";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";
import type { Block, DistrictRef } from "@/lib/api";

import { deleteBlock, deleteDistrict } from "./actions";

export const metadata = { title: "Regional blocks" };

const FIELD = "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink";

/**
 * Regional block management (SDD 9.3, ADR-0002).
 *
 * A block is a row, never a special case in code. Nothing in AMRSS names a
 * region — the first block was created through this same mechanism, and the
 * second is an afternoon of data entry rather than a release. A test enforces
 * that no region name appears in application source.
 */
export default async function BlocksPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;
  const canPurge = profile.permissions.includes("data:purge");
  const [blocks, allDistricts] = await Promise.all([api.blocks(), api.districts()]);

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
        {params.error ? (
          <p role="status" className="rounded-[--radius-card] border border-accent-strong/45 bg-accent/10 px-4 py-3 text-sm text-ink">
            {params.error}
          </p>
        ) : null}
        {params.ok ? (
          <p role="status" className="rounded-[--radius-card] border border-brand-600/40 bg-brand-50 px-4 py-3 text-sm text-ink">
            {params.ok}
          </p>
        ) : null}

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
                    <BlockModal
                      block={block}
                      districts={allDistricts.filter((d) => d.regional_block_id === block.id)}
                      canPurge={canPurge}
                    />
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

/**
 * A block, opened in place. Shows its details and districts, and — for the
 * overall authority — the delete controls, each behind a typed confirmation and
 * the same emptiness rules the API enforces: a district goes only once its
 * facilities are gone, a block only once its districts are.
 */
function BlockModal({
  block,
  districts,
  canPurge,
}: {
  block: Block;
  districts: DistrictRef[];
  canPurge: boolean;
}) {
  return (
    <Modal
      label={`Manage ${block.name}`}
      title={
        <span>
          {block.name}
          <span className="ml-2 font-normal text-ink-muted">{block.code}</span>
        </span>
      }
      triggerLabel={block.name}
      triggerClassName="text-left font-medium text-brand-700 hover:underline"
    >
      <div className="space-y-5">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-muted">Governing body</dt>
            <dd className="text-ink">{block.governing_body}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-muted">WHONET standard</dt>
            <dd className="text-ink">{block.whonet_config_standard ?? "Not set"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-muted">Districts</dt>
            <dd className="text-ink">{block.district_count}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-muted">Facilities</dt>
            <dd className="text-ink">{block.facility_count}</dd>
          </div>
        </dl>

        <div>
          <h3 className="text-sm font-medium text-ink">Districts</h3>
          {districts.length === 0 ? (
            <p className="mt-1 text-xs text-ink-muted">No districts in this block.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
              {districts.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="text-sm text-ink">
                    {d.name}
                    <span className="ml-2 text-xs text-ink-muted">
                      {d.facility_count} {d.facility_count === 1 ? "facility" : "facilities"}
                    </span>
                  </span>
                  {canPurge && d.facility_count === 0 ? (
                    <form action={deleteDistrict} className="flex items-center gap-2">
                      <input type="hidden" name="district_id" value={d.id} />
                      <input
                        name="confirm"
                        autoComplete="off"
                        placeholder={`Type "${d.name}"`}
                        className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
                      />
                      <button
                        type="submit"
                        className="rounded-lg bg-sir-r px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
                      >
                        Delete
                      </button>
                    </form>
                  ) : (
                    <span className="text-xs text-ink-muted">
                      {d.facility_count > 0 ? "Has facilities" : ""}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {canPurge ? (
          <details className="rounded-lg border border-sir-r/40 bg-sir-r/5">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-sir-r">
              Delete this block
            </summary>
            <form action={deleteBlock} className="space-y-2 border-t border-sir-r/30 p-3">
              <input type="hidden" name="block_id" value={block.id} />
              <p className="text-xs text-ink-muted">
                Refused while the block still has districts. Delete its districts first.
              </p>
              <label className="block text-xs uppercase tracking-wide text-ink-muted">
                Type <span className="font-mono text-ink">{block.code}</span> to confirm
              </label>
              <input name="confirm" autoComplete="off" className={FIELD} />
              <button
                type="submit"
                className="rounded-lg bg-sir-r px-3 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Delete block
              </button>
            </form>
          </details>
        ) : null}
      </div>
    </Modal>
  );
}
