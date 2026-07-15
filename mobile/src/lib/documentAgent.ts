import type { DocumentBlock } from "../types/api";

export const DOCUMENT_AGENT_TOOLS_VERSION = "mobile-doc-agent-v1";

export type DocumentAgentMode = "edit" | "rewrite";

export interface DocumentAgentContextBlock {
  id: string;
  type: DocumentBlock["type"];
  text: string;
  list_style: "bullet" | "numbered" | null;
  level: number | null;
}

export interface DocumentAgentContext {
  title: string;
  blocks: DocumentAgentContextBlock[];
}

export type DocumentAgentToolCall =
  | { name: "replace_block_text"; args: { block_id: string; content: string } }
  | { name: "replace_text_range"; args: { block_id: string; start: number; end: number; content: string } }
  | { name: "insert_paragraph_after"; args: { after_block_id: string | null; content: string } }
  | { name: "convert_to_heading"; args: { block_id: string; level: 1 | 2 | 3; content?: string } }
  | { name: "convert_to_list"; args: { block_id: string; style: "bullet" | "numbered"; items: string[] } }
  | { name: "split_paragraph"; args: { block_id: string; paragraphs: string[] } }
  | { name: "merge_blocks"; args: { block_ids: string[]; content: string } }
  | { name: "delete_blocks"; args: { block_ids: string[] } };

export interface DocumentAgentResult {
  summary: string;
  tool_calls: DocumentAgentToolCall[];
}

export function buildDocumentAgentContext(title: string, blocks: DocumentBlock[], selectedBlockIds: string[]): DocumentAgentContext {
  const selected = selectedBlockIds.length > 0 ? new Set(selectedBlockIds) : null;
  const source = selected ? blocks.filter((block) => selected.has(block.id)) : blocks;
  return {
    title,
    blocks: source.map(blockToAgentContext).filter((block) => block.text.trim() || block.type === "image"),
  };
}

export function blockToAgentContext(block: DocumentBlock): DocumentAgentContextBlock {
  if (block.type === "list") {
    return { id: block.id, type: block.type, text: block.props.items.join("\n"), list_style: block.props.style, level: null };
  }
  if (block.type === "heading") {
    return { id: block.id, type: block.type, text: block.props.content, list_style: null, level: block.props.level };
  }
  if (block.type === "table") {
    return { id: block.id, type: block.type, text: block.props.rows.map((row) => row.join("\t")).join("\n"), list_style: null, level: null };
  }
  if (block.type === "image") {
    return { id: block.id, type: block.type, text: block.props.caption ?? "", list_style: null, level: null };
  }
  return { id: block.id, type: block.type, text: block.props.content, list_style: null, level: null };
}

export function safeParseAgentResult(raw: string): DocumentAgentResult | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return normalizeAgentResult(parsed);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return normalizeAgentResult(JSON.parse(text.slice(start, end + 1)) as unknown);
    } catch {
      return null;
    }
  }
}

function normalizeAgentResult(value: unknown): DocumentAgentResult | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as { summary?: unknown; tool_calls?: unknown };
  if (!Array.isArray(payload.tool_calls)) return null;
  const toolCalls = payload.tool_calls.filter(isSupportedToolCall);
  return { summary: typeof payload.summary === "string" ? payload.summary : "将应用 AI 修改", tool_calls: toolCalls };
}

function isSupportedToolCall(value: unknown): value is DocumentAgentToolCall {
  if (!value || typeof value !== "object") return false;
  const call = value as { name?: unknown; args?: unknown };
  if (typeof call.name !== "string" || !call.args || typeof call.args !== "object") return false;
  const args = call.args as Record<string, unknown>;
  if (call.name === "replace_block_text") return typeof args.block_id === "string" && typeof args.content === "string";
  if (call.name === "replace_text_range") return typeof args.block_id === "string" && typeof args.start === "number" && typeof args.end === "number" && typeof args.content === "string";
  if (call.name === "insert_paragraph_after") return (typeof args.after_block_id === "string" || args.after_block_id === null) && typeof args.content === "string";
  if (call.name === "convert_to_heading") return typeof args.block_id === "string" && (args.level === 1 || args.level === 2 || args.level === 3) && (args.content === undefined || typeof args.content === "string");
  if (call.name === "convert_to_list") return typeof args.block_id === "string" && (args.style === "bullet" || args.style === "numbered") && Array.isArray(args.items) && args.items.every((item) => typeof item === "string");
  if (call.name === "split_paragraph") return typeof args.block_id === "string" && Array.isArray(args.paragraphs) && args.paragraphs.every((item) => typeof item === "string");
  if (call.name === "merge_blocks") return Array.isArray(args.block_ids) && args.block_ids.every((item) => typeof item === "string") && typeof args.content === "string";
  if (call.name === "delete_blocks") return Array.isArray(args.block_ids) && args.block_ids.every((item) => typeof item === "string");
  return false;
}
