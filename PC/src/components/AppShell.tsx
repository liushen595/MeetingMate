import { AiPanel } from "./AiPanel";
import { EditorPanel } from "./EditorPanel";
import { LibraryPanel } from "./LibraryPanel";
import { ManuscriptPanel } from "./ManuscriptPanel";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";

export function AppShell(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 bg-slate-100 text-slate-950">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Toolbar />
        <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(420px,1fr)_340px] gap-px bg-slate-200">
          <section className="min-h-0 overflow-hidden bg-white">
            <LibraryPanel />
            <ManuscriptPanel />
          </section>
          <EditorPanel />
          <AiPanel />
        </div>
      </main>
    </div>
  );
}
