import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ApiError, SESSION_COOKIE, api, type Profile } from "@/lib/api";

/** Resolve the signed-in user, or send them to sign in.
 *
 * The profile is fetched from the API on every request rather than trusted from
 * the cookie, so a role change or deactivation takes effect immediately instead
 * of at token expiry.
 */
export async function requireProfile(): Promise<Profile> {
  try {
    return await api.profile();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 423)) {
      redirect("/console/signin");
    }
    throw error;
  }
}

export async function setSession(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
