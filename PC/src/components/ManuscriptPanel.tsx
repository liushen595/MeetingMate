import { useWorkspaceStore } from "../stores/workspaceStore";

export function ManuscriptPanel(): React.JSX.Element {
  const { manuscripts, selectedManuscriptId, selectManuscript } = useWorkspaceStore();
  const manuscript = manuscripts.find((item) => item.id === selectedManuscriptId);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">手稿素材</h2>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] text-slate-500">mobile-web</span>
      </div>
      <div className="mb-3 space-y-2">
        {manuscripts.map((item) => (
          <button
            className={`w-full rounded-xl border p-3 text-left text-sm transition ${
              item.id === selectedManuscriptId
                ? "border-emerald-200 bg-emerald-50"
                : "border-slate-200 bg-white hover:bg-slate-50"
            }`}
            key={item.id}
            onClick={() => selectManuscript(item.id)}
            type="button"
          >
            <div className="font-medium text-slate-950">{item.title}</div>
            <div className="mt-1 text-xs text-slate-500">{item.blocks.length} 个 blocks</div>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
        {manuscript?.blocks.map((block) => (
          <article className="rounded-xl border border-slate-200 bg-white p-3" key={block.id}>
            <div className="mb-2 flex items-center justify-between">
              <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] uppercase tracking-wide text-slate-500">
                {block.type}
              </span>
              <span className="text-xs text-slate-400">{block.timestamp}</span>
            </div>
            <h3 className="text-sm font-medium text-slate-950">{block.title}</h3>
            <p className="mt-1 text-xs leading-5 text-slate-600">{block.summary}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
