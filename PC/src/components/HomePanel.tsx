import { useMemo, useState, type ReactNode } from "react";
import { pcApi } from "../lib/api";
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

const groupApiSpec = [
  "POST /api/v1/groups - 创建组并返回 6 位口令码",
  "POST /api/v1/groups/join - 使用 6 位口令码加入组",
  "GET /api/v1/groups - 获取当前用户加入的组列表",
  "GET /api/v1/groups/{group_id}/messages - 获取组内文档消息",
  "POST /api/v1/groups/{group_id}/documents - 发送库中文档到组",
  "GET /api/v1/groups/{group_id}/documents/{message_id}/download - 下载组内文档"
];

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
  const nextMeeting = useMemo(() => getNextMeeting(meetings), [meetings]);

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

  function createGroup(): void {
    if (!groupName.trim()) return;
    const now = Date.now();
    const group: GroupSummary = {
      id: `group-${crypto.randomUUID()}`,
      name: groupName.trim(),
      inviteCode: String(Math.floor(100000 + Math.random() * 900000)),
      inviteCodeExpiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      memberCount: 1
    };
    setGroups((current) => [group, ...current]);
    setSelectedGroupId(group.id);
    setGroupName("");
    setGroupDialog(null);
  }

  function joinGroup(): void {
    if (!/^\d{6}$/.test(inviteCode)) return;
    const group: GroupSummary = {
      id: `group-${crypto.randomUUID()}`,
      name: `口令组 ${inviteCode}`,
      inviteCode,
      inviteCodeExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      memberCount: 2
    };
    setGroups((current) => [group, ...current]);
    setSelectedGroupId(group.id);
    setInviteCode("");
    setGroupDialog(null);
  }

  function sendDocumentToGroup(): void {
    const group = groups.find((item) => item.id === selectedGroupId);
    const document = documents.find((item) => item.id === selectedDocumentId);
    if (!group || !document) return;
    setMessages((current) => [
      { id: `msg-${crypto.randomUUID()}`, groupId: group.id, senderName: "我", documentTitle: document.title, sentAt: new Date().toISOString() },
      ...current
    ]);
    setSelectedDocumentId("");
  }

  const activeGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0];
  const activeMessages = messages.filter((message) => message.groupId === activeGroup?.id);

  return (
    <section className="min-h-0 flex-1 overflow-auto bg-slate-50 p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="text-xs uppercase tracking-[0.2em] text-blue-500">MeetingMate PC</div>
          <h2 className="mt-3 text-3xl font-bold text-slate-950">从手稿到文档的 AI 工作流</h2>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-500">在库中新建或打开手稿，采集文字、手写、语音和图片，再转换为富文本文档进行 Agent 辅助编辑。</p>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.95fr)]">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
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
                    <button className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700" onClick={() => void createManuscriptFromMeeting()} type="button">创建手稿</button>
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

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-blue-500">Groups</div>
                <h3 className="mt-2 text-xl font-semibold text-slate-950">组</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">组功能先提供 UI 原型，服务器 API 待实现。</p>
              </div>
              <div className="flex gap-2">
                <button className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700" onClick={() => setGroupDialog("create")} type="button">创建组</button>
                <button className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50" onClick={() => setGroupDialog("join")} type="button">加入组</button>
              </div>
            </div>

            {groups.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">还没有组。创建组会生成 6 位数字口令码，有效期一天。</div>
            ) : (
              <div className="mt-6 grid gap-4 lg:grid-cols-[180px_1fr]">
                <div className="space-y-2">
                  {groups.map((group) => (
                    <button className={`w-full rounded-xl border p-3 text-left text-sm ${group.id === activeGroup?.id ? "border-blue-200 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`} key={group.id} onClick={() => setSelectedGroupId(group.id)} type="button">
                      <div className="font-medium text-slate-950">{group.name}</div>
                      <div className="mt-1 text-xs text-slate-500">{group.memberCount} 人 · {group.inviteCode}</div>
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
                        <button className="rounded-xl bg-slate-950 px-3 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!selectedDocumentId} onClick={sendDocumentToGroup} type="button">发送</button>
                      </div>
                      <div className="mt-4 space-y-2">
                        {activeMessages.length === 0 ? <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">暂无文档消息。</div> : null}
                        {activeMessages.map((message) => (
                          <div className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2" key={message.id}>
                            <div>
                              <div className="text-sm font-medium text-slate-900">{message.documentTitle}</div>
                              <div className="mt-1 text-xs text-slate-500">{message.senderName} · {formatDateTime(message.sentAt)}</div>
                            </div>
                            <button className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50" type="button">下载</button>
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

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-950">组功能 API 规范草案</h3>
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {groupApiSpec.map((item) => <code className="rounded-xl bg-slate-950 px-3 py-2 text-xs text-slate-100" key={item}>{item}</code>)}
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
              <button className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!groupName.trim()} onClick={createGroup} type="button">创建并生成口令</button>
            </>
          ) : (
            <>
              <input className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none" maxLength={6} onChange={(event) => setInviteCode(event.target.value.replace(/\D/g, ""))} placeholder="6 位数字口令" value={inviteCode} />
              <button className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!/^\d{6}$/.test(inviteCode)} onClick={joinGroup} type="button">加入组</button>
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

function toDatetimeLocal(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
