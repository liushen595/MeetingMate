import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, pcApi } from "../lib/api";
import { getNextMeeting, loadMeetings, saveMeetings } from "../lib/localMeetings";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { MeetingSchedule } from "../types/meeting";
import type { GroupDocumentMessage, GroupSummary } from "../types/group";

type MeetingDraft = {
  id?: string;
  title: string;
  address: string;
  startAt: string;
  endAt: string;
  notes: string;
};

export function HomePanel(): React.JSX.Element {
  const addDocument = useWorkspaceStore((state) => state.addDocument);
  const addManuscript = useWorkspaceStore((state) => state.addManuscript);
  const isHydrated = useWorkspaceStore((state) => state.isHydrated);
  const manuscripts = useWorkspaceStore((state) => state.manuscripts);
  const openDocumentEditor = useWorkspaceStore((state) => state.openDocumentEditor);
  const openManuscriptEditor = useWorkspaceStore((state) => state.openManuscriptEditor);
  const documents = useWorkspaceStore((state) => state.documents);
  const [meetings, setMeetings] = useState<MeetingSchedule[]>(() => loadMeetings());
  const [meetingDialog, setMeetingDialog] = useState<MeetingDraft | null>(null);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [messages, setMessages] = useState<GroupDocumentMessage[]>([]);
  const [groupDialog, setGroupDialog] = useState<"create" | "join" | null>(null);
  const [groupName, setGroupName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isSubmittingGroup, setIsSubmittingGroup] = useState(false);
  const [isSendingDocument, setIsSendingDocument] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const latestManuscript = manuscripts[0];
  const latestDocument = documents[0];
  const nextMeeting = useMemo(() => getNextMeeting(meetings), [meetings]);

  useEffect(() => {
    let active = true;
    setIsLoadingGroups(true);
    pcApi
      .listGroups()
      .then((items) => {
        if (!active) return;
        setGroups(items);
        setSelectedGroupId((current) => current || items[0]?.id || "");
        setGroupError(null);
      })
      .catch((error) => {
        if (active) setGroupError(error instanceof Error ? error.message : "组列表加载失败");
      })
      .finally(() => {
        if (active) setIsLoadingGroups(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedGroupId) {
      setMessages([]);
      return;
    }
    let active = true;
    setIsLoadingMessages(true);
    pcApi
      .listGroupMessages(selectedGroupId)
      .then((items) => {
        if (!active) return;
        setMessages(items);
        setGroupError(null);
      })
      .catch((error) => {
        if (active) setGroupError(error instanceof Error ? error.message : "组消息加载失败");
      })
      .finally(() => {
        if (active) setIsLoadingMessages(false);
      });
    return () => {
      active = false;
    };
  }, [selectedGroupId]);

  function persistMeetings(nextMeetings: MeetingSchedule[]): void {
    saveMeetings(nextMeetings);
    setMeetings([...nextMeetings]);
  }

  function openNewMeetingDialog(): void {
    setMeetingDialog({ title: "", address: "", startAt: "", endAt: "", notes: "" });
  }

  function openEditMeetingDialog(meeting: MeetingSchedule): void {
    setMeetingDialog({ id: meeting.id, title: meeting.title, address: meeting.address, startAt: toDatetimeLocal(meeting.startAt), endAt: meeting.endAt ? toDatetimeLocal(meeting.endAt) : "", notes: meeting.notes ?? "" });
  }

  function saveMeetingDraft(): void {
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
      updatedAt: now
    };
    persistMeetings([meeting, ...meetings.filter((item) => item.id !== meeting.id)]);
    setMeetingDialog(null);
  }

  function deleteMeeting(id: string): void {
    persistMeetings(meetings.filter((meeting) => meeting.id !== id));
  }

  async function createManuscriptFromMeeting(): Promise<void> {
    if (!nextMeeting) return;
    const manuscript = await pcApi.createManuscript(nextMeeting.title);
    addManuscript(manuscript);
    openManuscriptEditor(manuscript.id);
  }

  async function createManuscript(): Promise<void> {
    const manuscript = await pcApi.createManuscript("未命名手稿");
    addManuscript(manuscript);
    openManuscriptEditor(manuscript.id);
  }

  async function createDocument(): Promise<void> {
    const document = await pcApi.createDocument("未命名文档");
    addDocument(document);
    openDocumentEditor(document.id);
  }

  async function createGroup(): Promise<void> {
    if (!groupName.trim()) return;
    try {
      setIsSubmittingGroup(true);
      const group = await pcApi.createGroup(groupName.trim());
      setGroups((current) => [group, ...current.filter((item) => item.id !== group.id)]);
      setSelectedGroupId(group.id);
      setGroupName("");
      setGroupDialog(null);
      setGroupError(null);
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : "创建组失败");
    } finally {
      setIsSubmittingGroup(false);
    }
  }

  async function joinGroup(): Promise<void> {
    if (!/^\d{6}$/.test(inviteCode)) return;
    try {
      setIsSubmittingGroup(true);
      const group = await pcApi.joinGroup(inviteCode);
      setGroups((current) => [group, ...current.filter((item) => item.id !== group.id)]);
      setSelectedGroupId(group.id);
      setInviteCode("");
      setGroupDialog(null);
      setGroupError(null);
    } catch (error) {
      setGroupError(groupJoinErrorMessage(error));
    } finally {
      setIsSubmittingGroup(false);
    }
  }

  async function sendDocumentToGroup(): Promise<void> {
    if (!activeGroup || !selectedDocumentId) return;
    try {
      setIsSendingDocument(true);
      const message = await pcApi.sendDocumentToGroup(activeGroup.id, selectedDocumentId);
      setMessages((current) => [message, ...current.filter((item) => item.id !== message.id)]);
      setSelectedDocumentId("");
      setGroupError(null);
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : "发送文档失败");
    } finally {
      setIsSendingDocument(false);
    }
  }

  async function downloadGroupDocument(message: GroupDocumentMessage): Promise<void> {
    try {
      const blob = await pcApi.downloadGroupDocument(message.groupId, message.id, "docx");
      const filename = `${safeFilename(message.documentTitle)}.docx`;
      if (window.meetingMate?.saveBlobFile) {
        await window.meetingMate.saveBlobFile({ filename, data: await blob.arrayBuffer() });
      } else {
        downloadBlobInBrowser(blob, filename);
      }
      setGroupError(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setGroupError("你不是该组成员或登录已过期");
        return;
      }
      setGroupError(error instanceof Error ? error.message : "下载文档失败");
    }
  }

  const activeGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0];
  const activeMessages = messages.filter((message) => message.groupId === activeGroup?.id);

  return (
    <section className="pc-home-screen pc-warm-gradient min-h-0 flex-1 overflow-auto px-6 py-5">
      <div className="pc-home-stack mx-auto max-w-6xl">
        <header className="pc-home-hero">
          <div className="pc-hero-status-row">
            <p className="pc-eyebrow">MeetingMate Mobile</p>
            <span>{isHydrated ? "已连接工作区" : "同步中"}</span>
          </div>
          <h2>现场素材，直接沉淀成可编辑文档。</h2>
          <p>录音、图片、手写和文字进入同一份手稿，由云端 ASR、图片识别和 Agent 整理成保留来源引用的正式文档。</p>
          <div className="pc-hero-metrics" aria-label="工作区概览">
            <div>
              <strong>{manuscripts.length}</strong>
              <span>手稿</span>
            </div>
            <div>
              <strong>{documents.length}</strong>
              <span>文档</span>
            </div>
            <div>
              <strong>{groups.length}</strong>
              <span>协作组</span>
            </div>
          </div>
        </header>

        <div className="pc-home-dashboard-grid pc-home-priority-grid">
          <section className="pc-home-panel">
            <div className="pc-panel-head">
              <div>
                <p className="pc-eyebrow">Schedule</p>
                <h3>会议安排</h3>
              </div>
              <button className="pc-primary-small" onClick={openNewMeetingDialog} type="button">编辑会议</button>
            </div>

            {nextMeeting ? (
              <div className="pc-meeting-feature">
                <div className="pc-meeting-feature-content">
                  <div>
                    <span>最早开始</span>
                    <strong>{nextMeeting.title}</strong>
                    <p>时间：{formatDateTime(nextMeeting.startAt)}</p>
                    <p>地址：{nextMeeting.address || "未填写"}</p>
                    {nextMeeting.notes ? <p>{nextMeeting.notes}</p> : null}
                  </div>
                  <div className="pc-meeting-actions">
                    <button className="pc-ghost-button" onClick={() => openEditMeetingDialog(nextMeeting)} type="button">修改</button>
                    <button className="pc-primary-small" onClick={() => void createManuscriptFromMeeting()} type="button">创建手稿</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="pc-empty-panel">
                <strong>暂无会议</strong>
                <span>添加会议后，首页只展示最早开始的一场。</span>
                <button className="pc-primary-small" onClick={openNewMeetingDialog} type="button">添加会议</button>
              </div>
            )}

            {meetings.length > 0 ? (
              <div className="pc-compact-list">
                {meetings.slice(0, 4).map((meeting) => (
                  <div className="pc-compact-row" key={meeting.id}>
                    <div>
                      <strong>{meeting.title}</strong>
                      <small>{formatDateTime(meeting.startAt)} · {meeting.address || "未填写地址"}</small>
                    </div>
                    <button className="pc-danger-link" onClick={() => deleteMeeting(meeting.id)} type="button">删除</button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="pc-home-panel">
            <div className="pc-panel-head pc-panel-head-stacked">
              <div>
                <p className="pc-eyebrow">Groups</p>
                <h3>用户组</h3>
                <p className="pc-panel-copy">创建或加入组后，可把文档快照发送给组成员。</p>
              </div>
              <div className="pc-panel-actions">
                <button className="pc-primary-small" disabled={isSubmittingGroup} onClick={() => setGroupDialog("create")} type="button">创建组</button>
                <button className="pc-ghost-button" disabled={isSubmittingGroup} onClick={() => setGroupDialog("join")} type="button">加入组</button>
              </div>
            </div>

            {groupError ? <button className="pc-toast-inline" onClick={() => setGroupError(null)} type="button">{groupError}</button> : null}

            {isLoadingGroups ? (
              <div className="pc-empty-panel pc-groups-empty"><span>正在加载组列表...</span></div>
            ) : groups.length === 0 ? (
              <div className="pc-empty-panel pc-groups-empty"><span>还没有组。创建组会生成 6 位数字口令码，有效期一天。</span></div>
            ) : (
              <div className="pc-group-layout">
                <div className="pc-group-tabs">
                  {groups.map((group) => (
                    <button className={group.id === activeGroup?.id ? "pc-group-tab active" : "pc-group-tab"} key={group.id} onClick={() => setSelectedGroupId(group.id)} type="button">
                      <strong>{group.name}</strong>
                      <small>{group.memberCount} 人 · {group.inviteCode}</small>
                    </button>
                  ))}
                </div>
                {activeGroup ? (
                  <div className="pc-group-detail">
                    <h4>{activeGroup.name}</h4>
                    <p>口令 {activeGroup.inviteCode}，有效期至 {formatDateTime(activeGroup.inviteCodeExpiresAt)}</p>
                    <div className="pc-document-send-row">
                      <select onChange={(event) => setSelectedDocumentId(event.target.value)} value={selectedDocumentId}>
                        <option value="">选择库中文档</option>
                        {documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}
                      </select>
                      <button className="pc-primary-small" disabled={!selectedDocumentId || !activeGroup || isSendingDocument} onClick={() => void sendDocumentToGroup()} type="button">{isSendingDocument ? "发送中" : "发送"}</button>
                    </div>
                    <div className="pc-message-stack">
                      {isLoadingMessages ? <div className="pc-message-empty">正在加载文档消息...</div> : null}
                      {!isLoadingMessages && activeMessages.length === 0 ? <div className="pc-message-empty">暂无文档消息。</div> : null}
                      {activeMessages.map((message) => (
                        <div className="pc-message-row" key={message.id}>
                          <div>
                            <strong>{message.documentTitle}</strong>
                            <small>{displaySenderName(message.senderName)} · {formatDateTime(message.sentAt)}</small>
                          </div>
                          <button className="pc-ghost-button" onClick={() => void downloadGroupDocument(message)} type="button">下载</button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>

        <div className="pc-quick-grid">
          <button className="pc-quick-card ink" onClick={() => void createManuscript()} type="button">
            <span>开始采集</span>
            <strong>新建现场手稿</strong>
            <small>录音、拍照、手写都放进一张连续稿纸</small>
          </button>
          <button className="pc-quick-card paper" onClick={() => void createDocument()} type="button">
            <span>开始整理</span>
            <strong>新建正式文档</strong>
            <small>块编辑、AI 润色、摘要和续写</small>
          </button>
        </div>

        <section className="pc-home-workflow" aria-label="核心服务流程">
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

        <div className="pc-home-section-row">
          <h3>最近继续</h3>
          {!isHydrated && <span>同步中</span>}
        </div>
        <div className="pc-home-recent-stack">
          {latestManuscript ? (
            <button className="pc-home-recent-card" onClick={() => openManuscriptEditor(latestManuscript.id)} type="button">
              <span className="card-kind">最近手稿</span>
              <strong>{latestManuscript.title}</strong>
              <small>{formatRelativeTime(latestManuscript.updatedAt)}</small>
            </button>
          ) : null}
          {latestDocument ? (
            <button className="pc-home-recent-card document" onClick={() => openDocumentEditor(latestDocument.id)} type="button">
              <span className="card-kind">最近文档</span>
              <strong>{latestDocument.title}</strong>
              <small>{formatRelativeTime(latestDocument.updatedAt)}</small>
            </button>
          ) : null}
          {!latestManuscript && !latestDocument ? <p className="pc-home-empty-state">还没有内容。先创建一份手稿，录入现场素材。</p> : null}
        </div>

      </div>

      {meetingDialog ? (
        <Dialog title={meetingDialog.id ? "编辑会议" : "新增会议"} onClose={() => setMeetingDialog(null)}>
          <input className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none" onChange={(event) => setMeetingDialog({ ...meetingDialog, title: event.target.value })} placeholder="会议名称" value={meetingDialog.title} />
          <input className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none" onChange={(event) => setMeetingDialog({ ...meetingDialog, address: event.target.value })} placeholder="会议地址" value={meetingDialog.address} />
          <input className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none" onChange={(event) => setMeetingDialog({ ...meetingDialog, startAt: event.target.value })} type="datetime-local" value={meetingDialog.startAt} />
          <input className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none" onChange={(event) => setMeetingDialog({ ...meetingDialog, endAt: event.target.value })} type="datetime-local" value={meetingDialog.endAt} />
          <textarea className="min-h-24 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none" onChange={(event) => setMeetingDialog({ ...meetingDialog, notes: event.target.value })} placeholder="备注" value={meetingDialog.notes} />
          <button className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!meetingDialog.title.trim() || !meetingDialog.startAt} onClick={saveMeetingDraft} type="button">保存</button>
        </Dialog>
      ) : null}

      {groupDialog ? (
        <Dialog title={groupDialog === "create" ? "创建组" : "加入组"} onClose={() => setGroupDialog(null)}>
          {groupDialog === "create" ? (
            <>
              <input className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none" onChange={(event) => setGroupName(event.target.value)} placeholder="组名称" value={groupName} />
              <button className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!groupName.trim() || isSubmittingGroup} onClick={() => void createGroup()} type="button">{isSubmittingGroup ? "创建中" : "创建并生成口令"}</button>
            </>
          ) : (
            <>
              <input className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none" maxLength={6} onChange={(event) => setInviteCode(event.target.value.replace(/\D/g, ""))} placeholder="6 位数字口令" value={inviteCode} />
              <button className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!/^\d{6}$/.test(inviteCode) || isSubmittingGroup} onClick={() => void joinGroup()} type="button">{isSubmittingGroup ? "加入中" : "加入组"}</button>
            </>
          )}
        </Dialog>
      ) : null}
    </section>
  );
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/20" onClick={onClose}>
      <div className="grid w-full max-w-md gap-3 rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-950">{title}</h3>
          <button className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100" onClick={onClose} type="button">关闭</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;
  const diffMs = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "刚刚";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} 分钟前`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)} 小时前`;
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(timestamp));
}

function displaySenderName(senderName: string): string {
  return senderName === pcApi.currentSession?.user.name ? "我" : senderName;
}

function groupJoinErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return "口令不存在";
    if (error.status === 403) return "口令已过期";
  }
  return error instanceof Error ? error.message : "加入组失败";
}

function safeFilename(value: string): string {
  return (value.trim() || "组内文档").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function downloadBlobInBrowser(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toDatetimeLocal(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
