import Link from "next/link";

import {
  EmptyState,
  STATUS_LABEL,
  ScrollTable,
  StatusPill,
  formatDate,
  formatDateTime,
} from "@/components/admin";
import { Modal } from "@/components/modal";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";
import type { AdminFacility, DistrictRef, FacilityStatus } from "@/lib/api";

import {
  createDistrict,
  deleteBlock,
  deleteDistrict,
  deleteFacility,
  enrollFacility,
  resetData,
  transitionFacility,
  updateFacility,
} from "./actions";

export const metadata = { title: "Facility enrollment" };

const STATUS_ORDER: FacilityStatus[] = [
  "under_verification",
  "pending",
  "active",
  "suspended",
  "inactive",
  "retired",
];

/** What each move means, so the button is not the only explanation. */
const TRANSITION_LABEL: Record<FacilityStatus, string> = {
  pending: "Return to pending",
  under_verification: "Begin verification",
  active: "Activate",
  suspended: "Suspend",
  inactive: "Deactivate",
  retired: "Retire",
};

const FIELD = "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink";
const LABEL = "block text-xs font-medium uppercase tracking-wide text-ink-muted";

/**
 * Facility enrollment (SDD 9.2).
 *
 * Laboratories are enrolled here, not shipped with the software. A regional
 * block starts empty and its roster is built by the people who run it: nothing
 * in AMRSS knows the name of a hospital until someone registers it, which is
 * what lets the same build serve Ahafo and every region after it (ADR-0002).
 *
 * Ordered by what needs a decision rather than alphabetically: facilities
 * awaiting verification lead, because they are the ones enrolled but
 * contributing nothing, and that is the state most easily forgotten about.
 *
 * The lifecycle is enforced at the API. This page offers only the transitions a
 * facility can legally make right now — showing "Activate" on a pending
 * facility would teach the rules by refusal.
 */
export default async function FacilitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ facility_status?: string; error?: string; ok?: string }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;
  // Deleting facilities and resetting the dataset are held behind their own
  // permission (data:purge), so the controls appear only for the overall
  // authority — the API refuses them for anyone else regardless.
  const canPurge = profile.permissions.includes("data:purge");

  const [facilities, districts, blocks] = await Promise.all([
    api.facilities({ facility_status: params.facility_status }),
    api.districts(),
    api.blocks(),
  ]);

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
    <Shell profile={profile} current="/console/admin">
      <PageHeading
        title="Facility enrollment"
        description="Laboratories registered in this surveillance block, and where each one sits in the enrollment lifecycle."
        aside={
          <>
            <BannerFigure
              label="Registered"
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
        {params.error ? <Notice tone="warn">{params.error}</Notice> : null}
        {params.ok ? <Notice tone="ok">{params.ok}</Notice> : null}

        <RegistrationForms districts={districts} blocks={blocks} />

        <nav
          aria-label="Filter by status"
          className="scroll-row -mx-1 flex gap-2 overflow-x-auto px-1"
        >
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
              {blocked.length} {blocked.length === 1 ? "facility is" : "facilities are"} registered
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
            {facilities.length === 0 && !params.facility_status ? (
              <>
                No laboratory is registered in this block yet. Register the first one above; it
                starts pending and contributes nothing until it is activated.
              </>
            ) : (
              <>
                No facility matches this filter.{" "}
                <Link href="/console/admin/facilities" className="font-medium text-brand-700">
                  Show all
                </Link>
              </>
            )}
          </EmptyState>
        ) : (
          <>
            <ScrollTable>
              <caption className="sr-only">
                Registered facilities with their lifecycle status and quality state
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
                      <ManageFacility facility={facility} canPurge={canPurge} />
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

            <p className="text-sm text-ink-muted">
              Select a laboratory&rsquo;s name to manage its enrollment paperwork and lifecycle.
              Every change is recorded in the audit trail against the person who made it.
            </p>
          </>
        )}

        {canPurge ? (
          <DangerZone facilities={facilities} districts={districts} blocks={blocks} />
        ) : null}

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

/**
 * Registration.
 *
 * Collapsed by default: on most visits this page is being read, not added to,
 * and a permanently open eight-field form would push the roster below the fold.
 */
function RegistrationForms({
  districts,
  blocks,
}: {
  districts: DistrictRef[];
  blocks: { id: string; name: string }[];
}) {
  return (
    <div className="flex flex-wrap gap-3">
      <Modal
        label="Register a laboratory"
        triggerLabel="Register a laboratory"
        triggerClassName="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        <form action={enrollFacility} className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="name" className={LABEL}>
              Laboratory name
            </label>
            <input id="name" name="name" required maxLength={256} className={FIELD} />
          </div>
          <div>
            <label htmlFor="code" className={LABEL}>
              Facility code
            </label>
            <input id="code" name="code" required maxLength={32} className={FIELD} />
            <p className="mt-1 text-xs text-ink-muted">
              Unique across the platform. It identifies the laboratory in uploads and never
              changes.
            </p>
          </div>
          <div>
            <label htmlFor="district_id" className={LABEL}>
              District
            </label>
            <select id="district_id" name="district_id" required className={FIELD}>
              <option value="">Choose a district</option>
              {districts.map((district) => (
                <option key={district.id} value={district.id}>
                  {district.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="whonet_config_version" className={LABEL}>
              WHONET configuration version
            </label>
            <input
              id="whonet_config_version"
              name="whonet_config_version"
              maxLength={64}
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="mou_signed_on" className={LABEL}>
              MOU executed on
            </label>
            <input id="mou_signed_on" name="mou_signed_on" type="date" className={FIELD} />
          </div>
          <div>
            <label htmlFor="mou_reference" className={LABEL}>
              MOU reference
            </label>
            <input id="mou_reference" name="mou_reference" maxLength={128} className={FIELD} />
          </div>
          <div>
            <label htmlFor="upload_schedule" className={LABEL}>
              Upload schedule
            </label>
            <select id="upload_schedule" name="upload_schedule" defaultValue="weekly" className={FIELD}>
              <option value="weekly">Weekly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="monthly">Monthly</option>
              <option value="custom">Custom interval</option>
            </select>
          </div>
          <div>
            <label htmlFor="upload_interval_days" className={LABEL}>
              Custom interval (days)
            </label>
            <input
              id="upload_interval_days"
              name="upload_interval_days"
              type="number"
              min={1}
              max={365}
              className={FIELD}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label htmlFor="enrollment_notes" className={LABEL}>
              Notes
            </label>
            <textarea id="enrollment_notes" name="enrollment_notes" rows={2} className={FIELD} />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <button
              type="submit"
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Register laboratory
            </button>
            <p className="mt-2 text-xs text-ink-muted">
              A newly registered laboratory starts <strong>pending</strong>. It uploads nothing and
              contributes to no figure until it has been verified and activated.
            </p>
          </div>
        </form>
      </Modal>

      <Modal
        label="Add a district"
        triggerLabel="Add a district"
        triggerClassName="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
      >
        <form action={createDistrict} className="grid gap-4">
          <div>
            <label htmlFor="district_name" className={LABEL}>
              District name
            </label>
            <input id="district_name" name="name" required maxLength={128} className={FIELD} />
          </div>
          <div>
            <label htmlFor="regional_block_id" className={LABEL}>
              Regional block
            </label>
            <select id="regional_block_id" name="regional_block_id" required className={FIELD}>
              {blocks.map((block) => (
                <option key={block.id} value={block.id}>
                  {block.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <button
              type="submit"
              className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Add district
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function ManageFacility({
  facility,
  canPurge,
}: {
  facility: AdminFacility;
  canPurge: boolean;
}) {
  return (
    <Modal
      label={`Manage ${facility.name}`}
      title={
        <span>
          {facility.name}
          <span className="ml-2 font-normal text-ink-muted">
            {facility.code} · {facility.district_name} · {STATUS_LABEL[facility.status]}
          </span>
        </span>
      }
      triggerLabel={facility.name}
      triggerClassName="text-left font-medium text-brand-700 hover:underline"
    >
      <div className="space-y-5">
        <form action={updateFacility} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="facility_id" value={facility.id} />
          <div>
            <label htmlFor={`whonet-${facility.id}`} className={LABEL}>
              WHONET configuration version
            </label>
            <input
              id={`whonet-${facility.id}`}
              name="whonet_config_version"
              defaultValue={facility.whonet_config_version ?? ""}
              maxLength={64}
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor={`mou-${facility.id}`} className={LABEL}>
              MOU executed on
            </label>
            <input
              id={`mou-${facility.id}`}
              name="mou_signed_on"
              type="date"
              defaultValue={facility.mou_signed_on ?? ""}
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor={`mouref-${facility.id}`} className={LABEL}>
              MOU reference
            </label>
            <input
              id={`mouref-${facility.id}`}
              name="mou_reference"
              defaultValue={facility.mou_reference ?? ""}
              maxLength={128}
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor={`schedule-${facility.id}`} className={LABEL}>
              Upload schedule
            </label>
            <select
              id={`schedule-${facility.id}`}
              name="upload_schedule"
              defaultValue={facility.upload_schedule}
              className={FIELD}
            >
              <option value="weekly">Weekly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="monthly">Monthly</option>
              <option value="custom">Custom interval</option>
            </select>
          </div>
          <div>
            <label htmlFor={`interval-${facility.id}`} className={LABEL}>
              Custom interval (days)
            </label>
            <input
              id={`interval-${facility.id}`}
              name="upload_interval_days"
              type="number"
              min={1}
              max={365}
              defaultValue={facility.upload_interval_days ?? ""}
              className={FIELD}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label htmlFor={`notes-${facility.id}`} className={LABEL}>
              Notes
            </label>
            <textarea
              id={`notes-${facility.id}`}
              name="enrollment_notes"
              rows={2}
              defaultValue={facility.enrollment_notes ?? ""}
              className={FIELD}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <button
              type="submit"
              className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Save enrollment details
            </button>
          </div>
        </form>

        <div className="border-t border-line pt-4">
          <h3 className="text-sm font-medium text-ink">Lifecycle</h3>
          {facility.blocking_activation.length > 0 ? (
            <p className="mt-1 text-xs text-accent-strong">
              Activation is blocked until this facility has {facility.blocking_activation.join(" and ")}.
            </p>
          ) : null}

          {facility.available_transitions.length === 0 ? (
            <p className="mt-1 text-xs text-ink-muted">
              A retired facility makes no further moves. Its submitted data is retained and stays
              attributable.
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-3">
              {facility.available_transitions.map((target) => (
                /* One form per move, each carrying its own reason. A shared
                   reason box beside several buttons would attach whatever was
                   typed to whichever button was pressed. */
                <form
                  key={target}
                  action={transitionFacility}
                  className="flex flex-wrap items-end gap-2 rounded-lg border border-line px-3 py-2"
                >
                  <input type="hidden" name="facility_id" value={facility.id} />
                  <input type="hidden" name="target" value={target} />
                  <div>
                    <label htmlFor={`reason-${facility.id}-${target}`} className={LABEL}>
                      Reason
                    </label>
                    <input
                      id={`reason-${facility.id}-${target}`}
                      name="reason"
                      required
                      minLength={3}
                      maxLength={512}
                      className={`${FIELD} sm:w-64`}
                    />
                  </div>
                  <button
                    type="submit"
                    className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
                  >
                    {TRANSITION_LABEL[target]}
                  </button>
                </form>
              ))}
            </div>
          )}
        </div>

        {canPurge ? (
          <div className="border-t border-sir-r/40 pt-4">
            <h3 className="text-sm font-medium text-sir-r">Delete this facility</h3>
            <p className="mt-1 max-w-2xl text-xs text-ink-muted">
              Removes {facility.name} and <strong className="text-ink">every record it ever
              submitted</strong> — isolates, results, uploads and quality records. This cannot be
              undone. To suspend a laboratory without losing its data, use the lifecycle above
              instead. Its accounts are kept but detached and deactivated.
            </p>
            <form
              action={deleteFacility}
              className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-sir-r/40 bg-sir-r/5 px-3 py-2"
            >
              <input type="hidden" name="facility_id" value={facility.id} />
              <div>
                <label htmlFor={`delcode-${facility.id}`} className={LABEL}>
                  Type <span className="font-mono text-ink">{facility.code}</span> to confirm
                </label>
                <input
                  id={`delcode-${facility.id}`}
                  name="confirm"
                  autoComplete="off"
                  className={`${FIELD} sm:w-48`}
                />
              </div>
              <button
                type="submit"
                className="rounded-lg bg-sir-r px-3 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Delete facility
              </button>
            </form>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * The one place data is genuinely destroyed.
 *
 * Kept at the foot of the page, behind its own permission and a typed
 * confirmation, and visually set apart. "Begin a new cycle" is a real operation
 * a pilot needs — clearing test data before going live — but it is the opposite
 * of everything else in this console, which never loses a record. The two
 * choices are stated plainly: keep the facility roster, or remove it too.
 */
function DangerZone({
  facilities,
  districts,
  blocks,
}: {
  facilities: AdminFacility[];
  districts: DistrictRef[];
  blocks: { id: string; name: string }[];
}) {
  const emptyDistricts = districts.filter((d) => d.facility_count === 0);
  return (
    <details className="rounded-[--radius-card] border border-sir-r/45 bg-sir-r/5">
      <summary className="cursor-pointer px-4 py-3 text-lg font-semibold text-sir-r">
        Danger zone — delete and reset
      </summary>
      <div className="space-y-6 border-t border-sir-r/30 p-4">
        <DeleteGeography emptyDistricts={emptyDistricts} blocks={blocks} />
        <ResetSystem facilities={facilities} />
      </div>
    </details>
  );
}

/** Removing a district or a block. Both refuse a non-empty target at the API;
 * the district picker only offers empty ones so the common path succeeds. */
function DeleteGeography({
  emptyDistricts,
  blocks,
}: {
  emptyDistricts: DistrictRef[];
  blocks: { id: string; name: string }[];
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <form action={deleteDistrict} className="space-y-2 rounded-lg border border-sir-r/30 p-3">
        <h3 className="text-sm font-medium text-sir-r">Delete a district</h3>
        {emptyDistricts.length === 0 ? (
          <p className="text-xs text-ink-muted">
            Every district still has facilities. A district can be deleted only once its facilities
            are gone.
          </p>
        ) : (
          <>
            <select name="district_id" required className={FIELD}>
              <option value="">Choose an empty district</option>
              {emptyDistricts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <input
              name="confirm"
              autoComplete="off"
              placeholder="Type the district name to confirm"
              className={FIELD}
            />
            <button
              type="submit"
              className="rounded-lg bg-sir-r px-3 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Delete district
            </button>
          </>
        )}
      </form>

      <form action={deleteBlock} className="space-y-2 rounded-lg border border-sir-r/30 p-3">
        <h3 className="text-sm font-medium text-sir-r">Delete a regional block</h3>
        <select name="block_id" required className={FIELD}>
          <option value="">Choose a block</option>
          {blocks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <input
          name="confirm"
          autoComplete="off"
          placeholder="Type the block code to confirm"
          className={FIELD}
        />
        <button
          type="submit"
          className="rounded-lg bg-sir-r px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Delete block
        </button>
        <p className="text-xs text-ink-muted">Refused while the block still has districts.</p>
      </form>
    </div>
  );
}

function ResetSystem({ facilities }: { facilities: AdminFacility[] }) {
  return (
    <section aria-labelledby="danger-heading">
      <h2 id="danger-heading" className="text-lg font-semibold text-sir-r">
        Reset the system
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-ink">
        Clears surveillance data so this block can begin a new cycle. The canonical dictionary,
        methodology, regional blocks and user accounts are kept. There are{" "}
        {facilities.length} {facilities.length === 1 ? "facility" : "facilities"} registered.
        <strong className="font-medium"> This cannot be undone.</strong>
      </p>
      <form action={resetData} className="mt-4 grid gap-4 sm:max-w-xl">
        <fieldset className="grid gap-2">
          <legend className={LABEL}>What to clear</legend>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="radio" name="scope" value="surveillance" defaultChecked className="mt-1" />
            <span>
              <span className="font-medium">Uploads and results only.</span> Keeps the facility
              roster; each facility is reset to a pre-upload state.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="radio" name="scope" value="everything" className="mt-1" />
            <span>
              <span className="font-medium">Everything.</span> Also removes the facilities and
              districts; their facility-scoped accounts are detached and deactivated.
            </span>
          </label>
        </fieldset>
        <div>
          <label htmlFor="reset-confirm" className={LABEL}>
            Type <span className="font-mono text-ink">RESET</span> to confirm
          </label>
          <input id="reset-confirm" name="confirm" autoComplete="off" className={`${FIELD} sm:w-48`} />
        </div>
        <div>
          <button
            type="submit"
            className="rounded-lg bg-sir-r px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Reset surveillance data
          </button>
        </div>
      </form>
    </section>
  );
}

function Notice({ tone, children }: { tone: "ok" | "warn"; children: React.ReactNode }) {
  return (
    <p
      role="status"
      className={`rounded-[--radius-card] border px-4 py-3 text-sm text-ink ${
        tone === "ok"
          ? "border-brand-600/40 bg-brand-50"
          : "border-accent-strong/45 bg-accent/10"
      }`}
    >
      {children}
    </p>
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
  const href = value
    ? `/console/admin/facilities?facility_status=${value}`
    : "/console/admin/facilities";
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
