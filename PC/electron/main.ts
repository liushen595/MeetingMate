import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { AppDatabase } from "./database";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
let database: AppDatabase | undefined;

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: "MeetingMate PC",
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  database = new AppDatabase(process.cwd(), app.getPath("userData"));

  ipcMain.handle("workspace:get-initial-data", () => {
    return database?.getWorkspaceData();
  });

  ipcMain.handle("documents:save", (_event, input) => {
    return database?.saveDocument(input);
  });

  ipcMain.handle("documents:delete", (_event, id: string) => {
    database?.deleteDocument(id);
    return { ok: true };
  });

  ipcMain.handle("manuscripts:create", () => {
    return database?.createManuscript({ title: "未命名手稿", source: "desktop" });
  });

  ipcMain.handle("manuscripts:open-local", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Manuscript JSON", extensions: ["json"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const filePath = result.filePaths[0];
    const content = readFileSync(filePath, "utf8");
    const fallbackTitle = basename(filePath, extname(filePath));

    return database?.importManuscriptFromJson(content, fallbackTitle);
  });

  ipcMain.handle("manuscripts:rename", (_event, input: { id: string; title: string }) => {
    return database?.renameManuscript(input.id, input.title);
  });

  ipcMain.handle("manuscripts:save", (_event, input: { id: string; title: string; blocks: unknown[] }) => {
    return database?.saveManuscript(input);
  });

  ipcMain.handle("manuscripts:delete", (_event, id: string) => {
    database?.deleteManuscript(id);
    return { ok: true };
  });

  ipcMain.handle("manuscripts:export-document", (_event, manuscriptId: string) => {
    return database?.exportManuscriptToDocument(manuscriptId);
  });

  ipcMain.handle("ai:speech-to-text", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "webm"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const fileName = basename(result.filePaths[0]);
    return `语音识别结果占位：${fileName}\n这里后续会调用后端 ASR API 返回转写文本。`;
  });

  ipcMain.handle("ai:image-to-text", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const fileName = basename(result.filePaths[0]);
    return `图片识别结果占位：${fileName}\n这里后续会调用后端 OCR/VLM API 返回图片文字。`;
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  database?.close();
});
