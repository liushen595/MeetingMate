import type { User } from "../types/api";
import { API_BASE_URL, api } from "../lib/api";
import { getPlatform } from "../lib/device";

export function AccountPage({ user, onLogout, onRefresh }: { user: User; onLogout: () => void; onRefresh: () => Promise<void> }) {
  async function logout() {
    try {
      await api.logout();
    } catch {
      api.setSession(null);
    } finally {
      onLogout();
    }
  }

  return (
    <section className="screen account-screen">
      <header className="profile-card">
        <div className="avatar">{getInitial(user.name || user.email)}</div>
        <div>
          <p className="eyebrow">Account</p>
          <h1>{user.name || "未设置昵称"}</h1>
          <p>{user.email}</p>
        </div>
      </header>
      <div className="account-actions">
        <button className="ghost-button" onClick={() => void logout()} type="button">切换账号</button>
        <button className="danger-button" onClick={() => void logout()} type="button">登出</button>
      </div>

      <div className="settings-list account-info-grid">
        <InfoCard label="账号昵称" value={user.name || "未设置"} />
        <InfoCard label="邮箱" value={user.email} />
        <InfoCard label="服务器" value={API_BASE_URL} />
        <InfoCard label="客户端 ID" value={api.clientId} />
        <InfoCard label="平台" value={getPlatform()} />
        <button onClick={() => void onRefresh()} type="button">
          <span>同步</span>
          <strong>拉取手稿和文档列表</strong>
        </button>
      </div>

      <section className="account-note">
        <h2>安全提示</h2>
        <p>切换账号或登出会清除当前登录令牌并返回登录页。</p>
      </section>
    </section>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function getInitial(value: string) {
  return value.trim().slice(0, 1).toUpperCase() || "M";
}
