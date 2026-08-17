/**
 * The only bridge between the renderer and privileged code.
 *
 * Each channel is listed explicitly. There is deliberately no generic
 * `invoke(channel, ...)` escape hatch, because that would let renderer code
 * reach any handler the main process registers, present or future.
 *
 * Nothing here returns a secret. The renderer receives counts, labels and
 * already-de-identified summaries; the salt, the access token and the password
 * never cross this boundary in either direction, except for the password on its
 * way to the sign-in handler, which is the one call that needs it.
 */

import { contextBridge, ipcRenderer } from "electron";

type Listener = (payload: unknown) => void;

function subscribe(channel: string, listener: Listener): () => void {
  const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("amrss", {
  status: () => ipcRenderer.invoke("app:status"),
  settings: () => ipcRenderer.invoke("app:settings"),
  saveSettings: (patch: unknown) => ipcRenderer.invoke("settings:save", patch),
  openStateFolder: () => ipcRenderer.invoke("app:openStateFolder"),
  apiUrlProblem: (url: string) => ipcRenderer.invoke("app:apiUrlProblem", url),

  signIn: (input: { identifier: string; password: string; apiUrl?: string }) =>
    ipcRenderer.invoke("auth:signIn", input),
  signOut: () => ipcRenderer.invoke("auth:signOut"),
  openWebConsole: () => ipcRenderer.invoke("auth:openWebConsole"),

  chooseWhonetFile: () => ipcRenderer.invoke("setup:chooseWhonetFile"),
  confirmWhonetFile: (input: { path: string; profile: unknown }) =>
    ipcRenderer.invoke("setup:confirmWhonetFile", input),

  reload: () => ipcRenderer.invoke("data:reload"),
  grid: (request: unknown) => ipcRenderer.invoke("data:grid", request),
  record: (rowKey: string) => ipcRenderer.invoke("data:record", rowKey),

  validationReport: () => ipcRenderer.invoke("validation:report"),
  correct: (input: unknown) => ipcRenderer.invoke("validation:correct", input),
  clearCorrection: (input: unknown) => ipcRenderer.invoke("validation:clearCorrection", input),
  excludeRow: (input: unknown) => ipcRenderer.invoke("validation:exclude", input),
  restoreRow: (input: unknown) => ipcRenderer.invoke("validation:restore", input),
  mappings: () => ipcRenderer.invoke("validation:mappings"),
  mapCode: (input: unknown) => ipcRenderer.invoke("validation:mapCode", input),
  unmapCode: (input: unknown) => ipcRenderer.invoke("validation:unmapCode", input),
  approve: () => ipcRenderer.invoke("validation:approve"),

  overview: (filters: unknown) => ipcRenderer.invoke("analytics:overview", filters),
  antibiogram: (filters: unknown) => ipcRenderer.invoke("analytics:antibiogram", filters),
  antibiotics: (filters: unknown) => ipcRenderer.invoke("analytics:antibiotics", filters),
  trend: (input: unknown) => ipcRenderer.invoke("analytics:trend", input),

  breakpointStatus: () => ipcRenderer.invoke("breakpoints:status"),
  syncBreakpoints: () => ipcRenderer.invoke("breakpoints:sync"),
  importBreakpoints: () => ipcRenderer.invoke("breakpoints:import"),

  prepareUpload: () => ipcRenderer.invoke("upload:prepare"),
  sendUpload: () => ipcRenderer.invoke("upload:send"),

  exportGrid: (input: { mode: string }) => ipcRenderer.invoke("export:grid", input),
  exportValidation: () => ipcRenderer.invoke("export:validation"),
  exportAntibiogram: (filters: unknown) => ipcRenderer.invoke("export:antibiogram", filters),
  exportAnalytics: (filters: unknown) => ipcRenderer.invoke("export:analytics", filters),
  exportTrend: (input: unknown) => ipcRenderer.invoke("export:trend", input),
  exportHistory: () => ipcRenderer.invoke("export:history"),

  onStatus: (listener: Listener) => subscribe("amrss:status", listener),
  onData: (listener: Listener) => subscribe("amrss:data", listener),
  onSchedule: (listener: Listener) => subscribe("amrss:schedule", listener),
});
