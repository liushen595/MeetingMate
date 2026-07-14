import type { User } from "../types/api";
import { api } from "../lib/api";
import { getClientId, getPlatform } from "../lib/device";

export function AccountPage({ user, onLogout, onRefresh }: { user: User; onLogout: () => void; onRefresh: () => Promise<void> }) {
  async function logout() {
    await api.logout();
    onLogout();
  }

  return (
    <section className="screen account-screen">
      <header className="profile-card">
        <div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div>
        <div>
          <p className="eyebrow">账户</p>
          <h1>{user.name}</h1>
          <p>{user.email}</p>
        </div>
      </header>
      <div className="settings-list">
        <div>
          <span>当前设备</span>
          <strong>{getClientId()}</strong>
        </div>
        <div>
          <span>平台</span>
          <strong>{getPlatform()}</strong>
        </div>
        <button onClick={onRefresh} type="button">
          <span>同步</span>
          <strong>拉取手稿和文档列表</strong>
        </button>
        <button className="danger" onClick={logout} type="button">
          <span>退出登录</span>
          <strong>吊销当前设备 Token</strong>
        </button>
      </div>
    </section>
  );
}
