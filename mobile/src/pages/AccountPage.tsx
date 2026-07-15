import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { User } from "../types/api";
import { API_BASE_URL, api } from "../lib/api";
import { getPlatform } from "../lib/device";

type Profile = {
  name: string;
  company: string;
  address: string;
  department: string;
  position: string;
  phone: string;
  avatarDataUrl: string;
};

export function AccountPage({ user, onLogout, onRefresh }: { user: User; onLogout: () => void; onRefresh: () => Promise<void> }) {
  const profileKey = useMemo(() => `meetingmate.profile.${user.id || user.email}`, [user]);
  const [profile, setProfile] = useState<Profile>(() => readProfile(profileKey, user.name || ""));
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setProfile(readProfile(profileKey, user.name || ""));
  }, [profileKey, user.name]);

  async function logout() {
    try {
      await api.logout();
    } catch {
      api.setSession(null);
    } finally {
      onLogout();
    }
  }

  function updateProfile(next: Profile) {
    setProfile(next);
    localStorage.setItem(profileKey, JSON.stringify(next));
  }

  function updateProfileField(field: keyof Omit<Profile, "avatarDataUrl">, value: string) {
    updateProfile({ ...profile, [field]: value });
  }

  function uploadAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => updateProfile({ ...profile, avatarDataUrl: typeof reader.result === "string" ? reader.result : "" });
    reader.readAsDataURL(file);
  }

  return (
    <section className="screen account-screen">
      <header className="profile-card">
        <input accept="image/*" hidden onChange={uploadAvatar} ref={avatarInputRef} type="file" />
        <button className="avatar avatar-button" onClick={() => avatarInputRef.current?.click()} type="button">
          {profile.avatarDataUrl ? <img alt="头像" src={profile.avatarDataUrl} /> : getInitial(profile.name || user.email)}
        </button>
        <div>
          <p className="eyebrow">Account</p>
          <h1>{profile.name || "未设置姓名"}</h1>
          <p>{user.email}</p>
          <small>点击头像上传新图片</small>
        </div>
      </header>
      <div className="account-actions">
        <button className="ghost-button" onClick={() => void logout()} type="button">切换账号</button>
        <button className="danger-button" onClick={() => void logout()} type="button">登出</button>
      </div>

      <div className="settings-list account-info-grid">
        <ProfileInput label="姓名" onChange={(value) => updateProfileField("name", value)} value={profile.name} />
        <ProfileInput label="公司" onChange={(value) => updateProfileField("company", value)} value={profile.company} />
        <ProfileInput label="地址" onChange={(value) => updateProfileField("address", value)} value={profile.address} />
        <ProfileInput label="部门" onChange={(value) => updateProfileField("department", value)} value={profile.department} />
        <ProfileInput label="职位" onChange={(value) => updateProfileField("position", value)} value={profile.position} />
        <ProfileInput label="电话" onChange={(value) => updateProfileField("phone", value)} value={profile.phone} />
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

function ProfileInput({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return (
    <label>
      <span>{label}</span>
      <input onChange={(event) => onChange(event.target.value)} placeholder={`填写${label}`} value={value} />
    </label>
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

function readProfile(key: string, fallbackName: string): Profile {
  const fallback: Profile = { name: fallbackName, company: "", address: "", department: "", position: "", phone: "", avatarDataUrl: "" };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) || "{}") };
  } catch {
    return fallback;
  }
}
