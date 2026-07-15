import type {
  ApiErrorPayload,
  Asset,
  AssetKind,
  ConvertMode,
  Document,
  DocumentBlock,
  DocumentSummary,
  Manuscript,
  ManuscriptBlock,
  ManuscriptSummary,
  PagedResponse,
  Session,
  SyncOperation,
  SyncResponse,
  Task,
  UploadedPart,
} from "../types/api";
import { getClientId, getDevicePayload } from "./device";
import { makeIdempotencyKey } from "./ids";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";
const SESSION_KEY = "meetingmate.session";
const DEFAULT_PART_SIZE = 5 * 1024 * 1024;

export class ApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;
  requestId?: string;

  constructor(status: number, payload: ApiErrorPayload | null, fallback: string) {
    super(payload?.error.message ?? fallback);
    this.name = "ApiError";
    this.status = status;
    this.code = payload?.error.code ?? "invalid_request";
    this.details = payload?.error.details;
    this.requestId = payload?.error.request_id;
  }
}

type RequestOptions = RequestInit & {
  auth?: boolean;
  idempotent?: boolean;
  retryOnUnauthorized?: boolean;
};

export class ApiClient {
  private session: Session | null = null;
  readonly clientId = getClientId();

  constructor(private readonly baseUrl = API_BASE_URL) {
    this.session = this.readSession();
  }

  get currentSession() {
    return this.session;
  }

  setSession(session: Session | null) {
    this.session = session;
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }

  async login(email: string, password: string) {
    const session = await this.request<Session>("/auth/login", {
      method: "POST",
      auth: false,
      body: JSON.stringify({ email, password, device: getDevicePayload() }),
    });
    this.setSession(session);
    return session;
  }

  async register(email: string, password: string, name: string) {
    const session = await this.request<Session>("/auth/register", {
      method: "POST",
      auth: false,
      body: JSON.stringify({ email, password, name, device: getDevicePayload() }),
    });
    this.setSession(session);
    return session;
  }

  async logout() {
    const session = this.session;
    if (!session) return;
    try {
      await this.request<void>("/auth/logout", {
        method: "POST",
        body: JSON.stringify({ client_id: this.clientId, refresh_token: session.refresh_token }),
      });
    } finally {
      this.setSession(null);
    }
  }

  listManuscripts() {
    return this.request<PagedResponse<ManuscriptSummary>>("/manuscripts?limit=50");
  }

  createManuscript(title: string) {
    return this.request<Manuscript>("/manuscripts", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ title, client_id: this.clientId, initial_blocks: [] }),
    });
  }

  getManuscript(id: string) {
    return this.request<Manuscript>(`/manuscripts/${id}`);
  }

  syncManuscriptBlocks(id: string, baseRevision: number, operations: SyncOperation<ManuscriptBlock>[]) {
    return this.request<SyncResponse<ManuscriptBlock>>(`/manuscripts/${id}/blocks`, {
      method: "PUT",
      idempotent: true,
      body: JSON.stringify({ client_id: this.clientId, base_revision: baseRevision, operations }),
    });
  }

  convertManuscript(manuscriptId: string, mode: ConvertMode, title: string) {
    return this.request<Task>("/tasks/convert-manuscript", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ manuscript_id: manuscriptId, mode, title, client_id: this.clientId }),
    });
  }

  asrAudio(assetId: string) {
    return this.request<Task>("/tasks/asr-audio", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ asset_id: assetId, language: "zh-CN", enable_diarization: true, client_id: this.clientId }),
    });
  }

  streamAsrAudio(assetId: string) {
    return this.request<Response>("/tasks/asr-audio/stream", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ asset_id: assetId, language: "zh-CN", enable_diarization: true, client_id: this.clientId }),
    }, true);
  }

  getTask(id: string) {
    return this.request<Task>(`/tasks/${id}`);
  }

  async getAssetObjectUrl(assetId: string) {
    const headers = new Headers();
    headers.set("X-Client-Id", this.clientId);
    if (this.session?.access_token) headers.set("Authorization", `Bearer ${this.session.access_token}`);
    const response = await fetch(`${this.baseUrl}/assets/${assetId}/stream`, { headers });
    if (!response.ok) throw await this.toApiError(response);
    return URL.createObjectURL(await response.blob());
  }

  listDocuments() {
    return this.request<PagedResponse<DocumentSummary>>("/documents?limit=50");
  }

  createDocument(title: string) {
    return this.request<Document>("/documents", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ title, client_id: this.clientId, source_manuscript_ids: [], derived_from: null, initial_blocks: [] }),
    });
  }

  getDocument(id: string) {
    return this.request<Document>(`/documents/${id}`);
  }

  syncDocumentBlocks(id: string, baseRevision: number, operations: SyncOperation<DocumentBlock>[]) {
    return this.request<SyncResponse<DocumentBlock>>(`/documents/${id}/blocks`, {
      method: "PUT",
      idempotent: true,
      body: JSON.stringify({ client_id: this.clientId, base_revision: baseRevision, operations }),
    });
  }

  exportDocument(documentId: string, format: "pdf" | "docx") {
    return this.request<Task>("/exports", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ document_id: documentId, format, client_id: this.clientId }),
    });
  }

  getExportDownloadUrl(exportId: string) {
    return this.request<{ download_url: string; expires_at: string }>(`/exports/${exportId}/download`);
  }

  async uploadAsset(file: Blob, params: { kind: AssetKind; filename: string; contentType: string; durationMs?: number | null; width?: number | null; height?: number | null }) {
    const checksum = await sha256Hex(file);
    const upload = await this.request<{ asset_id: string; upload_id: string; part_size_bytes: number; parts: Array<{ part_number: number; upload_url: string; headers: Record<string, string> }> }>(
      "/assets/upload",
      {
        method: "POST",
        idempotent: true,
        body: JSON.stringify({
          kind: params.kind,
          filename: params.filename,
          content_type: params.contentType,
          size_bytes: file.size,
          checksum_sha256: checksum,
          part_size_bytes: DEFAULT_PART_SIZE,
        }),
      },
    );

    const partSize = upload.part_size_bytes || DEFAULT_PART_SIZE;
    const uploadedParts: Array<Partial<UploadedPart> & { part_number: number }> = [];
    const expectedPartSizes = new Map<number, number>();
    for (const part of upload.parts) {
      const start = (part.part_number - 1) * partSize;
      const end = Math.min(file.size, start + partSize);
      expectedPartSizes.set(part.part_number, end - start);
      const proxyUpload = this.getProxyUploadParams(part.upload_url);
      const response = await this.uploadPartViaBackend(upload.asset_id, part.part_number, upload.upload_id, proxyUpload, file.slice(start, end, params.contentType), part.headers);
      uploadedParts.push(response);
    }
    const completeParts = await this.resolveUploadedParts(upload.asset_id, uploadedParts, expectedPartSizes);

    return this.request<Asset>(`/assets/${upload.asset_id}/complete`, {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({
        upload_id: upload.upload_id,
        size_bytes: file.size,
        checksum_sha256: checksum,
        parts: completeParts,
        duration_ms: params.durationMs ?? null,
        width: params.width ?? null,
        height: params.height ?? null,
      }),
    });
  }

  streamAgent(documentId: string, selectedBlockIds: string[], prompt: string, mode: "rewrite" | "chat" = "rewrite") {
    return this.request<Response>("/ai/agent/chat", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ document_id: documentId, selected_block_ids: selectedBlockIds, prompt, mode, client_id: this.clientId }),
    }, true);
  }

  private readSession() {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Session;
    } catch {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  private async refreshSession() {
    if (!this.session) throw new ApiError(401, null, "未登录");
    const session = await this.request<Session>("/auth/refresh", {
      method: "POST",
      auth: false,
      retryOnUnauthorized: false,
      body: JSON.stringify({ refresh_token: this.session.refresh_token, client_id: this.clientId }),
    });
    this.setSession({ ...this.session, ...session, user: this.session.user });
  }

  private async request<T>(path: string, options: RequestOptions = {}, rawResponse = false): Promise<T> {
    const auth = options.auth ?? true;
    const headers = new Headers(options.headers);
    if (!headers.has("Content-Type") && options.body) headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("X-Client-Id", this.clientId);
    headers.set("X-Request-Id", makeIdempotencyKey());
    if (options.idempotent) headers.set("Idempotency-Key", makeIdempotencyKey());
    if (auth && this.session?.access_token) headers.set("Authorization", `Bearer ${this.session.access_token}`);

    const response = await fetch(`${this.baseUrl}${path}`, { ...options, headers });
    if (response.status === 401 && auth && options.retryOnUnauthorized !== false && this.session?.refresh_token) {
      await this.refreshSession();
      return this.request<T>(path, { ...options, retryOnUnauthorized: false }, rawResponse);
    }
    if (rawResponse) {
      if (!response.ok) throw await this.toApiError(response);
      return response as T;
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) throw new ApiError(response.status, json as ApiErrorPayload, response.statusText);
    return json as T;
  }

  private async toApiError(response: Response) {
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as ApiErrorPayload) : null;
    return new ApiError(response.status, payload, response.statusText);
  }

  private getProxyUploadParams(uploadUrl: string) {
    const url = new URL(uploadUrl, `${this.baseUrl}/`);
    const expiresAt = url.searchParams.get("expires_at");
    const signature = url.searchParams.get("signature");
    if (!expiresAt || !signature) {
      throw new Error("后端上传代理需要 upload_url 包含 expires_at 和 signature 查询参数。");
    }
    return { expiresAt, signature };
  }

  private async uploadPartViaBackend(
    assetId: string,
    partNumber: number,
    uploadId: string,
    proxyUpload: { expiresAt: string; signature: string },
    body: Blob,
    sourceHeaders: Record<string, string>,
  ) {
    const path = `/assets/${assetId}/upload-parts/${partNumber}?upload_id=${encodeURIComponent(uploadId)}&expires_at=${encodeURIComponent(proxyUpload.expiresAt)}&signature=${encodeURIComponent(proxyUpload.signature)}`;
    const headers = new Headers();
    const contentType = sourceHeaders["Content-Type"] ?? sourceHeaders["content-type"] ?? body.type;
    if (contentType) headers.set("Content-Type", contentType);
    const response = await this.request<Response>(path, { method: "PUT", body, headers, idempotent: true }, true);
    const metadata = await readUploadPartMetadata(response);
    const etag = metadata.etag ?? response.headers.get("ETag")?.replaceAll('"', "") ?? response.headers.get("etag")?.replaceAll('"', "") ?? undefined;
    const sizeBytes = metadata.size_bytes ?? body.size;
    return { part_number: metadata.part_number ?? partNumber, etag, size_bytes: sizeBytes };
  }

  private async resolveUploadedParts(assetId: string, uploadedParts: Array<Partial<UploadedPart> & { part_number: number }>, expectedPartSizes: Map<number, number>) {
    if (uploadedParts.every((part) => part.etag && typeof part.size_bytes === "number")) return uploadedParts as UploadedPart[];

    const uploaded = await this.request<{ uploaded_parts?: UploadedPart[] }>(`/assets/${assetId}/upload-parts`);
    const byPartNumber = new Map((uploaded.uploaded_parts ?? []).map((part) => [part.part_number, part]));
    const completeParts = uploadedParts.map((part) => {
      const serverPart = byPartNumber.get(part.part_number);
      return {
        part_number: part.part_number,
        etag: part.etag ?? serverPart?.etag ?? "",
        size_bytes: part.size_bytes ?? serverPart?.size_bytes ?? expectedPartSizes.get(part.part_number) ?? 0,
      };
    });

    const missing = completeParts.filter((part) => !part.etag || part.size_bytes <= 0);
    if (missing.length > 0) {
      throw new Error(
        `上传代理没有返回分片 metadata，且 GET /assets/${assetId}/upload-parts 也没有返回完整 uploaded_parts。缺失分片：${missing.map((part) => part.part_number).join(", ")}。`,
      );
    }
    return completeParts;
  }
}

async function readUploadPartMetadata(response: Response) {
  const text = await response.text();
  if (!text) return {} as { part_number?: number; etag?: string; size_bytes?: number };
  const data = JSON.parse(text) as Record<string, unknown>;
  return {
    part_number: typeof data.part_number === "number" ? data.part_number : undefined,
    etag: typeof data.etag === "string" ? data.etag.replaceAll('"', "") : typeof data.ETag === "string" ? data.ETag.replaceAll('"', "") : undefined,
    size_bytes: typeof data.size_bytes === "number" ? data.size_bytes : undefined,
  };
}

async function sha256Hex(file: Blob) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const api = new ApiClient();
