import { redirect } from "next/navigation";

import { PasswordField } from "@/components/password-field";
import { PageHeading, Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { requireProfile } from "@/lib/session";

export const metadata = { title: "Change password" };

const MIN_PASSWORD = 12;
const FIELD = "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink";
const LABEL = "block text-sm font-medium text-ink";

async function changePassword(formData: FormData): Promise<void> {
  "use server";

  const current = String(formData.get("current_password") ?? "");
  const next = String(formData.get("new_password") ?? "");
  const confirm = String(formData.get("confirm_password") ?? "");

  // Checked here rather than at the API because the API never sees the
  // confirmation field — it is a typing check, not a security control.
  if (next !== confirm) {
    redirect(`/console/account/password?error=${encodeURIComponent("The two new passwords do not match.")}`);
  }

  try {
    await api.changeOwnPassword(current, next);
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : "The password could not be changed.";
    redirect(`/console/account/password?error=${encodeURIComponent(message)}`);
  }

  redirect("/console/account/password?ok=1");
}

/**
 * Change your own password.
 *
 * The one account action a user performs for themselves. It exists mainly for
 * the state after an administrative reset: between the reset and this page, the
 * password is known to two people, so anything done under the account is not
 * attributable to either of them.
 */
export default async function PasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const profile = await requireProfile();
  const params = await searchParams;

  return (
    <Shell profile={profile} current="/console/account/password">
      <PageHeading
        title="Change password"
        description={`Signed in as ${profile.email}.`}
      />

      <div className="max-w-lg space-y-4">
        {params.ok ? (
          <p
            role="status"
            className="rounded-[--radius-card] border border-brand-600/40 bg-brand-50 px-4 py-3 text-sm text-ink"
          >
            Password changed. This account is yours alone again.
          </p>
        ) : null}
        {params.error ? (
          <p
            role="status"
            className="rounded-[--radius-card] border border-accent-strong/45 bg-accent/10 px-4 py-3 text-sm text-ink"
          >
            {params.error}
          </p>
        ) : null}

        {profile.must_change_password ? (
          <p className="rounded-[--radius-card] border border-accent-strong/45 bg-accent/10 px-4 py-3 text-sm text-ink">
            This account is using a password an administrator set, so they know it too. Choose your
            own now — until you do, an action recorded against this account cannot be attributed to
            you alone.
          </p>
        ) : null}

        <form
          action={changePassword}
          className="space-y-4 rounded-[--radius-card] border border-line bg-surface p-4"
        >
          <div>
            <label htmlFor="current_password" className={LABEL}>
              Current password
            </label>
            <PasswordField
              id="current_password"
              name="current_password"
              required
              autoComplete="current-password"
              className={FIELD}
            />
            {/* Asked for even though you are already signed in: a session left
                open on a shared workstation is otherwise enough to take the
                account permanently. */}
            <p className="mt-1 text-xs text-ink-muted">
              Required even while signed in, so an unattended session cannot be used to take the
              account.
            </p>
          </div>

          <div>
            <label htmlFor="new_password" className={LABEL}>
              New password
            </label>
            <PasswordField
              id="new_password"
              name="new_password"
              required
              minLength={MIN_PASSWORD}
              autoComplete="new-password"
              className={FIELD}
            />
            <p className="mt-1 text-xs text-ink-muted">
              At least {MIN_PASSWORD} characters. Length matters more than punctuation — a long
              phrase you can remember beats a short one you write down.
            </p>
          </div>

          <div>
            <label htmlFor="confirm_password" className={LABEL}>
              Repeat new password
            </label>
            <PasswordField
              id="confirm_password"
              name="confirm_password"
              required
              minLength={MIN_PASSWORD}
              autoComplete="new-password"
              className={FIELD}
            />
          </div>

          <button
            type="submit"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Change password
          </button>
        </form>

        <p className="rounded-[--radius-card] border border-line bg-surface-tint px-4 py-3 text-xs text-ink-muted">
          If you have forgotten your password there is no reset link, because AMRSS sends no mail
          and holds no address it could send one to. Ask an administrator, who can confirm who is
          asking before resetting it.
        </p>
      </div>
    </Shell>
  );
}
