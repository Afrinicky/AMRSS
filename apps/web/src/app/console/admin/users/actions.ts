"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { ApiError, api } from "@/lib/api";

/**
 * Account administration writes.
 *
 * Every rule that matters — who may grant which role, who may reach which
 * facility, that nobody edits their own authority, that the last administrator
 * survives — lives at the API and is tested there. These functions carry the
 * session and turn a refusal into a sentence someone can act on.
 */

const PAGE = "/admin/users";

function text(form: FormData, field: string): string | undefined {
  const value = String(form.get(field) ?? "").trim();
  return value === "" ? undefined : value;
}

function back(message: string, kind: "error" | "ok" = "error"): never {
  redirect(`${PAGE}?${kind}=${encodeURIComponent(message)}`);
}

function describe(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** Scope fields are sent only where the chosen role uses them, so a stale
 * facility left in a hidden field cannot follow a user into a regional role. */
function scopeFor(role: string, form: FormData) {
  if (role === "laboratory_staff" || role === "facility_administrator") {
    return { facility_id: text(form, "facility_id") ?? null, regional_block_id: null };
  }
  return { facility_id: null, regional_block_id: text(form, "regional_block_id") ?? null };
}

export async function createUser(form: FormData): Promise<void> {
  const email = text(form, "email");
  const full_name = text(form, "full_name");
  const role = text(form, "role");
  const password = text(form, "password");
  const username = text(form, "username") ?? null;

  if (!email || !full_name || !role || !password) {
    back("An account needs an email address, a name, a role and an initial password.");
  }

  try {
    await api.createUser({ email, username, full_name, role, password, ...scopeFor(role, form) });
  } catch (error) {
    back(describe(error, "The account could not be created."));
  }

  revalidatePath(PAGE);
  back(
    `${email} created. Give them the password in person or by another channel — ` +
      "they will be asked to change it when they first sign in.",
    "ok",
  );
}

export async function updateUser(form: FormData): Promise<void> {
  const userId = text(form, "user_id");
  const role = text(form, "role");
  if (!userId || !role) back("No account was identified.");

  // The username field is always present, so its empty value is meaningful: it
  // clears the handle back to email-only sign-in. Sent as "" rather than
  // omitted. Email cannot be blanked, so an empty email is simply not sent.
  const username = String(form.get("username") ?? "").trim();

  try {
    await api.updateUser(userId, {
      full_name: text(form, "full_name"),
      email: text(form, "email"),
      username,
      role,
      ...scopeFor(role, form),
    });
  } catch (error) {
    back(describe(error, "The account could not be updated."));
  }

  revalidatePath(PAGE);
  back("Account updated.", "ok");
}

export async function setUserActive(form: FormData): Promise<void> {
  const userId = text(form, "user_id");
  const active = String(form.get("is_active")) === "true";
  if (!userId) back("No account was identified.");

  try {
    await api.updateUser(userId, { is_active: active });
  } catch (error) {
    back(describe(error, "The account status could not be changed."));
  }

  revalidatePath(PAGE);
  back(active ? "Account reactivated." : "Account deactivated.", "ok");
}

export async function resetUserPassword(form: FormData): Promise<void> {
  const userId = text(form, "user_id");
  const password = text(form, "password");
  if (!userId || !password) back("A reset needs a new password.");

  try {
    await api.resetUserPassword(userId, password);
  } catch (error) {
    back(describe(error, "The password could not be reset."));
  }

  revalidatePath(PAGE);
  back(
    "Password reset. Deliver it out of band; the account must change it at next sign-in.",
    "ok",
  );
}

export async function unlockUser(form: FormData): Promise<void> {
  const userId = text(form, "user_id");
  if (!userId) back("No account was identified.");

  try {
    await api.unlockUser(userId);
  } catch (error) {
    back(describe(error, "The lockout could not be cleared."));
  }

  revalidatePath(PAGE);
  back("Lockout cleared. The account keeps its existing password.", "ok");
}
