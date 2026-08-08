/**
 * The only bridge between the renderer and privileged code.
 *
 * Each channel is listed explicitly. There is deliberately no generic
 * `invoke(channel, ...)` escape hatch, because that would let renderer code
 * reach any handler the main process registers, present or future.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("amrss", {
  readState: () => ipcRenderer.invoke("state:read"),
  saveState: (patch: unknown) => ipcRenderer.invoke("state:save", patch),
  chooseWhonetFile: () => ipcRenderer.invoke("whonet:choose"),
  signIn: (input: { email: string; password: string }) =>
    ipcRenderer.invoke("auth:signIn", input),
  prepareBatch: (input: { fungalCodes: string[] }) =>
    ipcRenderer.invoke("batch:prepare", input),
  sendBatch: () => ipcRenderer.invoke("batch:send"),
});
