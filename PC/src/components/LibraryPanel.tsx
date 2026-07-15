import { useWorkspaceStore } from "../stores/workspaceStore";

export function LibraryPanel(): React.JSX.Element {
  const { documents, removeDocument, selectedDocumentId, selectDocument } = useWorkspaceStore();

  const deleteDocument = async (id: string, title: string): Promise<void> => {
    const shouldDelete = window.confirm(`确认删除文档“${title}”？此操作会同步删除本地数据库中的内容。`);

    if (!shouldDelete) {
      return;
    }

    await window.meetingMate?.deleteDocument(id);
    removeDocument(id);
  };

  return (
    <div className="border-b border-slate-200 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">文档库</h2>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] text-slate-500">由手稿导出</span>
      </div>
      <div className="space-y-2">
        {documents.map((document) => (
          <div
            className={`w-full rounded-xl border p-3 text-left transition ${
              document.id === selectedDocumentId
                ? "border-blue-200 bg-blue-50"
                : "border-slate-200 bg-white hover:bg-slate-50"
            }`}
            key={document.id}
          >
            <button className="block w-full text-left" onClick={() => selectDocument(document.id)} type="button">
              <div className="text-sm font-medium text-slate-950">{document.title}</div>
              <div className="mt-1 text-xs text-slate-500">更新于 {document.updatedAt}</div>
            </button>
            <div className="mt-3 flex justify-end">
              <button
                className="rounded-lg border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                onClick={() => deleteDocument(document.id, document.title)}
                type="button"
              >
                删除
              </button>
            </div>
          </div>
        ))}
        {documents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-xs leading-5 text-slate-500">
            文档库为空。请先在手稿工作台选择“导出文档”。
          </div>
        ) : null}
      </div>
    </div>
  );
}
