import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { AssetImage } from "../components/AssetImage";
import { api } from "../lib/api";
import {
  createDocumentImageBlock,
  createHeadingBlock,
  createListBlock,
  createParagraphBlock,
  createQuoteBlock,
  deleteOperation,
  insertAfter,
  mergeServerBlocks,
  replaceBlock,
  touchBlock,
  upsertOperation,
} from "../lib/blocks";
import { DOCUMENT_AGENT_TOOLS_VERSION, buildDocumentAgentContext, safeParseAgentResult, type DocumentAgentResult } from "../lib/documentAgent";
import { applyDocumentAgentToolCalls, getBlockText, toHeadingBlock, toListBlock, toParagraphBlock, toQuoteBlock } from "../lib/documentAgentTools";
import { canUseNativeCamera, captureImageFromCamera, createPcmRecorder, readImageFile, type PcmRecorder } from "../lib/media";
import { readAgentEditSse, readAsrSse, readSseText } from "../lib/sse";
import type { Document, DocumentBlock, SyncOperation, Task } from "../types/api";

interface DocumentEditorProps {
  id: string;
  onBack: () => void;
}

type PendingOp = SyncOperation<DocumentBlock>;
type DocumentSheet = "insert" | "format" | "agent" | "export" | null;
type VoiceInputState = "idle" | "recording" | "uploading" | "transcribing";

const AGENT_BUSY_MESSAGES = ["正在理解你的修改意图", "正在阅读选中内容", "正在规划文档操作", "正在生成可应用方案"];

export function DocumentEditor({ id, onBack }: DocumentEditorProps) {
  const [document, setDocument] = useState<Document | null>(null);
  const [revision, setRevision] = useState(0);
  const [blocks, setBlocks] = useState<DocumentBlock[]>([]);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sheet, setSheet] = useState<DocumentSheet>(null);
  const [syncState, setSyncState] = useState("未同步");
  const [undoCount, setUndoCount] = useState(0);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentDraft, setAgentDraft] = useState("");
  const [agentResult, setAgentResult] = useState<DocumentAgentResult | null>(null);
  const [agentStatus, setAgentStatus] = useState("");
  const [agentBusyStep, setAgentBusyStep] = useState(0);
  const [agentBusy, setAgentBusy] = useState(false);
  const [voiceInputState, setVoiceInputState] = useState<VoiceInputState>("idle");
  const [voiceInputMessage, setVoiceInputMessage] = useState("");
  const [task, setTask] = useState<Task | null>(null);
  const [exportingFormat, setExportingFormat] = useState<"pdf" | "docx" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageAfterBlockIdRef = useRef<string | null>(null);
  const downloadedExportIdsRef = useRef<Set<string>>(new Set());
  const voiceRecorderRef = useRef<{ recorder: PcmRecorder; startedAt: number } | null>(null);
  const voiceStartPendingRef = useRef(false);
  const pendingOpsRef = useRef<PendingOp[]>([]);
  const syncTimerRef = useRef<number | null>(null);
  const undoStackRef = useRef<DocumentBlock[][]>([]);
  const undoGroupRef = useRef<string | null>(null);
  const userId = api.currentSession?.user.id ?? "";

  const visibleBlocks = useMemo(() => blocks.filter((block) => !block.deleted), [blocks]);
  const activeBlock = useMemo(() => visibleBlocks.find((block) => block.id === activeBlockId) ?? null, [activeBlockId, visibleBlocks]);
  const selectedBlocks = useMemo(() => visibleBlocks.filter((block) => selectedIds.includes(block.id)), [selectedIds, visibleBlocks]);
  const formatTargets = selectedBlocks.length > 0 ? selectedBlocks : activeBlock ? [activeBlock] : [];
  const agentScopeLabel = selectedIds.length > 0 ? `${selectedIds.length} 段内容` : "全文";
  const agentLiveText = useMemo(() => {
    if (agentBusy && agentDraft.trim()) return lastPreviewLine(agentDraft);
    if (agentBusy) return agentStatus || AGENT_BUSY_MESSAGES[agentBusyStep % AGENT_BUSY_MESSAGES.length];
    return agentStatus || agentResult?.summary || "";
  }, [agentBusy, agentBusyStep, agentDraft, agentResult, agentStatus]);

  useEffect(() => {
    let active = true;
    api
      .getDocument(id)
      .then((data) => {
        if (!active) return;
        const freshBlocks = data.blocks.filter((block) => !block.deleted);
        setDocument(data);
        setRevision(data.revision);
        setBlocks(freshBlocks);
        setActiveBlockId(freshBlocks[0]?.id ?? null);
        setSelectedIds([]);
        undoStackRef.current = [];
        undoGroupRef.current = null;
        setUndoCount(0);
        const warningKey = `meetingmate.convertWarnings.${data.id}`;
        const warnings = sessionStorage.getItem(warningKey);
        if (warnings) {
          try {
            const parsed = JSON.parse(warnings) as Array<{ block_id: string; code: string; message: string }>;
            setError(`部分手写内容已降级处理：${parsed.length} 项`);
          } catch {
            setError("部分内容已降级处理");
          }
          sessionStorage.removeItem(warningKey);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "文档加载失败"));
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    if (!task) return;
    if (task.status === "succeeded") {
      void downloadExportTask(task);
      return;
    }
    if (task.status === "failed" || task.status === "cancelled") {
      setExportingFormat(null);
      setError(task.error?.message ?? "导出失败");
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const next = await api.getTask(task.id);
        setTask(next);
        if (next.status === "succeeded") void downloadExportTask(next);
        if (next.status === "failed" || next.status === "cancelled") {
          setExportingFormat(null);
          setError(next.error?.message ?? "导出失败");
        }
      } catch (err) {
        setExportingFormat(null);
        setError(err instanceof Error ? err.message : "导出状态查询失败");
      }
    }, 1800);
    return () => window.clearInterval(timer);
  }, [task]);

  useEffect(() => {
    if (!agentBusy) {
      setAgentBusyStep(0);
      return;
    }
    const timer = window.setInterval(() => setAgentBusyStep((current) => current + 1), 1200);
    return () => window.clearInterval(timer);
  }, [agentBusy]);

  function queueOperation(op: PendingOp) {
    if (op.type === "upsert_block" && op.block) {
      const existingIndex = pendingOpsRef.current.findIndex((item) => item.type === "upsert_block" && item.block?.id === op.block?.id);
      if (existingIndex >= 0) {
        const existing = pendingOpsRef.current[existingIndex];
        pendingOpsRef.current = pendingOpsRef.current.map((item, index) =>
          index === existingIndex ? { ...op, after_block_id: existing.after_block_id ?? op.after_block_id, before_block_id: existing.before_block_id ?? op.before_block_id } : item,
        );
      } else {
        pendingOpsRef.current = [...pendingOpsRef.current, op];
      }
    } else {
      pendingOpsRef.current = [...pendingOpsRef.current, op];
    }
    setSyncState("等待自动保存");
    if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => void flushOps(), 650);
  }

  async function flushOps() {
    if (pendingOpsRef.current.length === 0) return;
    const ops = pendingOpsRef.current;
    pendingOpsRef.current = [];
    setSyncState("自动保存中");
    try {
      const response = await api.syncDocumentBlocks(id, revision, ops);
      setRevision(response.revision);
      setBlocks((current) => mergeServerBlocks(current, response.blocks));
      setSyncState(response.conflicts.length > 0 ? "有冲突，已保留本地内容" : "已保存");
    } catch (err) {
      pendingOpsRef.current = [...ops, ...pendingOpsRef.current];
      setSyncState("保存失败，将重试");
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  function rememberUndo(group: string | null = null) {
    if (group && undoGroupRef.current === group) return;
    undoStackRef.current = [...undoStackRef.current.slice(-39), cloneDocumentBlocks(blocks)];
    undoGroupRef.current = group;
    setUndoCount(undoStackRef.current.length);
  }

  function resetUndoGroup() {
    undoGroupRef.current = null;
  }

  function applyBlock(block: DocumentBlock, afterBlockId: string | null = null, undoGroup: string | false = `block:${block.id}`) {
    if (!userId) return;
    if (undoGroup !== false) rememberUndo(undoGroup);
    const existingIndex = blocks.findIndex((item) => item.id === block.id);
    const exists = existingIndex >= 0;
    const operationAfterBlockId = afterBlockId ?? (exists ? blocks[existingIndex - 1]?.id ?? null : null);
    const operationBeforeBlockId = operationAfterBlockId ? null : exists ? blocks[existingIndex + 1]?.id ?? null : null;
    setBlocks((current) => {
      const exists = current.some((item) => item.id === block.id);
      return exists ? replaceBlock(current, block) : insertAfter(current, block, afterBlockId);
    });
    queueOperation(upsertOperation(block, userId, operationAfterBlockId, operationBeforeBlockId));
  }

  function undoLastChange() {
    if (!userId) return;
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    const operations = restoreDocumentOperations(visibleBlocks, previous, userId);
    setBlocks(previous);
    setSelectedIds([]);
    setActiveBlockId(previous[0]?.id ?? null);
    undoGroupRef.current = null;
    setUndoCount(undoStackRef.current.length);
    operations.forEach(queueOperation);
    setSyncState("已撤回，等待自动保存");
  }

  function insertBlock(kind: "paragraph" | "heading" | "list" | "quote") {
    if (!userId) return;
    const after = activeBlockId ?? selectedIds.at(-1) ?? visibleBlocks.at(-1)?.id ?? null;
    const block =
      kind === "heading"
        ? createHeadingBlock(userId)
        : kind === "list"
          ? createListBlock(userId)
          : kind === "quote"
            ? createQuoteBlock(userId)
            : createParagraphBlock(userId);
    applyBlock(block, after, "insert");
    setActiveBlockId(block.id);
    setSelectedIds([]);
    setSheet(null);
  }

  function updateBlock(block: DocumentBlock) {
    applyBlock(touchBlock(block), null, `edit:${block.id}`);
  }

  function toggleSelect(blockId: string) {
    setActiveBlockId(blockId);
    setSelectedIds((current) => (current.includes(blockId) ? current.filter((item) => item !== blockId) : [...current, blockId]));
  }

  function openBlockMenu(blockId: string) {
    setActiveBlockId(blockId);
    setSheet("format");
  }

  function deleteBlocks(blockIds: string[]) {
    const ids = new Set(blockIds);
    if (ids.size === 0) return;
    rememberUndo("delete");
    setBlocks((current) => current.filter((block) => !ids.has(block.id)));
    blockIds.forEach((blockId) => queueOperation(deleteOperation<DocumentBlock>(blockId)));
    setSelectedIds([]);
    setActiveBlockId((current) => (current && ids.has(current) ? null : current));
    setSheet(null);
  }

  function transformTargets(kind: "paragraph" | "heading" | "list" | "quote") {
    if (formatTargets.length === 0) return;
    rememberUndo("format");
    formatTargets.forEach((block) => {
      const text = getBlockText(block) ?? "";
      if (kind === "paragraph") applyBlock(toParagraphBlock(block, text), null, false);
      if (kind === "heading") applyBlock(toHeadingBlock(block, text || "标题", 2), null, false);
      if (kind === "quote") applyBlock(toQuoteBlock(block, text), null, false);
      if (kind === "list") {
        const items = text.split("\n").map((item) => item.trim()).filter(Boolean);
        applyBlock(toListBlock(block, items.length > 0 ? items : [text || "列表项"], "bullet"), null, false);
      }
    });
    setSelectedIds(formatTargets.map((block) => block.id));
    setSheet(null);
  }

  function splitTextBlock(block: DocumentBlock, caret: number) {
    if (!userId || !(block.type === "paragraph" || block.type === "heading" || block.type === "quote")) return;
    const text = getBlockText(block) ?? "";
    const before = text.slice(0, caret).trimEnd();
    const after = text.slice(caret).trimStart();
    const updated = touchBlock({ ...block, props: { ...block.props, content: before } } as DocumentBlock);
    const next = createParagraphBlock(userId, after);
    rememberUndo(`split:${block.id}`);
    applyBlock(updated, null, false);
    applyBlock(next, block.id, false);
    setActiveBlockId(next.id);
    setSelectedIds([]);
  }

  async function chooseImage() {
    imageAfterBlockIdRef.current = activeBlockId ?? selectedIds.at(-1) ?? visibleBlocks.at(-1)?.id ?? null;
    if (!canUseNativeCamera()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      await uploadImage(await captureImageFromCamera(), imageAfterBlockIdRef.current);
    } catch {
      fileInputRef.current?.click();
    }
  }

  async function onImageFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !userId) return;
    try {
      await uploadImage(await readImageFile(file), imageAfterBlockIdRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "图片上传失败");
    }
  }

  async function uploadImage(image: { blob: Blob; width: number; height: number; filename: string; contentType: string }, afterBlockId: string | null) {
    if (!userId) return;
    setSyncState("上传图片");
    const asset = await api.uploadAsset(image.blob, { kind: "image", filename: image.filename, contentType: image.contentType, width: image.width, height: image.height });
    const block = createDocumentImageBlock(userId, asset.id, image.width, image.height);
    applyBlock(block, afterBlockId, "image");
    setActiveBlockId(block.id);
    setSelectedIds([]);
    setSheet(null);
  }

  async function startVoiceInput() {
    if (agentBusy || voiceInputState !== "idle" || voiceRecorderRef.current) return;
    voiceStartPendingRef.current = true;
    setError(null);
    setVoiceInputMessage("正在申请麦克风权限");
    try {
      const recorder = await createPcmRecorder();
      if (!voiceStartPendingRef.current) {
        await recorder.stop();
        setVoiceInputMessage("");
        return;
      }
      voiceRecorderRef.current = { recorder, startedAt: Date.now() };
      setVoiceInputState("recording");
      setVoiceInputMessage("正在录音，松开后转文字");
    } catch (err) {
      voiceStartPendingRef.current = false;
      setVoiceInputState("idle");
      setVoiceInputMessage("");
      setError(err instanceof Error ? err.message : "语音输入启动失败，请检查麦克风权限");
    }
  }

  async function stopVoiceInput() {
    voiceStartPendingRef.current = false;
    const current = voiceRecorderRef.current;
    if (!current) return;
    voiceRecorderRef.current = null;
    try {
      const audio = await current.recorder.stop();
      const durationMs = audio.durationMs || Date.now() - current.startedAt;
      if (durationMs < 500) {
        setVoiceInputState("idle");
        setVoiceInputMessage("录音太短，请按住后再说");
        window.setTimeout(() => setVoiceInputMessage(""), 1600);
        return;
      }
      await transcribeAgentVoice(audio.blob, audio.contentType, audio.extension, durationMs);
    } catch (err) {
      setVoiceInputState("idle");
      setVoiceInputMessage("");
      setError(err instanceof Error ? err.message : "语音输入失败");
    }
  }

  async function transcribeAgentVoice(blob: Blob, contentType: string, extension: string, durationMs: number) {
    let assetId: string | null = null;
    setVoiceInputState("uploading");
    setVoiceInputMessage("正在上传语音");
    try {
      const asset = await api.uploadAsset(blob, { kind: "audio", filename: `agent-voice-${Date.now()}.${extension}`, contentType, durationMs });
      assetId = asset.id;
      setVoiceInputState("transcribing");
      setVoiceInputMessage("正在转成文字");
      const response = await api.streamAsrAudio(asset.id, { enableDiarization: false });
      let transcript = "";
      await readAsrSse(response, {
        onDelta: (payload) => {
          transcript = payload.transcript || transcript;
          if (transcript) setVoiceInputMessage(lastPreviewLine(transcript));
        },
        onDone: (nextTask) => {
          transcript = nextTask.result?.transcript ?? transcript;
        },
      });
      const text = transcript.trim();
      if (!text) throw new Error("没有识别到可用语音内容");
      setAgentPrompt((current) => (current.trim() ? `${current.trim()}\n${text}` : text));
      setVoiceInputMessage("已填入语音指令");
      window.setTimeout(() => setVoiceInputMessage(""), 1600);
    } finally {
      setVoiceInputState("idle");
      if (assetId) void api.deleteAsset(assetId).catch(() => undefined);
    }
  }

  async function runAgent() {
    if (!agentPrompt.trim() || !document) return;
    await flushOps();
    setAgentBusy(true);
    setAgentDraft("");
    setAgentResult(null);
    setAgentStatus("正在连接 AI");
    setError(null);
    const prompt = agentPrompt.trim();
    const context = buildDocumentAgentContext(document.title, visibleBlocks, selectedIds);
    let full = "";
    try {
      const response = await api.streamAgent(id, selectedIds, prompt, "edit", { context, toolsVersion: DOCUMENT_AGENT_TOOLS_VERSION, selection: null });
      await readAgentEditSse(response, {
        onStatus: setAgentStatus,
        onDelta: (text) => {
          full += text;
          setAgentDraft(full);
        },
        onResult: (result) => {
          const normalized = safeParseAgentResult(JSON.stringify(result));
          setAgentResult(normalized);
          setAgentStatus(normalized?.summary || "AI 已生成修改方案");
        },
      });
      const parsed = safeParseAgentResult(full);
      if (parsed) {
        setAgentResult(parsed);
        setAgentStatus(parsed.summary || "AI 已生成修改方案");
      } else if (full.trim()) {
        setAgentStatus("AI 已生成文本草稿");
      }
    } catch (err) {
      try {
        setAgentStatus("正在生成文本草稿");
        const fallback = await api.streamAgent(id, selectedIds, prompt, "rewrite");
        full = "";
        await readSseText(fallback, (text) => {
          full += text;
          setAgentDraft(full);
        });
        const parsed = safeParseAgentResult(full);
        if (parsed) {
          setAgentResult(parsed);
          setAgentStatus(parsed.summary || "AI 已生成修改方案");
        } else {
          setAgentStatus("AI 已生成文本草稿");
        }
      } catch (fallbackErr) {
        setError(fallbackErr instanceof Error ? fallbackErr.message : err instanceof Error ? err.message : "Agent 请求失败");
      }
    } finally {
      setAgentBusy(false);
    }
  }

  function applyAgentOutput() {
    if (!userId) return;
    if (agentResult?.tool_calls.length) {
      rememberUndo("agent");
      const result = applyDocumentAgentToolCalls(visibleBlocks, agentResult.tool_calls, userId);
      setBlocks(result.blocks);
      result.operations.forEach(queueOperation);
      setSelectedIds(result.selectedIds);
      setActiveBlockId(result.selectedIds[0] ?? activeBlockId);
    } else if (agentDraft.trim()) {
      rememberUndo("agent");
      const target = selectedBlocks[0] ?? activeBlock ?? visibleBlocks[0];
      if (!target) {
        const block = createParagraphBlock(userId, agentDraft.trim());
        applyBlock(block, null, false);
        setActiveBlockId(block.id);
      } else if ("content" in target.props) {
        applyBlock(touchBlock({ ...target, props: { ...target.props, content: agentDraft.trim() } } as DocumentBlock), null, false);
        setActiveBlockId(target.id);
      } else {
        const block = createParagraphBlock(userId, agentDraft.trim());
        applyBlock(block, target.id, false);
        setActiveBlockId(block.id);
      }
    }
    setAgentDraft("");
    setAgentPrompt("");
    setAgentResult(null);
    setAgentStatus("");
    setSheet(null);
  }

  async function exportFile(format: "pdf" | "docx") {
    setExportingFormat(format);
    setError(null);
    setSheet(null);
    try {
      await flushOps();
      const nextTask = await api.exportDocument(id, format);
      setTask(nextTask);
      if (nextTask.status === "succeeded") await downloadExportTask(nextTask);
      if (nextTask.status === "failed" || nextTask.status === "cancelled") {
        setExportingFormat(null);
        setError(nextTask.error?.message ?? "导出失败");
      }
    } catch (err) {
      setExportingFormat(null);
      setError(err instanceof Error ? err.message : "导出失败");
    }
  }

  async function downloadExportTask(doneTask: Task) {
    const exportId = doneTask.result?.export_id;
    if (!exportId) {
      setExportingFormat(null);
      setError("导出完成但没有返回文件");
      return;
    }
    if (downloadedExportIdsRef.current.has(exportId)) return;
    downloadedExportIdsRef.current.add(exportId);

    try {
      const format = doneTask.result?.format ?? exportingFormat ?? "docx";
      const blob = await api.downloadExport(exportId);
      saveBlob(blob, exportFilename(document?.title ?? "document", format));
    } catch (err) {
      downloadedExportIdsRef.current.delete(exportId);
      setError(err instanceof Error ? err.message : "下载导出文件失败");
    } finally {
      setExportingFormat(null);
    }
  }

  if (error && !document) return <DocumentMessage title="文档加载失败" message={error} onBack={onBack} />;
  if (!document) return <DocumentMessage title="加载文档" message="正在读取文档" onBack={onBack} />;

  return (
    <section className="editor-screen document-screen">
      <input accept="image/*" hidden onChange={onImageFile} ref={fileInputRef} type="file" />
      <header className="editor-topbar docbar">
        <button className="ghost-button" onClick={onBack} type="button">返回</button>
        <div>
          <h1>{document.title}</h1>
          <p>{syncState} · revision {revision}</p>
        </div>
        <button className="primary-small" onClick={() => setSheet("export")} type="button">导出</button>
      </header>

      {task && <div className="task-banner"><span>{task.type}</span><strong>{task.progress.message}</strong><small>{task.status}</small></div>}
      {error && <button className="toast inline" onClick={() => setError(null)} type="button">{error}</button>}

      <article className="document-paper document-flow" onClick={() => setSheet(null)}>
        {visibleBlocks.length === 0 && <button className="empty-document" onClick={(event) => { event.stopPropagation(); insertBlock("paragraph"); }} type="button">开始写第一段</button>}
        {visibleBlocks.map((block) => (
        <DocumentBlockEditor
            active={activeBlockId === block.id}
            block={block}
            key={block.id}
            onActivate={setActiveBlockId}
            onChange={updateBlock}
            onEditStart={resetUndoGroup}
            onOpenActions={openBlockMenu}
            onSplit={splitTextBlock}
            onToggleSelect={toggleSelect}
            selected={selectedIds.includes(block.id)}
            selectionMode={selectedIds.length > 0}
          />
        ))}
      </article>

      <DocumentDock
        activeBlock={activeBlock}
        onClearSelection={() => setSelectedIds([])}
        onOpenSheet={setSheet}
        onUndo={undoLastChange}
        selectedCount={selectedIds.length}
        undoCount={undoCount}
      />

      {sheet && (
        <DocumentSheetPanel
          activeBlock={activeBlock}
          agentBusy={agentBusy}
          agentDraft={agentDraft}
          agentPrompt={agentPrompt}
          agentResult={agentResult}
          agentScopeLabel={agentScopeLabel}
          agentStatus={agentStatus}
          agentLiveText={agentLiveText}
          exportingFormat={exportingFormat}
          formatTargetCount={formatTargets.length}
          onAgentPromptChange={setAgentPrompt}
          onApplyAgent={applyAgentOutput}
          onChooseImage={() => void chooseImage()}
          onClose={() => setSheet(null)}
          onDelete={() => deleteBlocks(formatTargets.map((block) => block.id))}
          onExport={exportFile}
          onInsert={insertBlock}
          onRunAgent={() => void runAgent()}
          onSelectActive={() => activeBlock && setSelectedIds([activeBlock.id])}
          onSetAgentPrompt={setAgentPrompt}
          onTransform={transformTargets}
          onUseFullDocument={() => setSelectedIds([])}
          onVoiceInputStart={() => void startVoiceInput()}
          onVoiceInputStop={() => void stopVoiceInput()}
          selectedCount={selectedIds.length}
          sheet={sheet}
          voiceInputMessage={voiceInputMessage}
          voiceInputState={voiceInputState}
        />
      )}
    </section>
  );
}

function DocumentDock({
  activeBlock,
  selectedCount,
  undoCount,
  onOpenSheet,
  onClearSelection,
  onUndo,
}: {
  activeBlock: DocumentBlock | null;
  selectedCount: number;
  undoCount: number;
  onOpenSheet: (sheet: DocumentSheet) => void;
  onClearSelection: () => void;
  onUndo: () => void;
}) {
  return (
    <nav className="document-editor-dock" aria-label="文档编辑工具">
      {selectedCount > 0 && <button className="selection-pill" onClick={onClearSelection} type="button">已选 {selectedCount} 段 · 清除</button>}
      <button disabled={undoCount === 0} onClick={onUndo} type="button">撤回</button>
      <button onClick={() => onOpenSheet("insert")} type="button">插入</button>
      <button disabled={!activeBlock && selectedCount === 0} onClick={() => onOpenSheet("format")} type="button">格式</button>
      <button onClick={() => onOpenSheet("agent")} type="button">AI</button>
      <button onClick={() => onOpenSheet("export")} type="button">更多</button>
    </nav>
  );
}

function DocumentSheetPanel({
  activeBlock,
  agentBusy,
  agentDraft,
  agentPrompt,
  agentResult,
  agentScopeLabel,
  agentStatus,
  agentLiveText,
  exportingFormat,
  formatTargetCount,
  selectedCount,
  sheet,
  onAgentPromptChange,
  onApplyAgent,
  onChooseImage,
  onClose,
  onDelete,
  onExport,
  onInsert,
  onRunAgent,
  onSelectActive,
  onSetAgentPrompt,
  onTransform,
  onUseFullDocument,
  onVoiceInputStart,
  onVoiceInputStop,
  voiceInputMessage,
  voiceInputState,
}: {
  activeBlock: DocumentBlock | null;
  agentBusy: boolean;
  agentDraft: string;
  agentPrompt: string;
  agentResult: DocumentAgentResult | null;
  agentScopeLabel: string;
  agentStatus: string;
  agentLiveText: string;
  exportingFormat: "pdf" | "docx" | null;
  formatTargetCount: number;
  selectedCount: number;
  sheet: Exclude<DocumentSheet, null>;
  onAgentPromptChange: (value: string) => void;
  onApplyAgent: () => void;
  onChooseImage: () => void;
  onClose: () => void;
  onDelete: () => void;
  onExport: (format: "pdf" | "docx") => void;
  onInsert: (kind: "paragraph" | "heading" | "list" | "quote") => void;
  onRunAgent: () => void;
  onSelectActive: () => void;
  onSetAgentPrompt: (value: string) => void;
  onTransform: (kind: "paragraph" | "heading" | "list" | "quote") => void;
  onUseFullDocument: () => void;
  onVoiceInputStart: () => void;
  onVoiceInputStop: () => void;
  voiceInputMessage: string;
  voiceInputState: VoiceInputState;
}) {
  const voiceBusy = voiceInputState !== "idle";
  return (
    <div className="document-sheet-backdrop" onClick={onClose}>
      <section className="document-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <header className="sheet-header">
          <div>
            <p className="eyebrow">{sheet === "agent" ? "AI 修改" : sheet === "format" ? "段落操作" : sheet === "export" ? "导出" : "插入内容"}</p>
            <h2>{sheet === "agent" ? `作用范围：${agentScopeLabel}` : sheet === "format" ? `${formatTargetCount || 0} 段可调整` : sheet === "export" ? "生成可分享文件" : "在当前位置后添加"}</h2>
          </div>
          <button className="ghost-button" onClick={onClose} type="button">关闭</button>
        </header>

        {sheet === "insert" && (
          <div className="sheet-action-grid">
            <button onClick={() => onInsert("paragraph")} type="button"><strong>段落</strong><span>继续写正文</span></button>
            <button onClick={() => onInsert("heading")} type="button"><strong>标题</strong><span>新建小节</span></button>
            <button onClick={() => onInsert("list")} type="button"><strong>列表</strong><span>整理为要点</span></button>
            <button onClick={() => onInsert("quote")} type="button"><strong>引用</strong><span>突出原话</span></button>
            <button onClick={onChooseImage} type="button"><strong>图片</strong><span>插入相机或相册图片</span></button>
          </div>
        )}

        {sheet === "format" && (
          <div className="sheet-stack">
            {formatTargetCount === 0 && <p className="muted">先点一下正文中的段落，或通过段落右侧按钮选择多段。</p>}
            <div className="sheet-action-row">
              <button disabled={formatTargetCount === 0} onClick={() => onTransform("paragraph")} type="button">正文</button>
              <button disabled={formatTargetCount === 0} onClick={() => onTransform("heading")} type="button">标题</button>
              <button disabled={formatTargetCount === 0} onClick={() => onTransform("list")} type="button">列表</button>
              <button disabled={formatTargetCount === 0} onClick={() => onTransform("quote")} type="button">引用</button>
            </div>
            <div className="sheet-action-row">
              <button disabled={!activeBlock} onClick={onSelectActive} type="button">选择当前段</button>
              <button className="danger-text" disabled={formatTargetCount === 0} onClick={onDelete} type="button">删除</button>
            </div>
          </div>
        )}

        {sheet === "agent" && (
          <div className="sheet-stack">
            <div className="prompt-chip-row">
              {selectedCount > 0 && <button onClick={onUseFullDocument} type="button">改为全文</button>}
              {selectedCount === 0 && activeBlock && <button onClick={onSelectActive} type="button">只处理当前段</button>}
              {[
                "润色选中内容",
                "整理成要点列表",
                "压缩成三句话",
                "改成会议纪要语气",
              ].map((prompt) => <button key={prompt} onClick={() => onSetAgentPrompt(prompt)} type="button">{prompt}</button>)}
            </div>
            <div className={agentBusy ? "agent-prompt-shell busy" : "agent-prompt-shell"}>
              <textarea onChange={(event) => onAgentPromptChange(event.target.value)} placeholder="例如：把选中内容整理成三条行动项。" value={agentPrompt} />
            </div>
            <button
              className={voiceBusy ? "agent-voice-button recording" : "agent-voice-button"}
              disabled={agentBusy}
              onContextMenu={(event) => event.preventDefault()}
              onPointerCancel={onVoiceInputStop}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                onVoiceInputStart();
              }}
              onPointerLeave={(event) => {
                if (event.buttons === 1) onVoiceInputStop();
              }}
              onPointerUp={onVoiceInputStop}
              type="button"
            >
              <strong>{voiceInputState === "recording" ? "松开转文字" : voiceBusy ? "语音处理中" : "按住说话"}</strong>
              <span>{voiceInputMessage || "说出你想让 AI 做的修改，不会自动发送"}</span>
            </button>
            {(agentBusy || agentLiveText) && <AgentLiveStatus busy={agentBusy} text={agentLiveText} />}
            <div className="agent-actions">
              <button className="primary-small" disabled={agentBusy || !agentPrompt.trim()} onClick={onRunAgent} type="button">{agentBusy ? "生成中" : "生成修改"}</button>
              <button disabled={!agentDraft.trim() && !agentResult} onClick={onApplyAgent} type="button">应用</button>
            </div>
            {agentResult && <AgentResultPreview result={agentResult} />}
            {!agentResult && agentDraft && <pre className="agent-draft">{agentDraft}</pre>}
          </div>
        )}

        {sheet === "export" && (
          <div className="sheet-action-grid">
            <button disabled={!!exportingFormat} onClick={() => onExport("pdf")} type="button"><strong>{exportingFormat === "pdf" ? "PDF 生成中" : "PDF"}</strong><span>适合快速分享和预览</span></button>
            <button disabled={!!exportingFormat} onClick={() => onExport("docx")} type="button"><strong>{exportingFormat === "docx" ? "DOCX 生成中" : "DOCX"}</strong><span>适合继续编辑</span></button>
          </div>
        )}
      </section>
    </div>
  );
}

function AgentResultPreview({ result }: { result: DocumentAgentResult }) {
  return (
    <div className="agent-result-card">
      <strong>{result.summary || "AI 修改方案"}</strong>
      <span>将执行 {result.tool_calls.length} 个文档操作</span>
    </div>
  );
}

function AgentLiveStatus({ busy, text }: { busy: boolean; text: string }) {
  return (
    <div aria-live="polite" className={busy ? "agent-live-status busy" : "agent-live-status"}>
      <span className="agent-live-dot" />
      <p>{text || "AI 正在处理"}</p>
    </div>
  );
}

function DocumentBlockEditor({
  block,
  active,
  selected,
  selectionMode,
  onActivate,
  onChange,
  onEditStart,
  onOpenActions,
  onSplit,
  onToggleSelect,
}: {
  block: DocumentBlock;
  active: boolean;
  selected: boolean;
  selectionMode: boolean;
  onActivate: (id: string) => void;
  onChange: (block: DocumentBlock) => void;
  onEditStart: () => void;
  onOpenActions: (id: string) => void;
  onSplit: (block: DocumentBlock, caret: number) => void;
  onToggleSelect: (id: string) => void;
}) {
  const shellClass = ["doc-block", active ? "active" : "", selected ? "selected" : "", `doc-block-${block.type}`].filter(Boolean).join(" ");

  function onTextKeyDown(event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (!(block.type === "paragraph" || block.type === "heading" || block.type === "quote")) return;
    event.preventDefault();
    onSplit(block, event.currentTarget.selectionStart ?? getBlockText(block)?.length ?? 0);
  }

  return (
    <section className={shellClass} onClick={() => onActivate(block.id)}>
      {selectionMode && <button className="doc-block-check" onClick={(event) => { event.stopPropagation(); onToggleSelect(block.id); }} type="button">{selected ? "已选" : "选择"}</button>}
      <button className="doc-block-handle" onClick={(event) => { event.stopPropagation(); onOpenActions(block.id); }} type="button" aria-label="段落操作">···</button>

      {block.type === "paragraph" && <AutoTextarea className="doc-input paragraph-input" onChange={(content) => onChange({ ...block, props: { content } })} onFocus={() => { onEditStart(); onActivate(block.id); }} onKeyDown={onTextKeyDown} placeholder="继续写正文" value={block.props.content} />}

      {block.type === "heading" && (
        <div className="heading-editor">
          {active && (
            <select onChange={(event) => onChange({ ...block, props: { ...block.props, level: Number(event.target.value) as 1 | 2 | 3 } })} value={block.props.level}>
              <option value={1}>H1</option>
              <option value={2}>H2</option>
              <option value={3}>H3</option>
            </select>
          )}
          <AutoTextarea className={`doc-input heading-input heading-level-${block.props.level}`} onChange={(content) => onChange({ ...block, props: { ...block.props, content } })} onFocus={() => { onEditStart(); onActivate(block.id); }} onKeyDown={onTextKeyDown} placeholder="标题" value={block.props.content} />
        </div>
      )}

      {block.type === "list" && (
        <div className="list-editor">
          {active && (
            <select onChange={(event) => onChange({ ...block, props: { ...block.props, style: event.target.value as "bullet" | "numbered" } })} value={block.props.style}>
              <option value="bullet">项目符号</option>
              <option value="numbered">编号</option>
            </select>
          )}
          <AutoTextarea className={`doc-input list-input ${block.props.style}`} onChange={(content) => onChange({ ...block, props: { ...block.props, items: content.split("\n") } })} onFocus={() => { onEditStart(); onActivate(block.id); }} placeholder="每行一个列表项" value={block.props.items.join("\n")} />
        </div>
      )}

      {block.type === "quote" && <AutoTextarea className="doc-input quote-input" onChange={(content) => onChange({ ...block, props: { content } })} onFocus={() => { onEditStart(); onActivate(block.id); }} onKeyDown={onTextKeyDown} placeholder="引用" value={block.props.content} />}

      {block.type === "image" && (
        <figure className="image-block">
          <AssetImage alt={block.props.caption || "文档图片"} assetId={block.props.asset_id} />
          <input onChange={(event) => onChange({ ...block, props: { ...block.props, caption: event.target.value } })} onFocus={() => { onEditStart(); onActivate(block.id); }} placeholder="图片说明" value={block.props.caption ?? ""} />
        </figure>
      )}

      {block.type === "table" && <AutoTextarea className="doc-input table-input" onChange={(content) => onChange({ ...block, props: { rows: content.split("\n").map((row) => row.split("\t")) } })} onFocus={() => { onEditStart(); onActivate(block.id); }} value={block.props.rows.map((row) => row.join("\t")).join("\n")} />}

      {block.type === "code" && <AutoTextarea className="doc-input code-input" onChange={(content) => onChange({ ...block, props: { ...block.props, content } })} onFocus={() => { onEditStart(); onActivate(block.id); }} value={block.props.content} />}

      {active && block.source_refs && block.source_refs.length > 0 && <small className="source-ref">来源 {block.source_refs.length} 处</small>}
    </section>
  );
}

function AutoTextarea({ className, value, placeholder, onFocus, onKeyDown, onChange }: { className: string; value: string; placeholder?: string; onFocus: () => void; onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      className={className}
      onChange={(event) => {
        event.currentTarget.style.height = "auto";
        event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
        onChange(event.target.value);
      }}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      ref={ref}
      rows={1}
      value={value}
    />
  );
}

function lastPreviewLine(text: string) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const line = lines.at(-1) ?? text.trim();
  return line.length > 120 ? `${line.slice(0, 120)}...` : line;
}

function saveBlob(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const link = globalThis.document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener";
  globalThis.document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

function exportFilename(title: string, format: "pdf" | "docx") {
  const safeTitle = title.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 80) || "document";
  return `${safeTitle}.${format}`;
}

function cloneDocumentBlocks(blocks: DocumentBlock[]) {
  return blocks.map((block) => structuredClone(block));
}

function restoreDocumentOperations(current: DocumentBlock[], previous: DocumentBlock[], userId: string): PendingOp[] {
  const currentById = new Map(current.map((block) => [block.id, block]));
  const previousById = new Map(previous.map((block) => [block.id, block]));
  const operations: PendingOp[] = [];

  current.forEach((block) => {
    if (!previousById.has(block.id)) operations.push(deleteOperation<DocumentBlock>(block.id));
  });

  previous.forEach((block, index) => {
    const currentBlock = currentById.get(block.id);
    const previousId = previous[index - 1]?.id ?? null;
    const nextId = previousId ? null : previous[index + 1]?.id ?? null;
    if (!currentBlock || JSON.stringify(currentBlock) !== JSON.stringify(block) || current[index]?.id !== block.id) {
      operations.push(upsertOperation(block, userId, previousId, nextId));
    }
  });

  return operations;
}

function DocumentMessage({ title, message, onBack }: { title: string; message: string; onBack: () => void }) {
  return (
    <section className="editor-screen centered">
      <h1>{title}</h1>
      <p>{message}</p>
      <button className="primary-button" onClick={onBack} type="button">返回</button>
    </section>
  );
}
