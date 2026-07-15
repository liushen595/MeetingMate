import { useState } from "react";
import { pcApi } from "../lib/api";
import { useWorkspaceStore } from "../stores/workspaceStore";

export function LibraryPanel(): React.JSX.Element {
  const {
    addManuscript,
    documents,
    manuscripts,
    openDocumentEditor,
    openManuscriptEditor,
    removeDocument,
    selectedDocumentId,
    selectedManuscriptId
  } = useWorkspaceStore();
  const [tab, setTab] = useState<"all" | "manuscripts" | "documents">("all");
  const showManuscripts = tab === "all" || tab === "manuscripts";
  const showDocuments = tab === "all" || tab === "documents";

  const createManuscript = async (): Promise<void> => {
    const nextManuscript = await pcApi.createManuscript("未命名手稿");
    if (nextManuscript) {
      addManuscript(nextManuscript);
      openManuscriptEditor(nextManuscript.id);
    }
  };

  const deleteDocument = async (id: string, title: string): Promise<void> => {
    const shouldDelete = window.confirm(`确认删除文档“${title}”？此操作会同步删除本地数据库中的内容。`);

    if (!shouldDelete) return;

    await pcApi.deleteDocument(id);
    removeDocument(id);
  };

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Library</div>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">手稿与文本文档</h2>
        </div>
        <button className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700" onClick={createManuscript} type="button">
          新手稿
        </button>
      </div>

      <div className="mb-4 grid grid-cols-3 rounded-xl bg-slate-100 p-1 text-xs font-medium text-slate-600">
        {(["all", "manuscripts", "documents"] as const).map((item) => (
          <button className={`rounded-lg px-2 py-2 ${tab === item ? "bg-white text-slate-950 shadow-sm" : ""}`} key={item} onClick={() => setTab(item)} type="button">
            {item === "all" ? "全部" : item === "manuscripts" ? "手稿" : "文档"}
          </button>
        ))}
      </div>

      <div className="space-y-5">
        {showManuscripts ? (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">手稿</h3>
            <div className="space-y-2">
              {manuscripts.map((manuscript) => (
                <button
                  className={`w-full rounded-xl border p-3 text-left transition ${
                    manuscript.id === selectedManuscriptId ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                  key={manuscript.id}
                  onClick={() => openManuscriptEditor(manuscript.id)}
                  type="button"
                >
                  <span className="text-[11px] uppercase tracking-wide text-emerald-600">Manuscript</span>
                  <div className="mt-1 text-sm font-medium text-slate-950">{manuscript.title}</div>
                  <div className="mt-1 text-xs text-slate-500">{manuscript.blocks.length} blocks · {manuscript.updatedAt}</div>
                </button>
              ))}
              {manuscripts.length === 0 ? <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500">没有手稿。</p> : null}
            </div>
          </section>
        ) : null}

        {showDocuments ? (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">文本文档</h3>
            <div className="space-y-2">
              {documents.map((document) => (
                <div
                  className={`w-full rounded-xl border p-3 text-left transition ${
                    document.id === selectedDocumentId ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                  key={document.id}
                >
                  <button className="block w-full text-left" onClick={() => openDocumentEditor(document.id)} type="button">
                    <span className="text-[11px] uppercase tracking-wide text-blue-600">Document</span>
                    <div className="mt-1 text-sm font-medium text-slate-950">{document.title}</div>
                    <div className="mt-1 text-xs text-slate-500">{document.updatedAt}</div>
                  </button>
                  <div className="mt-3 flex justify-end">
                    <button className="rounded-lg border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50" onClick={() => deleteDocument(document.id, document.title)} type="button">
                      删除
                    </button>
                  </div>
                </div>
              ))}
              {documents.length === 0 ? <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500">没有文档。</p> : null}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
