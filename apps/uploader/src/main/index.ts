/**
 * Electron main process.
 *
 * All privileged work — reading the WHONET file, holding the salt, computing
 * linkage keys, transmitting — happens here. The renderer runs with node
 * integration off and context isolation on, and reaches this process only
 * through the narrow, explicitly-listed channels in preload.ts. A renderer
 * compromise therefore cannot read the salt or the patient data.
 */

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";

import { buildBatch, transmit, UPLOADER_VERSION } from "../core/payload";
import { daysUntilDue, LocalStore, verifyLog, type UploaderState } from "../core/store";
import { detectProfile, readIsolates } from "../core/whonet";

const store = new LocalStore(join(app.getPath("userData"), "amrss"));

/** Held in memory for the session only, never written to state or logged. */
let accessToken: string | null = null;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    title: `AMRSS Uploader ${UPLOADER_VERSION}`,
    backgroundColor: "#f6f8f7",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void window.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("state:read", () => {
  const state = store.read();
  const integrity = verifyLog(state.log);
  return {
    ...state,
    uploaderVersion: UPLOADER_VERSION,
    hasSalt: store.hasSalt(),
    signedIn: accessToken !== null,
    daysUntilDue: daysUntilDue(state),
    logIntegrity: integrity,
  };
});

ipcMain.handle("state:save", (_event, patch: Partial<UploaderState>) => {
  const state = { ...store.read(), ...patch };
  store.write(state);
  return state;
});

ipcMain.handle("whonet:choose", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select your WHONET data file",
    properties: ["openFile"],
    filters: [
      { name: "WHONET database", extensions: ["sqlite", "sqlite3", "db"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const path = result.filePaths[0];
  const detection = detectProfile(path);
  return { path, detection };
});

ipcMain.handle("auth:signIn", async (_event, input: { email: string; password: string }) => {
  const state = store.read();
  const response = await fetch(`${state.apiUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return { ok: false, message: (body.detail as string) ?? "Sign-in failed." };
  }
  accessToken = body.access_token as string;
  return { ok: true };
});

/**
 * Prepare a batch for review.
 *
 * Nothing leaves the machine here. The returned summary is what the facility
 * user confirms, and it contains counts only — never a patient identifier, and
 * never the linkage keys themselves (SDD 8.2 item 9).
 */
ipcMain.handle("batch:prepare", (_event, input: { fungalCodes: string[] }) => {
  const state = store.read();
  if (!state.profile || !state.whonetDatabasePath || !state.facilityCode) {
    return { ok: false, message: "Complete setup before preparing an upload." };
  }

  const salt = store.loadOrCreateSalt();
  try {
    store.verifySalt(state, salt);
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }

  try {
    const sources = readIsolates(state.whonetDatabasePath, state.profile, {
      since: state.lastSyncAt ? new Date(state.lastSyncAt) : undefined,
    });
    const batch = buildBatch(state.facilityCode, sources, {
      salt,
      facilityCode: state.facilityCode,
      fungalOrganismCodes: new Set(input.fungalCodes),
      whonetConfigVersion: state.whonetConfigVersion ?? undefined,
      astBreakpointStandard: state.astBreakpointStandard ?? undefined,
      alreadySent: new Set(state.sentRecordHashes),
    });
    pending = batch;
    return { ok: true, summary: batch.summary, checksum: batch.checksum };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
});

let pending: ReturnType<typeof buildBatch> | null = null;

/** Requires an explicit confirmation from the review screen — the practical
 * implementation of facility-level MOU-based consent (SDD 8.2 item 9). */
ipcMain.handle("batch:send", async () => {
  if (!pending) return { ok: false, message: "Prepare a batch before sending." };
  if (!accessToken) return { ok: false, message: "Sign in before sending." };

  let state = store.read();
  const result = await transmit(state.apiUrl, accessToken, pending);

  state = store.appendLog(state, {
    timestamp: new Date().toISOString(),
    batchId: result.batchId ?? null,
    recordCount: pending.summary.isolateCount,
    status: result.batchStatus ?? (result.ok ? "sent" : "failed"),
    checksum: pending.checksum,
    coverageStart: pending.summary.coverageStart,
    coverageEnd: pending.summary.coverageEnd,
    message: result.message,
  });

  // Record hashes are marked sent only on acceptance or hold — both mean the
  // server has the data. A failed transmission must leave them unsent so the
  // next run retries rather than silently skipping them forever.
  if (result.ok) {
    state = {
      ...state,
      sentRecordHashes: [...state.sentRecordHashes, ...pending.recordHashes],
      lastSyncAt: new Date().toISOString(),
    };
  }
  store.write(state);
  pending = null;

  return result;
});
