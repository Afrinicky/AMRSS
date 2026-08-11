import { EmptyState, ScrollTable, formatDate, formatDateTime } from "@/components/admin";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";
import type { ReportSummary } from "@/lib/api";

export const metadata = { title: "Reports" };

const PERIOD_LABEL: Record<ReportSummary["period"], string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
  ad_hoc: "Ad hoc",
};

/**
 * Published reports (SDD 9.7).
 *
 * These are stored artefacts, not live views. A report downloaded today says
 * what it said when it was generated, even if a threshold has since been tuned
 * or a late upload changed the underlying aggregate — which is the only way a
 * document circulated to a stewardship committee stays comparable with the copy
 * they discussed.
 *
 * Nothing here can show more than the dashboard: the same engine, thresholds,
 * suppression and QC gating produced both.
 */
export default async function ReportsPage() {
  const profile = await requireProfile();
  const reports = await api.reports();

  const scheduled = reports.filter((report) => report.period !== "ad_hoc");

  return (
    <Shell profile={profile} current="/console/reports">
      <PageHeading
        title="Reports"
        description="Published monthly, quarterly and annual reports, stored exactly as they were generated."
        aside={
          <>
            <BannerFigure
              label="Published"
              value={reports.length}
              detail={`${scheduled.length} in the scheduled series`}
            />
            <BannerFigure
              label="Latest"
              value={reports[0] ? formatDate(reports[0].period_end) : "—"}
              detail="Period covered"
            />
          </>
        }
      />

      <div className="space-y-6">
        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-sm text-ink-muted">
          A report never shows anything the dashboard would have withheld — the same reporting
          threshold, the same small-cell suppression and the same QC/EQA gating produced both.
          Each file carries its own coverage statement and the methodology versions in force
          when it was generated, so a figure stays explicable after the rules behind it change.
        </p>

        {reports.length === 0 ? (
          <EmptyState>
            No report has been published yet. Reports are generated per calendar period, so the
            first one becomes available once a full month of data has been accepted.
          </EmptyState>
        ) : (
          <ScrollTable>
            <caption className="sr-only">Published reports, most recent period first</caption>
            <thead>
              <tr className="border-b border-line text-left">
                <th scope="col" className="px-3 py-2 font-medium">Report</th>
                <th scope="col" className="px-3 py-2 font-medium">Period</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Organisms</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Isolates</th>
                <th scope="col" className="px-3 py-2 font-medium">Coverage</th>
                <th scope="col" className="px-3 py-2 font-medium">Generated</th>
                <th scope="col" className="px-3 py-2 font-medium">Download</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id} className="border-b border-line align-top last:border-0">
                  <th scope="row" className="px-3 py-2.5 text-left font-medium text-ink">
                    {report.title}
                    {report.notes ? (
                      <span className="mt-0.5 block text-xs font-normal italic text-ink-muted">
                        {report.notes}
                      </span>
                    ) : null}
                  </th>
                  <td className="px-3 py-2.5 text-ink-muted">
                    <span className="whitespace-nowrap rounded-full border border-line bg-surface-muted px-2 py-0.5 text-xs">
                      {PERIOD_LABEL[report.period]}
                    </span>
                    <span className="tabular mt-1 block text-xs">
                      {formatDate(report.period_start)} – {formatDate(report.period_end)}
                    </span>
                  </td>
                  <td className="tabular px-3 py-2.5 text-right">{report.organism_count}</td>
                  <td className="tabular px-3 py-2.5 text-right">
                    {report.isolate_count.toLocaleString()}
                  </td>
                  {/* Coverage travels with the listing, not only inside the
                      file: a reader choosing between two quarters should see
                      that one of them was missing a laboratory. */}
                  <td className="px-3 py-2.5 text-xs text-ink-muted">
                    {report.facilities_contributing} contributing
                    {report.facilities_excluded > 0 ? (
                      <span className="mt-0.5 block text-accent-strong">
                        {report.facilities_excluded} excluded on quality grounds
                      </span>
                    ) : null}
                  </td>
                  <td className="tabular px-3 py-2.5 text-xs text-ink-muted">
                    {formatDateTime(report.generated_at)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="flex flex-wrap gap-2">
                      {report.formats.map((format) => (
                        <a
                          key={format}
                          href={`/api/reports/${report.id}/download?file_format=${format}`}
                          className="whitespace-nowrap rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
                        >
                          {format.toUpperCase()}
                        </a>
                      ))}
                    </span>
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
