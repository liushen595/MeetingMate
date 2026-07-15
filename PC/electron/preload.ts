import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("meetingMate", {
  platform: process.platform,
  appMode: process.env.NODE_ENV ?? "production",
  getInitialWorkspace: () => ipcRenderer.invoke("workspace:get-initial-data"),
  saveDocument: (input: unknown) => ipcRenderer.invoke("documents:save", input),
  deleteDocument: (id: string) => ipcRenderer.invoke("documents:delete", id),
  createManuscript: () => ipcRenderer.invoke("manuscripts:create"),
  openLocalManuscript: () => ipcRenderer.invoke("manuscripts:open-local"),
  renameManuscript: (input: unknown) => ipcRenderer.invoke("manuscripts:rename", input),
  saveManuscript: (input: unknown) => ipcRenderer.invoke("manuscripts:save", input),
  deleteManuscript: (id: string) => ipcRenderer.invoke("manuscripts:delete", id),
  exportManuscriptToDocument: (id: string) => ipcRenderer.invoke("manuscripts:export-document", id),
  selectAudioFile: () => ipcRenderer.invoke("files:select-audio"),
  selectImageFile: () => ipcRenderer.invoke("files:select-image"),
  uploadAssetParts: (input: unknown) => ipcRenderer.invoke("files:upload-asset-parts", input)
});
