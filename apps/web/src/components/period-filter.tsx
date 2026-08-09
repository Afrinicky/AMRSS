/**
 * Care-setting and date-range filter, shared by every analytical view.
 *
 * A plain GET form with no client JavaScript: the selection ends up in the URL,
 * which means a filtered view can be bookmarked, sent to a colleague, or cited
 * in a report and still resolve to the same figures. A filter held only in
 * component state would make every screenshot unverifiable.
 */
export function PeriodFilter({
  careSetting,
  dateFrom,
  dateTo,
}: {
  careSetting?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  return (
    <form className="grid grid-cols-1 items-end gap-3 rounded-[--radius-card] border border-line bg-surface p-4 sm:grid-cols-2 lg:flex lg:flex-wrap">
      <div className="lg:w-44">
        <label
          htmlFor="care_setting"
          className="block text-xs font-medium uppercase tracking-wide text-ink-muted"
        >
          Care setting
        </label>
        <select
          id="care_setting"
          name="care_setting"
          defaultValue={careSetting ?? ""}
          className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
        >
          <option value="">All settings</option>
          <option value="IPD">Inpatient</option>
          <option value="OPD">Outpatient</option>
        </select>
      </div>
      <div className="lg:w-40">
        <label
          htmlFor="date_from"
          className="block text-xs font-medium uppercase tracking-wide text-ink-muted"
        >
          From
        </label>
        <input
          id="date_from"
          name="date_from"
          type="date"
          defaultValue={dateFrom ?? ""}
          className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
        />
      </div>
      <div className="lg:w-40">
        <label
          htmlFor="date_to"
          className="block text-xs font-medium uppercase tracking-wide text-ink-muted"
        >
          To
        </label>
        <input
          id="date_to"
          name="date_to"
          type="date"
          defaultValue={dateTo ?? ""}
          className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
        />
      </div>
      <button
        type="submit"
        className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 sm:w-auto"
      >
        Apply
      </button>
    </form>
  );
}
