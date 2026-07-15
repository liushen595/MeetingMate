import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { nativeImage } from "electron";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
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

  ipcMain.handle("files:select-audio", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "webm"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return getSelectedFile(result.filePaths[0], "audio");
  });

  ipcMain.handle("files:select-image", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return getSelectedFile(result.filePaths[0], "image");
  });

  ipcMain.handle("files:upload-asset-parts", async (_event, input: { path: string; assetId: string; uploadId: string; partSizeBytes: number; parts: Array<{ partNumber: number; uploadUrl: string; headers?: Record<string, string> }> }) => {
    const content = readFileSync(input.path);
    const uploadedParts: Array<{ part_number: number; etag: string; size_bytes: number }> = [];
    for (const part of input.parts) {
      const url = parseBackendUploadUrl(part.uploadUrl, input.assetId, part.partNumber);
      const start = (part.partNumber - 1) * input.partSizeBytes;
      const end = Math.min(content.byteLength, start + input.partSizeBytes);
      const body = content.subarray(start, end);
      const response = await fetch(url, { method: "PUT", headers: part.headers, body });
      if (!response.ok) {
        throw new Error(`Upload part ${part.partNumber} failed: ${response.status} ${response.statusText}`);
      }
      const responseText = await response.text();
      const responseJson = responseText ? safeJsonParse(responseText) : null;
      uploadedParts.push({
        part_number: part.partNumber,
        etag: String(getResponseValue(responseJson, "etag") ?? response.headers.get("etag") ?? `part-${part.partNumber}`),
        size_bytes: Number(getResponseValue(responseJson, "size_bytes") ?? body.byteLength)
      });
    }
    return { ok: true, parts: uploadedParts };
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

function getSelectedFile(filePath: string, kind: "audio" | "image") {
  const content = readFileSync(filePath);
  const extension = extname(filePath).toLowerCase();
  const imageSize = kind === "image" ? nativeImage.createFromBuffer(content).getSize() : null;
  return {
    path: filePath,
    kind,
    filename: basename(filePath),
    contentType: getContentType(extension, kind),
    sizeBytes: statSync(filePath).size,
    checksumSha256: createHash("sha256").update(content).digest("hex"),
    dataUrl: kind === "image" ? `data:${getContentType(extension, kind)};base64,${content.toString("base64")}` : null,
    width: imageSize?.width || null,
    height: imageSize?.height || null
  };
}

function getContentType(extension: string, kind: "audio" | "image"): string {
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".aac") return "audio/aac";
  if (extension === ".webm") return kind === "audio" ? "audio/webm" : "image/webp";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".bmp") return "image/bmp";
  return kind === "audio" ? "application/octet-stream" : "image/webp";
}

function parseBackendUploadUrl(uploadUrl: string, assetId: string, partNumber: number): string {
  const url = new URL(uploadUrl);
  const expectedPath = `/assets/${assetId}/upload-parts/${partNumber}`;
  if (!url.pathname.endsWith(expectedPath)) {
    throw new Error("后端对象存储已弃用，PC 端只支持后端 API 上传代理 URL。");
  }
  if (!url.searchParams.get("upload_id") || !url.searchParams.get("expires_at") || !url.searchParams.get("signature")) {
    throw new Error("后端上传代理 URL 缺少 upload_id、expires_at 或 signature。");
  }
  return url.toString();
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getResponseValue(value: unknown, key: "etag" | "size_bytes"): string | number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const next = (value as Record<string, unknown>)[key];
  return typeof next === "string" || typeof next === "number" ? next : null;
}
