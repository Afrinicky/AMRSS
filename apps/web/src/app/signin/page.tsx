import { redirect } from "next/navigation";

import { ApiError, login } from "@/lib/api";
import { setSession } from "@/lib/session";

export const metadata = { title: "Sign in" };

async function signIn(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  try {
    const tokens = await login(email, password);
    await setSession(tokens.access_token);
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : "Sign-in failed. Please try again.";
    redirect(`/signin?error=${encodeURIComponent(message)}`);
  }
  redirect("/");
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-2xl font-semibold tracking-tight text-brand-700">AMRSS</div>
          <p className="mt-1 text-sm text-ink-muted">
            Antimicrobial Resistance Surveillance System
          </p>
        </div>

        <form
          action={signIn}
          className="space-y-4 rounded-[--radius-card] border border-line bg-surface p-6"
        >
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-ink">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-ink">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-sir-r">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Sign in
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-ink-muted">
          Access is limited to authorised institutional users. All sign-in attempts are recorded.
        </p>
      </div>
    </div>
  );
}
