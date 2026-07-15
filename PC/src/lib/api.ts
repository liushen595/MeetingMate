import type { Document } from "../types/document";
import type { Manuscript } from "../types/manuscript";
import type { DocumentBlock, ManuscriptBlock } from "../types/block";

type Platform = "windows" | "mac" | "web";

type Session = {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; name: string };
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
  result: Record<string, unknown> | null;
};

type AssetUploadResponse = {
  asset_id: string;
  upload_id: string;
  parts: Array<{ part_number: number; upload_url: string; headers?: Record<string, string> }>;
};

export type SelectedFile = {
  path: string;
  kind: "audio" | "image";
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
};

const SESSION_KEY = "meetingmate.session";
const API_BASE_URL = "http://10.90.130.14:8000/api/v1";

class PcApiClient {
  private session: Session | null = this.readSession();
  readonly clientId = getClientId();
  readonly platform = getPlatform();

  get currentSession(): Session | null {
    return this.session;
  }

  get baseUrl(): string {
    return API_BASE_URL;
  }

  async register(input: { email: string; password: string; name: string }, persistSession = true): Promise<Session> {
    return this.authenticate("/auth/register", { ...input, device: this.devicePayload() }, persistSession);
  }

  async login(input: { email: string; password: string }): Promise<Session> {
    return this.authenticate("/auth/login", { ...input, device: this.devicePayload() }, true);
  }

  async logout(): Promise<void> {
    if (!this.session) return;
    await this.request<void>("/auth/logout", {
      method: "POST",
      body: JSON.stringify({ client_id: this.clientId, refresh_token: this.session.refresh_token })
    });
    this.setSession(null);
  }

  async clearSession(): Promise<void> {
    this.setSession(null);
  }

  async loadWorkspace(): Promise<{ documents: Document[]; manuscripts: Manuscript[] }> {
    const [manuscriptRes, documentRes] = await Promise.all([
      this.request<PagedResponse<{ id: string }>>("/manuscripts?limit=50"),
      this.request<PagedResponse<{ id: string }>>("/documents?limit=50")
    ]);

    const manuscripts = await Promise.all(manuscriptRes.items.map((item) => this.getManuscript(item.id)));
    const documents = await Promise.all(documentRes.items.map((item) => this.getDocument(item.id)));

    return { documents, manuscripts };
  }

  async createManuscript(title: string): Promise<Manuscript> {
    const remote = await this.request<RemoteManuscript>("/manuscripts", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ title, client_id: this.clientId, initial_blocks: [] })
    });
    return toManuscript(remote);
  }

  async saveManuscript(manuscript: Manuscript): Promise<Manuscript> {
    if (typeof manuscript.revision !== "number") throw new Error("远端手稿缺少 revision，无法同步");
    await this.request(`/manuscripts/${manuscript.id}/blocks`, {
      method: "PUT",
      idempotent: true,
      body: JSON.stringify({
        client_id: this.clientId,
        base_revision: manuscript.revision,
        operations: manuscript.blocks.map((block, index) => ({
          op_id: `op_${crypto.randomUUID()}`,
          type: "upsert_block",
          block: toRemoteManuscriptBlock(block, this.sessionUserId(), this.clientId, this.platform),
          block_id: null,
          before_block_id: null,
          after_block_id: index > 0 ? manuscript.blocks[index - 1]?.id ?? null : null,
          created_at: new Date().toISOString()
        }))
      })
    });
    return this.getManuscript(manuscript.id);
  }

  async getManuscript(id: string): Promise<Manuscript> {
    return toManuscript(await this.request<RemoteManuscript>(`/manuscripts/${id}`));
  }

  async createDocument(title: string): Promise<Document> {
    const remote = await this.request<RemoteDocument>("/documents", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ title, client_id: this.clientId, source_manuscript_ids: [], derived_from: null, initial_blocks: [] })
    });
    return toDocument(remote);
  }

  async saveDocument(document: Document): Promise<Document> {
    if (typeof document.revision !== "number") throw new Error("远端文档缺少 revision，无法同步");
    await this.request(`/documents/${document.id}/blocks`, {
      method: "PUT",
      idempotent: true,
      body: JSON.stringify({
        client_id: this.clientId,
        base_revision: document.revision,
        operations: document.blocks.map((block, index) => ({
          op_id: `op_${crypto.randomUUID()}`,
          type: "upsert_block",
          block: toRemoteDocumentBlock(block, this.sessionUserId(), this.clientId, this.platform),
          block_id: null,
          before_block_id: null,
          after_block_id: index > 0 ? document.blocks[index - 1]?.id ?? null : null,
          created_at: new Date().toISOString()
        }))
      })
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

  async convertManuscript(id: string, title: string): Promise<Document> {
    const task = await this.request<Task>("/tasks/convert-manuscript", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ manuscript_id: id, mode: "meeting_minutes", title, client_id: this.clientId })
    });
    const documentId = task.result?.document_id;
    if (typeof documentId !== "string") throw new Error("转换任务未返回 document_id");
    return this.getDocument(documentId);
  }

  async exportDocument(documentId: string, format: "pdf" | "docx" = "pdf"): Promise<string> {
    const task = await this.request<Task>("/exports", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ document_id: documentId, format, client_id: this.clientId })
    });
    const exportId = task.result?.export_id;
    if (typeof exportId !== "string") throw new Error("导出任务未返回 export_id");
    const download = await this.request<{ download_url: string }>(`/exports/${exportId}/download`);
    return download.download_url;
  }

  async transcribeAudio(file: SelectedFile): Promise<string> {
    const assetId = await this.createReadyAsset(file);
    const task = await this.request<Task>("/tasks/asr-audio", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ asset_id: assetId, language: "zh-CN", enable_diarization: true, client_id: this.clientId })
    });
    if (task.status === "succeeded") {
      const transcript = task.result?.transcript;
      if (typeof transcript === "string") return transcript;
    }
    throw new Error(`服务器已接收音频，但 ASR 任务尚未返回文本（task: ${task.id}, status: ${task.status}）`);
  }

  async recognizeImage(file: SelectedFile): Promise<string> {
    await this.createReadyAsset(file);
    throw new Error("服务器契约中尚未提供图片 OCR/VLM 识别接口，PC 端不会生成本地占位文本。请由服务器端补充图片识别 API 后接入。");
  }

  async runP0SmokeTest(): Promise<string[]> {
    const lines: string[] = [];
    const previousSession = this.session;
    const suffix = Date.now();
    const session = await this.register({ email: `pc-smoke-${suffix}@example.com`, password: "secret", name: "PC Smoke" });
    lines.push(`注册成功：${session.user.email}`);

    const upload = await this.request<AssetUploadResponse>("/assets/upload", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ kind: "audio", filename: "meeting.m4a", content_type: "audio/mp4", size_bytes: 10, checksum_sha256: "abc", part_size_bytes: 10 })
    });
    lines.push(`创建 Asset 上传：${upload.asset_id}`);

    await this.request(`/assets/${upload.asset_id}/complete`, {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({ upload_id: upload.upload_id, size_bytes: 10, checksum_sha256: "abc", parts: [{ part_number: 1, etag: "etag", size_bytes: 10 }], duration_ms: 1000, width: null, height: null })
    });
    lines.push("完成 Asset 上传：ready");

    const manuscript = await this.createManuscript("PC API Smoke Manuscript");
    lines.push(`创建手稿：${manuscript.id}`);

    const savedManuscript = await this.saveManuscript({ ...manuscript, blocks: [createSmokeTextBlock()] });
    lines.push(`同步手稿 Block：revision ${savedManuscript.revision}`);

    const document = await this.convertManuscript(savedManuscript.id, "PC API Smoke Document");
    lines.push(`手稿转文档：${document.id}`);

    const savedDocument = await this.saveDocument({ ...document, blocks: [{ ...document.blocks[0], content: `${document.blocks[0]?.content ?? ""}\nEdited from PC smoke test.` }] });
    lines.push(`同步文档 Block：revision ${savedDocument.revision}`);

    const downloadUrl = await this.exportDocument(savedDocument.id);
    lines.push(`创建 PDF 导出：${downloadUrl}`);

    this.setSession(previousSession);
    return lines;
  }

  private async createReadyAsset(file: SelectedFile): Promise<string> {
    const upload = await this.request<AssetUploadResponse>("/assets/upload", {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({
        kind: file.kind,
        filename: file.filename,
        content_type: file.contentType,
        size_bytes: file.sizeBytes,
        checksum_sha256: file.checksumSha256,
        part_size_bytes: Math.max(file.sizeBytes, 1)
      })
    });

    if (!window.meetingMate?.uploadFileParts) throw new Error("文件上传接口不可用");
    const uploaded = await window.meetingMate.uploadFileParts({
      path: file.path,
      parts: upload.parts.map((part) => ({
        partNumber: part.part_number,
        uploadUrl: toAbsoluteUploadUrl(part.upload_url),
        headers: part.headers
      }))
    });

    await this.request(`/assets/${upload.asset_id}/complete`, {
      method: "POST",
      idempotent: true,
      body: JSON.stringify({
        upload_id: upload.upload_id,
        size_bytes: file.sizeBytes,
        checksum_sha256: file.checksumSha256,
        parts: uploaded.parts,
        duration_ms: file.kind === "audio" ? 0 : null,
        width: null,
        height: null
      })
    });

    return upload.asset_id;
  }

  private async authenticate(path: string, body: unknown, persistSession: boolean): Promise<Session> {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "X-Request-Id": crypto.randomUUID() },
      body: JSON.stringify(body)
    });
    const session = await parseResponse<Session>(response);
    if (persistSession) this.setSession(session);
    return session;
  }

  private async request<T>(path: string, options: (RequestInit & { idempotent?: boolean }) = {}): Promise<T> {
    if (!this.session) throw new Error("请先登录服务器");

    const headers = new Headers(options.headers);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("X-Client-Id", this.clientId);
    headers.set("X-Request-Id", crypto.randomUUID());
    if (options.idempotent) headers.set("Idempotency-Key", crypto.randomUUID());
    headers.set("Authorization", `Bearer ${this.session.access_token}`);

    const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
    return parseResponse<T>(response);
  }

  private devicePayload() {
    return { client_id: this.clientId, platform: this.platform, app_version: "0.1.0", name: "MeetingMate PC" };
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
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(json?.error?.message ?? response.statusText);
  return json as T;
}

function toManuscript(remote: RemoteManuscript): Manuscript {
  return {
    id: remote.id,
    title: remote.title,
    revision: remote.revision,
    createdAt: remote.created_at,
    updatedAt: remote.updated_at,
    source: "desktop",
    blocks: remote.blocks.filter((block) => block.deleted !== true).map(toManuscriptBlock)
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
    blocks: remote.blocks.filter((block) => block.deleted !== true).map(toDocumentBlock)
  };
}

function toManuscriptBlock(block: Record<string, unknown>): ManuscriptBlock {
  const props = isRecord(block.props) ? block.props : {};
  const type = block.type === "audio" || block.type === "image" || block.type === "handwriting" ? block.type : "text";
  return {
    id: String(block.id),
    type,
    revision: toNumber(block.revision),
    createdAt: String(block.created_at ?? ""),
    updatedAt: String(block.updated_at ?? ""),
    title: String(props.content ?? props.transcript ?? props.caption ?? block.type ?? "Block").slice(0, 32),
    timestamp: String(block.updated_at ?? ""),
    summary: String(props.content ?? props.transcript ?? props.caption ?? props.ai_text ?? ""),
    props
  };
}

function toDocumentBlock(block: Record<string, unknown>): DocumentBlock {
  const props = isRecord(block.props) ? block.props : {};
  const type = block.type === "heading" || block.type === "list" || block.type === "quote" ? block.type : "paragraph";
  const content = type === "list" && Array.isArray(props.items) ? props.items.map(String).join("\n") : String(props.content ?? "");
  return {
    id: String(block.id),
    type,
    revision: toNumber(block.revision),
    createdAt: String(block.created_at ?? ""),
    updatedAt: String(block.updated_at ?? ""),
    content,
    items: Array.isArray(props.items) ? props.items.map(String) : undefined
  };
}

function toRemoteManuscriptBlock(block: ManuscriptBlock, authorId: string, clientId: string, platform: Platform): Record<string, unknown> {
  const now = new Date().toISOString();
  const base = remoteBlockBase(block, authorId, clientId, platform, now);
  if (block.type === "handwriting") return { ...base, type: "handwriting", props: { strokes: block.props.strokes ?? [], image_asset_id: block.props.image_asset_id ?? null, ai_text: block.props.ai_text ?? block.props.aiText ?? "" } };
  if (block.type === "audio" && typeof block.props.asset_id === "string") return { ...base, type: "audio", props: { asset_id: block.props.asset_id, duration_ms: Number(block.props.duration_ms ?? 0), transcript: String(block.props.transcript ?? block.summary ?? ""), speaker_segments: block.props.speaker_segments ?? [] } };
  if (block.type === "image" && typeof block.props.asset_id === "string") return { ...base, type: "image", props: { asset_id: block.props.asset_id, caption: String(block.props.caption ?? block.props.ocrText ?? block.summary ?? ""), width: nullableNumber(block.props.width), height: nullableNumber(block.props.height) } };
  return { ...base, type: "text", props: { content: String(block.props.content ?? block.props.transcript ?? block.props.caption ?? block.props.ocrText ?? block.summary ?? "") } };
}

function toRemoteDocumentBlock(block: DocumentBlock, authorId: string, clientId: string, platform: Platform): Record<string, unknown> {
  const now = new Date().toISOString();
  const base = { ...remoteBlockBase(block, authorId, clientId, platform, now), source_refs: [] };
  if (block.type === "heading") return { ...base, type: "heading", props: { level: 1, content: block.content } };
  if (block.type === "list") return { ...base, type: "list", props: { style: "bullet", items: block.items?.length ? block.items : block.content.split("\n").filter(Boolean) } };
  if (block.type === "quote") return { ...base, type: "quote", props: { content: block.content } };
  return { ...base, type: "paragraph", props: { content: block.content } };
}

function remoteBlockBase(block: { id: string; revision?: number; createdAt?: string; updatedAt?: string }, authorId: string, clientId: string, platform: Platform, now: string): Record<string, unknown> {
  return { id: block.id, revision: block.revision ?? 1, created_at: block.createdAt || now, updated_at: block.updatedAt || now, author_id: authorId, client_id: clientId, platform, deleted: false };
}

function createSmokeTextBlock(): ManuscriptBlock {
  const now = new Date().toISOString();
  return { id: `block_${crypto.randomUUID()}`, type: "text", revision: 1, createdAt: now, updatedAt: now, title: "Smoke", timestamp: now, summary: "Ship the desktop API flow first.", props: { content: "Ship the desktop API flow first." } };
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
