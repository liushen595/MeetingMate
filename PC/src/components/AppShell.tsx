import { useEffect, useState } from "react";
import { AiPanel } from "./AiPanel";
import { AccountPanel } from "./AccountPanel";
import { EditorPanel } from "./EditorPanel";
import { HomePanel } from "./HomePanel";
import { LibraryPanel } from "./LibraryPanel";
import { ManuscriptPanel } from "./ManuscriptPanel";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { isAuthError, pcApi } from "../lib/api";
import { useWorkspaceStore } from "../stores/workspaceStore";

export function AppShell(): React.JSX.Element {
  const activeSection = useWorkspaceStore((state) => state.activeSection);
  const hydrateWorkspace = useWorkspaceStore((state) => state.hydrateWorkspace);
  const [isAuthenticated, setIsAuthenticated] = useState(Boolean(pcApi.currentSession));
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const loadWorkspace = async (): Promise<void> => {
      if (!isAuthenticated || !pcApi.currentSession) {
        hydrateWorkspace({ documents: [], manuscripts: [] });
        return;
      }

      try {
        hydrateWorkspace(await pcApi.loadWorkspace());
        setLoadError(null);
      } catch (error) {
        if (isAuthError(error)) {
          await pcApi.clearSession();
          hydrateWorkspace({ documents: [], manuscripts: [] });
          setIsAuthenticated(false);
          return;
        }
        setLoadError(error instanceof Error ? error.message : "工作区加载失败，请稍后重试");
      }
    };

    void loadWorkspace();
  }, [hydrateWorkspace, isAuthenticated]);

  if (!isAuthenticated) {
    return <AccountPanel authOnly onAuthenticated={() => setIsAuthenticated(true)} />;
  }

  return (
    <div className="flex h-full min-h-0 bg-slate-100 text-slate-950">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Toolbar />
        {loadError ? (
          <div className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-800">
            工作区加载失败：{loadError}
          </div>
        ) : null}
        {activeSection === "home" ? <HomePanel /> : null}
        {activeSection === "library" ? (
          <section className="min-h-0 flex-1 overflow-auto bg-slate-50 p-8">
            <div className="mx-auto max-w-5xl rounded-3xl border border-slate-200 bg-white shadow-sm">
              <LibraryPanel />
            </div>
          </section>
        ) : null}
        {activeSection === "manuscriptEditor" ? <ManuscriptPanel /> : null}
        {activeSection === "documentEditor" ? (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(520px,1fr)_340px] gap-px bg-slate-200">
            <EditorPanel />
            <AiPanel />
          </div>
        ) : null}
        {activeSection === "account" ? <AccountPanel onAuthenticated={() => setIsAuthenticated(true)} onLogout={() => setIsAuthenticated(false)} /> : null}
      </main>
    </div>
  );
}

