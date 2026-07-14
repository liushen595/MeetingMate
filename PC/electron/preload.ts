import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("meetingMate", {
  platform: process.platform,
  appMode: process.env.NODE_ENV ?? "production"
});
