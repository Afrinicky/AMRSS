import { PageHeading, Shell } from "@/components/shell";
import { StatTile } from "@/components/statistic";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Surveillance coverage" };

/**
 * Whether the regional pattern is actually representative (SDD 4.3).
 *
 * The per-facility table appears only for callers the API returns it to.
 * Aggregate counts are the representativeness context every user needs; naming
 * individual laboratories as overdue is administrative.
 */
export default async function CoveragePage() {
  const profile = await requireProfile();
  const coverage = await api.coverage();

  return (
    <Shell profile={profile} current="/coverage">
      <PageHeading
        title="Surveillance coverage"
        description="How much of the regional block is represented in current figures, and which laboratories are reporting on schedule."
      />

      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Enrolled facilities"
            value={coverage.enrolled_facilities}
            detail={`${coverage.active_facilities} active`}
          />
          <StatTile
            label="Reporting this week"
            value={`${coverage.reporting_this_week} / ${coverage.active_facilities}`}
            detail={`${coverage.reporting_this_month} reported this month`}
          />
          <StatTile
            label="Overdue"
            value={coverage.overdue_facilities}
            detail="Past their configured schedule"
            tone={coverage.overdue_facilities > 0 ? "attention" : "neutral"}
          />
          <StatTile
            label="Districts covered"
            value={`${coverage.districts_covered} / ${coverage.districts_total}`}
            detail={`${coverage.isolates_this_month.toLocaleString()} isolates this month`}
          />
        </div>

        {coverage.facilities_excluded_by_quality > 0 ? (
          <div className="rounded-[--radius-card] border border-sir-i/40 bg-sir-i/5 px-4 py-3 text-sm">
            <p className="font-medium text-ink">
              {coverage.facilities_excluded_by_quality} facility
              {coverage.facilities_excluded_by_quality === 1 ? "" : "ies"} excluded from verified
              aggregates
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              Their QC attestation or EQA status is not current and satisfactory. They continue to
              see their own data in full.
            </p>
          </div>
        ) : null}

        {coverage.facilities.length > 0 ? (
          <section aria-labelledby="facilities-heading">
            <h2 id="facilities-heading" className="mb-3 text-lg font-semibold text-ink">
              Reporting compliance by facility
            </h2>
            <div className="overflow-x-auto rounded-[--radius-card] border border-line bg-surface">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-muted text-left">
                    <th scope="col" className="px-4 py-2.5 font-medium text-ink">
                      Facility
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium text-ink">
                      District
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium text-ink">
                      Schedule
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium text-ink">
                      Last accepted upload
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium text-ink">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium text-ink">
                      Quality
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.facilities.map((facility) => (
                    <tr key={facility.facility_id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5 font-medium text-ink">
                        {facility.facility_name}
                      </td>
                      <td className="px-4 py-2.5 text-ink-muted">{facility.district_name}</td>
                      <td className="px-4 py-2.5 capitalize text-ink-muted">
                        {facility.schedule}
                      </td>
                      <td className="tabular px-4 py-2.5 text-right text-ink-muted">
                        {facility.days_since_last_upload === null
                          ? "Never"
                          : `${facility.days_since_last_upload} day${facility.days_since_last_upload === 1 ? "" : "s"} ago`}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge
                          tone={facility.is_overdue ? "warning" : "ok"}
                          label={facility.is_overdue ? "Overdue" : "On schedule"}
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge
                          tone={facility.quality_verified ? "ok" : "warning"}
                          label={facility.quality_verified ? "QC/EQA current" : "QC/EQA lapsed"}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-4 text-sm text-ink-muted">
            Per-facility reporting detail is available to data stewards and regional
            administrators.
          </p>
        )}
      </div>
    </Shell>
  );
}

function Badge({ tone, label }: { tone: "ok" | "warning"; label: string }) {
  // The dot is a redundant cue so status does not rely on colour alone.
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        tone === "ok" ? "bg-sir-s/10 text-sir-s" : "bg-sir-i/10 text-sir-i"
      }`}
    >
      <span
        aria-hidden
        className={`inline-block size-1.5 rounded-full ${tone === "ok" ? "bg-sir-s" : "bg-sir-i"}`}
      />
      {label}
    </span>
  );
}
