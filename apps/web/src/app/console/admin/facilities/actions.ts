"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { ApiError, api } from "@/lib/api";
import type { FacilityStatus } from "@/lib/api";

/**
 * Enrollment writes.
 *
 * Every one of these is permission-gated and audited at the API; these
 * functions carry the session cookie and translate a refusal into something a
 * person can act on. None of them re-implements a rule — the lifecycle graph,
 * the activation prerequisites and the code-uniqueness check all live in the
 * API, because the console is not the only client and a rule enforced here
 * would be a rule the uploader could bypass (SDD 7).
 */

const PAGE = "/admin/facilities";

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

export async function enrollFacility(form: FormData): Promise<void> {
  const code = text(form, "code");
  const name = text(form, "name");
  const district_id = text(form, "district_id");
  if (!code || !name || !district_id) {
    back("A facility needs a code, a name and a district.");
  }

  const interval = text(form, "upload_interval_days");
  try {
    await api.enrollFacility({
      code,
      name,
      district_id,
      whonet_config_version: text(form, "whonet_config_version") ?? null,
      upload_schedule: text(form, "upload_schedule") ?? "weekly",
      upload_interval_days: interval ? Number(interval) : null,
      mou_signed_on: text(form, "mou_signed_on") ?? null,
      mou_reference: text(form, "mou_reference") ?? null,
      enrollment_notes: text(form, "enrollment_notes") ?? null,
    });
  } catch (error) {
    back(describe(error, "The facility could not be enrolled."));
  }

  revalidatePath(PAGE);
  back(`${name} enrolled. It contributes nothing until it is activated.`, "ok");
}

export async function updateFacility(form: FormData): Promise<void> {
  const facilityId = text(form, "facility_id");
  if (!facilityId) back("No facility was identified.");

  const interval = text(form, "upload_interval_days");
  try {
    await api.updateFacility(facilityId, {
      whonet_config_version: text(form, "whonet_config_version") ?? null,
      mou_signed_on: text(form, "mou_signed_on") ?? null,
      mou_reference: text(form, "mou_reference") ?? null,
      upload_schedule: text(form, "upload_schedule"),
      upload_interval_days: interval ? Number(interval) : null,
      enrollment_notes: text(form, "enrollment_notes") ?? null,
    });
  } catch (error) {
    back(describe(error, "The enrollment details could not be saved."));
  }

  revalidatePath(PAGE);
  back("Enrollment details saved.", "ok");
}

export async function transitionFacility(form: FormData): Promise<void> {
  const facilityId = text(form, "facility_id");
  const target = text(form, "target") as FacilityStatus | undefined;
  const reason = text(form, "reason");
  if (!facilityId || !target) back("No transition was identified.");
  // The API requires a reason and would refuse without one. Saying so here
  // costs a round trip less and names the field.
  if (!reason || reason.length < 3) {
    back("State a reason for the status change — it is recorded in the audit trail.");
  }

  try {
    await api.transitionFacility(facilityId, target, reason);
  } catch (error) {
    back(describe(error, "The status change was refused."));
  }

  revalidatePath(PAGE);
  back(`Status changed to ${target.replace(/_/g, " ")}.`, "ok");
}

export async function deleteFacility(form: FormData): Promise<void> {
  const facilityId = text(form, "facility_id");
  const confirm = text(form, "confirm");
  if (!facilityId || !confirm) {
    back("Type the facility code to confirm deletion.");
  }

  let message: string;
  try {
    const result = await api.deleteFacility(facilityId, confirm);
    message = result.message;
  } catch (error) {
    back(describe(error, "The facility could not be deleted."));
  }

  revalidatePath(PAGE);
  back(message, "ok");
}

export async function resetData(form: FormData): Promise<void> {
  const scope = text(form, "scope") === "everything" ? "everything" : "surveillance";
  const confirm = text(form, "confirm");
  if (!confirm) {
    back("Type RESET to confirm clearing the surveillance data.");
  }

  let message: string;
  try {
    const result = await api.resetData(scope, confirm);
    message = result.message;
  } catch (error) {
    back(describe(error, "The surveillance data could not be reset."));
  }

  revalidatePath(PAGE);
  back(message, "ok");
}

export async function createDistrict(form: FormData): Promise<void> {
  const blockId = text(form, "regional_block_id");
  const name = text(form, "name");
  if (!blockId || !name) back("A district needs a name and a block.");

  try {
    await api.createDistrict(blockId, name);
  } catch (error) {
    back(describe(error, "The district could not be created."));
  }

  revalidatePath(PAGE);
  back(`District ${name} created.`, "ok");
}
