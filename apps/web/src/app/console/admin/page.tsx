import Link from "next/link";

import { AdminStat, EmptyState, ScrollTable, StatusPill, formatDate } from "@/components/admin";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";
import type { AdminFacility, Block, DictionarySummary } from "@/lib/api";

export const metadata = { title: "Administration" };

/**
 * The administration console (SDD 9.2, 9.3, 3.4, 5.9, 10.2).
 *
 * Everything reachable from here changes *configuration* rather than computing
 * over data — which is precisely why it needs a landing page that says what
 * state the configuration is in. An administrator should be able to see at a
 * glance that four facilities are stuck awaiting verification, or that eleven
 * local codes are holding isolates out of the antibiogram, without opening four
 * pages to find out.
 *
 * Every panel degrades independently: a missing permission hides a section
 * rather than failing the page, because these permissions are genuinely
 * separable — a data steward reviews mappings without enrolling facilities.
 */
export default async function AdminPage() {
  const profile = await requireProfile();

  const [blocks, facilities, dictionary] = await Promise.all([
    profile.permissions.includes("block:manage")
      ? api.blocks().catch(() => null)
      : Promise.resolve(null),
    profile.permissions.includes("facility:enroll")
      ? api.facilities().catch(() => null)
      : Promise.resolve(null),
    profile.permissions.includes("dictionary:manage")
      ? api.dictionarySummary().catch(() => null)
      : Promise.resolve(null),
  ]);

  const awaitingVerification =
    facilities?.filter((f) => f.status === "under_verification").length ?? 0;
  const blockedFromActivation =
    facilities?.filter((f) => f.blocking_activation.length > 0 && f.status !== "active").length ?? 0;

  return (
    <Shell profile={profile} current="/console/admin">
      <PageHeading
        title="Administration"
        description="Enrollment, regional blocks, dictionary stewardship, methodology versions and the audit trail."
        aside={
          <>
            <BannerFigure
              label="Facilities"
              value={facilities?.length ?? "—"}
              detail={`${facilities?.filter((f) => f.status === "active").length ?? 0} active`}
            />
            <BannerFigure
              label="Blocks"
              value={blocks?.length ?? "—"}
              detail={`${blocks?.reduce((n, b) => n + b.district_count, 0) ?? 0} districts`}
            />
          </>
        }
      />

      <div className="space-y-6">
        {/* What needs attention, before what merely exists. An administrator
            opening this page has a queue, not a browsing session. */}
        <section aria-labelledby="attention-heading">
          <h2 id="attention-heading" className="heading-rule mb-3 text-lg font-semibold text-ink">
            Needs attention
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <AdminStat
              label="Awaiting verification"
              value={awaitingVerification}
              detail="Enrolled but not yet contributing"
              emphasis={awaitingVerification > 0}
            />
            <AdminStat
              label="Blocked from activation"
              value={blockedFromActivation}
              detail="Missing MOU or WHONET configuration"
              emphasis={blockedFromActivation > 0}
            />
            <AdminStat
              label="Codes awaiting mapping"
              value={dictionary?.pending_mappings ?? "—"}
              detail="Holding records out of the antibiogram"
              emphasis={(dictionary?.pending_mappings ?? 0) > 0}
            />
            <AdminStat
              label="Organisms without CLSI groups"
              value={dictionary?.organisms_without_clsi_groups ?? "—"}
              detail="Their measurements can never be interpreted"
              emphasis={(dictionary?.organisms_without_clsi_groups ?? 0) > 0}
            />
          </div>
        </section>

        <section aria-labelledby="sections-heading">
          <h2 id="sections-heading" className="heading-rule mb-3 text-lg font-semibold text-ink">
            Console
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <ConsoleCard
              href="/console/admin/facilities"
              title="Facility enrollment"
              body="Enrol laboratories and move them through the lifecycle. Only active facilities contribute to the verified antibiogram."
              available={profile.permissions.includes("facility:enroll")}
            />
            <ConsoleCard
              href="/console/admin/blocks"
              title="Regional blocks"
              body="Create and govern surveillance blocks and their districts. Adding a region is configuration, never a code change."
              available={profile.permissions.includes("block:manage")}
            />
            <ConsoleCard
              href="/console/admin/quality"
              title="QC and EQA compliance"
              body="Which laboratories pass the quality gate, which are excluded from the verified antibiogram, and why."
              available={profile.permissions.includes("qc:manage_gating")}
            />
            <ConsoleCard
              href="/console/admin/mappings"
              title="Dictionary stewardship"
              body="Review the local WHONET codes facilities have submitted and map them onto the canonical dictionary."
              available={profile.permissions.includes("mapping:review")}
            />
            <ConsoleCard
              href="/console/admin/methodology"
              title="Methodology versions"
              body="Thresholds, deduplication windows, suppression rules and loaded CLSI breakpoint tables, with their effective dates."
              available={profile.permissions.includes("methodology:manage")}
            />
            <ConsoleCard
              href="/console/admin/users"
              title="Accounts"
              body="Who can sign in and what each of them may do. Create accounts, reset passwords, clear lockouts and deactivate leavers."
              available={
                profile.permissions.includes("user:manage") ||
                profile.permissions.includes("user:manage_facility")
              }
            />
            <ConsoleCard
              href="/console/admin/audit"
              title="Audit trail"
              body="Every consequential action, append-only. Who did what, when, and what the value was before."
              available={profile.permissions.includes("audit:read")}
            />
          </div>
        </section>

        {blocks && blocks.length > 0 ? <BlockTable blocks={blocks} /> : null}
        {facilities && facilities.length > 0 ? (
          <FacilitySummary facilities={facilities} />
        ) : facilities ? (
          <EmptyState>
            No facility is enrolled yet. Create a regional block and its districts first, then
            enrol laboratories into them.
          </EmptyState>
        ) : null}

        {dictionary ? <DictionaryPanel summary={dictionary} /> : null}
      </div>
    </Shell>
  );
}

function ConsoleCard({
  href,
  title,
  body,
  available,
}: {
  href: string;
  title: string;
  body: string;
  available: boolean;
}) {
  // A section the signed-in role cannot use is omitted rather than shown
  // disabled: offering a door that does not open is worse than not showing it.
  if (!available) return null;
  return (
    <Link
      href={href}
      className="group min-w-0 rounded-[--radius-card] border border-line bg-surface p-4 transition-colors hover:border-brand-600/40 hover:bg-brand-50"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium text-ink">{title}</h3>
        <span aria-hidden className="text-sm text-brand-700 transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{body}</p>
    </Link>
  );
}

function BlockTable({ blocks }: { blocks: Block[] }) {
  return (
    <section aria-labelledby="blocks-heading">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="blocks-heading" className="heading-rule text-lg font-semibold text-ink">
          Regional blocks
        </h2>
        <Link href="/console/admin/blocks" className="text-sm font-medium text-brand-700">
          Manage blocks →
        </Link>
      </div>
      <ScrollTable>
        <thead>
          <tr className="border-b border-line text-left">
            <th scope="col" className="px-3 py-2 font-medium">Block</th>
            <th scope="col" className="px-3 py-2 font-medium">Governing body</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Districts</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Facilities</th>
            <th scope="col" className="px-3 py-2 font-medium">WHONET standard</th>
            <th scope="col" className="px-3 py-2 font-medium">Activated</th>
          </tr>
        </thead>
        <tbody className="tabular">
          {blocks.map((block) => (
            <tr key={block.id} className="border-b border-line last:border-0">
              <th scope="row" className="px-3 py-2 text-left font-medium text-ink">
                {block.name}
                <span className="ml-2 font-normal text-ink-muted">{block.code}</span>
              </th>
              <td className="px-3 py-2">{block.governing_body}</td>
              <td className="px-3 py-2 text-right">{block.district_count}</td>
              <td className="px-3 py-2 text-right">{block.facility_count}</td>
              <td className="px-3 py-2 text-ink-muted">
                {block.whonet_config_standard ?? "Not set"}
              </td>
              <td className="px-3 py-2 text-ink-muted">{formatDate(block.activated_on)}</td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>
    </section>
  );
}

function FacilitySummary({ facilities }: { facilities: AdminFacility[] }) {
  const byStatus = new Map<string, AdminFacility[]>();
  for (const facility of facilities) {
    byStatus.set(facility.status, [...(byStatus.get(facility.status) ?? []), facility]);
  }

  return (
    <section aria-labelledby="facility-heading">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="facility-heading" className="heading-rule text-lg font-semibold text-ink">
          Enrollment status
        </h2>
        <Link href="/console/admin/facilities" className="text-sm font-medium text-brand-700">
          Manage facilities →
        </Link>
      </div>
      <div className="flex flex-wrap gap-3">
        {[...byStatus.entries()].map(([status, list]) => (
          <div
            key={status}
            className="flex items-center gap-2 rounded-[--radius-card] border border-line bg-surface px-3 py-2"
          >
            <StatusPill status={status as AdminFacility["status"]} />
            <span className="tabular text-sm font-medium text-ink">{list.length}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DictionaryPanel({ summary }: { summary: DictionarySummary }) {
  return (
    <section aria-labelledby="dictionary-heading">
      <h2 id="dictionary-heading" className="heading-rule mb-3 text-lg font-semibold text-ink">
        Canonical dictionary
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStat
          label="Organisms"
          value={summary.organisms}
          detail={`${summary.organisms_of_special_importance} under alert surveillance`}
        />
        <AdminStat label="Antimicrobial agents" value={summary.antibiotics} />
        <AdminStat label="Specimen types" value={summary.specimen_types} />
        <AdminStat
          label="Unmapped organisms"
          value={summary.organisms_without_clsi_groups}
          detail="No CLSI group, so never interpretable"
          emphasis={summary.organisms_without_clsi_groups > 0}
        />
      </div>
    </section>
  );
}
