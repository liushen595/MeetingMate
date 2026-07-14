import type { DocumentBlock } from "../types/block";
import { useWorkspaceStore } from "../stores/workspaceStore";

function BlockView({ block }: { block: DocumentBlock }): React.JSX.Element {
  if (block.type === "heading") {
    return <h2 className="text-3xl font-bold tracking-tight text-slate-950">{block.content}</h2>;
  }

  if (block.type === "list") {
    return (
      <div>
        <p className="mb-2 font-medium text-slate-800">{block.content}</p>
        <ul className="list-disc space-y-2 pl-6 text-slate-700">
          {block.items?.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </div>
    );
  }

  if (block.type === "quote") {
    return <blockquote className="border-l-4 border-blue-500 bg-blue-50 px-4 py-3 text-slate-700">{block.content}</blockquote>;
  }

  if (block.type === "action") {
    return <div className="rounded-xl bg-emerald-50 p-4 text-emerald-800">行动项：{block.content}</div>;
  }

  return <p className="leading-8 text-slate-700">{block.content}</p>;
}

export function EditorPanel(): React.JSX.Element {
  const document = useWorkspaceStore((state) =>
    state.documents.find((item) => item.id === state.selectedDocumentId)
  );

  return (
    <section className="min-h-0 overflow-auto bg-slate-50 px-10 py-8">
      <div className="mx-auto max-w-3xl rounded-3xl border border-slate-200 bg-white p-10 shadow-sm">
        <div className="mb-8 flex items-center justify-between border-b border-slate-100 pb-5">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Structured Document</div>
            <div className="mt-2 text-sm text-slate-500">当前为 mock 预览，下一阶段替换为 Slate.js 编辑器。</div>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">{document?.status ?? "draft"}</span>
        </div>
        <div className="space-y-7">
          {document?.blocks.map((block) => <BlockView block={block} key={block.id} />)}
        </div>
      </div>
    </section>
  );
}
