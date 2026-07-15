import { useEffect, useState } from "react";
import { AiPanel } from "./AiPanel";
import { AccountPanel } from "./AccountPanel";
import { EditorPanel } from "./EditorPanel";
import { HomePanel } from "./HomePanel";
import { LibraryPanel } from "./LibraryPanel";
import { ManuscriptPanel } from "./ManuscriptPanel";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { pcApi } from "../lib/api";
import { useWorkspaceStore } from "../stores/workspaceStore";

export function AppShell(): React.JSX.Element {
  const activeSection = useWorkspaceStore((state) => state.activeSection);
  const hydrateWorkspace = useWorkspaceStore((state) => state.hydrateWorkspace);
  const [isAuthenticated, setIsAuthenticated] = useState(Boolean(pcApi.currentSession));

  useEffect(() => {
    const loadWorkspace = async (): Promise<void> => {
      if (!isAuthenticated || !pcApi.currentSession) {
        hydrateWorkspace({ documents: [], manuscripts: [] });
        return;
      }

      try {
        hydrateWorkspace(await pcApi.loadWorkspace());
      } catch {
        await pcApi.clearSession();
        hydrateWorkspace({ documents: [], manuscripts: [] });
        setIsAuthenticated(false);
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

