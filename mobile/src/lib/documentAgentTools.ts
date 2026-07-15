import type { DocumentBlock, SyncOperation } from "../types/api";
import { createParagraphBlock, deleteOperation, insertAfter, touchBlock, upsertOperation } from "./blocks";
import type { DocumentAgentToolCall } from "./documentAgent";

type AgentApplyOperation = SyncOperation<DocumentBlock>;

export interface AgentApplyResult {
  blocks: DocumentBlock[];
  operations: AgentApplyOperation[];
  selectedIds: string[];
}

export function applyDocumentAgentToolCalls(blocks: DocumentBlock[], toolCalls: DocumentAgentToolCall[], authorId: string): AgentApplyResult {
  let nextBlocks = blocks;
  const operations: AgentApplyOperation[] = [];
  const selectedIds: string[] = [];

  function upsert(block: DocumentBlock, afterBlockId: string | null = null) {
    const existingIndex = nextBlocks.findIndex((item) => item.id === block.id);
    const exists = existingIndex >= 0;
    const prevBlockId = exists ? nextBlocks[existingIndex - 1]?.id ?? null : null;
    const nextBlockId = exists ? nextBlocks[existingIndex + 1]?.id ?? null : null;
    const operationAfterBlockId = afterBlockId ?? prevBlockId;
    const operationBeforeBlockId = operationAfterBlockId ? null : nextBlockId;
    nextBlocks = exists ? nextBlocks.map((item) => (item.id === block.id ? block : item)) : insertAfter(nextBlocks, block, afterBlockId);
    operations.push(upsertOperation(block, authorId, operationAfterBlockId, operationBeforeBlockId));
    selectedIds.push(block.id);
  }

  function remove(blockId: string) {
    if (!nextBlocks.some((block) => block.id === blockId)) return;
    nextBlocks = nextBlocks.filter((block) => block.id !== blockId);
    operations.push(deleteOperation<DocumentBlock>(blockId));
  }

  for (const call of toolCalls) {
    if (call.name === "insert_paragraph_after") {
      const block = createParagraphBlock(authorId, call.args.content.trim());
      upsert(block, call.args.after_block_id);
      continue;
    }

    if (call.name === "delete_blocks") {
      call.args.block_ids.forEach(remove);
      continue;
    }

    if (call.name === "merge_blocks") {
      const targets = call.args.block_ids.map((blockId) => nextBlocks.find((block) => block.id === blockId)).filter((block): block is DocumentBlock => Boolean(block));
      const first = targets[0];
      if (!first) continue;
      upsert(toParagraphBlock(first, call.args.content.trim()));
      targets.slice(1).forEach((block) => remove(block.id));
      continue;
    }

    const target = nextBlocks.find((block) => block.id === call.args.block_id);
    if (!target) continue;

    if (call.name === "replace_block_text" && target) {
      upsert(withBlockText(target, call.args.content));
      continue;
    }

    if (call.name === "replace_text_range" && target) {
      const text = getBlockText(target);
      if (text === null) continue;
      const start = clampIndex(call.args.start, text.length);
      const end = clampIndex(call.args.end, text.length);
      upsert(withBlockText(target, `${text.slice(0, Math.min(start, end))}${call.args.content}${text.slice(Math.max(start, end))}`));
      continue;
    }

    if (call.name === "convert_to_heading" && target) {
      upsert(toHeadingBlock(target, call.args.content ?? getBlockText(target) ?? "标题", call.args.level));
      continue;
    }

    if (call.name === "convert_to_list" && target) {
      const items = call.args.items.map((item) => item.trim()).filter(Boolean);
      if (items.length === 0) continue;
      upsert(toListBlock(target, items, call.args.style));
      continue;
    }

    if (call.name === "split_paragraph" && target) {
      const paragraphs = call.args.paragraphs.map((item) => item.trim()).filter(Boolean);
      if (paragraphs.length === 0) continue;
      upsert(toParagraphBlock(target, paragraphs[0]));
      let afterId = target.id;
      for (const paragraph of paragraphs.slice(1)) {
        const block = createParagraphBlock(authorId, paragraph);
        upsert(block, afterId);
        afterId = block.id;
      }
      continue;
    }

  }

  return { blocks: nextBlocks, operations, selectedIds: unique(selectedIds).filter((id) => nextBlocks.some((block) => block.id === id)) };
}

export function getBlockText(block: DocumentBlock): string | null {
  if (block.type === "paragraph" || block.type === "heading" || block.type === "quote" || block.type === "code") return block.props.content;
  if (block.type === "list") return block.props.items.join("\n");
  if (block.type === "image") return block.props.caption ?? "";
  if (block.type === "table") return block.props.rows.map((row) => row.join("\t")).join("\n");
  return null;
}

export function toParagraphBlock(block: DocumentBlock, content: string): DocumentBlock {
  return touchBlock({ ...blockBase(block), type: "paragraph", props: { content }, source_refs: block.source_refs ?? [] } as DocumentBlock);
}

export function toHeadingBlock(block: DocumentBlock, content: string, level: 1 | 2 | 3): DocumentBlock {
  return touchBlock({ ...blockBase(block), type: "heading", props: { level, content }, source_refs: block.source_refs ?? [] } as DocumentBlock);
}

export function toListBlock(block: DocumentBlock, items: string[], style: "bullet" | "numbered" = "bullet"): DocumentBlock {
  return touchBlock({ ...blockBase(block), type: "list", props: { style, items }, source_refs: block.source_refs ?? [] } as DocumentBlock);
}

export function toQuoteBlock(block: DocumentBlock, content: string): DocumentBlock {
  return touchBlock({ ...blockBase(block), type: "quote", props: { content }, source_refs: block.source_refs ?? [] } as DocumentBlock);
}

function withBlockText(block: DocumentBlock, content: string): DocumentBlock {
  switch (block.type) {
    case "paragraph":
    case "quote":
      return touchBlock({ ...block, props: { content } });
    case "heading":
      return touchBlock({ ...block, props: { ...block.props, content } });
    case "code":
      return touchBlock({ ...block, props: { ...block.props, content } });
    case "list":
      return touchBlock({ ...block, props: { ...block.props, items: content.split("\n").map((item) => item.trim()).filter(Boolean) } });
    case "image":
      return touchBlock({ ...block, props: { ...block.props, caption: content } });
    default:
      return block;
  }
}

function blockBase(block: DocumentBlock) {
  return {
    id: block.id,
    revision: block.revision,
    created_at: block.created_at,
    updated_at: block.updated_at,
    author_id: block.author_id,
    client_id: block.client_id,
    platform: block.platform,
    deleted: block.deleted,
  };
}

function clampIndex(index: number, length: number) {
  return Math.max(0, Math.min(length, Math.round(index)));
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
