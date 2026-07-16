import type { DocumentBlock } from "../types/block";
import type { DocumentAgentToolCall } from "./documentAgent";

export function applyDocumentAgentToolCalls(
  blocks: DocumentBlock[],
  toolCalls: DocumentAgentToolCall[],
): DocumentBlock[] {
  let nextBlocks = blocks;

  function upsert(block: DocumentBlock, afterBlockId: string | null = null): void {
    const exists = nextBlocks.some((item) => item.id === block.id);
    nextBlocks = exists
      ? nextBlocks.map((item) => (item.id === block.id ? block : item))
      : insertAfter(nextBlocks, block, afterBlockId);
  }

  function remove(blockId: string): void {
    nextBlocks = nextBlocks.filter((block) => block.id !== blockId);
  }

  for (const call of toolCalls) {
    if (call.name === "insert_paragraph_after") {
      upsert(createParagraphBlock(call.args.content.trim()), call.args.after_block_id);
      continue;
    }
    if (call.name === "delete_blocks") {
      call.args.block_ids.forEach(remove);
      continue;
    }
    if (call.name === "merge_blocks") {
      const targets = call.args.block_ids
        .map((blockId) => nextBlocks.find((block) => block.id === blockId))
        .filter((block): block is DocumentBlock => Boolean(block));
      const first = targets[0];
      if (!first) continue;
      upsert(toParagraphBlock(first, call.args.content.trim()));
      targets.slice(1).forEach((block) => remove(block.id));
      continue;
    }

    const target = nextBlocks.find((block) => block.id === call.args.block_id);
    if (!target) continue;

    if (call.name === "replace_block_text") {
      upsert(withBlockText(target, call.args.content));
      continue;
    }
    if (call.name === "replace_text_range") {
      const text = getBlockText(target);
      const start = clampIndex(call.args.start, text.length);
      const end = clampIndex(call.args.end, text.length);
      upsert(withBlockText(target, `${text.slice(0, Math.min(start, end))}${call.args.content}${text.slice(Math.max(start, end))}`));
      continue;
    }
    if (call.name === "convert_to_heading") {
      upsert(toHeadingBlock(target, (call.args.content ?? getBlockText(target)) || "标题", call.args.level));
      continue;
    }
    if (call.name === "convert_to_list") {
      const items = call.args.items.map((item) => item.trim()).filter(Boolean);
      if (items.length) upsert(toListBlock(target, items));
      continue;
    }
    if (call.name === "split_paragraph") {
      const paragraphs = call.args.paragraphs.map((item) => item.trim()).filter(Boolean);
      if (!paragraphs.length) continue;
      upsert(toParagraphBlock(target, paragraphs[0] ?? ""));
      let afterId = target.id;
      for (const paragraph of paragraphs.slice(1)) {
        const block = createParagraphBlock(paragraph);
        upsert(block, afterId);
        afterId = block.id;
      }
    }
  }

  return nextBlocks;
}

export function getBlockText(block: DocumentBlock): string {
  if (block.type === "list") return (block.items ?? block.content.split("\n")).join("\n");
  if (block.type === "image") return String(block.props?.caption ?? block.content ?? "");
  return block.content;
}

function createParagraphBlock(content: string): DocumentBlock {
  return {
    id: `doc_block_${crypto.randomUUID()}`,
    type: "paragraph",
    content,
    props: { content },
  };
}

function toParagraphBlock(block: DocumentBlock, content: string): DocumentBlock {
  return { ...block, type: "paragraph", content, props: { content } };
}

function toHeadingBlock(block: DocumentBlock, content: string, level: 1 | 2 | 3): DocumentBlock {
  return { ...block, type: "heading", content, props: { level, content } };
}

function toListBlock(block: DocumentBlock, items: string[]): DocumentBlock {
  return { ...block, type: "list", content: items.join("\n"), items, props: { style: "bullet", items } };
}

function withBlockText(block: DocumentBlock, content: string): DocumentBlock {
  if (block.type === "list") {
    const items = content.split("\n").map((item) => item.trim()).filter(Boolean);
    return { ...block, content, items, props: { ...block.props, items } };
  }
  if (block.type === "image") return { ...block, content, props: { ...block.props, caption: content } };
  return { ...block, content, props: { ...block.props, content } };
}

function insertAfter(blocks: DocumentBlock[], next: DocumentBlock, afterBlockId: string | null): DocumentBlock[] {
  if (!afterBlockId) return [...blocks, next];
  const index = blocks.findIndex((block) => block.id === afterBlockId);
  return index === -1 ? [...blocks, next] : [...blocks.slice(0, index + 1), next, ...blocks.slice(index + 1)];
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length, Math.round(index)));
}
