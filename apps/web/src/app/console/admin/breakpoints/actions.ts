"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { ApiError, api, type BreakpointCriterion } from "@/lib/api";

/**
 * Writes to the breakpoint table.
 *
 * Every rule about what a valid breakpoint is lives at the API and is tested
 * there — inverted bounds, overlapping bands, duplicate scopes, zones outside
 * what a disk test produces. These functions carry the session and turn a
 * refusal into a sentence someone can act on.
 *
 * Nothing here edits a published version. Results already interpreted cite the
 * version they were interpreted under, so a threshold changed inside one would
 * silently rewrite what past antibiograms mean. Edits land on a draft; the
 * draft is published as a new dated version.
 */

const PAGE = "/console/admin/breakpoints";

function text(form: FormData, field: string): string | undefined {
  const value = String(form.get(field) ?? "").trim();
  return value === "" ? undefined : value;
}

function whole(form: FormData, field: string): number | null {
  const value = text(form, field);
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function back(message: string, kind: "error" | "ok" = "error"): never {
  redirect(`${PAGE}?${kind}=${encodeURIComponent(message)}`);
}

function describe(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export async function saveBreakpoint(form: FormData): Promise<void> {
  const organism_group = text(form, "organism_group");
  const agent_code = text(form, "agent_code");
  const method = text(form, "method");

  if (!organism_group || !agent_code || !method) {
    back("A criterion needs an organism group, an antimicrobial and a method.");
  }

  // The disk and MIC columns are both submitted and only one set is kept: a
  // stale zone diameter left in a hidden field would otherwise follow a
  // criterion that has been switched to MIC, and the two run in opposite
  // directions.
  const disk = method === "DISK";
  const criterion: BreakpointCriterion = {
    organism_group,
    agent_code: agent_code.toUpperCase(),
    method,
    standard: text(form, "standard") ?? "CLSI M100",
    table_reference: text(form, "table_reference") ?? null,
    site: text(form, "site") ?? null,
    route: text(form, "route") ?? null,
    disk_content: disk ? (text(form, "disk_content") ?? null) : null,
    mic_susceptible_max: disk ? null : (text(form, "mic_susceptible_max") ?? null),
    mic_intermediate_min: disk ? null : (text(form, "mic_intermediate_min") ?? null),
    mic_intermediate_max: disk ? null : (text(form, "mic_intermediate_max") ?? null),
    mic_resistant_min: disk ? null : (text(form, "mic_resistant_min") ?? null),
    disk_susceptible_min: disk ? whole(form, "disk_susceptible_min") : null,
    disk_intermediate_min: disk ? whole(form, "disk_intermediate_min") : null,
    disk_intermediate_max: disk ? whole(form, "disk_intermediate_max") : null,
    disk_resistant_max: disk ? whole(form, "disk_resistant_max") : null,
    dosage_note: text(form, "dosage_note") ?? null,
    comment: text(form, "comment") ?? null,
  };

  let problems: string[] = [];
  try {
    const draft = await api.saveBreakpoint(criterion);
    problems = draft.problems;
  } catch (error) {
    back(describe(error, "The criterion could not be saved."));
  }

  revalidatePath(PAGE);
  // A draft is allowed to be inconsistent while it is being worked on —
  // refusing an intermediate state would block someone correcting two rows
  // between the first and the second. The problems are reported and publishing
  // is what refuses.
  back(
    problems.length === 0
      ? `${criterion.agent_code} saved to the draft.`
      : `${criterion.agent_code} saved. The draft has ${problems.length} outstanding problem(s) and cannot be published until they are resolved.`,
    problems.length === 0 ? "ok" : "error",
  );
}

export async function removeBreakpoint(form: FormData): Promise<void> {
  const scope = {
    organism_group: String(form.get("organism_group") ?? ""),
    agent_code: String(form.get("agent_code") ?? ""),
    method: String(form.get("method") ?? ""),
    site: String(form.get("site") ?? ""),
    route: String(form.get("route") ?? ""),
  };

  try {
    await api.removeBreakpoint(scope);
  } catch (error) {
    back(describe(error, "The criterion could not be removed."));
  }

  revalidatePath(PAGE);
  back(`${scope.agent_code} removed from the draft.`, "ok");
}

export async function publishBreakpoints(form: FormData): Promise<void> {
  const version = text(form, "version");
  const source_edition = text(form, "source_edition");
  const effective_from = text(form, "effective_from");

  if (!version || !source_edition || !effective_from) {
    back(
      "Publishing needs a version, the edition it came from, and the date it takes effect. " +
        "All three are stamped onto every figure computed against this table.",
    );
  }

  let imported = 0;
  try {
    const published = await api.publishBreakpoints({
      version,
      source_edition,
      effective_from,
      description: text(form, "description") ?? "",
    });
    imported = published.imported;
  } catch (error) {
    back(describe(error, "The table was not published."));
  }

  revalidatePath(PAGE);
  revalidatePath("/console/admin/methodology");
  back(
    `${imported} criteria published as ${version}, effective ${effective_from}. ` +
      "Results interpreted from now on cite this version.",
    "ok",
  );
}
