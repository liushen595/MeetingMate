export type Platform = "ios" | "android" | "mac" | "windows" | "web";
export type Permission = "owner" | "editor" | "viewer";

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  created_at: string;
}

export interface Session {
  access_token: string;
  access_token_expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  user: User;
}

export interface DevicePayload {
  client_id: string;
  platform: Platform;
  app_version: string;
  name: string;
}

export type AssetKind = "audio" | "image" | "export" | "attachment";
export type AssetStatus = "pending_upload" | "uploaded" | "ready" | "failed";

export interface Asset {
  id: string;
  kind: AssetKind;
  filename: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  status: AssetStatus;
  url: string | null;
  created_at: string;
  updated_at: string;
}

export interface UploadPart {
  part_number: number;
  upload_url: string;
  headers: Record<string, string>;
  expires_at: string;
}

export interface UploadedPart {
  part_number: number;
  etag: string;
  size_bytes: number;
}

export interface UploadAssetResponse {
  asset_id: string;
  upload_id: string;
  part_size_bytes: number;
  parts: UploadPart[];
}

export interface SpeakerSegment {
  speaker_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  confidence: number;
}

export type StrokeTool = "pen" | "highlighter" | "eraser" | "lasso";
export type PersistedStrokeTool = "pen";

export interface StrokePoint {
  x: number;
  y: number;
  t: number;
  pressure: number;
}

export interface Stroke {
  id: string;
  tool: StrokeTool | PersistedStrokeTool;
  color: string;
  width: number;
  points: StrokePoint[];
}

interface BaseBlock {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  author_id: string;
  client_id: string;
  platform: Platform;
  deleted: boolean;
}

export interface ManuscriptTextBlock extends BaseBlock {
  type: "text";
  props: { content: string };
}

export interface ManuscriptAudioBlock extends BaseBlock {
  type: "audio";
  props: {
    asset_id: string;
    duration_ms: number;
    transcript: string;
    speaker_segments: SpeakerSegment[];
    asr_task_id?: string;
    asr_generated_at?: string;
  };
}

export interface ManuscriptImageBlock extends BaseBlock {
  type: "image";
  props: {
    asset_id: string;
    caption: string | null;
    width: number | null;
    height: number | null;
    recognition_task_id: string | null;
    recognition_generated_at: string | null;
  };
}

export interface ManuscriptHandwritingBlock extends BaseBlock {
  type: "handwriting";
  props: {
    strokes: Stroke[];
    image_asset_id?: string;
    ai_text: string;
  };
}

export type ManuscriptBlock =
  | ManuscriptTextBlock
  | ManuscriptAudioBlock
  | ManuscriptImageBlock
  | ManuscriptHandwritingBlock;

export interface ManuscriptSummary {
  id: string;
  title: string;
  owner_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface Manuscript extends ManuscriptSummary {
  blocks: ManuscriptBlock[];
}

export interface SourceRef {
  manuscript_id: string;
  block_id: string;
  range: { start_ms: number; end_ms: number } | null;
  region: { x: number; y: number; w: number; h: number } | null;
}

interface BaseDocumentBlock extends BaseBlock {
  source_refs?: SourceRef[];
}

export interface ParagraphBlock extends BaseDocumentBlock {
  type: "paragraph";
  props: { content: string };
}

export interface HeadingBlock extends BaseDocumentBlock {
  type: "heading";
  props: { level: 1 | 2 | 3; content: string };
}

export interface ListBlock extends BaseDocumentBlock {
  type: "list";
  props: { style: "bullet" | "number"; items: string[] };
}

export interface QuoteBlock extends BaseDocumentBlock {
  type: "quote";
  props: { content: string };
}

export interface DocumentImageBlock extends BaseDocumentBlock {
  type: "image";
  props: { asset_id: string; caption: string | null; width: number | null; height: number | null };
}

export interface TableBlock extends BaseDocumentBlock {
  type: "table";
  props: { rows: string[][] };
}

export interface CodeBlock extends BaseDocumentBlock {
  type: "code";
  props: { language: string; content: string };
}

export type DocumentBlock =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | QuoteBlock
  | DocumentImageBlock
  | TableBlock
  | CodeBlock;

export interface DerivedFrom {
  manuscript_id: string;
  task_id: string;
  mode: ConvertMode;
  converted_at: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  owner_id: string;
  source_manuscript_ids: string[];
  derived_from: DerivedFrom | null;
  revision: number;
  permission: Permission;
  created_at: string;
  updated_at: string;
}

export interface Document extends DocumentSummary {
  blocks: DocumentBlock[];
}

export type OperationType = "upsert_block" | "delete_block" | "move_block" | "restore_block";

export interface SyncOperation<TBlock> {
  op_id: string;
  type: OperationType;
  block: TBlock | null;
  block_id: string | null;
  before_block_id: string | null;
  after_block_id: string | null;
  created_at: string;
}

export interface SyncResponse<TBlock> {
  resource_id: string;
  revision: number;
  applied_op_ids: string[];
  conflicts: Array<{
    op_id: string;
    block_id: string;
    reason:
      | "block_updated_by_other_client"
      | "block_deleted_by_other_client"
      | "invalid_block_order"
      | "unsupported_merge";
    server_block: TBlock;
    client_block: TBlock;
  }>;
  blocks: TBlock[];
}

export type TaskType = "convert_manuscript" | "asr_audio" | "recognize_image" | "export_document" | "ai_rewrite";
export type TaskStatus = "queued" | "processing" | "succeeded" | "failed" | "cancelled";
export type TaskStage =
  | "queued"
  | "uploading"
  | "asr"
  | "image_recognition"
  | "diarization"
  | "llm_parse"
  | "document_build"
  | "exporting"
  | "completed";
export type ConvertMode = "meeting_minutes" | "todo_list" | "article_draft";

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  progress: { stage: TaskStage; current: number; total: number; message: string };
  result: null | {
    document_id?: string;
    asset_id?: string;
    transcript?: string;
    caption?: string;
    recognized_text?: string;
    text?: string;
    speaker_segments?: SpeakerSegment[];
    warnings?: Array<{ block_id: string; code: string; message: string }>;
    export_id?: string;
    document_revision?: number;
    format?: "pdf" | "docx";
    message_id?: string;
  };
  error: null | { code: string; message: string; retryable: boolean };
  retry_count: number;
  billing: unknown;
  created_at: string;
  updated_at: string;
}

export interface PagedResponse<T> {
  items: T[];
  next_cursor: string | null;
  sort_by: string;
  sort_order: "asc" | "desc";
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    request_id: string;
  };
}
