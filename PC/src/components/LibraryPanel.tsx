import { useWorkspaceStore } from "../stores/workspaceStore";

export function LibraryPanel(): React.JSX.Element {
  const { documents, selectedDocumentId, selectDocument } = useWorkspaceStore();

  return (
    <div className="border-b border-slate-200 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">文档库</h2>
        <button className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600 hover:bg-slate-200" type="button">
          新建
        </button>
      </div>
      <div className="space-y-2">
        {documents.map((document) => (
          <button
            className={`w-full rounded-xl border p-3 text-left transition ${
              document.id === selectedDocumentId
                ? "border-blue-200 bg-blue-50"
                : "border-slate-200 bg-white hover:bg-slate-50"
            }`}
            key={document.id}
            onClick={() => selectDocument(document.id)}
            type="button"
          >
            <div className="text-sm font-medium text-slate-950">{document.title}</div>
            <div className="mt-1 text-xs text-slate-500">更新于 {document.updatedAt}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
