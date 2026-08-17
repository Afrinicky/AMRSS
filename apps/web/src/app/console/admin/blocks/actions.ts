"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { ApiError, api } from "@/lib/api";

/**
 * Block and district deletion, driven from the block modal.
 *
 * The rules — refuse a district with facilities, refuse a block with districts —
 * live at the API and are tested there. These carry the session and turn a
 * refusal into a sentence, then return to the blocks page.
 */

const PAGE = "/console/admin/blocks";

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

export async function deleteDistrict(form: FormData): Promise<void> {
  const districtId = text(form, "district_id");
  const confirm = text(form, "confirm");
  if (!districtId || !confirm) back("Type the district name to confirm.");

  let message: string;
  try {
    const result = await api.deleteDistrict(districtId, confirm);
    message = result.message;
  } catch (error) {
    back(describe(error, "The district could not be deleted."));
  }
  revalidatePath(PAGE);
  back(message, "ok");
}

export async function deleteBlock(form: FormData): Promise<void> {
  const blockId = text(form, "block_id");
  const confirm = text(form, "confirm");
  if (!blockId || !confirm) back("Type the block code to confirm.");

  let message: string;
  try {
    const result = await api.deleteBlock(blockId, confirm);
    message = result.message;
  } catch (error) {
    back(describe(error, "The regional block could not be deleted."));
  }
  revalidatePath(PAGE);
  back(message, "ok");
}
