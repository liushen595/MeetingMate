import { useWorkspaceStore } from "../stores/workspaceStore";

export function Toolbar(): React.JSX.Element {
  const document = useWorkspaceStore((state) =>
    state.documents.find((item) => item.id === state.selectedDocumentId)
  );

  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div>
        <div className="text-sm text-slate-500">MeetingMate PC</div>
        <h1 className="text-lg font-semibold text-slate-950">{document?.title ?? "未选择文档"}</h1>
      </div>
      <div className="flex items-center gap-3">
        <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">本地草稿</span>
        <button className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" type="button">
          预览
        </button>
        <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700" type="button">
          转换为正式文档
        </button>
      </div>
    </header>
  );
}
