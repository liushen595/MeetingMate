import { useWorkspaceStore } from "../stores/workspaceStore";

const actions = [
  { id: "summarize", label: "总结全文" },
  { id: "polish", label: "润色选区" },
  { id: "actions", label: "提取行动项" }
];

export function AiPanel(): React.JSX.Element {
  const { aiOutput, runAiAction } = useWorkspaceStore();

  return (
    <aside className="flex min-h-0 flex-col bg-white">
      <div className="border-b border-slate-200 p-5">
        <div className="text-xs uppercase tracking-[0.2em] text-blue-500">AI Agent</div>
        <h2 className="mt-2 text-lg font-semibold text-slate-950">文档助手</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">第一版使用模拟输出，后续接入 SSE 流式 AI 服务。</p>
      </div>
      <div className="space-y-3 border-b border-slate-200 p-5">
        {actions.map((action) => (
          <button
            className="w-full rounded-xl border border-slate-200 px-4 py-3 text-left text-sm font-medium text-slate-700 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
            key={action.id}
            onClick={() => runAiAction(action.id)}
            type="button"
          >
            {action.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="rounded-2xl bg-slate-950 p-4 text-sm leading-7 text-slate-100 shadow-sm">
          {aiOutput}
        </div>
      </div>
      <div className="border-t border-slate-200 p-5">
        <button className="w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800" type="button">
          应用到文档 Mock
        </button>
      </div>
    </aside>
  );
}
