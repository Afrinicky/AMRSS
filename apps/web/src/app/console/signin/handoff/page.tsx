import { redirect } from "next/navigation";

import { ApiError, ApiUnavailableError, exchangeHandoff } from "@/lib/api";
import { setSession } from "@/lib/session";

export const metadata = { title: "Signing in" };
export const dynamic = "force-dynamic";

/**
 * The landing point for "open the web console" in the desktop uploader.
 *
 * The uploader holds a session already; it asks the API for a ninety-second
 * handoff code and opens this page with it. Everything happens on the server and
 * the page renders nothing on success — the code is exchanged for a session
 * cookie and the browser is sent straight on to the console.
 *
 * The code is never rendered back into the page, and the tokens it becomes never
 * leave the server, so the only place it exists in the browser is the address
 * the redirect immediately replaces.
 */
export default async function HandoffPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;

  if (!code) {
    redirect("/console/signin");
  }

  try {
    const tokens = await exchangeHandoff(code);
    await setSession(tokens.access_token);
  } catch (error) {
    const message =
      error instanceof ApiUnavailableError
        ? "The surveillance service is not responding. Wait a moment and try again from the uploader."
        : error instanceof ApiError
          ? error.message
          : "This sign-in link is no longer valid. Sign in again from the uploader.";
    redirect(`/console/signin?error=${encodeURIComponent(message)}`);
  }

  redirect("/console");
}
