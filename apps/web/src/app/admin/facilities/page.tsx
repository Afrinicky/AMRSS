import Link from "next/link";

import {
  EmptyState,
  STATUS_LABEL,
  ScrollTable,
  StatusPill,
  formatDate,
  formatDateTime,
} from "@/components/admin";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";
import type { AdminFacility } from "@/lib/api";

export const metadata = { title: "Facility enrollment" };

const STATUS_ORDER: AdminFacility["status"][] = [
  "under_verification",
  "pending",
  "active",
  "suspended",
  "inactive",
  "retired",
];

/**
 * Facility enrollment (SDD 9.2).
 *
 * Ordered by what needs a decision rather than alphabetically: facilities
 * awaiting verification lead, because they are the ones enrolled but
 * contributing nothing, and that is the state most easily forgotten about.
 *
 * The lifecycle is enforced at the API. This page shows only the transitions a
 * facility can legally make right now — offering "Activate" on a pending
 * facility would teach the rules by refusal.
 */
export default async function FacilitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ facility_status?: string }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;

  const facilities = await api.facilities({ facility_status: params.facility_status });

  const ordered = [...facilities].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      a.district_name.localeCompare(b.district_name) ||
      a.name.localeCompare(b.name),
  );

  const active = facilities.filter((f) => f.status === "active").length;
  const blocked = facilities.filter(
    (f) => f.blocking_activation.length > 0 && f.status !== "active",
  );

  return (
    <Shell profile={profile} current="/admin">
      <PageHeading
        title="Facility enrollment"
        description="Laboratories enrolled in this surveillance block, and where each one sits in the enrollment lifecycle."
        aside={
          <>
            <BannerFigure
              label="Enrolled"
              value={facilities.length}
              detail={`${active} contributing`}
            />
            <BannerFigure
              label="Blocked"
              value={blocked.length}
              detail="Awaiting enrollment paperwork"
            />
          </>
        }
      />

      <div className="space-y-6">
        <nav aria-label="Filter by status" className="scroll-row -mx-1 flex gap-2 overflow-x-auto px-1">
          <FilterChip current={params.facility_status} value={undefined} label="All" />
          {STATUS_ORDER.map((status) => (
            <FilterChip
              key={status}
              current={params.facility_status}
              value={status}
              label={STATUS_LABEL[status]}
            />
          ))}
        </nav>

        {blocked.length > 0 ? (
          <div className="rounded-[--radius-card] border border-accent-strong/45 bg-accent/10 px-4 py-3">
            <p className="text-sm font-medium text-ink">
              {blocked.length} {blocked.length === 1 ? "facility is" : "facilities are"} enrolled
              but cannot be activated
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              Activation requires an MOU execution date and a recorded WHONET configuration
              version. Until both are on file the laboratory can upload nothing, and its data
              would have no dictionary to map against.
            </p>
            <ul className="mt-2 space-y-1 text-xs text-ink">
              {blocked.map((facility) => (
                <li key={facility.id}>
                  {/* Not lowercased: the labels contain proper nouns, and
                      "missing whonet configuration version" reads as a typo. */}
                  <span className="font-medium">{facility.name}</span> — missing{" "}
                  {facility.blocking_activation.join(", ")}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {ordered.length === 0 ? (
          <EmptyState>
            No facility matches this filter.{" "}
            <Link href="/admin/facilities" className="font-medium text-brand-700">
              Show all
            </Link>
          </EmptyState>
        ) : (
          <ScrollTable>
            <caption className="sr-only">
              Enrolled facilities with their lifecycle status and quality state
            </caption>
            <thead>
              <tr className="border-b border-line text-left">
                <th scope="col" className="px-3 py-2 font-medium">Facility</th>
                <th scope="col" className="px-3 py-2 font-medium">District</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">WHONET config</th>
                <th scope="col" className="px-3 py-2 font-medium">MOU</th>
                <th scope="col" className="px-3 py-2 font-medium">Schedule</th>
                <th scope="col" className="px-3 py-2 font-medium">Last upload</th>
                <th scope="col" className="px-3 py-2 font-medium">Quality</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((facility) => (
                <tr key={facility.id} className="border-b border-line last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-medium text-ink">
                    {facility.name}
                    <span className="ml-2 font-normal text-ink-muted">{facility.code}</span>
                  </th>
                  <td className="px-3 py-2 text-ink-muted">{facility.district_name}</td>
                  <td className="px-3 py-2">
                    <StatusPill status={facility.status} />
                  </td>
                  <td className="px-3 py-2 text-ink-muted">
                    {facility.whonet_config_version ?? (
                      <span className="text-accent-strong">Not recorded</span>
                    )}
                  </td>
                  <td className="tabular px-3 py-2 text-ink-muted">
                    {facility.mou_signed_on ? (
                      formatDate(facility.mou_signed_on)
                    ) : (
                      <span className="text-accent-strong">Not recorded</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-ink-muted">
                    {facility.upload_schedule === "custom" && facility.upload_interval_days
                      ? `Every ${facility.upload_interval_days} days`
                      : facility.upload_schedule}
                  </td>
                  <td className="tabular px-3 py-2 text-ink-muted">
                    {formatDateTime(facility.last_accepted_upload_at)}
                  </td>
                  {/* QC and EQA are laboratory facts, independent of the
                      administrative status beside them (SDD 6.6 vs 9.2). A
                      facility can be active with lapsed EQA, or suspended with
                      QC current, and the two columns must not be conflated. */}
                  <td className="px-3 py-2 text-xs text-ink-muted">
                    QC {facility.qc_status.replace(/_/g, " ")}
                    <br />
                    EQA {facility.eqa_status.replace(/_/g, " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}

        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
          Only <strong className="font-medium text-ink">active</strong> facilities contribute to
          the verified regional antibiogram, and then only while their QC attestation and EQA are
          both current and satisfactory. The two gates are independent: an active facility with
          lapsed EQA is excluded from the verified aggregate but still sees its own data in full.
        </p>
      </div>
    </Shell>
  );
}

function FilterChip({
  current,
  value,
  label,
}: {
  current: string | undefined;
  value: string | undefined;
  label: string;
}) {
  const active = current === value;
  const href = value ? `/admin/facilities?facility_status=${value}` : "/admin/facilities";
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
      {label}
    </Link>
  );
}
