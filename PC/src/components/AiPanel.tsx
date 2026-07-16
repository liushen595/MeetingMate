import { useMemo, useState } from "react";
import { pcApi } from "../lib/api";
import { DOCUMENT_AGENT_TOOLS_VERSION, buildDocumentAgentContext, safeParseAgentResult, type DocumentAgentResult } from "../lib/documentAgent";
import { applyDocumentAgentToolCalls } from "../lib/documentAgentTools";
import { readAgentEditSse } from "../lib/sse";
import { useWorkspaceStore } from "../stores/workspaceStore";

type AgentAction = {
  id: "summarize" | "polish" | "actions";
  label: string;
  prompt: string;
  mode: "edit" | "rewrite";
};

const actions: AgentAction[] = [
  { id: "summarize", label: "总结全文", prompt: "总结这篇文档，输出核心结论、关键要点和后续建议。只在 summary 中返回总结，tool_calls 返回空数组，不要修改文档。", mode: "edit" },
  { id: "polish", label: "润色全文", prompt: "润色全文，让表达更正式、清晰、适合作为会议纪要。", mode: "edit" },
  { id: "actions", label: "提取行动项", prompt: "从全文中提取行动项，并整理成清晰的待办段落或列表。", mode: "edit" },
];

export function AiPanel(): React.JSX.Element {
  const { documents, selectedDocumentId, updateDocument } = useWorkspaceStore();
  const document = documents.find((item) => item.id === selectedDocumentId) ?? null;
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState("选择一个 AI 动作，或输入自定义指令后生成云端结果。");
  const [status, setStatus] = useState("");
  const [agentResult, setAgentResult] = useState<DocumentAgentResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canApply = Boolean(document && (agentResult?.tool_calls.length || draft.trim()));
  const context = useMemo(
    () => (document ? buildDocumentAgentContext(document.title, document.blocks) : null),
    [document],
  );
  const canRunAgent = Boolean(document && context?.blocks.length);

  async function runAgent(action?: AgentAction): Promise<void> {
    if (!document || !context || busy) return;
    if (context.blocks.length === 0) {
      setError("当前文档没有可供 AI 处理的文本内容");
      return;
    }
    const nextPrompt = action?.prompt ?? prompt.trim();
    if (!nextPrompt) return;
    setBusy(true);
    setError(null);
    setStatus("正在连接 AI");
    setDraft("");
    setAgentResult(null);
    let full = "";

    try {
      const response = await pcApi.streamAgent(
        document.id,
        [],
        nextPrompt,
        action?.mode ?? "edit",
        { context, toolsVersion: DOCUMENT_AGENT_TOOLS_VERSION, selection: null },
      );
      await readAgentEditSse(response, {
        onStatus: setStatus,
        onDelta: (text) => {
          full += text;
          setDraft(full);
        },
        onResult: (result) => {
          const normalized = safeParseAgentResult(JSON.stringify(result));
          setAgentResult(normalized);
          setStatus(normalized?.summary || "AI 已生成修改方案");
          if (normalized?.summary) setDraft(normalized.summary);
        },
      });

      const parsed = safeParseAgentResult(full);
      if (parsed) {
        setAgentResult(parsed);
        setStatus(parsed.summary || "AI 已生成修改方案");
      } else if (full.trim()) {
        setStatus("AI 已生成文本草稿");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI 请求失败");
      setStatus("AI 请求失败");
    } finally {
      setBusy(false);
    }
  }

  async function applyAgentOutput(): Promise<void> {
    if (!document || busy) return;
    try {
      setBusy(true);
      setError(null);
      setStatus("正在应用 AI 修改");
      const agentApplyResult = agentResult?.tool_calls.length
        ? applyDocumentAgentToolCalls(document.blocks, agentResult.tool_calls)
        : null;
      const nextBlocks = agentApplyResult
        ? agentApplyResult.blocks
        : draft.trim()
          ? [...document.blocks, { id: `doc_block_${crypto.randomUUID()}`, type: "paragraph" as const, content: draft.trim(), props: { content: draft.trim() } }]
          : document.blocks;
      const saved = await pcApi.saveDocument({ ...document, blocks: nextBlocks }, { deletedBlockIds: agentApplyResult?.deletedBlockIds });
      updateDocument(saved);
      setAgentResult(null);
      setPrompt("");
      setDraft("AI 修改已应用并保存。");
      setStatus("已保存");
    } catch (err) {
      setError(err instanceof Error ? err.message : "应用 AI 修改失败");
      setStatus("应用失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="flex min-h-0 flex-col bg-white">
      <div className="border-b border-slate-200 p-5">
        <div className="text-xs uppercase tracking-[0.2em] text-blue-500">AI Agent</div>
        <h2 className="mt-2 text-lg font-semibold text-slate-950">文档助手</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">已接入云端 Agent，可总结全文、生成修改方案并应用到当前文档。</p>
      </div>
      <div className="space-y-3 border-b border-slate-200 p-5">
        {actions.map((action) => (
          <button
            className="w-full rounded-xl border border-slate-200 px-4 py-3 text-left text-sm font-medium text-slate-700 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
            disabled={!canRunAgent || busy}
            key={action.id}
            onClick={() => void runAgent(action)}
            type="button"
          >
            {action.label}
          </button>
        ))}
        <textarea
          className="min-h-24 w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100"
          disabled={!canRunAgent || busy}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="输入自定义指令，例如：把全文改成更适合汇报的语气"
          value={prompt}
        />
        <button
          className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          disabled={!canRunAgent || busy || !prompt.trim()}
          onClick={() => void runAgent()}
          type="button"
        >
          {busy ? "生成中" : "生成修改"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {status ? <div className="mb-3 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-700">{status}</div> : null}
        {error ? <div className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div> : null}
        {agentResult ? (
          <div className="mb-3 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {agentResult.summary || "AI 修改方案"}，将执行 {agentResult.tool_calls.length} 个文档操作。
          </div>
        ) : null}
        <div className="whitespace-pre-wrap rounded-2xl bg-slate-950 p-4 text-sm leading-7 text-slate-100 shadow-sm">
          {draft || (busy ? "AI 正在处理..." : "暂无输出")}
        </div>
      </div>
      <div className="space-y-3 border-t border-slate-200 p-5">
        <button className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50" disabled={!canApply || busy} onClick={() => void applyAgentOutput()} type="button">
          应用到文档
        </button>
      </div>
    </aside>
  );
}
