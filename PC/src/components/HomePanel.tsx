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
  const addManuscript = useWorkspaceStore((state) => state.addManuscript);
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
    <section className="pc-warm-gradient min-h-0 flex-1 overflow-auto p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="pc-warm-panel rounded-3xl border border-slate-200 p-8 shadow-sm">
          <div className="text-xs uppercase tracking-[0.2em] text-blue-500">MeetingMate PC</div>
          <h2 className="mt-3 text-3xl font-bold text-slate-950">从手稿到文档的 AI 工作流</h2>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-500">在库中新建或打开手稿，采集文字、手写、语音和图片，再转换为富文本文档进行 Agent 辅助编辑。</p>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.95fr)]">
          <div className="pc-warm-panel rounded-3xl border border-slate-200 p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-emerald-500">Schedule</div>
                <h3 className="mt-2 text-xl font-semibold text-slate-950">会议安排</h3>
              </div>
              <button className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700" onClick={openNewMeetingDialog} type="button">编辑会议</button>
            </div>

            {nextMeeting ? (
              <div className="mt-6 rounded-2xl border border-emerald-100 bg-emerald-50 p-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="text-sm font-semibold text-emerald-900">最早开始</div>
                    <h4 className="mt-2 text-2xl font-bold text-slate-950">{nextMeeting.title}</h4>
                    <p className="mt-3 text-sm text-slate-600">时间：{formatDateTime(nextMeeting.startAt)}</p>
                    <p className="mt-1 text-sm text-slate-600">地址：{nextMeeting.address || "未填写"}</p>
                    {nextMeeting.notes ? <p className="mt-3 text-sm leading-6 text-slate-500">{nextMeeting.notes}</p> : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button className="rounded-xl border border-emerald-200 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-white" onClick={() => openEditMeetingDialog(nextMeeting)} type="button">修改</button>
                    <button className="pc-manuscript-gradient rounded-xl px-3 py-2 text-sm font-medium" onClick={() => void createManuscriptFromMeeting()} type="button">创建手稿</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-6 rounded-2xl border border-dashed border-slate-200 p-8 text-center">
                <h4 className="text-base font-semibold text-slate-900">暂无会议</h4>
                <p className="mt-2 text-sm text-slate-500">添加会议后，首页只展示最早开始的一场。</p>
                <button className="mt-4 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700" onClick={openNewMeetingDialog} type="button">添加会议</button>
              </div>
            )}

            {meetings.length > 0 ? (
              <div className="mt-5 space-y-2">
                {meetings.slice(0, 4).map((meeting) => (
                  <div className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3" key={meeting.id}>
                    <div>
                      <div className="text-sm font-medium text-slate-900">{meeting.title}</div>
                      <div className="mt-1 text-xs text-slate-500">{formatDateTime(meeting.startAt)} · {meeting.address || "未填写地址"}</div>
                    </div>
                    <button className="text-xs font-medium text-red-600 hover:text-red-700" onClick={() => deleteMeeting(meeting.id)} type="button">删除</button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="pc-warm-panel rounded-3xl border border-slate-200 p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-blue-500">Groups</div>
                <h3 className="mt-2 text-xl font-semibold text-slate-950">组</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">创建或加入组，把库中文档按发送时快照分享给组成员。</p>
              </div>
              <div className="flex gap-2">
                <button className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" disabled={isSubmittingGroup} onClick={() => setGroupDialog("create")} type="button">创建组</button>
                <button className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50" disabled={isSubmittingGroup} onClick={() => setGroupDialog("join")} type="button">加入组</button>
              </div>
            </div>

            {groupError ? <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">{groupError}</div> : null}

            {isLoadingGroups ? (
              <div className="mt-6 rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">组列表加载中...</div>
            ) : groups.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">还没有组。创建组会生成 6 位数字口令码，有效期一天。</div>
            ) : (
              <div className="mt-6 grid gap-4 lg:grid-cols-[180px_1fr]">
                <div className="space-y-2">
                  {groups.map((group) => (
                    <button className={`w-full rounded-xl border p-3 text-left text-sm ${group.id === activeGroup?.id ? "border-blue-200 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`} key={group.id} onClick={() => setSelectedGroupId(group.id)} type="button">
                      <div className="font-medium text-slate-950">{group.name}</div>
                      <div className="mt-1 text-xs text-slate-500">{group.memberCount} 人 · {group.role === "owner" ? "我创建" : "成员"}</div>
                    </button>
                  ))}
                </div>
                <div className="rounded-2xl border border-slate-200 p-4">
                  {activeGroup ? (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h4 className="font-semibold text-slate-950">{activeGroup.name}</h4>
                          <p className="mt-1 text-xs text-slate-500">口令 {activeGroup.inviteCode}，有效期至 {formatDateTime(activeGroup.inviteCodeExpiresAt)}</p>
                        </div>
                      </div>
                      <div className="mt-4 flex gap-2">
                        <select className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none" onChange={(event) => setSelectedDocumentId(event.target.value)} value={selectedDocumentId}>
                          <option value="">选择库中文档</option>
                          {documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}
                        </select>
                        <button className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!selectedDocumentId || !activeGroup || isSendingDocument} onClick={() => void sendDocumentToGroup()} type="button">{isSendingDocument ? "发送中" : "发送"}</button>
                      </div>
                      <div className="mt-4 space-y-2">
                        {isLoadingMessages ? <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">文档消息加载中...</div> : null}
                        {!isLoadingMessages && activeMessages.length === 0 ? <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">暂无文档消息。</div> : null}
                        {activeMessages.map((message) => (
                          <div className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2" key={message.id}>
                            <div>
                              <div className="text-sm font-medium text-slate-900">{message.documentTitle}</div>
                              <div className="mt-1 text-xs text-slate-500">{displaySenderName(message.senderName)} · {formatDateTime(message.sentAt)}</div>
                            </div>
                            <button className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50" onClick={() => void downloadGroupDocument(message)} type="button">下载</button>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            )}
          </div>
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
