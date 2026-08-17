import { EmptyState, ScrollTable, formatDateTime } from "@/components/admin";
import { Modal } from "@/components/modal";
import { PasswordField } from "@/components/password-field";
import { BannerFigure, PageHeading, Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { requireProfile } from "@/lib/session";
import type { AdminUser, UserScopeOptions } from "@/lib/api";

import {
  createUser,
  deleteUser,
  resetUserPassword,
  setUserActive,
  unlockUser,
  updateUser,
} from "./actions";

export const metadata = { title: "Accounts" };

const ROLE_LABEL: Record<string, string> = {
  clinician: "Clinician",
  laboratory_staff: "Laboratory staff",
  facility_administrator: "Facility administrator",
  data_steward: "Data steward",
  regional_amr_administrator: "Regional AMR administrator",
  auditor: "Auditor",
  // Retained so an account still carrying the retired role (before the merge
  // migration runs) is labelled rather than shown as a raw string.
  system_administrator: "System administrator (retired)",
};

const ROLE_NOTE: Record<string, string> = {
  clinician: "Reads regional surveillance. No administrative authority.",
  laboratory_staff: "Submits uploads and QC attestations for one laboratory.",
  facility_administrator: "Manages accounts at their own laboratory, and nothing beyond it.",
  data_steward: "Reviews batches and dictionary mappings across the block.",
  regional_amr_administrator:
    "The overall authority: enrols facilities, sets methodology, manages every account, " +
    "and can reset the system to start a new surveillance cycle.",
  auditor: "Reads the audit trail and holds no operational permission.",
  system_administrator: "Retired — its authority is now held by the regional AMR administrator.",
};

const FIELD = "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink";
const LABEL = "block text-xs font-medium uppercase tracking-wide text-ink-muted";
const MIN_PASSWORD = 12;

/**
 * Accounts (SDD 7, 10.2).
 *
 * Two kinds of administrator reach this page. The regional AMR administrator —
 * the platform's overall authority — manages every account; a facility
 * administrator manages their own laboratory's staff and nothing else. What each
 * one may reach is enforced at the API; the console only ever declines to draw a
 * control the caller could not use.
 *
 * The page states what each role can do rather than listing permission strings.
 * "Reads the audit trail and holds no operational permission" is a sentence an
 * administrator can act on; `audit:read` is not.
 */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;

  const [users, options] = await Promise.all([api.users(), api.userScopeOptions()]);

  const active = users.filter((u) => u.is_active);
  const locked = users.filter((u) => u.is_locked);
  const pendingPassword = users.filter((u) => u.must_change_password && u.is_active);

  return (
    <Shell profile={profile} current="/console/admin/users">
      <PageHeading
        title="Accounts"
        description="Who can sign in, what each of them may do, and the state of their access."
        aside={
          <>
            <BannerFigure
              label="Accounts"
              value={users.length}
              detail={`${active.length} active`}
            />
            <BannerFigure
              label="Locked out"
              value={locked.length}
              detail="Automatic, after failed sign-ins"
            />
          </>
        }
      />

      <div className="space-y-6">
        {params.error ? <Notice tone="warn">{params.error}</Notice> : null}
        {params.ok ? <Notice tone="ok">{params.ok}</Notice> : null}

        {locked.length > 0 || pendingPassword.length > 0 ? (
          <div className="rounded-[--radius-card] border border-accent-strong/45 bg-accent/10 px-4 py-3 text-sm text-ink">
            {locked.length > 0 ? (
              <p>
                <strong className="font-medium">
                  {locked.length} {locked.length === 1 ? "account is" : "accounts are"} locked out.
                </strong>{" "}
                A lockout clears itself after fifteen minutes; clear it sooner below if someone is
                waiting. It does not need a password reset — they still know their password.
              </p>
            ) : null}
            {pendingPassword.length > 0 ? (
              <p className={locked.length > 0 ? "mt-1" : ""}>
                {pendingPassword.length}{" "}
                {pendingPassword.length === 1 ? "account is" : "accounts are"} still using a
                password an administrator set. Until they change it, an action taken under that
                account could have been taken by either of them.
              </p>
            ) : null}
          </div>
        ) : null}

        <CreateAccount options={options} />

        {users.length === 0 ? (
          <EmptyState>No account matches your administrative scope.</EmptyState>
        ) : (
          <>
            <ScrollTable>
              <caption className="sr-only">Accounts with their role and access state</caption>
              <thead>
                <tr className="border-b border-line text-left">
                  <th scope="col" className="px-3 py-2 font-medium">Name</th>
                  <th scope="col" className="px-3 py-2 font-medium">Email</th>
                  <th scope="col" className="px-3 py-2 font-medium">Role</th>
                  <th scope="col" className="px-3 py-2 font-medium">Scope</th>
                  <th scope="col" className="px-3 py-2 font-medium">Last sign-in</th>
                  <th scope="col" className="px-3 py-2 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-b border-line last:border-0">
                    <th scope="row" className="px-3 py-2 text-left font-medium text-ink">
                      {user.editable ? (
                        <ManageAccount user={user} options={options} profile={profile} />
                      ) : (
                        user.full_name
                      )}
                    </th>
                    <td className="px-3 py-2 text-ink-muted">
                      {user.email}
                      {user.username ? (
                        <span className="block text-xs text-ink-muted">@{user.username}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-ink-muted">
                      {ROLE_LABEL[user.role] ?? user.role}
                    </td>
                    <td className="px-3 py-2 text-ink-muted">
                      {user.facility_name ?? (user.regional_block_id ? "Regional" : "Platform")}
                    </td>
                    <td className="tabular px-3 py-2 text-ink-muted">
                      {user.last_login_at ? formatDateTime(user.last_login_at) : "Never"}
                    </td>
                    <td className="px-3 py-2">
                      <StateBadges user={user} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>

            <p className="text-sm text-ink-muted">
              Select an account&rsquo;s name to manage it. Every change is recorded in the audit
              trail against you; you cannot change your own role or deactivate yourself.
            </p>
          </>
        )}

        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
          There is no self-service password recovery: no email is held for anyone, and adding one
          would put a reset link into a mailbox this system does not control. A forgotten password
          is reset here instead, by a person who can confirm who is asking.
        </p>
      </div>
    </Shell>
  );
}

function StateBadges({ user }: { user: AdminUser }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {user.is_active ? (
        <Badge tone="ok">Active</Badge>
      ) : (
        <Badge tone="muted">Deactivated</Badge>
      )}
      {user.is_locked ? <Badge tone="warn">Locked</Badge> : null}
      {user.must_change_password ? <Badge tone="warn">Password set by admin</Badge> : null}
    </span>
  );
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "muted"; children: React.ReactNode }) {
  const styles = {
    ok: "border-brand-600/40 bg-brand-600/10 text-brand-700",
    warn: "border-accent-strong/45 bg-accent/15 text-ink",
    muted: "border-line bg-surface-muted text-ink-muted",
  }[tone];
  return (
    <span className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs ${styles}`}>
      {children}
    </span>
  );
}

function RoleSelect({
  id,
  options,
  defaultValue,
}: {
  id: string;
  options: UserScopeOptions;
  defaultValue?: string;
}) {
  return (
    <>
      <select id={id} name="role" required defaultValue={defaultValue ?? ""} className={FIELD}>
        {defaultValue ? null : <option value="">Choose a role</option>}
        {options.roles.map((role) => (
          <option key={role} value={role}>
            {ROLE_LABEL[role] ?? role}
          </option>
        ))}
      </select>
      {/* What each role means, in one line each. Nobody should have to open the
          SDD to decide whether "data steward" is the right answer. */}
      <ul className="mt-2 space-y-0.5 text-xs text-ink-muted">
        {options.roles.map((role) => (
          <li key={role}>
            <span className="font-medium text-ink">{ROLE_LABEL[role] ?? role}</span> —{" "}
            {ROLE_NOTE[role]}
          </li>
        ))}
      </ul>
    </>
  );
}

function ScopeFields({
  options,
  idPrefix,
  facilityId,
  blockId,
}: {
  options: UserScopeOptions;
  idPrefix: string;
  facilityId?: string | null;
  blockId?: string | null;
}) {
  // Both selects are rendered because the form carries no client JavaScript to
  // swap them when the role changes. The server sends only the one the chosen
  // role uses (see `scopeFor`), so the unused value is discarded rather than
  // following a user into a scope their role does not have.
  return (
    <>
      {options.facilities.length > 0 ? (
        <div>
          <label htmlFor={`${idPrefix}-facility`} className={LABEL}>
            Facility
          </label>
          <select
            id={`${idPrefix}-facility`}
            name="facility_id"
            defaultValue={facilityId ?? ""}
            className={FIELD}
          >
            <option value="">—</option>
            {options.facilities.map((facility) => (
              <option key={facility.id} value={facility.id}>
                {facility.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-muted">
            Used by laboratory staff and facility administrators.
          </p>
        </div>
      ) : null}

      {options.blocks.length > 0 ? (
        <div>
          <label htmlFor={`${idPrefix}-block`} className={LABEL}>
            Regional block
          </label>
          <select
            id={`${idPrefix}-block`}
            name="regional_block_id"
            defaultValue={blockId ?? ""}
            className={FIELD}
          >
            <option value="">—</option>
            {options.blocks.map((block) => (
              <option key={block.id} value={block.id}>
                {block.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-muted">
            Used by clinicians, stewards, auditors and regional administrators.
          </p>
        </div>
      ) : null}
    </>
  );
}

function CreateAccount({ options }: { options: UserScopeOptions }) {
  return (
    <Modal
      label="Create an account"
      triggerLabel="Create an account"
      triggerClassName="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
    >
      <form action={createUser} className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="full_name" className={LABEL}>
            Full name
          </label>
          <input id="full_name" name="full_name" required maxLength={256} className={FIELD} />
        </div>
        <div>
          <label htmlFor="email" className={LABEL}>
            Email address
          </label>
          <input id="email" name="email" type="email" required className={FIELD} />
          <p className="mt-1 text-xs text-ink-muted">
            Used to sign in. No mail is ever sent to it.
          </p>
        </div>
        <div>
          <label htmlFor="username" className={LABEL}>
            Username <span className="font-normal normal-case">(optional)</span>
          </label>
          <input
            id="username"
            name="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={64}
            className={FIELD}
          />
          <p className="mt-1 text-xs text-ink-muted">
            A short handle they can sign in with instead of the email. Letters, digits, dot, hyphen
            and underscore.
          </p>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="role" className={LABEL}>
            Role
          </label>
          <RoleSelect id="role" options={options} />
        </div>

        <ScopeFields options={options} idPrefix="new" />

        <div className="sm:col-span-2">
          <label htmlFor="password" className={LABEL}>
            Initial password
          </label>
          <PasswordField
            id="password"
            name="password"
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            className={FIELD}
          />
          <p className="mt-1 text-xs text-ink-muted">
            At least {MIN_PASSWORD} characters. You will know this password, so the account is
            required to change it at first sign-in — hand it over in person or by another channel,
            not in the same message as the email address.
          </p>
        </div>

        <div className="sm:col-span-2">
          <button
            type="submit"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Create account
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ManageAccount({
  user,
  options,
  profile,
}: {
  user: AdminUser;
  options: UserScopeOptions;
  profile: { email: string };
}) {
  const isSelf = user.email === profile.email;

  return (
    <Modal
      label={`Manage ${user.full_name}`}
      title={
        <span>
          {user.full_name}
          <span className="ml-2 font-normal text-ink-muted">
            {ROLE_LABEL[user.role] ?? user.role}
            {isSelf ? " · you" : ""}
          </span>
        </span>
      }
      triggerLabel={user.full_name}
      triggerClassName="text-left font-medium text-brand-700 hover:underline"
    >
      <div className="space-y-5">
        {isSelf ? (
          <p className="rounded-lg border border-line bg-surface-tint px-3 py-2 text-xs text-ink-muted">
            This is your own account. You can correct your name here; changing your role or
            deactivating yourself needs another administrator, so that no one can quietly widen
            their own access or lock themselves out.
          </p>
        ) : null}

        <form action={updateUser} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="user_id" value={user.id} />
          <div>
            <label htmlFor={`name-${user.id}`} className={LABEL}>
              Full name
            </label>
            <input
              id={`name-${user.id}`}
              name="full_name"
              defaultValue={user.full_name}
              maxLength={256}
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor={`email-${user.id}`} className={LABEL}>
              Email address
            </label>
            <input
              id={`email-${user.id}`}
              name="email"
              type="email"
              defaultValue={user.email}
              className={FIELD}
            />
            <p className="mt-1 text-xs text-ink-muted">
              Editable, so a demo account seeded with a placeholder address can become a real one.
            </p>
          </div>
          <div>
            <label htmlFor={`username-${user.id}`} className={LABEL}>
              Username
            </label>
            <input
              id={`username-${user.id}`}
              name="username"
              defaultValue={user.username ?? ""}
              autoCapitalize="none"
              spellCheck={false}
              maxLength={64}
              className={FIELD}
            />
            <p className="mt-1 text-xs text-ink-muted">
              Leave blank for email-only sign-in.
            </p>
          </div>
          <div>
            <label htmlFor={`role-${user.id}`} className={LABEL}>
              Role
            </label>
            <select
              id={`role-${user.id}`}
              name="role"
              defaultValue={user.role}
              disabled={isSelf}
              className={`${FIELD} disabled:opacity-60`}
            >
              {options.roles.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role] ?? role}
                </option>
              ))}
            </select>
            {/* A disabled <select> submits nothing, so on your own account the
                role must still be carried or the update arrives with no role and
                is rejected. Server-side, an unchanged role is allowed. */}
            {isSelf ? <input type="hidden" name="role" value={user.role} /> : null}
          </div>

          <ScopeFields
            options={options}
            idPrefix={user.id}
            facilityId={user.facility_id}
            blockId={user.regional_block_id}
          />

          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Save changes
            </button>
          </div>
        </form>

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <form action={resetUserPassword} className="space-y-2">
            <input type="hidden" name="user_id" value={user.id} />
            <label htmlFor={`pw-${user.id}`} className={LABEL}>
              Reset password
            </label>
            <PasswordField
              id={`pw-${user.id}`}
              name="password"
              minLength={MIN_PASSWORD}
              required
              autoComplete="new-password"
              className={FIELD}
            />
            <button
              type="submit"
              className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Reset password
            </button>
            <p className="text-xs text-ink-muted">
              Also clears any lockout. The account must change it at next sign-in.
            </p>
          </form>

          <div className="space-y-3">
            {user.is_locked ? (
              <form action={unlockUser}>
                <input type="hidden" name="user_id" value={user.id} />
                <button
                  type="submit"
                  className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
                >
                  Clear lockout
                </button>
                <p className="mt-1 text-xs text-ink-muted">
                  Keeps the existing password. Use this when someone simply mistyped it.
                </p>
              </form>
            ) : null}

            {!isSelf ? (
              <form action={setUserActive}>
                <input type="hidden" name="user_id" value={user.id} />
                <input type="hidden" name="is_active" value={user.is_active ? "false" : "true"} />
                <button
                  type="submit"
                  className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
                >
                  {user.is_active ? "Deactivate account" : "Reactivate account"}
                </button>
                <p className="mt-1 text-xs text-ink-muted">
                  {user.is_active
                    ? "Signs them out at their next request and blocks new sign-ins. Their submitted data and audit history are kept."
                    : "Restores access and clears any stale lockout."}
                </p>
              </form>
            ) : null}
          </div>
        </div>

        {/* Deletion lives at the foot of an already-collapsed panel, behind a
            typed confirmation — out of the way until deliberately opened. */}
        {!isSelf ? (
          <details className="rounded-lg border border-sir-r/40 bg-sir-r/5">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-sir-r">
              Delete this account
            </summary>
            <form action={deleteUser} className="flex flex-wrap items-end gap-2 border-t border-sir-r/30 p-3">
              <input type="hidden" name="user_id" value={user.id} />
              <div>
                <label htmlFor={`del-${user.id}`} className={LABEL}>
                  Type <span className="font-mono text-ink">{user.username ?? user.email}</span> to
                  confirm
                </label>
                <input
                  id={`del-${user.id}`}
                  name="confirm"
                  autoComplete="off"
                  className={`${FIELD} sm:w-64`}
                />
              </div>
              <button
                type="submit"
                className="rounded-lg bg-sir-r px-3 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Delete account
              </button>
              <p className="w-full text-xs text-ink-muted">
                Removes the login for good. Their audit history is kept and stays attributed to
                their name. Prefer deactivating unless the account was created in error.
              </p>
            </form>
          </details>
        ) : null}
      </div>
    </Modal>
  );
}

function Notice({ tone, children }: { tone: "ok" | "warn"; children: React.ReactNode }) {
  return (
    <p
      role="status"
      className={`rounded-[--radius-card] border px-4 py-3 text-sm text-ink ${
        tone === "ok" ? "border-brand-600/40 bg-brand-50" : "border-accent-strong/45 bg-accent/10"
      }`}
    >
      {children}
    </p>
  );
}
