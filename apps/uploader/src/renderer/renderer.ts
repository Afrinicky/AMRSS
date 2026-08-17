/**
 * Renderer.
 *
 * Presentation only. It never sees the salt, a patient identifier, or a linkage
 * key — the summary it renders contains counts alone.
 */

interface Bridge {
  readState(): Promise<any>;
  saveState(patch: Record<string, unknown>): Promise<any>;
  chooseWhonetFile(): Promise<any>;
  signIn(input: { email: string; password: string }): Promise<any>;
  prepareBatch(input: { fungalCodes: string[] }): Promise<any>;
  sendBatch(): Promise<any>;
}

declare const amrss: Bridge;

/** Fungal organism codes, mirroring the canonical dictionary. Kept here so the
 * uploader can classify offline; the server re-derives it from the dictionary
 * on ingest, so a stale copy cannot corrupt stored data. */
const FUNGAL_CODES = ["cal", "cgl", "ctr", "cpa", "cau", "cne"];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Everything user-supplied reaches the DOM through textContent, never innerHTML. */
function setRows(table: HTMLTableElement, rows: string[][]): void {
  const body = table.tBodies[0]!;
  body.replaceChildren();
  for (const cells of rows) {
    const tr = body.insertRow();
    for (const value of cells) {
      tr.insertCell().textContent = value;
    }
  }
}

function notice(target: HTMLElement, tone: "ok" | "warn" | "bad", message: string): void {
  const div = document.createElement("div");
  div.className = `notice ${tone}`;
  div.textContent = message;
  target.replaceChildren(div);
}

function definitionList(entries: Array<[string, string]>): HTMLDListElement {
  const dl = document.createElement("dl");
  for (const [term, value] of entries) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  }
  return dl;
}

async function refresh(): Promise<void> {
  const state = await amrss.readState();

  $<HTMLInputElement>("facility-code").value = state.facilityCode ?? "";
  $<HTMLInputElement>("api-url").value = state.apiUrl ?? "";
  $<HTMLInputElement>("config-version").value = state.whonetConfigVersion ?? "";
  $<HTMLInputElement>("breakpoint-standard").value = state.astBreakpointStandard ?? "";
  $<HTMLSelectElement>("schedule").value = state.uploadSchedule ?? "weekly";
  $("version").textContent = `v${state.uploaderVersion}`;

  const badge = $("due-badge");
  if (state.daysUntilDue === null) {
    badge.textContent = "No upload sent yet";
    badge.className = "badge warn";
  } else if (state.daysUntilDue < 0) {
    badge.textContent = `Upload overdue by ${Math.abs(state.daysUntilDue)} day(s)`;
    badge.className = "badge warn";
  } else {
    badge.textContent = `Next upload due in ${state.daysUntilDue} day(s)`;
    badge.className = "badge ok";
  }

  $("auth-status").textContent = state.signedIn ? "Signed in for this session." : "";

  const integrity = $("log-integrity");
  if (!state.logIntegrity.valid) {
    notice(
      integrity,
      "bad",
      `The local upload log has been altered at entry ${state.logIntegrity.firstBrokenIndex + 1}. ` +
        `Report this to your regional Data Steward.`,
    );
  } else {
    integrity.replaceChildren();
  }

  setRows(
    $<HTMLTableElement>("history"),
    (state.log ?? [])
      .slice()
      .reverse()
      .map((entry: any) => [
        new Date(entry.timestamp).toLocaleString(),
        String(entry.recordCount),
        `${entry.coverageStart} – ${entry.coverageEnd}`,
        entry.status,
        entry.message,
      ]),
  );
}

$("save-setup").addEventListener("click", async () => {
  await amrss.saveState({
    facilityCode: $<HTMLInputElement>("facility-code").value.trim() || null,
    apiUrl: $<HTMLInputElement>("api-url").value.trim(),
    whonetConfigVersion: $<HTMLInputElement>("config-version").value.trim() || null,
    astBreakpointStandard: $<HTMLInputElement>("breakpoint-standard").value.trim() || null,
    uploadSchedule: $<HTMLSelectElement>("schedule").value,
  });
  await refresh();
});

$("choose-file").addEventListener("click", async () => {
  const target = $("detection");
  const chosen = await amrss.chooseWhonetFile();
  if (!chosen) return;

  const { path, detection } = chosen;

  if (!detection.profile) {
    notice(
      target,
      "bad",
      `This file could not be read as a WHONET database. Missing required field(s): ` +
        `${detection.unmappedRequired.join(", ")}. Available columns: ` +
        `${detection.availableColumns.slice(0, 30).join(", ")}. Contact your regional Data ` +
        `Steward — do not proceed with a partial mapping.`,
    );
    return;
  }

  await amrss.saveState({ whonetDatabasePath: path, profile: detection.profile });

  target.replaceChildren(
    definitionList([
      ["File", path],
      ["Table", detection.table],
      ["Patient identifier column", detection.profile.patientIdentifier],
      ["Specimen date column", detection.profile.specimenDate],
      ["Organism column", detection.profile.organism],
      ["Specimen type column", detection.profile.specimenType],
      ["Care setting column", detection.profile.careSetting ?? "not present"],
    ]),
  );

  if (detection.identifyingColumnsPresent.length > 0) {
    const warning = document.createElement("div");
    warning.className = "notice warn";
    warning.textContent =
      `This file contains identifying columns (${detection.identifyingColumnsPresent.join(", ")}). ` +
      `They are read on this computer to compute the patient linkage key and are never ` +
      `transmitted. Confirm the mapping above matches your WHONET configuration before uploading.`;
    target.append(warning);
  }
});

$("sign-in").addEventListener("click", async () => {
  $("auth-status").textContent = "Signing in…";
  try {
    const result = await amrss.signIn({
      email: $<HTMLInputElement>("email").value.trim(),
      password: $<HTMLInputElement>("password").value,
    });
    $<HTMLInputElement>("password").value = "";
    $("auth-status").textContent = result.ok ? "Signed in for this session." : result.message;
  } catch (error) {
    // A rejected IPC would otherwise leave the button looking inert. Surfacing
    // the message is what turns "nothing happens" into something actionable.
    $("auth-status").textContent = `Sign-in failed: ${(error as Error).message}`;
  }
  await refresh();
});

$("prepare").addEventListener("click", async () => {
  const target = $("summary");
  const sendButton = $<HTMLButtonElement>("send");
  sendButton.disabled = true;

  const result = await amrss.prepareBatch({ fungalCodes: FUNGAL_CODES });
  if (!result.ok) {
    notice(target, "warn", result.message);
    return;
  }

  const s = result.summary;
  target.replaceChildren(
    definitionList([
      ["Isolates to send", String(s.isolateCount)],
      ["Already accepted, skipped", String(s.skippedAsAlreadySent)],
      ["Coverage period", `${s.coverageStart} – ${s.coverageEnd}`],
      ["Distinct organisms", String(s.organismCount)],
      ["Susceptibility results", String(s.resultCount)],
      ["QC attestation", s.qcStatus],
      ["Compressed size", `${(s.compressedBytes / 1024).toFixed(1)} kB`],
      ["Checksum", result.checksum],
    ]),
  );
  const confirmation = document.createElement("div");
  confirmation.className = "notice ok";
  confirmation.textContent =
    "No patient identifiers are included in this batch. Sending confirms your facility's " +
    "agreement to contribute this de-identified data.";
  target.append(confirmation);

  sendButton.disabled = false;
});

$("send").addEventListener("click", async () => {
  const target = $("send-result");
  const sendButton = $<HTMLButtonElement>("send");
  sendButton.disabled = true;

  const result = await amrss.sendBatch();
  const tone = result.ok ? (result.batchStatus === "qc_hold" ? "warn" : "ok") : "bad";
  notice(target, tone, result.message);

  if (result.findings?.length) {
    const list = document.createElement("ul");
    for (const finding of result.findings) {
      const item = document.createElement("li");
      item.textContent = `${finding.severity.toUpperCase()} · ${finding.code}: ${finding.message}`;
      list.append(item);
    }
    target.append(list);
  }

  await refresh();
});

void refresh();
