import { useEffect } from "react";
import { AiPanel } from "./AiPanel";
import { EditorPanel } from "./EditorPanel";
import { LibraryPanel } from "./LibraryPanel";
import { ManuscriptPanel } from "./ManuscriptPanel";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { useWorkspaceStore } from "../stores/workspaceStore";

export function AppShell(): React.JSX.Element {
  const activeSection = useWorkspaceStore((state) => state.activeSection);
  const hydrateWorkspace = useWorkspaceStore((state) => state.hydrateWorkspace);

  useEffect(() => {
    window.meetingMate?.getInitialWorkspace().then((data) => {
      if (data) {
        hydrateWorkspace(data);
      }
    });
  }, [hydrateWorkspace]);

  return (
    <div className="flex h-full min-h-0 bg-slate-100 text-slate-950">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Toolbar />
        {activeSection === "library" ? (
          <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(420px,1fr)_340px] gap-px bg-slate-200">
            <section className="min-h-0 overflow-auto bg-white">
              <LibraryPanel />
            </section>
            <EditorPanel />
            <AiPanel />
          </div>
        ) : null}
        {activeSection === "manuscripts" ? <ManuscriptPanel /> : null}
        {activeSection === "ai" ? <StandaloneAiWorkspace /> : null}
        {activeSection === "exports" ? <PlaceholderWorkspace title="导出" description="后续在这里管理 PDF / DOCX 导出任务。" /> : null}
        {activeSection === "settings" ? <PlaceholderWorkspace title="设置" description="后续在这里管理账户、API、同步和本地数据配置。" /> : null}
      </main>
    </div>
  );
}

function StandaloneAiWorkspace(): React.JSX.Element {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(520px,1fr)_380px] gap-px bg-slate-200">
      <section className="min-h-0 overflow-auto bg-slate-50 p-10">
        <div className="rounded-3xl border border-slate-200 bg-white p-10 shadow-sm">
          <div className="text-xs uppercase tracking-[0.2em] text-blue-500">AI Workspace</div>
          <h2 className="mt-3 text-2xl font-bold text-slate-950">AI 工作台</h2>
          <p className="mt-3 text-sm leading-7 text-slate-500">这里后续承载全文问答、润色、摘要、行动项提取和知识库检索。</p>
        </div>
      </section>
      <AiPanel />
    </div>
  );
}

function PlaceholderWorkspace({ description, title }: { description: string; title: string }): React.JSX.Element {
  return (
    <section className="min-h-0 flex-1 overflow-auto bg-slate-50 p-10">
      <div className="rounded-3xl border border-slate-200 bg-white p-10 shadow-sm">
        <h2 className="text-2xl font-bold text-slate-950">{title}</h2>
        <p className="mt-3 text-sm leading-7 text-slate-500">{description}</p>
      </div>
    </section>
  );
}
