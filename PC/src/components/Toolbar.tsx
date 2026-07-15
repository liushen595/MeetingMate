import { useWorkspaceStore } from "../stores/workspaceStore";

export function Toolbar(): React.JSX.Element {
  const activeSection = useWorkspaceStore((state) => state.activeSection);
  const saveStatus = useWorkspaceStore((state) => state.saveStatus);
  const document = useWorkspaceStore((state) =>
    state.documents.find((item) => item.id === state.selectedDocumentId)
  );
  const manuscript = useWorkspaceStore((state) =>
    state.manuscripts.find((item) => item.id === state.selectedManuscriptId)
  );
  const setActiveSection = useWorkspaceStore((state) => state.setActiveSection);

  const statusText = {
    idle: "本地草稿",
    saving: "保存中",
    saved: "已自动保存",
    error: "保存失败"
  }[saveStatus];

  const title = {
    home: "首页",
    library: "库",
    account: "账户",
    manuscriptEditor: manuscript?.title ?? "手稿编辑",
    documentEditor: document?.title ?? "文档编辑"
  }[activeSection];

  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div>
        <div className="text-sm text-slate-500">MeetingMate PC</div>
        <h1 className="text-lg font-semibold text-slate-950">{title}</h1>
      </div>
      <div className="flex items-center gap-3">
        {activeSection === "documentEditor" ? <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">{statusText}</span> : null}
        {(activeSection === "documentEditor" || activeSection === "manuscriptEditor") ? (
          <button className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50" onClick={() => setActiveSection("library")} type="button">
            返回库
          </button>
        ) : null}
      </div>
    </header>
  );
}
