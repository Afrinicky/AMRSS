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
import { readFileSync, statSync, watch, type FSWatcher, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

import { blueprintFiles, readDeploymentDefaults, suppliedBreakpointPath } from "../core/deployment";
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
import { parseBreakpointCsv, type BreakpointCriterion, type BreakpointSet } from "../core/interpret";
import {
  BREAKPOINT_COLUMNS,
  breakpointCsv,
  breakpointSheetRows,
  catalogue,
  type CellField,
  completeness,
  criterionRow,
  describeSet,
  matchesPreference,
  organismGroupsIn,
  readBreakpointSheet,
  removeCriterion,
  setCell,
  upsertCriterion,
} from "../core/breakpoints";
import { convertM100Workbook } from "../core/m100";
import { buildWorkbook } from "../core/xlsx";
import { readWorkbook } from "../core/xlsx-read";
import {
  codebookWorkbook,
  describeImport,
  readCodebookWorkbook,
  unmappedCodes,
} from "../core/codebook";
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
import { PlatformClient } from "../core/platform";
import type { PlatformResult } from "../core/session";
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

/**
 * What this installation was pointed at when it was installed.
 *
 * Looked for beside the packaged application first, then in the project during
 * development. Its presence is what lets the sign-in screen ask for nothing but
 * a username and password.
 */
const RESOURCE_DIRECTORIES = [
  process.resourcesPath ?? "",
  join(app.getAppPath(), ".."),
  app.getAppPath(),
  process.cwd(),
  // In development the application runs from apps/uploader, and the supplied
  // table sits under `data/` at the root of the repository. Packaged, the build
  // copies it to `breakpoints/` beside the application, which the entries above
  // already cover.
  join(process.cwd(), "..", "..", "data"),
];

const deployment = readDeploymentDefaults(RESOURCE_DIRECTORIES);

/** What the supplied table is called on screen. Named by its edition, so a
 * laboratory can tell at a glance whether it is the one they report under. */
const SUPPLIED_BREAKPOINTS_LABEL = "CLSI M100 36th edition (2026), supplied with AMRSS";

const store = new LocalStore(join(app.getPath("userData"), "amrss"), deployment);
const credentials = new CredentialStore(join(app.getPath("userData"), "amrss"));
const session = new SessionManager(credentials);
const workspace = new Workspace(store);

/**
 * The platform, for the parts of the application that administer it.
 *
 * Reads the API address on every call rather than capturing it, because a
 * laboratory can change it in Settings without restarting, and a client holding
 * the old one would fail in a way nobody would connect to the change.
 */
const platform = new PlatformClient(session, () => store.read().apiUrl);

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
          label: "Connection settings (IT)",
          click: () => send("amrss:open-connection-settings", {}),
        },
        { type: "separator" },
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
                "never leave this computer." +
                (deployment.supportContact ? `\n\nSupport: ${deployment.supportContact}` : ""),
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
          regionalBlockId: current.profile.regionalBlockId,
          breakpoints: current.profile.breakpoints,
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
    patch.includeUntestedIsolates !== undefined ||
    // Which method a laboratory reads changes what counts as covered, so the
    // coverage figure and the grid are recomputed rather than left stale.
    patch.testingMethod !== undefined
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
  async (_event, input: { identifier: string; password: string }) => {
    const current = store.read();
    const outcome = await session.signIn(current.apiUrl, input.identifier, input.password, {
      offlineGraceDays: current.offlineGraceDays,
      supportContact: deployment.supportContact,
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
      detail: outcome.ok ? undefined : outcome.detail,
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
 * The whole code book, out and back.
 *
 * The workbook opens with the laboratory's outstanding gaps already listed, so
 * the job is filling in a column rather than transcribing codes off a screen.
 */
ipcMain.handle("mapping:export", async () => {
  const mappings = store.readCorrections().mappings;
  const dataset = workspace.appliedDataset;
  const gaps = dataset ? unmappedCodes(dataset.records, mappings) : {};
  return saveWorkbook(`amrss-code-mapping-${stamp()}.xlsx`, () =>
    codebookWorkbook(mappings, gaps),
  );
});

ipcMain.handle("mapping:import", async () => {
  const chosen = await dialog.showOpenDialog({
    title: "Select your completed code mapping workbook",
    properties: ["openFile"],
    filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
  });
  if (chosen.canceled || !chosen.filePaths[0]) return { ok: false, message: "Import cancelled." };

  let result;
  try {
    result = readCodebookWorkbook(readFileSync(chosen.filePaths[0]), store.readCorrections().mappings);
  } catch (error) {
    return {
      ok: false,
      message: `That file could not be read as a workbook: ${(error as Error).message}`,
    };
  }

  const book = store.readCorrections();
  store.writeCorrections({ ...book, mappings: result.mappings });
  reloadAndNotify("mapping");

  // Rows naming a code AMRSS does not hold are reported, never applied — a
  // mapping onto a code that does not exist would fail silently on every row
  // that used it. The rest of the workbook still goes in.
  return {
    ok: result.problems.length === 0,
    message:
      result.problems.length === 0
        ? describeImport(result)
        : `${describeImport(result)} ${result.problems.length} row(s) were not applied.`,
    problems: result.problems.slice(0, 20),
  };
});

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

/** Whether this installation was built with a breakpoint table, so Settings can
 * offer it rather than advertising a button that does nothing. */
ipcMain.handle("breakpoints:supplied", () => {
  const path = suppliedBreakpointPath(RESOURCE_DIRECTORIES);
  return { available: path !== null, label: SUPPLIED_BREAKPOINTS_LABEL };
});

/**
 * Load the table the installer was built with.
 *
 * Offered as a button and never applied on first run. A table that appeared by
 * itself is a table nobody chose, and therefore one nobody checked against the
 * edition their laboratory actually reports under. Pressing the button is the
 * check; it goes through the same parser and the same method filter as any other
 * import.
 */
ipcMain.handle("breakpoints:loadSupplied", async () => {
  const path = suppliedBreakpointPath(RESOURCE_DIRECTORIES);
  if (!path) {
    return {
      ok: false,
      message: "This installation was not built with a breakpoint table.",
    };
  }

  const parsed = parseBreakpointCsv(await readFile(path, "utf8"));
  if (parsed.problems.length > 0) {
    return {
      ok: false,
      message: `The supplied table could not be read. ${parsed.problems.slice(0, 3).join("; ")}`,
      problems: parsed.problems.slice(0, 20),
    };
  }

  const preference = store.read().testingMethod;
  const criteria = parsed.criteria.filter((criterion) =>
    matchesPreference(criterion, preference),
  );
  store.writeBreakpoints({
    version: "CLSI-M100-Ed36",
    label: SUPPLIED_BREAKPOINTS_LABEL,
    effectiveFrom: new Date().toISOString().slice(0, 10),
    source: "local-import",
    syncedAt: new Date().toISOString(),
    criteria,
  });
  reloadAndNotify("breakpoints");
  return {
    ok: true,
    message:
      `Loaded ${criteria.length} criteria from ${SUPPLIED_BREAKPOINTS_LABEL}. ` +
      "Check it against your own copy of the edition before you rely on it.",
  };
});

/**
 * The blueprints this installation carries, newest first.
 *
 * Distinct from the supplied table: the blueprint holds no thresholds at all,
 * so it ships regardless of what a deployment's CLSI licence permits, and
 * loading it turns "no breakpoint table" from a dead end into a form to fill
 * in.
 */
ipcMain.handle("breakpoints:blueprints", () =>
  blueprintFiles(RESOURCE_DIRECTORIES).map((file) => ({
    edition: file.edition,
    label: `CLSI M100, ${file.edition} edition — structure only, no thresholds`,
  })),
);

/**
 * Load a blueprint as the working table.
 *
 * Every row arrives as a placeholder: the combination is real, the numbers are
 * not there yet. That is safe to hold and impossible to be misled by — the
 * interpretation engine selects on thresholds, so a row with none never
 * matches and the measurement stays `PI`, which is exactly what it is.
 *
 * Refuses to overwrite a table that already has thresholds in it. Loading a
 * blueprint over a filled table would discard somebody's typing with no way
 * back, and the two are one click apart on the same screen.
 */
ipcMain.handle("breakpoints:loadBlueprint", async (_event, input: { edition?: string } = {}) => {
  const available = blueprintFiles(RESOURCE_DIRECTORIES);
  const chosen = input.edition
    ? available.find((file) => file.edition === input.edition)
    : available[0];
  if (!chosen) {
    return {
      ok: false,
      message: "This installation was not built with a breakpoint blueprint.",
    };
  }

  const existing = store.readBreakpoints();
  const filled = completeness(existing.criteria).filled;
  if (filled > 0) {
    return {
      ok: false,
      message:
        `The table already holds ${filled} threshold${filled === 1 ? "" : "s"}. Loading a ` +
        "blueprint would replace them. Export what you have first, or start a new edition, " +
        "which keeps this one intact.",
    };
  }

  const parsed = parseBreakpointCsv(await readFile(chosen.path, "utf8"));
  if (parsed.problems.length > 0) {
    return {
      ok: false,
      message: `The blueprint could not be read. ${parsed.problems.slice(0, 3).join("; ")}`,
      problems: parsed.problems.slice(0, 20),
    };
  }

  const preference = store.read().testingMethod;
  const criteria = parsed.criteria.filter((criterion) => matchesPreference(criterion, preference));
  store.writeBreakpoints({
    version: `M100-blueprint-${chosen.edition}`,
    label: `CLSI M100, ${chosen.edition} edition`,
    effectiveFrom: `${chosen.edition}-01-01`,
    source: "blueprint",
    syncedAt: new Date().toISOString(),
    criteria,
  });
  reloadAndNotify("breakpoints");
  return {
    ok: true,
    message:
      `Loaded the ${chosen.edition} layout: ${criteria.length} rows across ` +
      `${new Set(criteria.map((criterion) => criterion.organism_group)).size} organism groups, ` +
      "with every threshold blank. Export it, fill it in from your licensed M100, and import " +
      "it back — or type the values straight into the table.",
  };
});

/**
 * Begin the next edition from this one's structure.
 *
 * A new edition is a new table, not an edit to the old one. Every result
 * already interpreted cites the version it was interpreted under, so changing
 * a threshold inside a published edition would silently rewrite what past
 * antibiograms mean. Starting fresh keeps the old table exportable and the old
 * results explicable.
 *
 * What carries over is the *shape* — organism groups, agents, disk potencies,
 * site and route qualifiers — because that is what does not change much between
 * editions and what would take a day to retype. What does not carry over is a
 * single number.
 */
ipcMain.handle("breakpoints:newEdition", async (_event, input: { edition: string }) => {
  const edition = (input.edition ?? "").trim();
  if (!/^\d{4}$/.test(edition)) {
    return { ok: false, message: "An edition is a four-digit year, e.g. 2027." };
  }

  const existing = store.readBreakpoints();
  if (existing.criteria.length === 0) {
    return {
      ok: false,
      message: "There is no table to take a structure from. Load a blueprint first.",
    };
  }

  const criteria = existing.criteria.map((criterion) => ({
    organism_group: criterion.organism_group,
    agent_code: criterion.agent_code,
    method: criterion.method,
    standard: criterion.standard ?? "CLSI M100",
    table_reference: criterion.table_reference ?? null,
    tier: criterion.tier ?? null,
    site: criterion.site ?? null,
    route: criterion.route ?? null,
    disk_content: criterion.disk_content ?? null,
    dosage_note: null,
    comment: `Carried forward from ${describeSet(existing)} — enter the ${edition} thresholds.`,
  }));

  store.writeBreakpoints({
    version: `M100-blueprint-${edition}`,
    label: `CLSI M100, ${edition} edition`,
    effectiveFrom: `${edition}-01-01`,
    source: "blueprint",
    syncedAt: new Date().toISOString(),
    criteria,
  });
  reloadAndNotify("breakpoints");
  return {
    ok: true,
    message:
      `Started the ${edition} edition from ${criteria.length} rows of structure. Every ` +
      "threshold is blank; the previous edition is no longer loaded, so export it first if " +
      "you have not already.",
  };
});

ipcMain.handle("breakpoints:sync", async () => {
  const state = store.read();
  if (!session.isOnline) {
    return { ok: false, message: "Sign in online to fetch the breakpoint table." };
  }
  const result = await syncBreakpoints(state.apiUrl);
  reloadAndNotify("breakpoints");
  return result;
});

/**
 * Loading a breakpoint table from a file.
 *
 * Two shapes are accepted and they are not equivalent. The **template CSV** is
 * the interchange format: it is what Export writes, what the platform imports,
 * and it round-trips exactly. A **CLSI M100 workbook** is the laboratory's own
 * licensed copy of the standard, converted on the way in — useful because it is
 * the file a laboratory actually possesses, and imperfect because a spreadsheet
 * lifted out of a printed document loses the occasional cell. Rows that cannot
 * be read are reported and left out, never guessed at, and the drop list comes
 * back with the result so the laboratory can complete them in the table editor.
 */
ipcMain.handle("breakpoints:import", async () => {
  const chosen = await dialog.showOpenDialog({
    title: "Select your breakpoint table",
    properties: ["openFile"],
    filters: [
      { name: "Breakpoint table", extensions: ["csv", "xlsx"] },
      { name: "Template CSV", extensions: ["csv"] },
      { name: "CLSI M100 workbook", extensions: ["xlsx"] },
    ],
  });
  if (chosen.canceled || !chosen.filePaths[0]) return { ok: false, message: "Import cancelled." };

  const path = chosen.filePaths[0];
  const preference = store.read().testingMethod;
  let criteria: BreakpointCriterion[];
  let label: string;
  let notes: string[] = [];

  if (path.toLowerCase().endsWith(".xlsx")) {
    // Two quite different workbooks arrive through this dialogue, and telling
    // them apart matters. One is *ours* — a blueprint or a table exported from
    // here, filled in in Excel, coming back. The other is the laboratory's own
    // licensed CLSI M100, which has to be converted and loses rows on the way.
    // The header row says which: a sheet carrying the template's columns is
    // ours and is read exactly, not converted approximately.
    const sheet = readTemplateSheet(path);
    if (sheet) {
      if (sheet.problems.length > 0) {
        return {
          ok: false,
          message: `The workbook was not imported. ${sheet.problems.slice(0, 5).join("; ")}`,
          problems: sheet.problems.slice(0, 20),
        };
      }
      criteria = sheet.criteria.filter((criterion) => matchesPreference(criterion, preference));
      const stated = completeness(criteria);
      store.writeBreakpoints({
        version: `local-import-${new Date().toISOString().slice(0, 10)}`,
        label: `Imported from ${basename(path)}`,
        effectiveFrom: new Date().toISOString().slice(0, 10),
        source: stated.filled === 0 ? "blueprint" : "local-import",
        syncedAt: new Date().toISOString(),
        criteria,
      });
      reloadAndNotify("breakpoints");
      return {
        ok: true,
        message:
          `Loaded ${criteria.length} rows, ${stated.filled} of them with thresholds` +
          (stated.placeholders > 0
            ? `. ${stated.placeholders} are still blank — those combinations read as pending until they are filled in.`
            : "."),
      };
    }

    let conversion;
    try {
      conversion = convertM100Workbook(readFileSync(path), {
        standard: "CLSI M100",
        only: preference === "both" ? undefined : preference,
      });
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    criteria = conversion.criteria;
    label = `CLSI M100 workbook — ${conversion.organismGroups.length} organism groups, ${conversion.agentCodes.length} agents`;
    notes = conversion.dropped.map((row) => `Row ${row.row}: ${row.label} — ${row.reason}`);
    if (criteria.length === 0) {
      return {
        ok: false,
        message:
          "No breakpoints could be read from that workbook. Check that it holds the M100 tables "
          + "with Organism and Antimicrobial Agent columns.",
        problems: notes.slice(0, 20),
      };
    }
  } else {
    const parsed = parseBreakpointCsv(await readFile(path, "utf8"));
    if (parsed.problems.length > 0) {
      return {
        ok: false,
        message: `The table was not imported. ${parsed.problems.slice(0, 5).join("; ")}`,
        problems: parsed.problems.slice(0, 20),
      };
    }
    criteria = parsed.criteria.filter((criterion) => matchesPreference(criterion, preference));
    label = `Imported from ${basename(path)}`;
  }

  const stated = completeness(criteria);
  const set: BreakpointSet = {
    version: `local-import-${new Date().toISOString().slice(0, 10)}`,
    label,
    effectiveFrom: new Date().toISOString().slice(0, 10),
    // A file with rows but no thresholds is a blueprint however it was
    // produced, and saying so is what lets the rest of the application explain
    // why nothing is being interpreted yet.
    source: stated.filled === 0 && criteria.length > 0 ? "blueprint" : "local-import",
    syncedAt: new Date().toISOString(),
    criteria,
  };
  store.writeBreakpoints(set);
  reloadAndNotify("breakpoints");

  const filled =
    stated.placeholders > 0
      ? ` ${stated.filled} state thresholds; ${stated.placeholders} are blank and read as pending until filled in.`
      : "";
  return {
    ok: true,
    message:
      notes.length === 0
        ? `Loaded ${criteria.length} breakpoint rows.${filled}`
        : `Loaded ${criteria.length} breakpoint rows.${filled} ${notes.length} row(s) could not be read `
          + "and are listed below — add them in the table if your laboratory reports those agents.",
    problems: notes.slice(0, 40),
  };
});

/** Read an .xlsx as the template, or say it is not one.
 *
 * Every sheet is tried, because a laboratory that has been working in the file
 * may well have put its notes on the first one. A workbook that is not ours at
 * all returns null and goes to the M100 converter instead. */
function readTemplateSheet(
  path: string,
): { criteria: BreakpointCriterion[]; problems: string[] } | null {
  let workbook;
  try {
    workbook = readWorkbook(readFileSync(path));
  } catch {
    return null;
  }
  for (const name of workbook.sheetNames) {
    const parsed = readBreakpointSheet(workbook.sheet(name));
    if (parsed) return parsed;
  }
  return null;
}

/** The loaded table as the template CSV — the file Import accepts. Exporting,
 * correcting a threshold in Excel and importing again is a supported loop. */
ipcMain.handle("breakpoints:export", async (_event, input: { format?: "csv" | "xlsx" } = {}) => {
  const set = store.readBreakpoints();
  if (set.criteria.length === 0) {
    return { ok: false, message: "There is no breakpoint table loaded to export." };
  }

  const stated = completeness(set.criteria);

  if (input.format === "xlsx") {
    return saveWorkbook(`amrss-breakpoints-${stamp()}.xlsx`, () =>
      buildWorkbook([
        {
          name: "Breakpoints",
          header: [...BREAKPOINT_COLUMNS],
          rows: breakpointSheetRows(set.criteria),
          // Wide enough to type in without fighting the column. The four
          // threshold columns a person actually fills in come first among the
          // numeric ones, and the comment is last and widest because it is
          // read rather than edited.
          columnWidths: [34, 12, 9, 14, 12, 10, 13, 10, 7, ...Array(12).fill(11), 18, 70],
        },
        {
          name: "How to use this",
          header: ["", ""],
          rows: [
            ["Table", describeSet(set)],
            ["Rows", set.criteria.length],
            ["With thresholds", stated.filled],
            ["Still blank", stated.placeholders],
            ["Exported", new Date().toISOString()],
            ["", ""],
            [
              "Filling it in",
              "Type the thresholds from your own licensed CLSI M100 into the "
                + "mic_* and disk_* columns on the Breakpoints sheet. Leave a cell "
                + "empty where the standard states nothing — empty means "
                + "'not stated', not zero.",
            ],
            [
              "Zone diameters",
              "disk_susceptible_min is the S bound (≥) and disk_resistant_max is "
                + "the R bound (≤). Larger zone means more susceptible, so S must "
                + "be the larger number.",
            ],
            [
              "MICs",
              "mic_susceptible_max is the S bound (≤) and mic_resistant_min is "
                + "the R bound (≥). These run the opposite way to zones: S is the "
                + "smaller number.",
            ],
            [
              "Putting it back",
              "Save the workbook and use Import a table. This file imports "
                + "unchanged — same columns, same order — and so does the CSV "
                + "export. Every row is validated on the way in, and a row that "
                + "contradicts itself is refused with the reason.",
            ],
            [
              "Rows you do not need",
              "Delete them. A row your laboratory does not report is a row "
                + "nothing will ever match, and leaving it blank costs nothing "
                + "either.",
            ],
            [
              "Rows that are missing",
              "Add them. Organism group, agent code, method and — for a disk "
                + "row — the disk content are what identify a row; the rest is "
                + "the thresholds.",
            ],
          ],
          columnWidths: [22, 96],
        },
      ]),
    );
  }

  const chosen = await dialog.showSaveDialog({
    title: "Save breakpoint table",
    defaultPath: `amrss-breakpoints-${stamp()}.csv`,
    filters: [{ name: "Breakpoint template CSV", extensions: ["csv"] }],
  });
  if (chosen.canceled || !chosen.filePath) return { ok: false, message: "Download cancelled." };
  try {
    writeFileSync(chosen.filePath, breakpointCsv(set.criteria), "utf8");
    return {
      ok: true,
      message:
        `Saved ${set.criteria.length} rows to ${chosen.filePath}` +
        (stated.placeholders > 0
          ? `, ${stated.placeholders} of them blank and waiting for thresholds. `
          : ". ") +
        "This file imports back unchanged.",
    };
  } catch (error) {
    return { ok: false, message: `Could not save the file: ${(error as Error).message}` };
  }
});

/**
 * The table on screen.
 *
 * Filtered and paged in the main process rather than the renderer: a full M100
 * conversion is several hundred criteria, and sending all of them across the
 * bridge on every keystroke is the difference between a table that responds and
 * one that stutters.
 */
ipcMain.handle(
  "breakpoints:table",
  (_event, input: { search?: string; method?: string; offset?: number; limit?: number } = {}) => {
    const set = store.readBreakpoints();
    const search = (input.search ?? "").trim().toLowerCase();
    const method = (input.method ?? "").trim().toUpperCase();

    const rows = set.criteria
      .filter((criterion) => !method || (criterion.method ?? "").toUpperCase() === method)
      .map(criterionRow)
      .filter((row) =>
        !search
          ? true
          : `${row.organismGroup} ${row.agentCode} ${row.agentName} ${row.scope}`
              .toLowerCase()
              .includes(search),
      )
      .sort(
        (a, b) =>
          a.organismGroup.localeCompare(b.organismGroup) || a.agentName.localeCompare(b.agentName),
      );

    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(500, Math.max(1, input.limit ?? 100));
    return {
      description: describeSet(set),
      total: set.criteria.length,
      matched: rows.length,
      offset,
      rows: rows.slice(offset, offset + limit),
    };
  },
);

/** One criterion the laboratory has typed or corrected. Checked exactly as a
 * file import is: a threshold typed into a form and one read from a CSV are the
 * same claim about a patient's result. */
ipcMain.handle(
  "breakpoints:save",
  (_event, input: { criterion: BreakpointCriterion; replacing?: string }) => {
    const set = store.readBreakpoints();
    const result = upsertCriterion(set.criteria, input.criterion, input.replacing);
    if (result.problems.length > 0) {
      return { ok: false, message: result.problems[0]!, problems: result.problems };
    }
    store.writeBreakpoints({
      ...set,
      // A table a person has edited is theirs, whatever it started as. Saying it
      // is still the platform's would misattribute a local decision.
      source: "local-import",
      label: set.source === "platform" ? `${set.label ?? "Platform table"} (edited here)` : set.label,
      criteria: result.criteria,
    });
    reloadAndNotify("breakpoints");
    return { ok: true, message: "Breakpoint saved." };
  },
);

/**
 * The table arranged the way CLSI prints it.
 *
 * Built here rather than in the renderer: the whole table is several hundred
 * criteria and the grouping is the same work every time, so doing it once per
 * request in the process that already holds the data beats sending all of it
 * across the bridge for the renderer to sort.
 */
ipcMain.handle(
  "breakpoints:catalogue",
  (_event, input: { method?: "DISK" | "MIC"; search?: string; organismGroup?: string } = {}) => {
    const set = store.readBreakpoints();
    // Which half opens first follows what the laboratory said it tests with, so
    // a disk laboratory is not shown a page of concentrations it never reads.
    const preference = store.read().testingMethod;
    const method = input.method ?? (preference === "mic" ? "MIC" : "DISK");
    const standing = session.current?.profile.breakpoints;
    return {
      ...catalogue(set, { method, search: input.search, organismGroup: input.organismGroup }),
      organismGroups: organismGroupsIn(set),
      testingMethod: preference,
      source: set.source,
      // Whether this account may change the table here, decided by the
      // platform at sign-in and not by this process. Breakpoints are national;
      // a facility edits its own only where the national authority has granted
      // it an exception, and that grant is recorded against the facility
      // rather than against the role.
      //
      // An installation that has never been online has no standing yet. It is
      // treated as editable, because a laboratory setting itself up offline
      // with a blueprint and a printed page has to be able to type into it —
      // and what it types is checked again when it reaches the platform.
      editable: standing?.mayEditLocally ?? true,
      editRefusal: standing?.mayEditLocally === false ? standing.refusal : "",
    };
  },
);

/** One threshold, corrected in place. Re-validated on every change, so a
 * correction that makes the row self-contradictory is refused as it is made. */
ipcMain.handle(
  "breakpoints:setCell",
  (
    _event,
    input: { key: string; method: "DISK" | "MIC"; field: CellField; value: string },
  ) => {
    const set = store.readBreakpoints();
    const result = setCell(set.criteria, input.key, input.method, input.field, input.value);
    if (result.problems.length > 0) {
      return { ok: false, message: result.problems[0]!, problems: result.problems };
    }
    store.writeBreakpoints({
      ...set,
      source: "local-import",
      label: set.source === "platform" ? `${set.label ?? "Platform table"} (edited here)` : set.label,
      criteria: result.criteria,
    });
    reloadAndNotify("breakpoints");
    return { ok: true, message: "Saved." };
  },
);

ipcMain.handle("breakpoints:remove", (_event, input: { key: string }) => {
  const set = store.readBreakpoints();
  const criteria = removeCriterion(set.criteria, input.key);
  if (criteria.length === set.criteria.length) {
    return { ok: false, message: "That breakpoint is no longer in the table." };
  }
  store.writeBreakpoints({ ...set, source: "local-import", criteria });
  reloadAndNotify("breakpoints");
  return { ok: true, message: "Breakpoint removed." };
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

/* ------------------------------------------------------------------ *
 * The administrator consoles.
 * ------------------------------------------------------------------ *
 *
 * Every channel below is one call to the platform, with the answer turned into
 * the same `{ ok, message }` shape the rest of the bridge speaks so a view can
 * render a failure without knowing whether it came from HTTP, from a dropped
 * connection, or from a permission the account does not hold.
 *
 * Nothing here decides anything. The consoles hide controls an account cannot
 * use, which is a courtesy; the refusal that counts happens at the API, exactly
 * as it does for the browser console. A renderer that reached these channels
 * directly would gain no authority its account did not already have.
 */

/**
 * One platform result, as the renderer wants it.
 *
 * Never a thrown error, always a sentence, and the data only when there is
 * data. The renderer draws a screen either way and has nothing to do with an
 * exception; what it needs is something to put on the page.
 *
 * The success message is the caller's rather than the server's, because the
 * server's is written for an API client — "204 No Content" is true and useless
 * — while the caller knows what was just done and to whom.
 */
function bridged<T>(
  result: PlatformResult<T>,
  onSuccess: string,
): { ok: boolean; message: string; data?: T } {
  return result.ok
    ? { ok: true, message: onSuccess, data: result.data }
    : { ok: false, message: result.error };
}

ipcMain.handle("platform:users", async () =>
  bridged(await platform.users(), "Accounts loaded."),
);

ipcMain.handle("platform:userOptions", async () =>
  bridged(await platform.userOptions(), "Options loaded."),
);

ipcMain.handle("platform:createUser", async (_event, input: Parameters<PlatformClient["createUser"]>[0]) =>
  bridged(await platform.createUser(input), `Created ${input.email}.`),
);

ipcMain.handle(
  "platform:updateUser",
  async (_event, input: { userId: string; patch: Parameters<PlatformClient["updateUser"]>[1] }) =>
    bridged(await platform.updateUser(input.userId, input.patch), "Account updated."),
);

/**
 * Change somebody's role.
 *
 * Its own channel, mirroring its own endpoint. A regional administrator being
 * promoted to superadmin gains authority over every region in the programme,
 * and that is not something that should travel as one field inside a general
 * update alongside a corrected surname.
 */
ipcMain.handle(
  "platform:changeRole",
  async (_event, input: { userId: string } & Parameters<PlatformClient["changeRole"]>[1]) => {
    const { userId, ...change } = input;
    return bridged(await platform.changeRole(userId, change), `Role changed to ${change.role}.`);
  },
);

ipcMain.handle(
  "platform:resetPassword",
  async (_event, input: { userId: string; password: string }) =>
    bridged(
      await platform.resetPassword(input.userId, input.password),
      "Password set. The account must change it at next sign-in — deliver it in person, not by email.",
    ),
);

ipcMain.handle("platform:unlockUser", async (_event, input: { userId: string }) =>
  bridged(await platform.unlockUser(input.userId), "Lockout cleared."),
);

ipcMain.handle(
  "platform:deleteUser",
  async (_event, input: { userId: string; confirm: string }) =>
    bridged(await platform.deleteUser(input.userId, input.confirm), "Account deleted."),
);

ipcMain.handle("platform:blocks", async () => bridged(await platform.blocks(), "Regions loaded."));

ipcMain.handle("platform:createBlock", async (_event, input: Parameters<PlatformClient["createBlock"]>[0]) =>
  bridged(await platform.createBlock(input), `Created the ${input.name} region.`),
);

ipcMain.handle("platform:districts", async (_event, input: { regionalBlockId?: string } = {}) =>
  bridged(await platform.districts(input.regionalBlockId), "Districts loaded."),
);

ipcMain.handle(
  "platform:createDistrict",
  async (_event, input: { regionalBlockId: string; name: string }) =>
    bridged(
      await platform.createDistrict(input.regionalBlockId, input.name),
      `Added the ${input.name} district.`,
    ),
);

ipcMain.handle("platform:facilities", async (_event, input: Parameters<PlatformClient["facilities"]>[0] = {}) =>
  bridged(await platform.facilities(input), "Facilities loaded."),
);

ipcMain.handle("platform:enrollFacility", async (_event, input: Parameters<PlatformClient["enrollFacility"]>[0]) =>
  bridged(
    await platform.enrollFacility(input),
    `${input.name} enrolled. It contributes nothing until it is activated.`,
  ),
);

ipcMain.handle(
  "platform:transitionFacility",
  async (_event, input: { facilityId: string; target: string; reason: string }) =>
    bridged(
      await platform.transitionFacility(input.facilityId, input.target, input.reason),
      `Facility moved to ${input.target}.`,
    ),
);

ipcMain.handle(
  "platform:setBreakpointOverride",
  async (_event, input: { facilityId: string; granted: boolean; reason: string }) =>
    bridged(
      await platform.setBreakpointOverride(input.facilityId, input.granted, input.reason),
      input.granted
        ? "This facility may now keep its own breakpoint table. The exception is recorded with your name on it."
        : "Override withdrawn. The facility falls back to the national table at its next sync; nothing it entered has been deleted.",
    ),
);

ipcMain.handle("platform:batches", async (_event, input: { status?: string } = {}) =>
  bridged(await platform.batches(input.status), "Submissions loaded."),
);

ipcMain.handle(
  "platform:transitionBatch",
  async (_event, input: { batchId: string; target: string; reason: string }) =>
    bridged(
      await platform.transitionBatch(input.batchId, input.target, input.reason),
      `Batch moved to ${input.target}.`,
    ),
);

ipcMain.handle("platform:mappings", async (_event, input: { status?: string } = {}) =>
  bridged(await platform.mappings(input.status), "Mappings loaded."),
);

ipcMain.handle(
  "platform:reviewMapping",
  async (_event, input: { mappingId: string; approve: boolean; note: string }) =>
    bridged(
      await platform.reviewMapping(input.mappingId, input.approve, input.note),
      input.approve ? "Mapping approved." : "Mapping rejected.",
    ),
);

ipcMain.handle("platform:audit", async (_event, input: { action?: string; limit?: number } = {}) =>
  bridged(await platform.audit(input), "Audit trail loaded."),
);

/**
 * The platform's own surveillance figures.
 *
 * Distinct from the `analytics:*` channels, which compute over the WHONET file
 * on this machine. These are the regional numbers — every contributing
 * facility, deduplicated and quality-gated by the platform — and a laboratory
 * needs both: its own data to check, and the region's to compare itself
 * against. Conflating them in one screen is how a facility reads a national
 * resistance rate as its own.
 */
ipcMain.handle(
  "platform:surveillance",
  async (_event, input: { path: string; params?: Record<string, unknown> }) =>
    bridged(await platform.surveillance(input.path, input.params ?? {}), "Loaded."),
);

ipcMain.handle("platform:breakpointAuthority", async (_event, input: { facilityId?: string } = {}) =>
  bridged(await platform.breakpointAuthority(input.facilityId), "Loaded."),
);

ipcMain.handle("app:openStateFolder", async () => {
  await shell.openPath(store.stateDirectory);
  return { ok: true, message: "Opened the AMRSS data folder." };
});

ipcMain.handle("app:apiUrlProblem", (_event, url: string) => apiUrlProblem(url));

/**
 * Try an address without signing in.
 *
 * Answers in the two registers the interface needs: a sentence for whoever is
 * standing at the machine, and the technical reason underneath for whoever
 * fixes it.
 */
ipcMain.handle("connection:test", async (_event, url: string) => {
  const problem = apiUrlProblem(url);
  if (problem) {
    return { ok: false, message: "That address cannot be used.", detail: problem };
  }
  const probe = await probeConnectivity(url);
  if (probe.online) {
    return {
      ok: true,
      message: `Connected${probe.latencyMs ? ` — answered in ${probe.latencyMs} ms.` : "."}`,
    };
  }
  return {
    ok: false,
    message: "No AMRSS service answered at that address.",
    detail: `${normaliseApiUrl(url)}: ${probe.detail}`,
  };
});
