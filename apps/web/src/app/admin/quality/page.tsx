import { AdminStat, EmptyState, ScrollTable, formatDate, formatDateTime } from "@/components/admin";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";
import type { QualityProfile, TierState } from "@/lib/api";

export const metadata = { title: "QC and EQA compliance" };

/**
 * The QC/EQA dashboard (SDD 6.5, 6.6).
 *
 * This page answers one question the antibiogram cannot: which laboratories'
 * data is actually in the verified figure, and for the ones that are not, why.
 *
 * Ordered by how much attention a facility needs — excluded first, then
 * expiring, then current. A dashboard sorted alphabetically buries the two
 * laboratories that need a phone call among the eight that do not.
 *
 * Quality state uses the chrome palette rather than the S/I/R one. A facility
 * marked in the Resistant red would read as a resistance finding, and the whole
 * point of this page is that it says nothing about resistance at all.
 */
export default async function QualityPage() {
  const profile = await requireProfile();
  const dashboard = await api.qualityDashboard();

  return (
    <Shell profile={profile} current="/admin">
      <PageHeading
        title="QC and EQA compliance"
        description="Which laboratories currently pass the quality gate, and what the others need to do about it."
        aside={
          <>
            <BannerFigure
              label="Contributing"
              value={dashboard.contributing}
              detail="Pass both tiers"
            />
            <BannerFigure
              label="Excluded"
              value={dashboard.excluded}
              detail="From the verified aggregate"
            />
          </>
        }
      />

      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <AdminStat
            label="Excluded"
            value={dashboard.excluded}
            detail="Not in the verified antibiogram"
            emphasis={dashboard.excluded > 0}
          />
          <AdminStat
            label="Expiring soon"
            value={dashboard.expiring_soon}
            detail={`Within ${dashboard.expiry_warning_days} days`}
            emphasis={dashboard.expiring_soon > 0}
          />
          <AdminStat
            label="QC validity"
            value={`${dashboard.qc_validity_days} days`}
            detail="From the end of the attested period"
          />
          <AdminStat
            label="EQA validity"
            value={`${dashboard.eqa_validity_days} days`}
            detail="Unless the scheme states its own"
          />
        </div>

        {/* The rule, stated on the page rather than assumed. A regional officer
            looking at an excluded facility needs to know that exclusion is from
            the aggregate, not from the platform. */}
        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-sm text-ink-muted">
          {dashboard.gating_note}
        </p>

        {dashboard.facilities.length === 0 ? (
          <EmptyState>No facility is enrolled in this block yet.</EmptyState>
        ) : (
          <ScrollTable>
            <caption className="sr-only">
              Per-facility QC and EQA compliance, most urgent first
            </caption>
            <thead>
              <tr className="border-b border-line text-left">
                <th scope="col" className="px-3 py-2 font-medium">Facility</th>
                <th scope="col" className="px-3 py-2 font-medium">Tier 1 — QC attestation</th>
                <th scope="col" className="px-3 py-2 font-medium">Tier 2 — EQA</th>
                <th scope="col" className="px-3 py-2 font-medium">Verified aggregate</th>
                <th scope="col" className="px-3 py-2 font-medium">Last upload</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.facilities.map((facility) => (
                <tr key={facility.facility_id} className="border-b border-line align-top last:border-0">
                  <th scope="row" className="px-3 py-2.5 text-left font-medium text-ink">
                    {facility.facility_name}
                    <span className="mt-0.5 block text-xs font-normal text-ink-muted">
                      {facility.district_name} · {facility.enrollment_status.replace(/_/g, " ")}
                    </span>
                  </th>
                  <td className="px-3 py-2.5">
                    <TierCell state={facility.qc} warnWithin={dashboard.expiry_warning_days} />
                  </td>
                  <td className="px-3 py-2.5">
                    <TierCell state={facility.eqa} warnWithin={dashboard.expiry_warning_days} />
                  </td>
                  <td className="px-3 py-2.5">
                    {facility.contributes_to_verified_aggregate ? (
                      <span className="whitespace-nowrap rounded-full border border-brand-600/40 bg-brand-600/10 px-2.5 py-0.5 text-xs font-medium text-brand-700">
                        Contributing
                      </span>
                    ) : (
                      <>
                        <span className="whitespace-nowrap rounded-full border border-accent-strong/50 bg-accent-strong/15 px-2.5 py-0.5 text-xs font-medium text-ink">
                          Excluded
                        </span>
                        {/* Every reason, not the first. A laboratory told only
                            that its QC lapsed will fix that and be surprised to
                            remain excluded. */}
                        <ul className="mt-1.5 space-y-0.5 text-xs text-ink-muted">
                          {facility.exclusion_reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </td>
                  <td className="tabular px-3 py-2.5 text-xs text-ink-muted">
                    {formatDateTime(facility.last_accepted_upload_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}

        <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-3 text-xs text-ink-muted">
          AMRSS records quality <strong className="font-medium text-ink">attestation and
          compliance</strong>. It is not the laboratory&rsquo;s quality management system and
          performs no wet-lab QC analytics — no Levey-Jennings charting, no QC-strain trend
          analysis. That boundary is deliberate: a surveillance platform that quietly became a
          half-built LIMS would be worse at both jobs.
        </p>
      </div>
    </Shell>
  );
}

/**
 * One tier's standing.
 *
 * "Expired on 12 May" and "never submitted" are shown differently on purpose:
 * one is a form to chase, the other an onboarding conversation, and an
 * administrator reading the row needs to know which call to make.
 */
function TierCell({ state, warnWithin }: { state: TierState; warnWithin: number }) {
  const label = state.status.replace(/_/g, " ");
  const expiringSoon =
    state.status === "satisfactory" &&
    state.days_remaining !== null &&
    state.days_remaining <= warnWithin;

  const tone =
    state.status === "satisfactory" && !expiringSoon
      ? "border-brand-600/40 bg-brand-600/10 text-brand-700"
      : state.status === "not_submitted"
        ? "border-line bg-surface-muted text-ink-muted"
        : "border-accent-strong/50 bg-accent-strong/15 text-ink";

  return (
    <div>
      <span
        className={`inline-block whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${tone}`}
      >
        {label}
      </span>
      <div className="mt-1 space-y-0.5 text-xs text-ink-muted">
        {state.source_date ? <div>Recorded {formatDate(state.source_date)}</div> : null}
        {state.valid_until ? (
          <div className={expiringSoon ? "font-medium text-accent-strong" : undefined}>
            {state.days_remaining !== null && state.days_remaining >= 0
              ? `Valid until ${formatDate(state.valid_until)} · ${state.days_remaining} days left`
              : `Lapsed ${formatDate(state.valid_until)}`}
          </div>
        ) : null}
      </div>
    </div>
  );
}
