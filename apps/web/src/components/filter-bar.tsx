import type { Scope } from "@/lib/api";

/**
 * Geography, care-setting and date-range filter, shared by every analytical view.
 *
 * A plain GET form with no client JavaScript: the selection ends up in the URL,
 * which means a filtered view can be bookmarked, sent to a colleague, or cited
 * in a report and still resolve to the same figures. A filter held only in
 * component state would make every screenshot unverifiable.
 *
 * That constraint shapes the geography controls. A district often holds several
 * laboratories — a district hospital and a mission hospital serve different
 * populations and report different resistance — so the facility list is grouped
 * under district headings with `<optgroup>`, which the browser renders natively.
 * Repopulating the facility select when the district changes would need client
 * state, and would cost the URL-addressable property to save one line of markup.
 *
 * Selecting a facility supersedes the district rather than intersecting with it
 * (see `scopeParams`), so a facility can never be filtered down to nothing by a
 * district it does not belong to.
 */
export function FilterBar({
  scope,
  districtId,
  facilityId,
  showFacility = true,
  careSetting,
  dateFrom,
  dateTo,
  leading,
  submitLabel = "Apply",
  children,
}: {
  /** Omitted where a view has no geography dimension of its own. */
  scope?: Scope;
  districtId?: string;
  facilityId?: string;
  /** Off where one facility is not a meaningful scope — the comparison view
   * narrows to a district and then compares the facilities inside it, so
   * pinning a single facility would leave nothing to compare. */
  showFacility?: boolean;
  careSetting?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Controls that choose *what* is being shown, rendered before the geography.
   * On the trend view that is the organism and agent, which are the subject of
   * the page rather than a filter on it. */
  leading?: React.ReactNode;
  submitLabel?: string;
  /** Extra view-specific controls, rendered before the submit button. */
  children?: React.ReactNode;
}) {
  const pinned = scope?.pinned_facility_id
    ? scope.facilities.find((facility) => facility.id === scope.pinned_facility_id)
    : undefined;

  return (
    <form className="grid grid-cols-1 items-end gap-3 rounded-[--radius-card] border border-line bg-surface p-4 sm:grid-cols-2 lg:flex lg:flex-wrap">
      {leading}

      {scope && !pinned ? (
        <>
          <Field htmlFor="district_id" label="District" className="lg:w-52">
            <select
              id="district_id"
              name="district_id"
              defaultValue={districtId ?? ""}
              className={CONTROL}
            >
              <option value="">All districts</option>
              {scope.districts.map((district) => (
                <option key={district.id} value={district.id}>
                  {district.name}
                  {/* Naming the count is the point: it says out loud that a
                      district figure pools several laboratories. */}
                  {district.facility_count ? ` (${laboratories(district.facility_count)})` : ""}
                </option>
              ))}
            </select>
          </Field>

          {scope.can_select_facility && showFacility ? (
            <Field htmlFor="facility_id" label="Facility" className="lg:w-64">
              <select
                id="facility_id"
                name="facility_id"
                defaultValue={facilityId ?? ""}
                className={CONTROL}
              >
                <option value="">All facilities</option>
                {scope.districts.map((district) => {
                  const facilities = scope.facilities.filter(
                    (facility) => facility.district_id === district.id,
                  );
                  if (facilities.length === 0) return null;
                  return (
                    <optgroup key={district.id} label={district.name}>
                      {facilities.map((facility) => (
                        <option key={facility.id} value={facility.id}>
                          {facility.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </Field>
          ) : null}
        </>
      ) : null}

      {/* A facility-scoped account is pinned by the API whatever the URL says.
          Stating which facility is more useful than offering a choice that
          would be refused. */}
      {pinned ? (
        <div className="lg:w-64">
          <span className="block text-xs font-medium uppercase tracking-wide text-ink-muted">
            Facility
          </span>
          <p className="mt-1 rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm text-ink">
            {pinned.name}
          </p>
          <input type="hidden" name="facility_id" value={pinned.id} />
        </div>
      ) : null}

      <Field htmlFor="care_setting" label="Care setting" className="lg:w-44">
        <select
          id="care_setting"
          name="care_setting"
          defaultValue={careSetting ?? ""}
          className={CONTROL}
        >
          <option value="">All settings</option>
          <option value="IPD">Inpatient</option>
          <option value="OPD">Outpatient</option>
        </select>
      </Field>

      <Field htmlFor="date_from" label="From" className="lg:w-40">
        <input
          id="date_from"
          name="date_from"
          type="date"
          defaultValue={dateFrom ?? ""}
          className={CONTROL}
        />
      </Field>

      <Field htmlFor="date_to" label="To" className="lg:w-40">
        <input
          id="date_to"
          name="date_to"
          type="date"
          defaultValue={dateTo ?? ""}
          className={CONTROL}
        />
      </Field>

      {children}

      <button
        type="submit"
        className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 sm:w-auto"
      >
        {submitLabel}
      </button>
    </form>
  );
}

const CONTROL = "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink";

function laboratories(count: number): string {
  return `${count} ${count === 1 ? "laboratory" : "laboratories"}`;
}

export function Field({
  htmlFor,
  label,
  className,
  children,
}: {
  htmlFor: string;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label
        htmlFor={htmlFor}
        className="block text-xs font-medium uppercase tracking-wide text-ink-muted"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

export { CONTROL as filterControlClass };

/**
 * The geography a page passes to the API.
 *
 * Facility supersedes district: sending both intersects them, and a facility
 * filtered by a district it does not belong to returns an empty result rather
 * than an error — which reads as "no resistance here" and is the worst possible
 * failure for this view.
 */
export function scopeParams(params: { district_id?: string; facility_id?: string }): {
  district_id?: string;
  facility_id?: string;
} {
  if (params.facility_id) return { facility_id: params.facility_id };
  return { district_id: params.district_id };
}
