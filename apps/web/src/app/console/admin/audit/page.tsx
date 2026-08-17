import Link from "next/link";

import { EmptyState, ScrollTable, formatDateTime } from "@/components/admin";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Audit trail" };

const PAGE_SIZE = 50;

/**
 * The audit trail (SDD 10.2).
 *
 * Append-only by construction: there is no update or delete path to this table
 * anywhere in application source, and this page is read-only. That is the point
 * — a trail an administrator can edit is not a trail.
 *
 * Before and after states are both shown. "Status changed to suspended" without
 * "from active" is not an audit entry, it is a rumour, and the reason a change
 * was made is often the only thing that makes it explicable a year later.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; entity?: string; offset?: string }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;

  const offset = Math.max(0, Number.parseInt(params.offset ?? "0", 10) || 0);
  const page = await api.auditTrail({
    action: params.action,
    entity: params.entity,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });

  const shown = page.entries.length;
  const hasNext = offset + shown < page.total;

  const query = (next: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, ...next })) {
      if (value) search.set(key, value);
    }
    const rendered = search.toString();
    return rendered ? `/console/admin/audit?${rendered}` : "/console/admin/audit";
  };

  return (
    <Shell profile={profile} current="/console/admin">
      <PageHeading
        title="Audit trail"
        description="Every consequential action, in the order it happened. Append-only — nothing here can be edited or removed."
        aside={
          <>
            <BannerFigure label="Entries" value={page.total.toLocaleString()} />
            <BannerFigure
              label="Showing"
              value={shown === 0 ? "0" : `${offset + 1}–${offset + shown}`}
            />
          </>
        }
      />

      <div className="space-y-6">
        {/* Built from the actions actually present rather than the full
            vocabulary: a filter offering twenty actions that have never
            occurred is a worse tool than one offering the six that have. */}
        <nav aria-label="Filter by action" className="scroll-row -mx-1 flex gap-2 overflow-x-auto px-1">
          <FilterChip href={query({ action: undefined, offset: undefined })} active={!params.action}>
            All actions
          </FilterChip>
          {page.actions.map((action) => (
            <FilterChip
              key={action}
              href={query({ action, offset: undefined })}
              active={params.action === action}
            >
              {action}
            </FilterChip>
          ))}
        </nav>

        {page.entries.length === 0 ? (
          <EmptyState>
            No audit entry matches this filter.{" "}
            <Link href="/console/admin/audit" className="font-medium text-brand-700">
              Show all
            </Link>
          </EmptyState>
        ) : (
          <ScrollTable>
            <caption className="sr-only">Audit entries, most recent first</caption>
            <thead>
              <tr className="border-b border-line text-left">
                <th scope="col" className="px-3 py-2 font-medium">When</th>
                <th scope="col" className="px-3 py-2 font-medium">Who</th>
                <th scope="col" className="px-3 py-2 font-medium">Action</th>
                <th scope="col" className="px-3 py-2 font-medium">Subject</th>
                <th scope="col" className="px-3 py-2 font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {page.entries.map((entry) => (
                <tr key={entry.id} className="border-b border-line align-top last:border-0">
                  <td className="tabular whitespace-nowrap px-3 py-2 text-xs text-ink-muted">
                    {formatDateTime(entry.occurred_at)}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-medium text-ink">{entry.actor_label}</span>
                    {entry.actor_role ? (
                      <span className="mt-0.5 block text-xs text-ink-muted">
                        {entry.actor_role.replace(/_/g, " ")}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <code className="whitespace-nowrap rounded bg-surface-muted px-1.5 py-0.5 text-xs">
                      {entry.action}
                    </code>
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-muted">
                    {entry.entity}
                    {entry.entity_id ? (
                      <span className="mt-0.5 block font-mono text-[11px] opacity-70">
                        {entry.entity_id.slice(0, 8)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <StateDiff before={entry.before_state} after={entry.after_state} />
                    {entry.note ? (
                      <p className="mt-1 italic text-ink-muted">{entry.note}</p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <PageLink
            href={query({ offset: String(Math.max(0, offset - PAGE_SIZE)) })}
            disabled={offset === 0}
          >
            ← Newer
          </PageLink>
          <span className="tabular text-xs text-ink-muted">
            {page.total.toLocaleString()} entries
          </span>
          <PageLink href={query({ offset: String(offset + PAGE_SIZE) })} disabled={!hasNext}>
            Older →
          </PageLink>
        </div>
      </div>
    </Shell>
  );
}

/** Before and after, side by side. Neither alone is an audit record. */
function StateDiff({
  before,
  after,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  if (keys.length === 0) return <span className="text-ink-muted">—</span>;

  return (
    <dl className="space-y-0.5">
      {keys.slice(0, 6).map((key) => {
        const from = before?.[key];
        const to = after?.[key];
        return (
          <div key={key} className="flex flex-wrap gap-x-1.5">
            <dt className="text-ink-muted">{key.replace(/_/g, " ")}:</dt>
            <dd className="text-ink">
              {from !== undefined && from !== to ? (
                <>
                  <span className="text-ink-muted line-through">{render(from)}</span>{" "}
                  <span aria-hidden>→</span>{" "}
                </>
              ) : null}
              {render(to ?? from)}
            </dd>
          </div>
        );
      })}
      {keys.length > 6 ? (
        <div className="text-ink-muted">+{keys.length - 6} more fields</div>
      ) : null}
    </dl>
  );
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "border-brand-600 bg-brand-600 text-white"
          : "border-line bg-surface text-ink-muted hover:border-brand-600/40 hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}

function PageLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted opacity-50">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
    >
      {children}
    </Link>
  );
}
