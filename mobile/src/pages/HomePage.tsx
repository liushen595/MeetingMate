import { useMemo, useState, type ReactNode } from "react";
import type { DocumentSummary, ManuscriptSummary } from "../types/api";
import { formatRelativeTime } from "../lib/ids";

type MeetingSchedule = {
  id: string;
  title: string;
  address: string;
  startAt: string;
  endAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

type MeetingDraft = {
  id?: string;
  title: string;
  address: string;
  startAt: string;
  endAt: string;
  notes: string;
};

type GroupSummary = {
  id: string;
  name: string;
  inviteCode: string;
  inviteCodeExpiresAt: string;
  memberCount: number;
};

type GroupDocumentMessage = {
  id: string;
  groupId: string;
  senderName: string;
  documentTitle: string;
  sentAt: string;
};

const MEETINGS_KEY = "meetingmate.local.meetings";

const groupApiSpec = [
  "POST /api/v1/groups - 创建组并返回 6 位口令码",
  "POST /api/v1/groups/join - 使用 6 位口令码加入组",
  "GET /api/v1/groups - 获取当前用户加入的组列表",
  "GET /api/v1/groups/{group_id}/messages - 获取组内文档消息",
  "POST /api/v1/groups/{group_id}/documents - 发送库中文档到组",
  "GET /api/v1/groups/{group_id}/documents/{message_id}/download - 下载组内文档",
];

interface HomePageProps {
  manuscripts: ManuscriptSummary[];
  documents: DocumentSummary[];
  loading: boolean;
  onCreateManuscript: (title?: string) => Promise<void>;
  onCreateDocument: () => Promise<void>;
  onOpenManuscript: (id: string) => void;
  onOpenDocument: (id: string) => void;
}

export function HomePage(props: HomePageProps) {
  const [meetings, setMeetings] = useState<MeetingSchedule[]>(() => loadMeetings());
  const [meetingDialog, setMeetingDialog] = useState<MeetingDraft | null>(null);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [messages, setMessages] = useState<GroupDocumentMessage[]>([]);
  const [groupDialog, setGroupDialog] = useState<"create" | "join" | null>(null);
  const [groupName, setGroupName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const latestManuscript = props.manuscripts[0];
  const latestDocument = props.documents[0];
  const nextMeeting = useMemo(() => getNextMeeting(meetings), [meetings]);
  const activeGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0];
  const activeMessages = messages.filter((message) => message.groupId === activeGroup?.id);

  function persistMeetings(nextMeetings: MeetingSchedule[]) {
    const sortedMeetings = [...nextMeetings].sort(sortByStartAt);
    saveMeetings(sortedMeetings);
    setMeetings(sortedMeetings);
  }

  function openNewMeetingDialog() {
    setMeetingDialog({ title: "", address: "", startAt: "", endAt: "", notes: "" });
  }

  function openEditMeetingDialog(meeting: MeetingSchedule) {
    setMeetingDialog({
      id: meeting.id,
      title: meeting.title,
      address: meeting.address,
      startAt: toDatetimeLocal(meeting.startAt),
      endAt: meeting.endAt ? toDatetimeLocal(meeting.endAt) : "",
      notes: meeting.notes ?? "",
    });
  }

  function saveMeetingDraft() {
    if (!meetingDialog?.title.trim() || !meetingDialog.startAt) return;
    const now = new Date().toISOString();
    const meeting: MeetingSchedule = {
      id: meetingDialog.id ?? `meeting-${crypto.randomUUID()}`,
      title: meetingDialog.title.trim(),
      address: meetingDialog.address.trim(),
      startAt: new Date(meetingDialog.startAt).toISOString(),
      endAt: meetingDialog.endAt ? new Date(meetingDialog.endAt).toISOString() : undefined,
      notes: meetingDialog.notes.trim() || undefined,
      createdAt: meetings.find((item) => item.id === meetingDialog.id)?.createdAt ?? now,
      updatedAt: now,
    };
    persistMeetings([meeting, ...meetings.filter((item) => item.id !== meeting.id)]);
    setMeetingDialog(null);
  }

  function deleteMeeting(id: string) {
    persistMeetings(meetings.filter((meeting) => meeting.id !== id));
  }

  async function createManuscriptFromMeeting() {
    if (!nextMeeting) return;
    await props.onCreateManuscript(nextMeeting.title);
  }

  function createGroup() {
    if (!groupName.trim()) return;
    const now = Date.now();
    const group: GroupSummary = {
      id: `group-${crypto.randomUUID()}`,
      name: groupName.trim(),
      inviteCode: String(Math.floor(100000 + Math.random() * 900000)),
      inviteCodeExpiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      memberCount: 1,
    };
    setGroups((current) => [group, ...current]);
    setSelectedGroupId(group.id);
    setGroupName("");
    setGroupDialog(null);
  }

  function joinGroup() {
    if (!/^\d{6}$/.test(inviteCode)) return;
    const group: GroupSummary = {
      id: `group-${crypto.randomUUID()}`,
      name: `口令组 ${inviteCode}`,
      inviteCode,
      inviteCodeExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      memberCount: 2,
    };
    setGroups((current) => [group, ...current]);
    setSelectedGroupId(group.id);
    setInviteCode("");
    setGroupDialog(null);
  }

  function sendDocumentToGroup() {
    const group = groups.find((item) => item.id === activeGroup?.id);
    const document = props.documents.find((item) => item.id === selectedDocumentId);
    if (!group || !document) return;
    setMessages((current) => [
      { id: `msg-${crypto.randomUUID()}`, groupId: group.id, senderName: "我", documentTitle: document.title, sentAt: new Date().toISOString() },
      ...current,
    ]);
    setSelectedDocumentId("");
  }

  return (
    <section className="screen home-screen">
      <header className="hero-card">
        <p className="eyebrow">移动工作台</p>
        <h1>先记录现场，再让 Agent 整理成文档。</h1>
        <p>录音、拍照、手写都进入同一张连续稿纸；转换后的文档保留来源引用，可继续手动编辑或交给 AI 修改。</p>
      </header>

      <div className="quick-grid">
        <button className="quick-card ink" onClick={() => void props.onCreateManuscript()} type="button">
          <span>新建手稿</span>
          <strong>录音 / 图片 / 手写</strong>
        </button>
        <button className="quick-card paper" onClick={() => void props.onCreateDocument()} type="button">
          <span>新建文档</span>
          <strong>块编辑 / Agent 修改</strong>
        </button>
      </div>

      <div className="home-dashboard-grid">
        <section className="home-panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Schedule</p>
              <h2>会议安排</h2>
            </div>
            <button className="primary-small" onClick={openNewMeetingDialog} type="button">编辑会议</button>
          </div>

          {nextMeeting ? (
            <div className="meeting-feature">
              <span>最早开始</span>
              <strong>{nextMeeting.title}</strong>
              <p>时间：{formatDateTime(nextMeeting.startAt)}</p>
              <p>地址：{nextMeeting.address || "未填写"}</p>
              {nextMeeting.notes ? <p>{nextMeeting.notes}</p> : null}
              <div className="meeting-actions">
                <button className="ghost-button" onClick={() => openEditMeetingDialog(nextMeeting)} type="button">修改</button>
                <button className="primary-small" onClick={() => void createManuscriptFromMeeting()} type="button">创建手稿</button>
              </div>
            </div>
          ) : (
            <div className="empty-panel">
              <strong>暂无会议</strong>
              <span>添加会议后，首页只展示最早开始的一场。</span>
              <button className="primary-small" onClick={openNewMeetingDialog} type="button">添加会议</button>
            </div>
          )}

          {meetings.length > 0 ? (
            <div className="compact-list">
              {meetings.slice(0, 4).map((meeting) => (
                <div className="compact-row" key={meeting.id}>
                  <div>
                    <strong>{meeting.title}</strong>
                    <small>{formatDateTime(meeting.startAt)} · {meeting.address || "未填写地址"}</small>
                  </div>
                  <button className="danger-link" onClick={() => deleteMeeting(meeting.id)} type="button">删除</button>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="home-panel">
          <div className="panel-head panel-head-stacked">
            <div>
              <p className="eyebrow">Groups</p>
              <h2>用户组</h2>
              <p className="panel-copy">组功能先提供 UI 原型，服务器 API 待实现。</p>
            </div>
            <div className="panel-actions">
              <button className="primary-small" onClick={() => setGroupDialog("create")} type="button">创建组</button>
              <button className="ghost-button" onClick={() => setGroupDialog("join")} type="button">加入组</button>
            </div>
          </div>

          {groups.length === 0 ? (
            <div className="empty-panel groups-empty">
              <span>还没有组。创建组会生成 6 位数字口令码，有效期一天。</span>
            </div>
          ) : (
            <div className="group-layout">
              <div className="group-tabs">
                {groups.map((group) => (
                  <button className={group.id === activeGroup?.id ? "group-tab active" : "group-tab"} key={group.id} onClick={() => setSelectedGroupId(group.id)} type="button">
                    <strong>{group.name}</strong>
                    <small>{group.memberCount} 人 · {group.inviteCode}</small>
                  </button>
                ))}
              </div>
              {activeGroup ? (
                <div className="group-detail">
                  <h3>{activeGroup.name}</h3>
                  <p>口令 {activeGroup.inviteCode}，有效期至 {formatDateTime(activeGroup.inviteCodeExpiresAt)}</p>
                  <div className="document-send-row">
                    <select onChange={(event) => setSelectedDocumentId(event.target.value)} value={selectedDocumentId}>
                      <option value="">选择库中文档</option>
                      {props.documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}
                    </select>
                    <button className="primary-small" disabled={!selectedDocumentId} onClick={sendDocumentToGroup} type="button">发送</button>
                  </div>
                  <div className="message-stack">
                    {activeMessages.length === 0 ? <div className="message-empty">暂无文档消息。</div> : null}
                    {activeMessages.map((message) => (
                      <div className="message-row" key={message.id}>
                        <div>
                          <strong>{message.documentTitle}</strong>
                          <small>{message.senderName} · {formatDateTime(message.sentAt)}</small>
                        </div>
                        <button className="ghost-button" type="button">下载</button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>

      <section className="home-panel api-spec-panel">
        <h2>组功能 API 规范草案</h2>
        <div className="api-spec-grid">
          {groupApiSpec.map((item) => <code className="api-code" key={item}>{item}</code>)}
        </div>
      </section>

      <div className="section-title-row">
        <h2>最近继续</h2>
        {props.loading && <span>同步中</span>}
      </div>
      <div className="recent-stack">
        {latestManuscript && (
          <button className="library-card" onClick={() => props.onOpenManuscript(latestManuscript.id)} type="button">
            <span className="card-kind">手稿</span>
            <strong>{latestManuscript.title}</strong>
            <small>{formatRelativeTime(latestManuscript.updated_at)}</small>
          </button>
        )}
        {latestDocument && (
          <button className="library-card document" onClick={() => props.onOpenDocument(latestDocument.id)} type="button">
            <span className="card-kind">文档</span>
            <strong>{latestDocument.title}</strong>
            <small>{formatRelativeTime(latestDocument.updated_at)}</small>
          </button>
        )}
        {!latestManuscript && !latestDocument && <p className="empty-state">还没有内容。先创建一份手稿，录入现场素材。</p>}
      </div>

      {meetingDialog ? (
        <MobileDialog title={meetingDialog.id ? "编辑会议" : "新增会议"} onClose={() => setMeetingDialog(null)}>
          <input onChange={(event) => setMeetingDialog({ ...meetingDialog, title: event.target.value })} placeholder="会议名称" value={meetingDialog.title} />
          <input onChange={(event) => setMeetingDialog({ ...meetingDialog, address: event.target.value })} placeholder="会议地址" value={meetingDialog.address} />
          <input onChange={(event) => setMeetingDialog({ ...meetingDialog, startAt: event.target.value })} type="datetime-local" value={meetingDialog.startAt} />
          <input onChange={(event) => setMeetingDialog({ ...meetingDialog, endAt: event.target.value })} type="datetime-local" value={meetingDialog.endAt} />
          <textarea onChange={(event) => setMeetingDialog({ ...meetingDialog, notes: event.target.value })} placeholder="备注" value={meetingDialog.notes} />
          <button className="primary-button" disabled={!meetingDialog.title.trim() || !meetingDialog.startAt} onClick={saveMeetingDraft} type="button">保存</button>
        </MobileDialog>
      ) : null}

      {groupDialog ? (
        <MobileDialog title={groupDialog === "create" ? "创建组" : "加入组"} onClose={() => setGroupDialog(null)}>
          {groupDialog === "create" ? (
            <>
              <input onChange={(event) => setGroupName(event.target.value)} placeholder="组名称" value={groupName} />
              <button className="primary-button" disabled={!groupName.trim()} onClick={createGroup} type="button">创建并生成口令</button>
            </>
          ) : (
            <>
              <input inputMode="numeric" maxLength={6} onChange={(event) => setInviteCode(event.target.value.replace(/\D/g, ""))} placeholder="6 位数字口令" value={inviteCode} />
              <button className="primary-button" disabled={!/^\d{6}$/.test(inviteCode)} onClick={joinGroup} type="button">加入组</button>
            </>
          )}
        </MobileDialog>
      ) : null}
    </section>
  );
}

function MobileDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="mobile-dialog-backdrop" onClick={onClose}>
      <div className="mobile-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="mobile-dialog-head">
          <h3>{title}</h3>
          <button className="dialog-close" onClick={onClose} type="button">关闭</button>
        </div>
        <div className="mobile-form">{children}</div>
      </div>
    </div>
  );
}

function loadMeetings(): MeetingSchedule[] {
  const raw = localStorage.getItem(MEETINGS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as MeetingSchedule[];
    return Array.isArray(parsed) ? parsed.filter(isMeetingSchedule).sort(sortByStartAt) : [];
  } catch {
    return [];
  }
}

function saveMeetings(meetings: MeetingSchedule[]) {
  localStorage.setItem(MEETINGS_KEY, JSON.stringify(meetings));
}

function getNextMeeting(meetings: MeetingSchedule[]) {
  const now = Date.now();
  return meetings.filter((meeting) => new Date(meeting.startAt).getTime() >= now).sort(sortByStartAt)[0] ?? null;
}

function sortByStartAt(a: MeetingSchedule, b: MeetingSchedule) {
  return new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
}

function isMeetingSchedule(value: unknown): value is MeetingSchedule {
  if (!value || typeof value !== "object") return false;
  const meeting = value as Partial<MeetingSchedule>;
  return typeof meeting.id === "string" && typeof meeting.title === "string" && typeof meeting.address === "string" && typeof meeting.startAt === "string";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function toDatetimeLocal(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
