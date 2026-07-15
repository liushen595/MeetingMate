import { useEffect, useState } from "react";
import { pcApi } from "../lib/api";
import { useWorkspaceStore } from "../stores/workspaceStore";

type AccountPanelProps = {
  authOnly?: boolean;
  onAuthenticated?: () => void;
  onLogout?: () => void;
};

const LAST_EMAIL_KEY = "meetingmate.auth.last_email";
const REMEMBER_ACCOUNT_KEY = "meetingmate.auth.remember_account";
const REMEMBER_PASSWORD_KEY = "meetingmate.auth.remember_password";
const SAVED_PASSWORD_KEY = "meetingmate.auth.saved_password";

export function AccountPanel({ authOnly = false, onAuthenticated, onLogout }: AccountPanelProps): React.JSX.Element {
  const hydrateWorkspace = useWorkspaceStore((state) => state.hydrateWorkspace);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loginEmail, setLoginEmail] = useState(() => localStorage.getItem(LAST_EMAIL_KEY) ?? "");
  const [loginPassword, setLoginPassword] = useState(() => localStorage.getItem(REMEMBER_PASSWORD_KEY) === "true" ? localStorage.getItem(SAVED_PASSWORD_KEY) ?? "" : "");
  const [rememberAccount, setRememberAccount] = useState(() => localStorage.getItem(REMEMBER_ACCOUNT_KEY) !== "false");
  const [rememberPassword, setRememberPassword] = useState(() => localStorage.getItem(REMEMBER_PASSWORD_KEY) === "true");
  const [registerEmail, setRegisterEmail] = useState("");
  const [registerName, setRegisterName] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerPasswordConfirm, setRegisterPasswordConfirm] = useState("");
  const [sessionEmail, setSessionEmail] = useState(pcApi.currentSession?.user.email ?? "");
  const [status, setStatus] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const session = pcApi.currentSession;

  useEffect(() => {
    if (mode !== "login") return;
    setLoginEmail(localStorage.getItem(LAST_EMAIL_KEY) ?? "");
    if (localStorage.getItem(REMEMBER_PASSWORD_KEY) === "true") setLoginPassword(localStorage.getItem(SAVED_PASSWORD_KEY) ?? "");
  }, [mode]);

  async function refreshWorkspace(): Promise<void> {
    const data = await pcApi.loadWorkspace();
    hydrateWorkspace(data);
  }

  async function submitLogin(): Promise<void> {
    setIsBusy(true);
    setStatus("");
    try {
      const session = await pcApi.login({ email: loginEmail.trim(), password: loginPassword });
      persistLoginFields(loginEmail.trim(), loginPassword, rememberAccount, rememberPassword);
      await refreshWorkspace();
      setSessionEmail(session.user.email);
      setStatus(`登录成功：${session.user.email}`);
      onAuthenticated?.();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function submitRegister(): Promise<void> {
    setIsBusy(true);
    setStatus("");
    try {
      const email = registerEmail.trim();
      if (registerPassword !== registerPasswordConfirm) {
        setStatus("两次输入的密码不一致。");
        return;
      }
      await pcApi.register({ email, password: registerPassword, name: registerName.trim() }, false);
      setStatus("注册成功，2 秒后返回登录页面。");
      setLoginEmail(email);
      setLoginPassword("");
      localStorage.setItem(LAST_EMAIL_KEY, email);
      setRegisterEmail("");
      setRegisterName("");
      setRegisterPassword("");
      setRegisterPasswordConfirm("");
      window.setTimeout(() => {
        setMode("login");
        setStatus("");
      }, 2000);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function logout(): Promise<void> {
    await pcApi.logout();
    hydrateWorkspace({ documents: [], manuscripts: [] });
    setSessionEmail("");
    onLogout?.();
  }

  if (!authOnly && session) {
    return (
      <section className="min-h-0 flex-1 overflow-auto bg-slate-50 p-8">
        <div className="mx-auto max-w-4xl space-y-6">
          <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-5">
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-blue-600 text-3xl font-semibold text-white">
                  {getInitial(session.user.name || session.user.email)}
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-blue-500">Account</div>
                  <h2 className="mt-2 text-2xl font-bold text-slate-950">{session.user.name || "未设置昵称"}</h2>
                  <p className="mt-1 text-sm text-slate-500">{session.user.email}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50" onClick={() => void logout()} type="button">
                  切换账号
                </button>
                <button className="rounded-xl border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50" onClick={() => void logout()} type="button">
                  登出
                </button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <InfoCard label="账号昵称" value={session.user.name || "未设置"} />
            <InfoCard label="邮箱" value={session.user.email} />
            <InfoCard label="服务器" value={pcApi.baseUrl} />
            <InfoCard label="客户端 ID" value={pcApi.clientId} />
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-base font-semibold text-slate-950">安全提示</h3>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              切换账号或登出会清除当前登录令牌并返回登录页。若勾选过“记住账号/密码”，登录页会继续按你的选择保留本机凭据。
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={`${authOnly ? "flex h-full items-center justify-center" : "min-h-0 flex-1 overflow-auto"} bg-slate-50 p-8`}>
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="text-xs uppercase tracking-[0.2em] text-blue-500">MeetingMate Server</div>
        <h2 className="mt-2 text-2xl font-bold text-slate-950">{mode === "login" ? "登录" : "注册"}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">服务器：{pcApi.baseUrl}</p>
        {!authOnly && <p className="mt-1 text-sm leading-6 text-slate-500">当前账号：{sessionEmail || "未登录"}</p>}

        {mode === "login" ? (
          <form className="mt-6 grid gap-3" onSubmit={(event) => { event.preventDefault(); void submitLogin(); }}>
            <input autoComplete="username" className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100" onChange={(event) => setLoginEmail(event.target.value)} placeholder="邮箱" value={loginEmail} />
            <input autoComplete={rememberPassword ? "current-password" : "off"} className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100" onChange={(event) => setLoginPassword(event.target.value)} placeholder="密码" type="password" value={loginPassword} />
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input checked={rememberAccount} onChange={(event) => setRememberAccount(event.target.checked)} type="checkbox" />
              记住账号
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input checked={rememberPassword} onChange={(event) => setRememberPassword(event.target.checked)} type="checkbox" />
              记住密码
            </label>
            <button className="mt-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" disabled={isBusy || !loginEmail.trim() || !loginPassword} type="submit">登录</button>
          </form>
        ) : (
          <form className="mt-6 grid gap-3" onSubmit={(event) => { event.preventDefault(); void submitRegister(); }}>
            <input autoComplete="off" className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100" onChange={(event) => setRegisterEmail(event.target.value)} placeholder="邮箱" value={registerEmail} />
            <input autoComplete="off" className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100" onChange={(event) => setRegisterName(event.target.value)} placeholder="账号昵称" value={registerName} />
            <input autoComplete="new-password" className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100" onChange={(event) => setRegisterPassword(event.target.value)} placeholder="密码" type="password" value={registerPassword} />
            <input autoComplete="new-password" className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100" onChange={(event) => setRegisterPasswordConfirm(event.target.value)} placeholder="确认密码" type="password" value={registerPasswordConfirm} />
            <button className="mt-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" disabled={isBusy || !registerEmail.trim() || !registerName.trim() || !registerPassword || !registerPasswordConfirm} type="submit">注册</button>
          </form>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50" onClick={() => { setMode(mode === "login" ? "register" : "login"); setStatus(""); }} type="button">
            {mode === "login" ? "创建账号" : "返回登录"}
          </button>
          {!authOnly && pcApi.currentSession ? <button className="rounded-xl border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50" onClick={() => void logout()} type="button">退出</button> : null}
        </div>

        {status ? <div className="mt-6 rounded-2xl bg-slate-950 p-4 text-sm leading-7 text-slate-100">{status}</div> : null}
      </div>
    </section>
  );
}

function InfoCard({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">{label}</div>
      <div className="mt-2 break-all text-sm font-medium text-slate-900">{value}</div>
    </div>
  );
}

function getInitial(value: string): string {
  return value.trim().slice(0, 1).toUpperCase() || "M";
}

function persistLoginFields(email: string, password: string, rememberAccount: boolean, rememberPassword: boolean): void {
  localStorage.setItem(REMEMBER_ACCOUNT_KEY, String(rememberAccount));
  localStorage.setItem(REMEMBER_PASSWORD_KEY, String(rememberPassword));
  if (rememberAccount) localStorage.setItem(LAST_EMAIL_KEY, email);
  else localStorage.removeItem(LAST_EMAIL_KEY);
  if (rememberPassword) localStorage.setItem(SAVED_PASSWORD_KEY, password);
  else localStorage.removeItem(SAVED_PASSWORD_KEY);
}
