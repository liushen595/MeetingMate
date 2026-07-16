import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "../lib/api";
import type { DocumentSummary, GroupDocumentMessage, GroupSummary, ManuscriptSummary } from "../types/api";
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

const MEETINGS_KEY = "meetingmate.local.meetings";

const collaborationHighlights = [
  "6 位口令邀请，有效期一天",
  "库中文档按发送时快照共享",
  "组内成员可下载 DOCX 文档",
  "保留原文档，不影响个人库编辑",
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
  const [groupLoading, setGroupLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);
  const [groupAction, setGroupAction] = useState<"create" | "join" | "send" | "download" | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const latestManuscript = props.manuscripts[0];
  const latestDocument = props.documents[0];
  const nextMeeting = useMemo(() => getNextMeeting(meetings), [meetings]);
  const activeGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0];
  const activeMessages = messages.filter((message) => message.groupId === activeGroup?.id);

  useEffect(() => {
    let cancelled = false;

    async function loadGroups() {
      setGroupLoading(true);
      setGroupError(null);
      try {
        const nextGroups = await api.listGroups();
        if (cancelled) return;
        setGroups(nextGroups);
        setSelectedGroupId((current) => nextGroups.some((group) => group.id === current) ? current : nextGroups[0]?.id || "");
      } catch (error) {
        if (!cancelled) setGroupError(errorMessage(error, "组列表加载失败"));
      } finally {
        if (!cancelled) setGroupLoading(false);
      }
    }

    void loadGroups();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeGroup) {
      setMessages([]);
      return;
    }
    let cancelled = false;

    async function loadMessages() {
      setMessageLoading(true);
      setGroupError(null);
      try {
        const nextMessages = await api.listGroupMessages(activeGroup.id);
        if (cancelled) return;
        setMessages((current) => [...current.filter((message) => message.groupId !== activeGroup.id), ...nextMessages]);
      } catch (error) {
        if (!cancelled) setGroupError(errorMessage(error, "组消息加载失败"));
      } finally {
        if (!cancelled) setMessageLoading(false);
      }
    }

    void loadMessages();
    return () => {
      cancelled = true;
    };
  }, [activeGroup?.id]);

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

  async function createGroup() {
    if (!groupName.trim()) return;
    setGroupAction("create");
    setGroupError(null);
    try {
      const group = await api.createGroup(groupName.trim());
      setGroups((current) => [group, ...current.filter((item) => item.id !== group.id)]);
      setSelectedGroupId(group.id);
      setGroupName("");
      setGroupDialog(null);
    } catch (error) {
      setGroupError(errorMessage(error, "创建组失败"));
    } finally {
      setGroupAction(null);
    }
  }

  async function joinGroup() {
    if (!/^\d{6}$/.test(inviteCode)) return;
    setGroupAction("join");
    setGroupError(null);
    try {
      const group = await api.joinGroup(inviteCode);
      setGroups((current) => [group, ...current.filter((item) => item.id !== group.id)]);
      setSelectedGroupId(group.id);
      setInviteCode("");
      setGroupDialog(null);
    } catch (error) {
      setGroupError(errorMessage(error, "加入组失败", { 404: "口令不存在", 403: "口令已过期" }));
    } finally {
      setGroupAction(null);
    }
  }

  async function sendDocumentToGroup() {
    if (!activeGroup || !selectedDocumentId) return;
    setGroupAction("send");
    setGroupError(null);
    try {
      const message = await api.sendDocumentToGroup(activeGroup.id, selectedDocumentId);
      setMessages((current) => [message, ...current.filter((item) => item.id !== message.id)]);
      setSelectedDocumentId("");
    } catch (error) {
      setGroupError(errorMessage(error, "发送文档失败"));
    } finally {
      setGroupAction(null);
    }
  }

  async function downloadGroupDocument(message: GroupDocumentMessage) {
    if (!activeGroup) return;
    setGroupAction("download");
    setGroupError(null);
    try {
      const blob = await api.downloadGroupDocument(activeGroup.id, message.id, "docx");
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, "_blank");
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) {
      setGroupError(errorMessage(error, "下载失败", { 403: "你不是该组成员或登录已过期" }));
    } finally {
      setGroupAction(null);
    }
  }

  return (
    <section className="screen home-screen">
      <header className="hero-card home-hero">
        <div className="hero-status-row">
          <p className="eyebrow">MeetingMate Mobile</p>
          <span>{props.loading ? "同步中" : "已连接工作区"}</span>
        </div>
        <h1>现场素材，直接沉淀成可编辑文档。</h1>
        <p>录音、图片、手写和文字进入同一份手稿，由云端 ASR、图片识别和 Agent 整理成保留来源引用的正式文档。</p>
        <div className="hero-metrics" aria-label="工作区概览">
          <div>
            <strong>{props.manuscripts.length}</strong>
            <span>手稿</span>
          </div>
          <div>
            <strong>{props.documents.length}</strong>
            <span>文档</span>
          </div>
          <div>
            <strong>{groups.length}</strong>
            <span>协作组</span>
          </div>
        </div>
      </header>

      <div className="quick-grid">
        <button className="quick-card ink" onClick={() => void props.onCreateManuscript()} type="button">
          <span>开始采集</span>
          <strong>新建现场手稿</strong>
          <small>录音、拍照、手写都放进一张连续稿纸</small>
        </button>
        <button className="quick-card paper" onClick={() => void props.onCreateDocument()} type="button">
          <span>开始整理</span>
          <strong>新建正式文档</strong>
          <small>块编辑、AI 润色、摘要和续写</small>
        </button>
      </div>

      <section className="home-workflow" aria-label="核心服务流程">
        <div>
          <span>01</span>
          <strong>采集</strong>
          <small>音频 / 图片 / 手写</small>
        </div>
        <div>
          <span>02</span>
          <strong>识别</strong>
          <small>ASR / 图片理解 / 手写识别</small>
        </div>
        <div>
          <span>03</span>
          <strong>成文</strong>
          <small>Agent 整理 / 引用保留</small>
        </div>
      </section>

      <div className="section-title-row home-section-row">
        <h2>最近继续</h2>
        {props.loading && <span>同步中</span>}
      </div>
      <div className="recent-stack home-recent-stack">
        {latestManuscript && (
          <button className="library-card home-recent-card" onClick={() => props.onOpenManuscript(latestManuscript.id)} type="button">
            <span className="card-kind">最近手稿</span>
            <strong>{latestManuscript.title}</strong>
            <small>{formatRelativeTime(latestManuscript.updated_at)}</small>
          </button>
        )}
        {latestDocument && (
          <button className="library-card document home-recent-card" onClick={() => props.onOpenDocument(latestDocument.id)} type="button">
            <span className="card-kind">最近文档</span>
            <strong>{latestDocument.title}</strong>
            <small>{formatRelativeTime(latestDocument.updated_at)}</small>
          </button>
        )}
        {!latestManuscript && !latestDocument && <p className="empty-state home-empty-state">还没有内容。先创建一份手稿，录入现场素材。</p>}
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
              <p className="panel-copy">创建或加入组后，可把文档快照发送给组成员。</p>
            </div>
            <div className="panel-actions">
              <button className="primary-small" onClick={() => setGroupDialog("create")} type="button">创建组</button>
              <button className="ghost-button" onClick={() => setGroupDialog("join")} type="button">加入组</button>
            </div>
          </div>

          {groupError ? <button className="toast inline" onClick={() => setGroupError(null)} type="button">{groupError}</button> : null}
          {groupLoading ? <div className="empty-panel groups-empty"><span>正在加载组列表...</span></div> : groups.length === 0 ? (
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
                    <button className="primary-small" disabled={!selectedDocumentId || !activeGroup || groupAction === "send"} onClick={() => void sendDocumentToGroup()} type="button">
                      {groupAction === "send" ? "发送中" : "发送"}
                    </button>
                  </div>
                  <div className="message-stack">
                    {messageLoading ? <div className="message-empty">正在加载文档消息...</div> : null}
                    {!messageLoading && activeMessages.length === 0 ? <div className="message-empty">暂无文档消息。</div> : null}
                    {activeMessages.map((message) => (
                      <div className="message-row" key={message.id}>
                        <div>
                          <strong>{message.documentTitle}</strong>
                          <small>{displaySenderName(message.senderName)} · {formatDateTime(message.sentAt)}</small>
                        </div>
                        <button className="ghost-button" disabled={groupAction === "download"} onClick={() => void downloadGroupDocument(message)} type="button">下载</button>
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
        <p className="eyebrow">Collaboration Scope</p>
        <h2>组协作覆盖范围</h2>
        <p className="panel-copy">把整理后的文档以快照形式发给成员，适合会后纪要、资料分发和小组复盘。</p>
        <div className="api-spec-grid">
          {collaborationHighlights.map((item) => <span className="api-code" key={item}>{item}</span>)}
        </div>
      </section>

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
          {groupError ? <p className="form-error">{groupError}</p> : null}
          {groupDialog === "create" ? (
            <>
              <input onChange={(event) => setGroupName(event.target.value)} placeholder="组名称" value={groupName} />
              <button className="primary-button" disabled={!groupName.trim() || groupAction === "create"} onClick={() => void createGroup()} type="button">
                {groupAction === "create" ? "创建中" : "创建并生成口令"}
              </button>
            </>
          ) : (
            <>
              <input inputMode="numeric" maxLength={6} onChange={(event) => setInviteCode(event.target.value.replace(/\D/g, ""))} placeholder="6 位数字口令" value={inviteCode} />
              <button className="primary-button" disabled={!/^\d{6}$/.test(inviteCode) || groupAction === "join"} onClick={() => void joinGroup()} type="button">
                {groupAction === "join" ? "加入中" : "加入组"}
              </button>
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

function displaySenderName(senderName: string) {
  return senderName === api.currentSession?.user.name ? "我" : senderName;
}

function errorMessage(error: unknown, fallback: string, statusMessages: Record<number, string> = {}) {
  if (error instanceof ApiError && statusMessages[error.status]) return statusMessages[error.status];
  return error instanceof Error ? error.message : fallback;
}
