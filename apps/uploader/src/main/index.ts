/**
 * Electron main process.
 *
 * All privileged work — reading the WHONET file, holding the salt, computing
 * linkage keys, holding the session token, transmitting — happens here. The
 * renderer runs with node integration off and context isolation on, and reaches
 * this process only through the narrow, explicitly-listed channels in
 * preload.ts. A renderer compromise therefore cannot read the salt, the
 * patient data or the access token.
 *
 * The renderer is served from a custom `amrss://` scheme rather than `file://`
 * so that it can be split into ES modules — a single 3,000-line script is not a
 * thing anyone can review, and reviewability is the property this application
 * trades on.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from "electron";
import { statSync, watch, type FSWatcher, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

import { ORGANISMS, organismLabel, SPECIMEN_TYPES, specimenLabel } from "../core/dictionary";
import {
  clearCorrection,
  correct,
  type CorrectableField,
  excludeRow,
  mapCode,
  restoreRow,
  unmapCode,
} from "../core/corrections";
import { parseBreakpointCsv, type BreakpointSet } from "../core/interpret";
import { buildBatch, transmit, UPLOADER_VERSION } from "../core/payload";
import {
  approvalIsCurrent,
  describeSchedule,
  evaluateUploadGate,
  isDue,
  nextRunAt,
} from "../core/schedule";
import {
  apiUrlProblem,
  CredentialStore,
  normaliseApiUrl,
  probeConnectivity,
  roleLabel,
  SessionManager,
} from "../core/session";
import { daysUntilDue, LocalStore, setupComplete, type UploaderState, verifyLog } from "../core/store";
import { uploadableRecords } from "../core/validation";
import { detectProfile, toSourceIsolates } from "../core/whonet";
import {
  analyticsWorkbook,
  antibiogramWorkbook,
  gridWorkbook,
  historyWorkbook,
  trendWorkbook,
  validationWorkbook,
  type GridMode,
} from "./exports";
import { Workspace } from "./workspace";
import { buildGrid, type GridRequest } from "./grid";

const store = new LocalStore(join(app.getPath("userData"), "amrss"));
const credentials = new CredentialStore(join(app.getPath("userData"), "amrss"));
const session = new SessionManager(credentials);
const workspace = new Workspace(store);

/** Organism codes the dictionary marks fungal, so the batch can label kingdom
 * without asking the renderer to carry a list that would go stale. */
const FUNGAL_CODES = new Set(
  ORGANISMS.filter((organism) => organism.kingdom === "fungi").map((organism) => organism.code),
);

let mainWindow: BrowserWindow | null = null;
let connectivity = {
  online: false,
  checkedAt: null as string | null,
  latencyMs: null as number | null,
  detail: "Not checked yet.",
};
let watcher: FSWatcher | null = null;
let watchTimer: NodeJS.Timeout | null = null;
let reloadTimer: NodeJS.Timeout | null = null;
let connectivityTimer: NodeJS.Timeout | null = null;
let scheduleTimer: NodeJS.Timeout | null = null;
let pending: ReturnType<typeof buildBatch> | null = null;
/** Set when an automatic run was held back, so it complains once per retry
 * interval rather than once a minute. Held in memory: a restart is a reasonable
 * moment to try again. */
let retryAfterMs: number | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "amrss",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: `AMRSS Uploader ${UPLOADER_VERSION}`,
    backgroundColor: "#eef4f0",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  void mainWindow.loadURL("amrss://app/index.html");

  // Nothing in this application should open a second window or navigate away
  // from its own interface. A link a laboratory clicks goes to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

/** Serve the compiled renderer, and nothing outside it. */
function registerRendererProtocol(): void {
  const root = join(__dirname, "..", "renderer");
  protocol.handle("amrss", async (request) => {
    const url = new URL(request.url);
    const requested = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    const target = join(root, requested === "" ? "index.html" : requested);
    // Path traversal would turn the renderer into a reader of the whole disk.
    if (!target.startsWith(root)) return new Response("Not found", { status: 404 });
    try {
      return await net.fetch(pathToFileURL(target).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

app.whenReady().then(() => {
  registerRendererProtocol();
  buildMenu();
  createWindow();
  workspace.reload();
  startConnectivityMonitor();
  startFileWatcher();
  startScheduler();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Reload WHONET data",
          accelerator: "CmdOrCtrl+R",
          click: () => reloadAndNotify("manual"),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About AMRSS Uploader",
          click: () => {
            void dialog.showMessageBox({
              type: "info",
              title: "AMRSS Uploader",
              message: `AMRSS Uploader ${UPLOADER_VERSION}`,
              detail:
                "Reads your WHONET database, checks it, shows you your own data, and submits " +
                "de-identified surveillance records to the AMRSS platform. Patient identifiers " +
                "never leave this computer.",
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * Live connection to the file and to the platform.
 * ------------------------------------------------------------------ */

function startConnectivityMonitor(): void {
  const run = async (): Promise<void> => {
    const state = store.read();
    const result = await probeConnectivity(state.apiUrl);
    connectivity = {
      online: result.online,
      latencyMs: result.latencyMs,
      checkedAt: new Date().toISOString(),
      detail: result.detail,
    };

    // An offline session promotes itself the moment the link returns, so a
    // laboratory that started work on a dead connection does not have to sign
    // in again to upload.
    if (result.online && session.current?.mode === "offline") {
      await session.upgradeIfPossible(state.apiUrl);
    }

    // Sent on every tick rather than only on change: the payload also carries
    // the workspace, the schedule and the upload gate, and the shell redraws
    // its header from it.
    send("amrss:status", statusPayload(state));
  };

  void run();
  if (connectivityTimer) clearInterval(connectivityTimer);
  const seconds = Math.max(10, store.read().connectivity.pollSeconds);
  connectivityTimer = setInterval(() => void run(), seconds * 1000);
}

/**
 * Follow the WHONET file.
 *
 * WHONET writes to its database every time a result is entered, and a laboratory
 * that has just entered twenty results should see twenty results here. A watcher
 * catches the write immediately; the poll behind it is the backstop for the
 * cases watchers miss — network shares, and editors that replace the file rather
 * than writing into it.
 *
 * Reloads are debounced. A single WHONET save produces several filesystem
 * events, and re-reading four times would be visible as a stutter.
 */
function startFileWatcher(): void {
  stopFileWatcher();
  const state = store.read();
  if (!state.realtime.enabled || !state.whonetDatabasePath) return;

  try {
    watcher = watch(state.whonetDatabasePath, () => scheduleReload());
  } catch {
    // Unwatchable path (a network share, most often). The poll below still
    // catches changes; it is slower, not absent.
  }

  const seconds = Math.max(5, state.realtime.pollSeconds);
  watchTimer = setInterval(() => {
    const snapshot = workspace.snapshot();
    if (!snapshot.path) return;
    try {
      const stats = statSync(snapshot.path);
      if (snapshot.fileModifiedMs !== null && stats.mtimeMs !== snapshot.fileModifiedMs) {
        scheduleReload();
      }
    } catch {
      /* the file is momentarily locked by WHONET; the next tick will see it */
    }
  }, seconds * 1000);
}

function stopFileWatcher(): void {
  watcher?.close();
  watcher = null;
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}

function scheduleReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => reloadAndNotify("watcher"), 1500);
}

function reloadAndNotify(trigger: string): void {
  const state = store.read();
  const snapshot = workspace.reload(state);

  // The sign-off is a statement about data that has now changed.
  if (state.approval && !approvalIsCurrent(state.approval, snapshot.fingerprint)) {
    store.write({ ...state, approval: null });
  }

  send("amrss:data", { snapshot, trigger });
  send("amrss:status", statusPayload(store.read()));
}

function startScheduler(): void {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(() => void runScheduledUpload(), 60_000);
}

/**
 * The automatic run.
 *
 * It refuses far more often than it sends, and that is the design. Everything
 * the send button checks is checked here — signed in, online, validated, signed
 * off where the facility asked for it — and a refusal is reported to the
 * interface rather than retried silently, because a schedule that has been
 * failing quietly for a fortnight is worse than no schedule.
 */
async function runScheduledUpload(): Promise<void> {
  const state = store.read();
  if (state.schedule.mode !== "automatic") return;
  if (retryAfterMs !== null && Date.now() < retryAfterMs) return;
  if (!isDue(state.schedule, state.lastAutomaticRunAt, new Date())) return;

  const report = (ran: boolean, reason: string | null, code: string): void => {
    send("amrss:schedule", { ran, at: new Date().toISOString(), reason, code });
  };

  const gate = currentGate(state);
  if (!gate.allowed) {
    // A blocked run stays due. `lastAutomaticRunAt` is deliberately not moved —
    // that field records when a batch actually went — so once the obstacle
    // clears (the connection returns, the findings are fixed) the next tick
    // sends. The retry stamp only stops it from complaining every minute in the
    // meantime.
    retryAfterMs = Date.now() + Math.max(5, state.schedule.retryMinutes) * 60_000;
    report(false, gate.reason, gate.code);
    return;
  }

  const prepared = prepareBatch(state);
  if (!prepared.ok) {
    // Nothing new to send is a completed run, not a failure: the schedule has
    // done its job and should wait for its next slot.
    retryAfterMs = null;
    store.write({ ...state, lastAutomaticRunAt: new Date().toISOString() });
    report(false, prepared.message, "nothing_to_send");
    return;
  }

  const result = await sendPrepared("automatic");
  retryAfterMs = result.ok
    ? null
    : Date.now() + Math.max(5, state.schedule.retryMinutes) * 60_000;
  if (result.ok) store.write({ ...store.read(), lastAutomaticRunAt: new Date().toISOString() });
  report(result.ok, result.message, result.ok ? "ok" : "failed");
  send("amrss:status", statusPayload(store.read()));
}

/* ------------------------------------------------------------------ *
 * Status, the payload the whole shell is drawn from.
 * ------------------------------------------------------------------ */

function currentGate(state: UploaderState) {
  const snapshot = workspace.snapshot();
  const report = workspace.validation;
  return evaluateUploadGate({
    signedIn: session.current !== null,
    online: connectivity.online && session.isOnline,
    setupComplete: setupComplete(state),
    blockingFindings: report?.blocking ?? 0,
    recordsReady: report?.recordsReady ?? snapshot.recordCount,
    requireValidation: state.schedule.requireValidation,
    requireSignOff: state.schedule.requireValidatedSignOff,
    approvalCurrent: approvalIsCurrent(state.approval, snapshot.fingerprint),
  });
}

function statusPayload(state: UploaderState) {
  const snapshot = workspace.snapshot();
  const current = session.current;
  return {
    uploaderVersion: UPLOADER_VERSION,
    session: current
      ? {
          fullName: current.profile.fullName,
          role: current.profile.role,
          roleLabel: roleLabel(current.profile.role),
          email: current.profile.email,
          username: current.profile.username,
          facilityId: current.profile.facilityId,
          permissions: current.profile.permissions,
          mustChangePassword: current.profile.mustChangePassword,
          mode: current.mode,
          offlineDaysRemaining: current.offlineDaysRemaining,
          signedInAt: current.signedInAt,
        }
      : null,
    connectivity,
    facility: { code: state.facilityCode, name: state.facilityName },
    apiUrl: state.apiUrl,
    webUrl: state.webUrl,
    setupComplete: setupComplete(state),
    schedule: {
      ...state.schedule,
      description: describeSchedule(state.schedule),
      nextRunAt: nextRunAt(state.schedule, state.lastAutomaticRunAt, new Date())?.toISOString() ?? null,
    },
    realtime: state.realtime,
    connectivitySettings: state.connectivity,
    analysis: state.analysis,
    approval: state.approval,
    approvalCurrent: approvalIsCurrent(state.approval, snapshot.fingerprint),
    gate: currentGate(state),
    daysUntilDue: daysUntilDue(state),
    lastSyncAt: state.lastSyncAt,
    workspace: snapshot,
    logIntegrity: verifyLog(state.log),
    uploadCount: state.log.length,
  };
}

/* ------------------------------------------------------------------ *
 * IPC.
 * ------------------------------------------------------------------ */

ipcMain.handle("app:status", () => statusPayload(store.read()));

ipcMain.handle("app:settings", () => {
  const state = store.read();
  return {
    ...state,
    // The renderer never needs these and must not hold them.
    sentRecordHashes: [],
    hasSalt: store.hasSalt(),
    stateDirectory: store.stateDirectory,
  };
});

ipcMain.handle("settings:save", (_event, patch: Partial<UploaderState>) => {
  const previous = store.read();
  const next: UploaderState = {
    ...previous,
    ...patch,
    apiUrl: patch.apiUrl !== undefined ? normaliseApiUrl(patch.apiUrl) : previous.apiUrl,
    schedule: { ...previous.schedule, ...(patch.schedule ?? {}) },
    realtime: { ...previous.realtime, ...(patch.realtime ?? {}) },
    connectivity: { ...previous.connectivity, ...(patch.connectivity ?? {}) },
    analysis: { ...previous.analysis, ...(patch.analysis ?? {}) },
  };
  store.write(next);

  // Settings that change how the application listens take effect immediately
  // rather than at the next restart.
  if (
    patch.realtime !== undefined ||
    patch.whonetDatabasePath !== undefined ||
    patch.includeUntestedIsolates !== undefined
  ) {
    startFileWatcher();
    reloadAndNotify("settings");
  }
  if (patch.connectivity !== undefined || patch.apiUrl !== undefined) startConnectivityMonitor();

  return statusPayload(next);
});

ipcMain.handle("setup:chooseWhonetFile", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select your WHONET data file",
    properties: ["openFile"],
    filters: [
      { name: "WHONET database", extensions: ["sqlite", "sqlite3", "db", "mdb"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const path = result.filePaths[0];
  try {
    const detection = detectProfile(path);
    return { path, detection };
  } catch (error) {
    return { path, detection: null, error: (error as Error).message };
  }
});

ipcMain.handle(
  "setup:confirmWhonetFile",
  (_event, input: { path: string; profile: unknown }) => {
    const state = store.read();
    store.write({
      ...state,
      whonetDatabasePath: input.path,
      profile: input.profile as UploaderState["profile"],
      setupCompletedAt: state.setupCompletedAt ?? new Date().toISOString(),
      approval: null,
    });
    startFileWatcher();
    reloadAndNotify("setup");
    return statusPayload(store.read());
  },
);

ipcMain.handle(
  "auth:signIn",
  async (_event, input: { identifier: string; password: string; apiUrl?: string }) => {
    const state = store.read();
    // The sign-in screen carries the address so a first run can be completed in
    // one place; saving it here is what makes the next launch one step shorter.
    if (input.apiUrl !== undefined && normaliseApiUrl(input.apiUrl) !== state.apiUrl) {
      store.write({ ...state, apiUrl: normaliseApiUrl(input.apiUrl) });
      startConnectivityMonitor();
    }

    const current = store.read();
    const outcome = await session.signIn(current.apiUrl, input.identifier, input.password, {
      offlineGraceDays: current.offlineGraceDays,
    });

    if (outcome.ok) {
      const probe = await probeConnectivity(current.apiUrl);
      connectivity = {
        online: probe.online,
        latencyMs: probe.latencyMs,
        checkedAt: new Date().toISOString(),
        detail: probe.detail,
      };
      // Signing in is when the platform's dictionaries and breakpoint table are
      // worth fetching: it is the one moment the software knows it has both a
      // network and an authenticated caller.
      if (outcome.session.mode === "online") await syncBreakpoints(current.apiUrl);
      reloadAndNotify("sign-in");
    }

    return {
      ok: outcome.ok,
      message: outcome.message,
      code: outcome.ok ? "ok" : outcome.code,
      status: statusPayload(store.read()),
    };
  },
);

ipcMain.handle("auth:signOut", () => {
  session.signOut();
  return statusPayload(store.read());
});

ipcMain.handle("auth:openWebConsole", async () => {
  const state = store.read();
  if (!state.webUrl.trim()) {
    return { ok: false, message: "No web console address is configured. Add it in Settings." };
  }
  if (!connectivity.online || !session.isOnline) {
    return {
      ok: false,
      message: "The web console needs a connection. You are working offline at the moment.",
    };
  }
  const url = await session.webConsoleUrl(state.apiUrl, state.webUrl);
  if (!url) {
    return {
      ok: false,
      message: "The server would not issue a sign-in link. Try signing in again.",
    };
  }
  await shell.openExternal(url);
  return { ok: true, message: "Opening the web console in your browser, signed in as you." };
});

ipcMain.handle("data:reload", () => {
  reloadAndNotify("manual");
  return statusPayload(store.read());
});

ipcMain.handle("data:grid", (_event, request: GridRequest) => {
  const dataset = workspace.appliedDataset;
  if (!dataset) return { rows: [], columns: [], total: 0, page: 1, pageSize: request.pageSize ?? 50 };
  return buildGrid(dataset, workspace.breakpointIndex, workspace.validation, request);
});

/** One record, with everything needed to correct it: the values, the findings
 * against it, what the file originally said, and the dictionary entries a
 * correction may choose from. */
ipcMain.handle("data:record", (_event, rowKey: string) => {
  const dataset = workspace.appliedDataset;
  const record = dataset?.records.find((candidate) => candidate.key === rowKey);
  if (!dataset || !record) return null;

  const corrections = store.readCorrections();
  const rowCorrection = corrections.rows[rowKey];

  return {
    record: {
      key: record.key,
      rowIndex: record.rowIndex,
      organismCode: record.organismCode,
      organismName: organismLabel(record.organismCode),
      specimenTypeCode: record.specimenTypeCode,
      specimenName: specimenLabel(record.specimenTypeCode),
      values: {
        patientIdentifier: record.patientIdentifier,
        specimenNumber: record.specimenNumber,
        specimenDate: record.specimenDate ? record.specimenDate.toISOString().slice(0, 10) : "",
        sex: record.sex,
        ageYears: record.ageYears === null ? "" : String(record.ageYears),
        careSettingRaw: record.careSettingRaw,
        specimenTypeCode: record.specimenTypeCode,
        organismCode: record.organismCode,
      },
    },
    issues: (workspace.validation?.issues ?? []).filter((issue) => issue.rowKey === rowKey),
    corrections: rowCorrection?.fields ?? {},
    excluded: Boolean(
      dataset.excluded.some(
        (entry) => entry.key === rowKey && entry.reason === "excluded_by_facility",
      ),
    ),
    organismOptions: ORGANISMS.map((organism) => ({
      code: organism.code,
      name: organism.name,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    specimenOptions: SPECIMEN_TYPES.map((specimen) => ({
      code: specimen.code,
      name: specimen.name,
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
});

ipcMain.handle("analytics:overview", (_event, filters) =>
  workspace.analytics(store.read(), filters ?? {}),
);

ipcMain.handle("analytics:antibiogram", (_event, filters) =>
  workspace.antibiogram(store.read(), filters ?? {}),
);

ipcMain.handle("analytics:antibiotics", (_event, filters) =>
  workspace.antibiotics(store.read(), filters ?? {}),
);

ipcMain.handle(
  "analytics:trend",
  (_event, input: { filters: unknown; antibioticCode: string; bucket: "month" | "quarter" }) =>
    workspace.trend(
      store.read(),
      (input.filters ?? {}) as never,
      input.antibioticCode,
      input.bucket ?? "month",
    ),
);

ipcMain.handle("validation:report", () => workspace.validation);

ipcMain.handle(
  "validation:correct",
  (
    _event,
    input: { rowKey: string; field: CorrectableField; value: string | null; note?: string },
  ) => {
    const dataset = workspace.appliedDataset;
    const record = dataset?.records.find((candidate) => candidate.key === input.rowKey);
    if (!record) return { ok: false, message: "That row is no longer in the file." };

    const by = session.current?.profile.fullName ?? null;
    store.writeCorrections(
      correct(store.readCorrections(), record, input.field, input.value, {
        note: input.note ?? null,
        by,
      }),
    );
    reloadAndNotify("correction");
    return { ok: true, message: "Correction saved. The WHONET file is unchanged." };
  },
);

ipcMain.handle(
  "validation:clearCorrection",
  (_event, input: { rowKey: string; field: CorrectableField }) => {
    store.writeCorrections(clearCorrection(store.readCorrections(), input.rowKey, input.field));
    reloadAndNotify("correction");
    return { ok: true, message: "Correction removed." };
  },
);

ipcMain.handle("validation:exclude", (_event, input: { rowKey: string; reason: string }) => {
  const by = session.current?.profile.fullName ?? null;
  store.writeCorrections(excludeRow(store.readCorrections(), input.rowKey, input.reason, by));
  reloadAndNotify("correction");
  return { ok: true, message: "Row held out of the upload." };
});

ipcMain.handle("validation:restore", (_event, input: { rowKey: string }) => {
  store.writeCorrections(restoreRow(store.readCorrections(), input.rowKey));
  reloadAndNotify("correction");
  return { ok: true, message: "Row restored." };
});

ipcMain.handle("validation:mappings", () => store.readCorrections().mappings);

ipcMain.handle(
  "validation:mapCode",
  (_event, input: { entity: "organism" | "specimen" | "antibiotic"; from: string; to: string }) => {
    store.writeCorrections(mapCode(store.readCorrections(), input.entity, input.from, input.to));
    reloadAndNotify("mapping");
    return { ok: true, message: `"${input.from}" now maps to "${input.to}" everywhere in this file.` };
  },
);

ipcMain.handle(
  "validation:unmapCode",
  (_event, input: { entity: "organism" | "specimen" | "antibiotic"; from: string }) => {
    store.writeCorrections(unmapCode(store.readCorrections(), input.entity, input.from));
    reloadAndNotify("mapping");
    return { ok: true, message: "Mapping removed." };
  },
);

/**
 * A person signing off on the data as it stands.
 *
 * Recorded against a fingerprint of the data, so it lapses the instant WHONET
 * writes another result. An automatic upload will not send without a current
 * sign-off unless the facility has turned that requirement off.
 */
ipcMain.handle("validation:approve", () => {
  const state = store.read();
  const snapshot = workspace.snapshot();
  const report = workspace.validation;

  if (state.schedule.requireValidation && (report?.blocking ?? 0) > 0) {
    return {
      ok: false,
      message: `${report?.blocking} record problem(s) must be fixed before the data can be approved.`,
    };
  }

  store.write({
    ...state,
    approval: {
      fingerprint: snapshot.fingerprint,
      approvedAt: new Date().toISOString(),
      approvedBy: session.current?.profile.fullName ?? null,
      recordCount: snapshot.recordCount,
      blockingAtApproval: report?.blocking ?? 0,
    },
  });
  send("amrss:status", statusPayload(store.read()));
  return { ok: true, message: "Data approved for upload." };
});

ipcMain.handle("breakpoints:status", () => workspace.snapshot().breakpoints);

ipcMain.handle("breakpoints:sync", async () => {
  const state = store.read();
  if (!session.isOnline) {
    return { ok: false, message: "Sign in online to fetch the breakpoint table." };
  }
  const result = await syncBreakpoints(state.apiUrl);
  reloadAndNotify("breakpoints");
  return result;
});

ipcMain.handle("breakpoints:import", async () => {
  const chosen = await dialog.showOpenDialog({
    title: "Select your CLSI breakpoint table (template CSV)",
    properties: ["openFile"],
    filters: [{ name: "Breakpoint table", extensions: ["csv"] }],
  });
  if (chosen.canceled || !chosen.filePaths[0]) return { ok: false, message: "Import cancelled." };

  const text = await readFile(chosen.filePaths[0], "utf8");
  const parsed = parseBreakpointCsv(text);
  if (parsed.problems.length > 0) {
    return {
      ok: false,
      message: `The table was not imported. ${parsed.problems.slice(0, 5).join("; ")}`,
    };
  }

  const set: BreakpointSet = {
    version: `local-import-${new Date().toISOString().slice(0, 10)}`,
    label: `Imported from ${chosen.filePaths[0]}`,
    effectiveFrom: new Date().toISOString().slice(0, 10),
    source: "local-import",
    syncedAt: new Date().toISOString(),
    criteria: parsed.criteria,
  };
  store.writeBreakpoints(set);
  reloadAndNotify("breakpoints");
  return { ok: true, message: `Imported ${parsed.criteria.length} breakpoint criteria.` };
});

async function syncBreakpoints(apiUrl: string): Promise<{ ok: boolean; message: string }> {
  const token = session.token;
  if (!token) return { ok: false, message: "Sign in first." };
  try {
    const response = await fetch(`${normaliseApiUrl(apiUrl)}/api/v1/breakpoints/active`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      return { ok: false, message: `The server answered ${response.status}.` };
    }
    const body = (await response.json()) as {
      version: string | null;
      label: string | null;
      effective_from: string | null;
      criteria: unknown[];
    };
    store.writeBreakpoints({
      version: body.version,
      label: body.label,
      effectiveFrom: body.effective_from,
      source: "platform",
      syncedAt: new Date().toISOString(),
      criteria: (body.criteria ?? []) as BreakpointSet["criteria"],
    });
    return {
      ok: true,
      message:
        body.criteria?.length > 0
          ? `Synced ${body.criteria.length} breakpoint criteria (${body.label ?? body.version}).`
          : "The platform has no breakpoint table loaded yet, so measurements stay pending.",
    };
  } catch (error) {
    return { ok: false, message: `Could not fetch breakpoints: ${(error as Error).message}` };
  }
}

/* ------------------------------------------------------------------ *
 * The batch.
 * ------------------------------------------------------------------ */

/**
 * Prepare a batch for review.
 *
 * Nothing leaves the machine here. The returned summary is what the facility
 * user confirms, and it contains counts only — never a patient identifier, and
 * never the linkage keys themselves (SDD 8.2 item 9).
 */
function prepareBatch(
  state: UploaderState,
): { ok: true; summary: unknown; checksum: string } | { ok: false; message: string } {
  if (!state.profile || !state.whonetDatabasePath || !state.facilityCode) {
    return { ok: false, message: "Complete setup before preparing an upload." };
  }
  const dataset = workspace.appliedDataset;
  const report = workspace.validation;
  if (!dataset || !report) {
    return { ok: false, message: "No WHONET data has been read yet." };
  }

  const salt = store.loadOrCreateSalt();
  try {
    store.verifySalt(state, salt);
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }

  try {
    // Only records that cleared validation. A blocked row stays at the
    // laboratory until it is fixed, and uploads on a later run.
    const sources = toSourceIsolates(uploadableRecords(dataset, report));
    const batch = buildBatch(state.facilityCode, sources, {
      salt,
      facilityCode: state.facilityCode,
      fungalOrganismCodes: FUNGAL_CODES,
      whonetConfigVersion: state.whonetConfigVersion ?? undefined,
      astBreakpointStandard: state.astBreakpointStandard ?? undefined,
      alreadySent: new Set(state.sentRecordHashes),
    });
    pending = batch;
    return { ok: true, summary: batch.summary, checksum: batch.checksum };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

ipcMain.handle("upload:prepare", () => {
  const state = store.read();
  const prepared = prepareBatch(state);
  return { ...prepared, gate: currentGate(state) };
});

/** Requires an explicit confirmation from the review screen — the practical
 * implementation of facility-level MOU-based consent (SDD 8.2 item 9). */
ipcMain.handle("upload:send", async () => {
  const gate = currentGate(store.read());
  if (!gate.allowed) return { ok: false, message: gate.reason ?? "Upload is not permitted yet." };
  return sendPrepared("manual");
});

async function sendPrepared(trigger: "manual" | "automatic"): Promise<{
  ok: boolean;
  message: string;
  batchStatus?: string;
  findings?: unknown[];
}> {
  if (!pending) {
    const prepared = prepareBatch(store.read());
    if (!prepared.ok) return { ok: false, message: prepared.message };
  }
  const batch = pending!;
  const token = session.token;
  if (!token) return { ok: false, message: "Sign in before sending." };

  let state = store.read();
  const result = await transmit(state.apiUrl, token, batch);

  state = store.appendLog(state, {
    timestamp: new Date().toISOString(),
    batchId: result.batchId ?? null,
    recordCount: batch.summary.isolateCount,
    status: result.batchStatus ?? (result.ok ? "sent" : "failed"),
    checksum: batch.checksum,
    coverageStart: batch.summary.coverageStart,
    coverageEnd: batch.summary.coverageEnd,
    message: result.message,
    trigger,
  });

  // Record hashes are marked sent only on acceptance or hold — both mean the
  // server has the data. A failed transmission must leave them unsent so the
  // next run retries rather than silently skipping them forever.
  if (result.ok) {
    state = {
      ...state,
      sentRecordHashes: [...state.sentRecordHashes, ...batch.recordHashes],
      lastSyncAt: new Date().toISOString(),
    };
  }
  store.write(state);
  pending = null;

  send("amrss:status", statusPayload(store.read()));
  return result;
}

/* ------------------------------------------------------------------ *
 * Downloads.
 * ------------------------------------------------------------------ */

async function saveWorkbook(suggestedName: string, build: () => Buffer): Promise<{
  ok: boolean;
  message: string;
  path?: string;
}> {
  const chosen = await dialog.showSaveDialog({
    title: "Save workbook",
    defaultPath: suggestedName,
    filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
  });
  if (chosen.canceled || !chosen.filePath) return { ok: false, message: "Download cancelled." };

  try {
    writeFileSync(chosen.filePath, build());
    return { ok: true, message: `Saved to ${chosen.filePath}`, path: chosen.filePath };
  } catch (error) {
    return { ok: false, message: `Could not save the file: ${(error as Error).message}` };
  }
}

const stamp = (): string => new Date().toISOString().slice(0, 10);

ipcMain.handle("export:grid", async (_event, input: { mode: GridMode }) => {
  const dataset = workspace.appliedDataset;
  if (!dataset) return { ok: false, message: "No WHONET data has been read yet." };
  const state = store.read();
  return saveWorkbook(
    `amrss-database-${input.mode}-${stamp()}.xlsx`,
    () =>
      gridWorkbook(dataset, workspace.breakpointIndex, input.mode, {
        facility: state.facilityCode,
        // This workbook is written to the laboratory's own disk and never
        // transmitted, so it carries the laboratory's own identifiers — the
        // same ones already on screen and in WHONET. What leaves the building
        // is the batch, and the batch is built from an allow-list that has no
        // route for them.
        includeIdentifiers: true,
      }),
  );
});

ipcMain.handle("export:validation", async () => {
  const dataset = workspace.appliedDataset;
  const report = workspace.validation;
  if (!dataset || !report) return { ok: false, message: "No WHONET data has been read yet." };
  return saveWorkbook(`amrss-validation-${stamp()}.xlsx`, () =>
    validationWorkbook(report, dataset),
  );
});

ipcMain.handle("export:antibiogram", async (_event, filters) => {
  const state = store.read();
  return saveWorkbook(`amrss-antibiogram-${stamp()}.xlsx`, () =>
    antibiogramWorkbook(
      workspace.filtered(filters ?? {}),
      state.analysis,
      filters ?? {},
      workspace.breakpointIndex,
    ),
  );
});

ipcMain.handle("export:analytics", async (_event, filters) => {
  const state = store.read();
  return saveWorkbook(`amrss-analysis-${stamp()}.xlsx`, () =>
    analyticsWorkbook(workspace.filtered(filters ?? {}), state.analysis, filters ?? {}),
  );
});

ipcMain.handle(
  "export:trend",
  async (
    _event,
    input: { filters: unknown; antibioticCode: string; bucket: "month" | "quarter" },
  ) => {
    const state = store.read();
    return saveWorkbook(`amrss-trend-${input.antibioticCode}-${stamp()}.xlsx`, () =>
      trendWorkbook(
        workspace.filtered((input.filters ?? {}) as never),
        state.analysis,
        (input.filters ?? {}) as never,
        input.antibioticCode,
        input.bucket ?? "month",
      ),
    );
  },
);

ipcMain.handle("export:history", async () =>
  saveWorkbook(`amrss-upload-history-${stamp()}.xlsx`, () => historyWorkbook(store.read().log)),
);

ipcMain.handle("app:openStateFolder", async () => {
  await shell.openPath(store.stateDirectory);
  return { ok: true, message: "Opened the AMRSS data folder." };
});

ipcMain.handle("app:apiUrlProblem", (_event, url: string) => apiUrlProblem(url));
