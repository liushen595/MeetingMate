import type { Document } from "../types/document";
import type { Manuscript } from "../types/manuscript";
import type { DocumentBlock, ManuscriptBlock } from "../types/block";

type Platform = "windows" | "mac" | "web";

type Session = {
  access_token: string;
  access_token_expires_in?: number;
  refresh_token: string;
  refresh_token_expires_in?: number;
  user: { id: string; email: string; name: string };
};

type ApiErrorPayload = {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
  };
};

type PagedResponse<T> = {
  items: T[];
};

type RemoteManuscript = {
  id: string;
  title: string;
  revision: number;
  created_at: string;
  updated_at: string;
  blocks: Array<Record<string, unknown>>;
};

type RemoteDocument = {
  id: string;
  title: string;
  revision: number;
  updated_at: string;
  blocks: Array<Record<string, unknown>>;
  derived_from?: { manuscript_id?: string } | null;
};

type Task = {
  id: string;
  type: string;
  status: "queued" | "processing" | "succeeded" | "failed" | "cancelled";
  progress?: {
    stage?: string;
    current?: number;
    total?: number;
    message?: string;
  } | null;
  result: Record<string, unknown> | null;
  error?: { message?: string } | null;
};

export type ConvertWarning = {
  block_id: string;
  code: string;
  message: string;
};

export type ConvertProgress = {
  taskId: string;
  status: Task["status"];
  stage?: string;
  current?: number;
  total?: number;
  message?: string;
};

export type ConvertManuscriptResult = {
  document: Document;
  warnings: ConvertWarning[];
};

type AssetUploadResponse = {
  asset_id: string;
  upload_id: string;
  part_size_bytes: number;
  parts: Array<{
    part_number: number;
    upload_url: string;
    headers?: Record<string, string>;
  }>;
};

type Asset = {
  id: string;
  kind: "audio" | "image" | "export" | "attachment";
  width?: number | null;
  height?: number | null;
};

export type ImageRecognitionResult = {
  assetId: string;
  caption: string;
  text: string;
  width: number | null;
  height: number | null;
  taskId: string | null;
  generatedAt: string | null;
};

export type SelectedFile = {
  path: string;
  kind: "audio" | "image";
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  dataUrl?: string | null;
  width?: number | null;
  height?: number | null;
};

export type AudioTranscription = {
  assetId: string;
  durationMs: number;
  transcript: string;
  speakerSegments: unknown[];
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, message: string, code = "", requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

const SESSION_KEY = "meetingmate.session";
const API_BASE_URL = "http://10.90.130.14:8000/api/v1";

class PcApiClient {
  private session: Session | null = this.readSession();
  private refreshPromise: Promise<void> | null = null;
  readonly clientId = getClientId();
  readonly platform = getPlatform();

  get currentSession(): Session | null {
    return this.session;
  }

  get baseUrl(): string {
    return API_BASE_URL;
  }

  async register(
    input: { email: string; password: string; name: string },
    persistSession = true,
  ): Promise<Session> {
    return this.authenticate(
      "/auth/register",
      { ...input, device: this.devicePayload() },
      persistSession,
    );
  }

  async login(input: { email: string; password: string }): Promise<Session> {
    return this.authenticate(
      "/auth/login",
      { ...input, device: this.devicePayload() },
      true,
    );
  }

  async logout(): Promise<void> {
    if (!this.session) return;
    await this.request<void>("/auth/logout", {
      method: "POST",
      body: JSON.stringify({
        client_id: this.clientId,
        refresh_token: this.session.refresh_token,
      }),
    });
    this.setSession(null);
  }

  async clearSession(): Promise<void> {
    this.setSession(null);
  }

  async loadWorkspace(): Promise<{
    documents: Document[];
    manuscripts: Manuscript[];
  }> {
    const [manuscriptRes, documentRes] = await Promise.all([
      this.request<PagedResponse<{ id: string }>>("/manuscripts?limit=50"),
      this.request<PagedResponse<{ id: string }>>("/documents?limit=50"),
    ]);

    const manuscripts = await Promise.all(
      manuscriptRes.items.map((item) => this.getManuscript(item.id)),
    );
    const documents = await Promise.all(
      documentRes.items.map((item) => this.getDocument(item.id)),
    );

    return { documents, manuscripts };
  }

  async createManuscript(title: string): Promise<Manuscript> {
    const remote = await this.request<RemoteManuscript>("/manuscripts", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({
        title,
        client_id: this.clientId,
        initial_blocks: [],
      }),
    });
    return toManuscript(remote);
  }

  async saveManuscript(manuscript: Manuscript): Promise<Manuscript> {
    if (typeof manuscript.revision !== "number")
      throw new Error("远端手稿缺少 revision，无法同步");
    await this.request(`/manuscripts/${manuscript.id}/blocks`, {
      method: "PUT",
      idempotent: true,
      body: JSON.stringify({
        client_id: this.clientId,
        base_revision: manuscript.revision,
        operations: manuscript.blocks.map((block, index) => ({
          op_id: `op_${crypto.randomUUID()}`,
          type: "upsert_block",
          block: toRemoteManuscriptBlock(
            block,
            this.sessionUserId(),
            this.clientId,
            this.platform,
          ),
          block_id: null,
          before_block_id: null,
          after_block_id:
            index > 0 ? (manuscript.blocks[index - 1]?.id ?? null) : null,
          created_at: new Date().toISOString(),
        })),
      }),
    });
    return this.getManuscript(manuscript.id);
  }

  async getManuscript(id: string): Promise<Manuscript> {
    return toManuscript(
      await this.request<RemoteManuscript>(`/manuscripts/${id}`),
    );
  }

  async createDocument(title: string): Promise<Document> {
    const remote = await this.request<RemoteDocument>("/documents", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({
        title,
        client_id: this.clientId,
        source_manuscript_ids: [],
        derived_from: null,
        initial_blocks: [],
      }),
    });
    return toDocument(remote);
  }

  async saveDocument(document: Document): Promise<Document> {
    if (typeof document.revision !== "number")
      throw new Error("远端文档缺少 revision，无法同步");
    await this.request(`/documents/${document.id}/blocks`, {
      method: "PUT",
      idempotent: true,
      body: JSON.stringify({
        client_id: this.clientId,
        base_revision: document.revision,
        operations: document.blocks.map((block, index) => ({
          op_id: `op_${crypto.randomUUID()}`,
          type: "upsert_block",
          block: toRemoteDocumentBlock(
            block,
            this.sessionUserId(),
            this.clientId,
            this.platform,
          ),
          block_id: null,
          before_block_id: null,
          after_block_id:
            index > 0 ? (document.blocks[index - 1]?.id ?? null) : null,
          created_at: new Date().toISOString(),
        })),
      }),
    });
    return this.getDocument(document.id);
  }

  async getDocument(id: string): Promise<Document> {
    return toDocument(await this.request<RemoteDocument>(`/documents/${id}`));
  }

  async deleteDocument(id: string): Promise<void> {
    await this.request<void>(`/documents/${id}`, { method: "DELETE" });
  }

  async deleteManuscript(id: string): Promise<void> {
    await this.request<void>(`/manuscripts/${id}`, { method: "DELETE" });
  }

  async convertManuscript(
    id: string,
    title: string,
    optimizeAudio: boolean,
    onProgress?: (progress: ConvertProgress) => void,
  ): Promise<ConvertManuscriptResult> {
    const task = await this.request<Task>("/tasks/convert-manuscript", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({
        manuscript_id: id,
        mode: "meeting_minutes",
        title,
        client_id: this.clientId,
        optimize_audio: optimizeAudio,
      }),
    });
    const completedTask = await this.waitForTask(
      task,
      "手稿转文档任务超时未返回结果",
      onProgress,
    );
    const documentId = completedTask.result?.document_id;
    if (typeof documentId !== "string")
      throw new Error("转换任务未返回 document_id");
    return {
      document: await this.getDocument(documentId),
      warnings: extractConvertWarnings(completedTask.result),
    };
  }

  async exportDocument(
    documentId: string,
    format: "pdf" | "docx" = "pdf",
  ): Promise<string> {
    const task = await this.request<Task>("/exports", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({
        document_id: documentId,
        format,
        client_id: this.clientId,
      }),
    });
    const exportId = task.result?.export_id;
    if (typeof exportId !== "string")
      throw new Error("导出任务未返回 export_id");
    const download = await this.request<{ download_url: string }>(
      `/exports/${exportId}/download`,
    );
    return download.download_url;
  }

  async transcribeAudio(file: SelectedFile): Promise<AudioTranscription> {
    const asset = await this.createReadyAsset(file);
    const task = await this.request<Task>("/tasks/asr-audio", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({
        asset_id: asset.id,
        language: "zh-CN",
        enable_diarization: true,
        client_id: this.clientId,
      }),
    });
    const completedTask = await this.waitForTask(task);
    const transcript = extractTranscript(completedTask.result);
    if (transcript)
      return {
        assetId: asset.id,
        durationMs: 0,
        transcript,
        speakerSegments: extractSpeakerSegments(completedTask.result),
      };
    throw new Error(
      `ASR 任务已完成，但服务器返回了空转写文本。请检查服务器 ASR 服务是否成功读取音频内容、音频格式是否受支持，以及 assets.content/part_contents 是否有实际文件内容。（task: ${completedTask.id}, result: ${JSON.stringify(completedTask.result ?? {})}）`,
    );
  }

  async getAssetObjectUrl(assetId: string): Promise<string> {
    if (!this.session) throw new ApiError(401, "请先登录服务器");
    const accessToken = this.session.access_token;
    const response = await this.fetchAssetStream(assetId);
    if (response.ok) return URL.createObjectURL(await response.blob());
    if (response.status !== 401) throw await responseToApiError(response, "音频加载失败");

    await this.refreshSession(accessToken);
    const retryResponse = await this.fetchAssetStream(assetId);
    if (!retryResponse.ok) throw await responseToApiError(retryResponse, "音频加载失败");
    return URL.createObjectURL(await retryResponse.blob());
  }

  private async fetchAssetStream(assetId: string): Promise<Response> {
    if (!this.session) throw new ApiError(401, "请先登录服务器");
    const headers = new Headers();
    headers.set("X-Client-Id", this.clientId);
    headers.set("Authorization", `Bearer ${this.session.access_token}`);
    return fetch(`${API_BASE_URL}/assets/${assetId}/stream`, {
      headers,
    });
  }

  async uploadImageAsset(file: SelectedFile): Promise<{ assetId: string; width: number | null; height: number | null }> {
    if (file.kind !== "image") throw new Error("请选择图片文件");
    const asset = await this.createReadyAsset(file);
    return { assetId: asset.id, width: asset.width ?? file.width ?? null, height: asset.height ?? file.height ?? null };
  }

  async recognizeImageAsset(assetId: string): Promise<ImageRecognitionResult> {
    const task = await this.request<Task>("/tasks/recognize-image", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ asset_id: assetId, language: "zh-CN", client_id: this.clientId }),
    });
    const completedTask = await this.waitForTask(
      task,
      "图片识别任务超时未返回文本",
    );
    const caption = extractImageCaption(completedTask.result);
    const text = extractImageText(completedTask.result) || caption;
    if (caption || text)
      return {
        assetId,
        caption,
        text,
        width: null,
        height: null,
        taskId: completedTask.id,
        generatedAt: new Date().toISOString(),
      };
    throw new Error(
      `图片识别任务已完成，但服务器返回了空文本。（task: ${completedTask.id}, result: ${JSON.stringify(completedTask.result ?? {})}）`,
    );
  }

  async runP0SmokeTest(): Promise<string[]> {
    const lines: string[] = [];
    const previousSession = this.session;
    const suffix = Date.now();
    const session = await this.register({
      email: `pc-smoke-${suffix}@example.com`,
      password: "secret",
      name: "PC Smoke",
    });
    lines.push(`注册成功：${session.user.email}`);

    const upload = await this.request<AssetUploadResponse>("/assets/upload", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({
        kind: "audio",
        filename: "meeting.m4a",
        content_type: "audio/mp4",
        size_bytes: 10,
        checksum_sha256: "abc",
        part_size_bytes: 10,
      }),
    });
    lines.push(`创建 Asset 上传：${upload.asset_id}`);

    await this.request(`/assets/${upload.asset_id}/complete`, {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({
        upload_id: upload.upload_id,
        size_bytes: 10,
        checksum_sha256: "abc",
        parts: [{ part_number: 1, etag: "etag", size_bytes: 10 }],
        duration_ms: 1000,
        width: null,
        height: null,
      }),
    });
    lines.push("完成 Asset 上传：ready");

    const manuscript = await this.createManuscript("PC API Smoke Manuscript");
    lines.push(`创建手稿：${manuscript.id}`);

    const savedManuscript = await this.saveManuscript({
      ...manuscript,
      blocks: [createSmokeTextBlock()],
    });
    lines.push(`同步手稿 Block：revision ${savedManuscript.revision}`);

    const { document } = await this.convertManuscript(
      savedManuscript.id,
      "PC API Smoke Document",
      false,
    );
    lines.push(`手稿转文档：${document.id}`);

    const savedDocument = await this.saveDocument({
      ...document,
      blocks: [
        {
          ...document.blocks[0],
          content: `${document.blocks[0]?.content ?? ""}\nEdited from PC smoke test.`,
        },
      ],
    });
    lines.push(`同步文档 Block：revision ${savedDocument.revision}`);

    const downloadUrl = await this.exportDocument(savedDocument.id);
    lines.push(`创建 PDF 导出：${downloadUrl}`);

    this.setSession(previousSession);
    return lines;
  }

  private async createReadyAsset(file: SelectedFile): Promise<Asset> {
    const upload = await this.request<AssetUploadResponse>("/assets/upload", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({
        kind: file.kind,
        filename: file.filename,
        content_type: file.contentType,
        size_bytes: file.sizeBytes,
        checksum_sha256: file.checksumSha256,
        part_size_bytes: Math.max(file.sizeBytes, 1),
      }),
    });

    if (!window.meetingMate?.uploadAssetParts)
      throw new Error("文件上传接口不可用");
    const uploaded = await window.meetingMate.uploadAssetParts({
      path: file.path,
      assetId: upload.asset_id,
      uploadId: upload.upload_id,
      partSizeBytes: upload.part_size_bytes,
      parts: upload.parts.map((part) => ({
        partNumber: part.part_number,
        uploadUrl: toAbsoluteUploadUrl(part.upload_url),
        headers: part.headers,
      })),
    });

    return this.request<Asset>(`/assets/${upload.asset_id}/complete`, {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({
        upload_id: upload.upload_id,
        size_bytes: file.sizeBytes,
        checksum_sha256: file.checksumSha256,
        parts: uploaded.parts,
        duration_ms: file.kind === "audio" ? 0 : null,
        width: file.kind === "image" ? file.width ?? null : null,
        height: file.kind === "image" ? file.height ?? null : null,
      }),
    });
  }

  private async waitForTask(
    task: Task,
    timeoutMessage = "服务器已接收音频，但 ASR 任务超时未返回文本",
    onProgress?: (progress: ConvertProgress) => void,
  ): Promise<Task> {
    let current = task;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      onProgress?.(toTaskProgress(current));
      if (current.status === "succeeded") return current;
      if (current.status === "failed")
        throw new Error(
          current.error?.message ?? `任务执行失败（task: ${current.id}）`,
        );
      if (current.status === "cancelled")
        throw new Error(`任务已取消（task: ${current.id}）`);
      await sleep(2000);
      current = await this.request<Task>(`/tasks/${current.id}`);
    }
    throw new Error(
      `${timeoutMessage}（task: ${current.id}, status: ${current.status}）`,
    );
  }

  private async authenticate(
    path: string,
    body: unknown,
    persistSession: boolean,
  ): Promise<Session> {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Request-Id": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
    const session = await parseResponse<Session>(response);
    if (persistSession) this.setSession(session);
    return session;
  }

  private async request<T>(
    path: string,
    options: RequestInit & { idempotent?: boolean } = {},
  ): Promise<T> {
    if (!this.session) throw new ApiError(401, "请先登录服务器");

    const accessToken = this.session.access_token;
    const requestOptions = this.withRequestHeaders(options);
    const response = await this.fetchWithSession(path, requestOptions);
    if (response.ok) return parseResponse<T>(response);
    if (response.status !== 401) throw await responseToApiError(response);

    await this.refreshSession(accessToken);
    return parseResponse<T>(await this.fetchWithSession(path, requestOptions));
  }

  private withRequestHeaders(
    options: RequestInit & { idempotent?: boolean },
  ): RequestInit {
    const headers = new Headers(options.headers);
    if (options.body && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("X-Client-Id", this.clientId);
    if (!headers.has("X-Request-Id")) headers.set("X-Request-Id", crypto.randomUUID());
    if (options.idempotent && !headers.has("Idempotency-Key"))
      headers.set("Idempotency-Key", crypto.randomUUID());
    return { ...options, headers };
  }

  private async fetchWithSession(
    path: string,
    options: RequestInit,
  ): Promise<Response> {
    if (!this.session) throw new ApiError(401, "请先登录服务器");

    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.session.access_token}`);

    return fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
    });
  }

  private async refreshSession(expiredAccessToken: string): Promise<void> {
    if (this.session?.access_token && this.session.access_token !== expiredAccessToken) return;

    if (!this.session?.refresh_token) {
      this.setSession(null);
      throw new ApiError(401, "登录已失效，请重新登录");
    }

    if (!this.refreshPromise) {
      const refreshToken = this.session.refresh_token;
      this.refreshPromise = this.refreshWithToken(refreshToken).finally(() => {
        this.refreshPromise = null;
      });
    }

    await this.refreshPromise;
  }

  private async refreshWithToken(refreshToken: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Client-Id": this.clientId,
        "X-Request-Id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        client_id: this.clientId,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      this.setSession(null);
      throw await responseToApiError(response, "登录已失效，请重新登录");
    }

    this.setSession(await parseResponse<Session>(response));
  }

  private devicePayload() {
    return {
      client_id: this.clientId,
      platform: this.platform,
      app_version: "0.1.0",
      name: "MeetingMate PC",
    };
  }

  private sessionUserId(): string {
    if (!this.session) throw new Error("未登录后端");
    return this.session.user.id;
  }

  private setSession(session: Session | null): void {
    this.session = session;
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }

  private readSession(): Session | null {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Session;
    } catch {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) throw apiErrorFromResponse(response, json);
  return json as T;
}

async function responseToApiError(
  response: Response,
  fallbackMessage?: string,
): Promise<ApiError> {
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return apiErrorFromResponse(response, json, fallbackMessage);
}

function apiErrorFromResponse(
  response: Response,
  json: unknown,
  fallbackMessage?: string,
): ApiError {
  const payload = isRecord(json) ? (json as ApiErrorPayload) : null;
  const error = payload?.error;
  return new ApiError(
    response.status,
    error?.message ?? fallbackMessage ?? response.statusText,
    error?.code ?? "",
    error?.request_id,
  );
}

function toTaskProgress(task: Task): ConvertProgress {
  return {
    taskId: task.id,
    status: task.status,
    stage: task.progress?.stage,
    current: task.progress?.current,
    total: task.progress?.total,
    message: task.progress?.message,
  };
}

function extractConvertWarnings(result: Record<string, unknown> | null): ConvertWarning[] {
  if (!result || !Array.isArray(result.warnings)) return [];
  return result.warnings
    .filter(isRecord)
    .map((warning) => ({
      block_id: String(warning.block_id ?? ""),
      code: String(warning.code ?? ""),
      message: String(warning.message ?? ""),
    }));
}

function toManuscript(remote: RemoteManuscript): Manuscript {
  return {
    id: remote.id,
    title: remote.title,
    revision: remote.revision,
    createdAt: remote.created_at,
    updatedAt: remote.updated_at,
    source: "desktop",
    blocks: remote.blocks
      .filter((block) => block.deleted !== true)
      .map(toManuscriptBlock),
  };
}

function toDocument(remote: RemoteDocument): Document {
  return {
    id: remote.id,
    manuscriptId: remote.derived_from?.manuscript_id,
    revision: remote.revision,
    title: remote.title,
    status: "synced",
    updatedAt: remote.updated_at,
    blocks: remote.blocks
      .filter((block) => block.deleted !== true)
      .map(toDocumentBlock),
  };
}

function toManuscriptBlock(block: Record<string, unknown>): ManuscriptBlock {
  const props = isRecord(block.props) ? block.props : {};
  const type =
    block.type === "audio" ||
    block.type === "image" ||
    block.type === "handwriting"
      ? block.type
      : "text";
  return {
    id: String(block.id),
    type,
    revision: toNumber(block.revision),
    createdAt: String(block.created_at ?? ""),
    updatedAt: String(block.updated_at ?? ""),
    title: String(
      props.content ??
        props.transcript ??
        props.caption ??
        block.type ??
        "Block",
    ).slice(0, 32),
    timestamp: String(block.updated_at ?? ""),
    summary: String(
      props.content ?? props.transcript ?? props.caption ?? props.ai_text ?? "",
    ),
    props,
  };
}

function toDocumentBlock(block: Record<string, unknown>): DocumentBlock {
  const props = isRecord(block.props) ? block.props : {};
  if (block.type === "image") {
    return {
      id: String(block.id),
      type: "image",
      revision: toNumber(block.revision),
      createdAt: String(block.created_at ?? ""),
      updatedAt: String(block.updated_at ?? ""),
      content: String(props.caption ?? props.ocrText ?? props.content ?? ""),
      props,
    };
  }
  const type =
    block.type === "heading" || block.type === "list" || block.type === "quote"
      ? block.type
      : "paragraph";
  const content =
    type === "list" && Array.isArray(props.items)
      ? props.items.map(String).join("\n")
      : String(props.content ?? "");
  return {
    id: String(block.id),
    type,
    revision: toNumber(block.revision),
    createdAt: String(block.created_at ?? ""),
    updatedAt: String(block.updated_at ?? ""),
    content,
    items: Array.isArray(props.items) ? props.items.map(String) : undefined,
  };
}

function toRemoteManuscriptBlock(
  block: ManuscriptBlock,
  authorId: string,
  clientId: string,
  platform: Platform,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const base = remoteBlockBase(block, authorId, clientId, platform, now);
  if (block.type === "handwriting")
    return {
      ...base,
      type: "handwriting",
      props: {
        strokes: block.props.strokes ?? [],
        image_asset_id: block.props.image_asset_id ?? null,
        ai_text: block.props.ai_text ?? block.props.aiText ?? "",
      },
    };
  if (block.type === "audio" && typeof block.props.asset_id === "string")
    return {
      ...base,
      type: "audio",
      props: {
        asset_id: block.props.asset_id,
        duration_ms: Number(block.props.duration_ms ?? 0),
        transcript: String(block.props.transcript ?? block.summary ?? ""),
        speaker_segments: block.props.speaker_segments ?? [],
      },
    };
  if (block.type === "image" && typeof block.props.asset_id === "string")
    return {
      ...base,
      type: "image",
      props: {
        asset_id: block.props.asset_id,
        caption: String(block.props.caption ?? block.summary ?? ""),
        width: nullableNumber(block.props.width),
        height: nullableNumber(block.props.height),
        recognition_task_id: typeof block.props.recognition_task_id === "string" ? block.props.recognition_task_id : null,
        recognition_generated_at: typeof block.props.recognition_generated_at === "string" ? block.props.recognition_generated_at : null,
      },
    };
  return {
    ...base,
    type: "text",
    props: {
      content: String(
        block.props.content ??
          block.props.transcript ??
          block.props.caption ??
          block.props.ocrText ??
          block.summary ??
          "",
      ),
    },
  };
}

function toRemoteDocumentBlock(
  block: DocumentBlock,
  authorId: string,
  clientId: string,
  platform: Platform,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const base = {
    ...remoteBlockBase(block, authorId, clientId, platform, now),
    source_refs: [],
  };
  if (block.type === "heading")
    return {
      ...base,
      type: "heading",
      props: { level: 1, content: block.content },
    };
  if (block.type === "list")
    return {
      ...base,
      type: "list",
      props: {
        style: "bullet",
        items: block.items?.length
          ? block.items
          : block.content.split("\n").filter(Boolean),
      },
    };
  if (block.type === "quote")
    return { ...base, type: "quote", props: { content: block.content } };
  if (block.type === "image")
    return {
      ...base,
      type: "image",
      props: {
        asset_id: block.props?.asset_id ?? null,
        caption: String(block.props?.caption ?? block.content),
        width: nullableNumber(block.props?.width),
        height: nullableNumber(block.props?.height),
      },
    };
  return { ...base, type: "paragraph", props: { content: block.content } };
}

function remoteBlockBase(
  block: {
    id: string;
    revision?: number;
    createdAt?: string;
    updatedAt?: string;
  },
  authorId: string,
  clientId: string,
  platform: Platform,
  now: string,
): Record<string, unknown> {
  return {
    id: block.id,
    revision: block.revision ?? 1,
    created_at: block.createdAt || now,
    updated_at: block.updatedAt || now,
    author_id: authorId,
    client_id: clientId,
    platform,
    deleted: false,
  };
}

function createSmokeTextBlock(): ManuscriptBlock {
  const now = new Date().toISOString();
  return {
    id: `block_${crypto.randomUUID()}`,
    type: "text",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    title: "Smoke",
    timestamp: now,
    summary: "Ship the desktop API flow first.",
    props: { content: "Ship the desktop API flow first." },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function toAbsoluteUploadUrl(uploadUrl: string): string {
  if (/^https?:\/\//i.test(uploadUrl)) return uploadUrl;
  return new URL(uploadUrl, `${API_BASE_URL}/`).toString();
}

function extractTranscript(result: Record<string, unknown> | null): string {
  if (!result) return "";
  const candidates = [
    result.transcript,
    result.text,
    result.content,
    result.asr_text,
    isRecord(result.asr_audio) ? result.asr_audio.transcript : undefined,
    isRecord(result.data)
      ? (result.data.transcript ?? result.data.text)
      : undefined,
    isRecord(result.result)
      ? (result.result.transcript ?? result.result.text)
      : undefined,
  ];
  const direct = candidates.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  if (direct) return direct.trim();
  const segments =
    result.speaker_segments ??
    result.segments ??
    (isRecord(result.asr_audio)
      ? result.asr_audio.speaker_segments
      : undefined);
  if (Array.isArray(segments)) {
    return segments
      .map((segment) =>
        isRecord(segment) && typeof segment.text === "string"
          ? segment.text.trim()
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractImageText(result: Record<string, unknown> | null): string {
  if (!result) return "";
  const candidates = [
    result.text,
    result.content,
    result.ocr_text,
    result.description,
    isRecord(result.image)
      ? (result.image.caption ?? result.image.text ?? result.image.ocr_text)
      : undefined,
    isRecord(result.data)
      ? (result.data.caption ?? result.data.text ?? result.data.ocr_text)
      : undefined,
    isRecord(result.result)
      ? (result.result.caption ?? result.result.text ?? result.result.ocr_text)
      : undefined,
  ];
  const direct = candidates.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  return direct ? direct.trim() : "";
}

function extractImageCaption(result: Record<string, unknown> | null): string {
  if (!result) return "";
  const candidates = [
    result.caption,
    isRecord(result.image) ? result.image.caption : undefined,
    isRecord(result.data) ? result.data.caption : undefined,
    isRecord(result.result) ? result.result.caption : undefined,
  ];
  const direct = candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return direct ? direct.trim() : "";
}

function extractSpeakerSegments(
  result: Record<string, unknown> | null,
): unknown[] {
  if (!result) return [];
  const segments =
    result.speaker_segments ??
    result.segments ??
    (isRecord(result.asr_audio)
      ? result.asr_audio.speaker_segments
      : undefined);
  return Array.isArray(segments) ? segments : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getClientId(): string {
  const key = "meetingmate.pc.client_id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const next = `device_${crypto.randomUUID()}`;
  localStorage.setItem(key, next);
  return next;
}

function getPlatform(): Platform {
  const platform = window.meetingMate?.platform;
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "windows";
  return "web";
}

export const pcApi = new PcApiClient();
