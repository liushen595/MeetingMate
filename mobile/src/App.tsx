import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AccountPage } from "./pages/AccountPage";
import { DocumentEditor } from "./pages/DocumentEditor";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { ManuscriptEditor } from "./pages/ManuscriptEditor";
import { api } from "./lib/api";
import type { DocumentSummary, ManuscriptSummary, Session } from "./types/api";

type Route =
  | { screen: "home" }
  | { screen: "library" }
  | { screen: "account" }
  | { screen: "manuscript"; id: string }
  | { screen: "document"; id: string };

function parseRoute(): Route {
  const hash = window.location.hash || "#/home";
  const [, section, id] = hash.split("/");
  if (section === "library") return { screen: "library" };
  if (section === "account") return { screen: "account" };
  if (section === "manuscripts" && id) return { screen: "manuscript", id };
  if (section === "documents" && id) return { screen: "document", id };
  return { screen: "home" };
}

function navigate(path: string) {
  window.location.hash = path;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(api.currentSession);
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [manuscripts, setManuscripts] = useState<ManuscriptSummary[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) navigate("/home");
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const refreshLibrary = useCallback(async () => {
    if (!api.currentSession) return;
    setLoadingLibrary(true);
    try {
      const [manuscriptRes, documentRes] = await Promise.all([api.listManuscripts(), api.listDocuments()]);
      setManuscripts(manuscriptRes.items);
      setDocuments(documentRes.items);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载失败");
    } finally {
      setLoadingLibrary(false);
    }
  }, []);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary, session]);

  const actions = useMemo(
    () => ({
      openHome: () => navigate("/home"),
      openLibrary: () => navigate("/library"),
      openAccount: () => navigate("/account"),
      openManuscript: (id: string) => navigate(`/manuscripts/${id}`),
      openDocument: (id: string) => navigate(`/documents/${id}`),
      async createManuscript(title?: string) {
        const defaultTitle = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date());
        const manuscript = await api.createManuscript(title?.trim() || `${defaultTitle} 手稿`);
        await refreshLibrary();
        navigate(`/manuscripts/${manuscript.id}`);
      },
      async createDocument() {
        const doc = await api.createDocument("空白文档");
        await refreshLibrary();
        navigate(`/documents/${doc.id}`);
      },
    }),
    [refreshLibrary],
  );

  function handleLogout() {
    setSession(null);
    setManuscripts([]);
    setDocuments([]);
    navigate("/home");
  }

  if (!session) {
    return <AuthScreen onAuthed={(next) => setSession(next)} />;
  }

  const insideEditor = route.screen === "manuscript" || route.screen === "document";

  return (
    <div className="app-shell">
      {message && (
        <button className="toast" onClick={() => setMessage(null)} type="button">
          {message}
        </button>
      )}
      <main className={insideEditor ? "app-main app-main-editor" : "app-main"}>
        {route.screen === "home" && (
          <HomePage
            documents={documents}
            loading={loadingLibrary}
            manuscripts={manuscripts}
            onCreateDocument={actions.createDocument}
            onCreateManuscript={actions.createManuscript}
            onOpenDocument={actions.openDocument}
            onOpenManuscript={actions.openManuscript}
          />
        )}
        {route.screen === "library" && (
          <LibraryPage
            documents={documents}
            loading={loadingLibrary}
            manuscripts={manuscripts}
            onCreateDocument={actions.createDocument}
            onCreateManuscript={actions.createManuscript}
            onOpenDocument={actions.openDocument}
            onOpenManuscript={actions.openManuscript}
            onRefresh={refreshLibrary}
          />
        )}
        {route.screen === "account" && <AccountPage onLogout={handleLogout} onRefresh={refreshLibrary} user={session.user} />}
        {route.screen === "manuscript" && <ManuscriptEditor id={route.id} onBack={actions.openLibrary} onOpenDocument={actions.openDocument} />}
        {route.screen === "document" && <DocumentEditor id={route.id} onBack={actions.openLibrary} />}
      </main>
      {!insideEditor && <BottomNav active={route.screen} onNavigate={navigate} />}
    </div>
  );
}

function BottomNav({ active, onNavigate }: { active: "home" | "library" | "account"; onNavigate: (path: string) => void }) {
  const items = [
    { key: "home", label: "首页", path: "/home" },
    { key: "library", label: "库", path: "/library" },
    { key: "account", label: "账户", path: "/account" },
  ] as const;
  return (
    <nav className="bottom-nav" aria-label="主导航">
      {items.map((item) => (
        <button className={active === item.key ? "bottom-nav-item active" : "bottom-nav-item"} key={item.key} onClick={() => onNavigate(item.path)} type="button">
          <span className="nav-dot" />
          {item.label}
        </button>
      ))}
    </nav>
  );
}

function AuthScreen({ onAuthed }: { onAuthed: (session: Session) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const session = mode === "login" ? await api.login(email, password) : await api.register(email, password, name || email.split("@")[0]);
      onAuthed(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "认证失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="brand-mark">MM</div>
        <p className="eyebrow">MeetingMate Mobile</p>
        <h1>把现场素材变成可修改的文档</h1>
        <p className="muted">登录后使用云端 ASR、多模态转换和文档同步。移动端按同一套 Block JSON 与后端交互。</p>
        <form className="auth-form" onSubmit={submit}>
          {mode === "register" && <input autoComplete="name" onChange={(event) => setName(event.target.value)} placeholder="昵称" value={name} />}
          <input autoComplete="email" inputMode="email" onChange={(event) => setEmail(event.target.value)} placeholder="邮箱" required type="email" value={email} />
          <input autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={6} onChange={(event) => setPassword(event.target.value)} placeholder="密码" required type="password" value={password} />
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={loading} type="submit">
            {loading ? "处理中" : mode === "login" ? "登录" : "注册并登录"}
          </button>
        </form>
        <button className="text-button" onClick={() => setMode(mode === "login" ? "register" : "login")} type="button">
          {mode === "login" ? "没有账户，创建一个" : "已有账户，去登录"}
        </button>
      </section>
    </main>
  );
}
