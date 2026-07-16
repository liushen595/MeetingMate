import type {
  ApiErrorPayload,
  Asset,
  AssetKind,
  ConvertMode,
  Document,
  DocumentBlock,
  DocumentSummary,
  GroupDocumentMessage,
  GroupSummary,
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
import type { DocumentAgentContext, DocumentAgentMode } from "./documentAgent";
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

type RemoteGroupSummary = {
  id: string;
  name: string;
  invite_code: string;
  invite_code_expires_at: string;
  member_count: number;
  role: "owner" | "member";
  created_at: string;
  updated_at: string;
};

type RemoteGroupDocumentMessage = {
  id: string;
  group_id: string;
  sender_id: string;
  sender_name: string;
  document_id: string;
  document_title: string;
  document_revision: number;
  sent_at: string;
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

  convertManuscript(manuscriptId: string, mode: ConvertMode, title: string, optimizeAudio: boolean) {
    return this.request<Task>("/tasks/convert-manuscript", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ manuscript_id: manuscriptId, mode, title, client_id: this.clientId, optimize_audio: optimizeAudio }),
    });
  }

  asrAudio(assetId: string) {
    return this.request<Task>("/tasks/asr-audio", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ asset_id: assetId, language: "zh-CN", enable_diarization: true, client_id: this.clientId }),
    });
  }

  streamAsrAudio(assetId: string, options: { enableDiarization?: boolean } = {}) {
    return this.request<Response>("/tasks/asr-audio/stream", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ asset_id: assetId, language: "zh-CN", enable_diarization: options.enableDiarization ?? true, client_id: this.clientId }),
    }, true);
  }

  recognizeImage(assetId: string) {
    return this.request<Task>("/tasks/recognize-image", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ asset_id: assetId, language: "zh-CN", client_id: this.clientId }),
    });
  }

  streamRecognizeImage(assetId: string) {
    return this.request<Response>("/tasks/recognize-image/stream", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ asset_id: assetId, language: "zh-CN", client_id: this.clientId }),
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

  deleteAsset(assetId: string) {
    return this.request<void>(`/assets/${assetId}`, { method: "DELETE" });
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

  async downloadExport(exportId: string, retried = false): Promise<Blob> {
    if (!this.session) throw new Error("请先登录服务器");

    const download = await this.getExportDownloadUrl(exportId);
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${this.session.access_token}`);
    headers.set("X-Client-Id", this.clientId);

    const response = await fetch(download.download_url, { headers });
    if (response.status === 401 && !retried && this.session.refresh_token) {
      await this.refreshSession();
      return this.downloadExport(exportId, true);
    }
    if (!response.ok) throw await this.toApiError(response);
    return response.blob();
  }

  async listGroups(): Promise<GroupSummary[]> {
    const response = await this.request<PagedResponse<RemoteGroupSummary>>("/groups?limit=50");
    return response.items.map(toGroup);
  }

  async createGroup(name: string): Promise<GroupSummary> {
    const remote = await this.request<RemoteGroupSummary>("/groups", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ name, client_id: this.clientId }),
    });
    return toGroup(remote);
  }

  async joinGroup(inviteCode: string): Promise<GroupSummary> {
    const remote = await this.request<RemoteGroupSummary>("/groups/join", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ invite_code: inviteCode, client_id: this.clientId }),
    });
    return toGroup(remote);
  }

  async listGroupMessages(groupId: string): Promise<GroupDocumentMessage[]> {
    const response = await this.request<PagedResponse<RemoteGroupDocumentMessage>>(`/groups/${groupId}/messages?limit=50`);
    return response.items.map(toGroupMessage);
  }

  async sendDocumentToGroup(groupId: string, documentId: string): Promise<GroupDocumentMessage> {
    const remote = await this.request<RemoteGroupDocumentMessage>(`/groups/${groupId}/documents`, {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ document_id: documentId, client_id: this.clientId }),
    });
    return toGroupMessage(remote);
  }

  async downloadGroupDocument(groupId: string, messageId: string, format: "pdf" | "docx" = "docx"): Promise<Blob> {
    if (!this.session) throw new Error("请先登录服务器");

    const response = await fetch(`${this.baseUrl}/groups/${groupId}/documents/${messageId}/download?format=${format}`, {
      headers: {
        Authorization: `Bearer ${this.session.access_token}`,
        "X-Client-Id": this.clientId,
        "X-Request-Id": makeIdempotencyKey(),
      },
    });

    if (!response.ok) throw await this.toApiError(response);
    return response.blob();
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

  streamAgent(
    documentId: string,
    selectedBlockIds: string[],
    prompt: string,
    mode: DocumentAgentMode = "rewrite",
    options: { context?: DocumentAgentContext; toolsVersion?: string; selection?: { block_id: string; start: number; end: number; text: string } | null } = {},
  ) {
    const body: Record<string, unknown> = {
      document_id: documentId,
      selected_block_ids: selectedBlockIds,
      prompt,
      mode,
      client_id: this.clientId,
    };
    if (options.context) body.context = options.context;
    if (options.toolsVersion) body.tools_version = options.toolsVersion;
    if ("selection" in options) body.selection = options.selection ?? null;
    return this.request<Response>("/ai/agent/chat", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify(body),
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
    const payload = parseApiErrorPayload(text);
    return new ApiError(response.status, payload, response.statusText);
  }

  private getProxyUploadParams(uploadUrl: string) {
    const baseUrl = this.baseUrl.startsWith("http") ? this.baseUrl : window.location.origin;
    const url = new URL(uploadUrl, baseUrl);
    if (!url.pathname.includes("/assets/") || !url.pathname.includes("/upload-parts/")) {
      throw new Error("移动端当前只支持后端 API 上传代理 URL。请确认后端 ASSET_UPLOAD_URL_MODE=api，不要返回 object storage 直传 URL。");
    }
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

function toGroup(remote: RemoteGroupSummary): GroupSummary {
  return {
    id: remote.id,
    name: remote.name,
    inviteCode: remote.invite_code,
    inviteCodeExpiresAt: remote.invite_code_expires_at,
    memberCount: remote.member_count,
    role: remote.role,
    createdAt: remote.created_at,
    updatedAt: remote.updated_at,
  };
}

function toGroupMessage(remote: RemoteGroupDocumentMessage): GroupDocumentMessage {
  return {
    id: remote.id,
    groupId: remote.group_id,
    senderId: remote.sender_id,
    senderName: remote.sender_name,
    documentId: remote.document_id,
    documentTitle: remote.document_title,
    documentRevision: remote.document_revision,
    sentAt: remote.sent_at,
  };
}

function parseApiErrorPayload(text: string): ApiErrorPayload | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as ApiErrorPayload;
  } catch {
    return null;
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
  const digest = globalThis.crypto?.subtle
    ? await globalThis.crypto.subtle.digest("SHA-256", buffer)
    : sha256ArrayBuffer(buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha256ArrayBuffer(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const words = new Uint32Array(paddedLength / 4);

  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] |= bytes[index] << (24 - (index % 4) * 8);
  }
  words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
  words[words.length - 2] = Math.floor(bitLength / 0x100000000);
  words[words.length - 1] = bitLength;

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const schedule = new Uint32Array(64);

  for (let offset = 0; offset < words.length; offset += 16) {
    for (let index = 0; index < 16; index += 1) schedule[index] = words[offset + index];
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(schedule[index - 15], 7) ^ rotateRight(schedule[index - 15], 18) ^ (schedule[index - 15] >>> 3);
      const s1 = rotateRight(schedule[index - 2], 17) ^ rotateRight(schedule[index - 2], 19) ^ (schedule[index - 2] >>> 10);
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + schedule[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const output = new ArrayBuffer(32);
  const view = new DataView(output);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((value, index) => view.setUint32(index * 4, value));
  return output;
}

function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export const api = new ApiClient();
