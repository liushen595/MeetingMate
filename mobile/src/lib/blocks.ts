import type {
  DocumentBlock,
  DocumentImageBlock,
  ManuscriptAudioBlock,
  ManuscriptBlock,
  ManuscriptHandwritingBlock,
  ManuscriptImageBlock,
  ManuscriptTextBlock,
  Platform,
  Stroke,
  SyncOperation,
} from "../types/api";
import { getClientId, getPlatform } from "./device";
import { makeId, nowIso } from "./ids";

function base(authorId: string) {
  const time = nowIso();
  return {
    revision: 1,
    created_at: time,
    updated_at: time,
    author_id: authorId,
    client_id: getClientId(),
    platform: getPlatform() as Platform,
    deleted: false,
  };
}

export function touchBlock<T extends ManuscriptBlock | DocumentBlock>(block: T): T {
  return { ...block, revision: block.revision + 1, updated_at: nowIso() } as T;
}

export function createTextBlock(authorId: string, content = ""): ManuscriptTextBlock {
  return { id: makeId("block"), type: "text", ...base(authorId), props: { content } };
}

export function createAudioBlock(authorId: string, assetId: string, durationMs: number): ManuscriptAudioBlock {
  return {
    id: makeId("block"),
    type: "audio",
    ...base(authorId),
    props: { asset_id: assetId, duration_ms: durationMs, transcript: "", speaker_segments: [] },
  };
}

export function createImageBlock(authorId: string, assetId: string, width: number, height: number, caption = ""): ManuscriptImageBlock {
  return { id: makeId("block"), type: "image", ...base(authorId), props: { asset_id: assetId, caption, width, height } };
}

export function createHandwritingBlock(authorId: string, strokes: Stroke[] = []): ManuscriptHandwritingBlock {
  return { id: makeId("block"), type: "handwriting", ...base(authorId), props: { strokes, ai_text: "" } };
}

export function createParagraphBlock(authorId: string, content = ""): DocumentBlock {
  return { id: makeId("doc_block"), type: "paragraph", ...base(authorId), props: { content }, source_refs: [] };
}

export function createHeadingBlock(authorId: string, content = "标题", level: 1 | 2 | 3 = 2): DocumentBlock {
  return { id: makeId("doc_block"), type: "heading", ...base(authorId), props: { level, content }, source_refs: [] };
}

export function createListBlock(authorId: string): DocumentBlock {
  return { id: makeId("doc_block"), type: "list", ...base(authorId), props: { style: "bullet", items: [""] }, source_refs: [] };
}

export function createQuoteBlock(authorId: string): DocumentBlock {
  return { id: makeId("doc_block"), type: "quote", ...base(authorId), props: { content: "" }, source_refs: [] };
}

export function createDocumentImageBlock(authorId: string, assetId: string, width: number, height: number, caption = ""): DocumentImageBlock {
  return { id: makeId("doc_block"), type: "image", ...base(authorId), props: { asset_id: assetId, caption, width, height }, source_refs: [] };
}

export function upsertOperation<TBlock extends ManuscriptBlock | DocumentBlock>(block: TBlock, authorId: string, afterBlockId: string | null = null): SyncOperation<TBlock> {
  const normalizedBlock = { ...block, author_id: authorId, client_id: getClientId(), platform: getPlatform() as Platform } as TBlock;
  const apiBlock = normalizedBlock.type === "handwriting" ? ({ ...normalizedBlock, props: { ...normalizedBlock.props, strokes: normalizeStrokesForApi(normalizedBlock.props.strokes) } } as TBlock) : normalizedBlock;
  return {
    op_id: makeId("op"),
    type: "upsert_block",
    block: apiBlock,
    block_id: null,
    before_block_id: null,
    after_block_id: afterBlockId,
    created_at: nowIso(),
  };
}

function normalizeStrokesForApi(strokes: Stroke[]) {
  return strokes.map((stroke) => ({
    ...stroke,
    // 后端 MVP 契约只规定了可持久化 stroke.tool 为 pen；套索/橡皮是端侧工具，不进入 strokes。
    tool: "pen" as const,
    width: Math.max(1, Math.round(stroke.width)),
    points: stroke.points.map((point, index) => ({
      x: Number(point.x.toFixed(2)),
      y: Number(point.y.toFixed(2)),
      t: Math.max(0, Math.round(point.t || index * 16)),
      pressure: Number((point.pressure || 0.5).toFixed(2)),
    })),
  }));
}

export function replaceBlock<TBlock extends { id: string }>(blocks: TBlock[], next: TBlock) {
  return blocks.map((block) => (block.id === next.id ? next : block));
}

export function insertAfter<TBlock extends { id: string }>(blocks: TBlock[], next: TBlock, afterBlockId: string | null) {
  if (!afterBlockId) return [...blocks, next];
  const index = blocks.findIndex((block) => block.id === afterBlockId);
  if (index === -1) return [...blocks, next];
  return [...blocks.slice(0, index + 1), next, ...blocks.slice(index + 1)];
}

export function mergeServerBlocks<TBlock extends { id: string }>(local: TBlock[], serverBlocks: TBlock[]) {
  if (serverBlocks.length === 0) return local;
  const byId = new Map(serverBlocks.map((block) => [block.id, block]));
  return local.map((block) => byId.get(block.id) ?? block);
}
