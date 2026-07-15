import { useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent } from "react";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { api } from "../lib/api";
import {
  createAudioBlock,
  createHandwritingBlock,
  createImageBlock,
  createTextBlock,
  insertAfter,
  mergeServerBlocks,
  replaceBlock,
  touchBlock,
  upsertOperation,
} from "../lib/blocks";
import { captureImageFromCamera, formatDuration, readImageFile } from "../lib/media";
import type { ConvertMode, Manuscript, ManuscriptBlock, ManuscriptHandwritingBlock, Stroke, StrokeTool, SyncOperation, Task } from "../types/api";
import { AssetImage } from "../components/AssetImage";
import { AudioAsset } from "../components/AudioAsset";
import { BlankHandwritingCanvas } from "../components/BlankHandwritingCanvas";
import { HandwritingCanvas } from "../components/HandwritingCanvas";

interface ManuscriptEditorProps {
  id: string;
  onBack: () => void;
  onOpenDocument: (id: string) => void;
}

type MenuState = { blockId: string | null; x: number; y: number; selectedStrokeIds: string[] } | null;
type PendingOp = SyncOperation<ManuscriptBlock>;
type PendingAudio = {
  id: string;
  afterBlockId: string | null;
  durationMs: number;
  objectUrl: string;
  status: "uploading" | "failed";
  error?: string;
};

export function ManuscriptEditor({ id, onBack, onOpenDocument }: ManuscriptEditorProps) {
  const [manuscript, setManuscript] = useState<Manuscript | null>(null);
  const [revision, setRevision] = useState(0);
  const [blocks, setBlocks] = useState<ManuscriptBlock[]>([]);
  const [tool, setTool] = useState<StrokeTool>("pen");
  const [color, setColor] = useState("#1f1b14");
  const [brushWidth, setBrushWidth] = useState(2.8);
  const [menu, setMenu] = useState<MenuState>(null);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ blockId: string; strokeIds: string[] } | null>(null);
  const [syncState, setSyncState] = useState("未同步");
  const [recording, setRecording] = useState<{ recorder: MediaRecorder; startedAt: number; afterBlockId: string | null } | null>(null);
  const [pendingAudios, setPendingAudios] = useState<PendingAudio[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockHeights, setBlockHeights] = useState<Record<string, number>>({});
  const pendingOpsRef = useRef<PendingOp[]>([]);
  const syncTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageAfterBlockIdRef = useRef<string | null>(null);

  const userId = api.currentSession?.user.id ?? "";
  const visibleBlocks = useMemo(() => blocks.filter((block) => !block.deleted), [blocks]);

  useEffect(() => {
    let active = true;
    setError(null);
    api
      .getManuscript(id)
      .then((data) => {
        if (!active) return;
        setManuscript(data);
        setRevision(data.revision);
        setBlocks(data.blocks.filter((block) => !block.deleted));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "手稿加载失败"));
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    if (!task || task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") return;
    const timer = window.setInterval(async () => {
      const next = await api.getTask(task.id);
      setTask(next);
      if (next.status === "succeeded" && next.result?.document_id) onOpenDocument(next.result.document_id);
      if (next.status === "succeeded" && next.result?.asset_id && typeof next.result.transcript === "string") {
        const block = blocks.find((item): item is Extract<ManuscriptBlock, { type: "audio" }> => item.type === "audio" && item.props.asset_id === next.result?.asset_id);
        if (block) {
          applyBlock(
            touchBlock({
              ...block,
              props: {
                ...block.props,
                transcript: next.result.transcript,
                speaker_segments: next.result.speaker_segments ?? [],
                asr_task_id: next.id,
                asr_generated_at: new Date().toISOString(),
              },
            }),
          );
        }
      }
    }, 1600);
    return () => window.clearInterval(timer);
  }, [task, onOpenDocument, blocks]);

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
    syncTimerRef.current = window.setTimeout(() => void flushOps(), 700);
  }

  async function flushOps() {
    if (pendingOpsRef.current.length === 0) return;
    const ops = pendingOpsRef.current;
    pendingOpsRef.current = [];
    setSyncState("自动保存中");
    try {
      const response = await api.syncManuscriptBlocks(id, revision, ops);
      setRevision(response.revision);
      setBlocks((current) => mergeServerBlocks(current, response.blocks));
      setSyncState(response.conflicts.length > 0 ? "有冲突，已保留本地内容" : "已保存");
    } catch (err) {
      pendingOpsRef.current = [...ops, ...pendingOpsRef.current];
      setSyncState("保存失败，将重试");
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  function applyBlock(block: ManuscriptBlock, afterBlockId: string | null = null) {
    setBlocks((current) => {
      const exists = current.some((item) => item.id === block.id);
      return exists ? replaceBlock(current, block) : insertAfter(current, block, afterBlockId);
    });
    queueOperation(upsertOperation(block, afterBlockId));
  }

  function insertBlockRespectingSelection(block: ManuscriptBlock, afterBlockId: string | null) {
    const split = buildSelectedContinuation(afterBlockId);
    if (!split) {
      applyBlock(block, afterBlockId);
      return;
    }

    setBlockHeights((current) => ({ ...current, [split.continuation.id]: Math.max(120, estimateStrokeHeight(split.continuation.props.strokes)) }));
    setBlocks((current) => insertAfter(insertAfter(replaceBlock(current, split.updatedSource), block, split.source.id), split.continuation, block.id));
    queueOperation(upsertOperation(split.updatedSource));
    queueOperation(upsertOperation(block, split.source.id));
    queueOperation(upsertOperation(split.continuation, block.id));
    setSelected(null);
  }

  function buildSelectedContinuation(afterBlockId: string | null) {
    if (!selected?.strokeIds.length || !userId || selected.blockId !== afterBlockId) return null;
    const source = blocks.find((block): block is ManuscriptHandwritingBlock => block.id === selected.blockId && block.type === "handwriting");
    if (!source) return null;
    const picked = source.props.strokes.filter((stroke) => selected.strokeIds.includes(stroke.id));
    if (picked.length === 0) return null;
    const remaining = source.props.strokes.filter((stroke) => !selected.strokeIds.includes(stroke.id));
    const updatedSource = touchBlock({ ...source, props: { ...source.props, strokes: remaining } });
    const continuation = createHandwritingBlock(userId, normalizeStrokesToTop(picked));
    return { source, updatedSource, continuation };
  }

  function insertText(afterBlockId: string | null = null) {
    if (!userId) return;
    const block = createTextBlock(userId, "");
    insertBlockRespectingSelection(block, afterBlockId);
    setActiveBlockId(block.id);
    setMenu(null);
  }

  async function startRecording(afterBlockId: string | null = null) {
    setMenu(null);
    if (recording) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, { mimeType: pickAudioMimeType() });
    const chunks: BlobPart[] = [];
    const startedAt = Date.now();
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const duration = Date.now() - startedAt;
      stream.getTracks().forEach((track) => track.stop());
      void finishAudio(blob, duration, afterBlockId);
    };
    recorder.start(1000);
    setRecording({ recorder, startedAt, afterBlockId });
  }

  function stopRecording() {
    if (!recording) return;
    recording.recorder.stop();
    setRecording(null);
  }

  async function finishAudio(blob: Blob, durationMs: number, afterBlockId: string | null) {
    if (!userId) return;
    const pendingId = crypto.randomUUID?.() ?? `pending-${Date.now()}`;
    const objectUrl = URL.createObjectURL(blob);
    setPendingAudios((current) => [...current, { id: pendingId, afterBlockId, durationMs, objectUrl, status: "uploading" }]);
    setSyncState("上传录音");
    try {
      const asset = await api.uploadAsset(blob, { kind: "audio", filename: `recording-${Date.now()}.webm`, contentType: blob.type || "audio/webm", durationMs });
      const block = createAudioBlock(userId, asset.id, durationMs);
      setPendingAudios((current) => {
        const target = current.find((item) => item.id === pendingId);
        if (target) URL.revokeObjectURL(target.objectUrl);
        return current.filter((item) => item.id !== pendingId);
      });
      insertBlockRespectingSelection(block, afterBlockId);
      const asrTask = await api.asrAudio(asset.id);
      setTask(asrTask);
    } catch (err) {
      const message = err instanceof Error ? err.message : "录音上传失败";
      setPendingAudios((current) => current.map((item) => (item.id === pendingId ? { ...item, status: "failed", error: message } : item)));
      setError(message);
    }
  }

  async function chooseImage(afterBlockId: string | null = null) {
    imageAfterBlockIdRef.current = afterBlockId;
    setMenu(null);
    try {
      const image = await captureImageFromCamera();
      await uploadImage(image, afterBlockId);
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
    insertBlockRespectingSelection(createImageBlock(userId, asset.id, image.width, image.height), afterBlockId);
  }

  function commitBlankHandwriting(strokes: Stroke[], height: number) {
    if (!userId) return;
    const block = createHandwritingBlock(userId, strokes);
    setBlockHeights((current) => ({ ...current, [block.id]: height }));
    applyBlock(block, visibleBlocks.at(-1)?.id ?? null);
    setActiveBlockId(block.id);
  }

  function updateHandwriting(block: ManuscriptHandwritingBlock, strokes: Stroke[]) {
    applyBlock(touchBlock({ ...block, props: { ...block.props, strokes } }));
  }

  function resizeHandwriting(blockId: string, height: number) {
    setBlockHeights((current) => ({ ...current, [blockId]: Math.max(height, current[blockId] ?? 220) }));
  }

  function handleTextInput(block: Extract<ManuscriptBlock, { type: "text" }>, content: string) {
    applyBlock(touchBlock({ ...block, props: { content } }));
  }

  function showBlockMenu(blockId: string | null, event: PointerEvent) {
    event.preventDefault();
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
    setActiveBlockId(blockId);
    setMenu({ blockId, x: Math.min(event.clientX, window.innerWidth - 188), y: Math.min(event.clientY, window.innerHeight - 220), selectedStrokeIds: selected?.blockId === blockId ? selected.strokeIds : [] });
  }

  function startLongPress(blockId: string | null, event: PointerEvent) {
    if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = window.setTimeout(() => showBlockMenu(blockId, event), 520);
  }

  function cancelLongPress() {
    if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
  }

  function splitSelectedAsNextLine() {
    const split = buildSelectedContinuation(selected?.blockId ?? null);
    if (!split) return;
    setBlockHeights((current) => ({ ...current, [split.continuation.id]: Math.max(120, estimateStrokeHeight(split.continuation.props.strokes)) }));
    setBlocks((current) => insertAfter(replaceBlock(current, split.updatedSource), split.continuation, split.source.id));
    queueOperation(upsertOperation(split.updatedSource));
    queueOperation(upsertOperation(split.continuation, split.source.id));
    setSelected(null);
    setMenu(null);
  }

  async function convert(mode: ConvertMode) {
    if (!manuscript) return;
    await flushOps();
    const taskResult = await api.convertManuscript(manuscript.id, mode, manuscript.title.replace(/手稿$/, "文档"));
    setTask(taskResult);
  }

  if (error && !manuscript) return <EditorMessage title="手稿加载失败" message={error} onBack={onBack} />;
  if (!manuscript) return <EditorMessage title="加载手稿" message="正在读取服务器上的 Block JSON" onBack={onBack} />;

  return (
    <section className="editor-screen manuscript-screen">
      <input accept="image/*" hidden onChange={onImageFile} ref={fileInputRef} type="file" />
      <header className="editor-topbar">
        <button className="ghost-button" onClick={onBack} type="button">返回</button>
        <div>
          <h1>{manuscript.title}</h1>
          <p>{syncState}</p>
        </div>
        <button className="primary-small" onClick={() => convert("meeting_minutes")} type="button">转文档</button>
      </header>

      {task && <TaskBanner task={task} />}
      {error && <button className="toast inline" onClick={() => setError(null)} type="button">{error}</button>}

      <div className="paper-toolbar">
        <button className={tool === "pen" ? "active" : ""} onClick={() => setTool("pen")} type="button">笔</button>
        <button className={tool === "highlighter" ? "active" : ""} onClick={() => setTool("highlighter")} type="button">荧光</button>
        <button className={tool === "eraser" ? "active" : ""} onClick={() => setTool("eraser")} type="button">橡皮</button>
        <button className={tool === "lasso" ? "active" : ""} onClick={() => setTool("lasso")} type="button">套索</button>
        <input aria-label="画笔颜色" onChange={(event) => setColor(event.target.value)} type="color" value={color} />
        <input aria-label="画笔粗细" max="9" min="1" onChange={(event) => setBrushWidth(Number(event.target.value))} type="range" value={brushWidth} />
      </div>

      <div className="capture-toolbar">
        <button onClick={() => (recording ? stopRecording() : startRecording(null))} type="button">{recording ? "停止录音" : "录音追加"}</button>
        <button onClick={() => chooseImage(null)} type="button">图片追加</button>
        <button onClick={() => insertText(null)} type="button">文字追加</button>
      </div>

      <article className="waterfall-paper" onPointerCancel={cancelLongPress} onPointerLeave={cancelLongPress} onPointerUp={cancelLongPress}>
        {visibleBlocks.map((block, index) => (
          <div key={block.id}>
            <div
              className={activeBlockId === block.id ? "paper-block active" : "paper-block"}
              onPointerDown={(event) => startLongPress(block.id, event)}
              onPointerMove={cancelLongPress}
            >
              {block.type === "text" && <textarea onChange={(event) => handleTextInput(block, event.target.value)} placeholder="输入文字" value={block.props.content} />}
              {block.type === "audio" && (
                <div className="audio-block">
                  <AudioAsset assetId={block.props.asset_id} />
                  <div>
                    <span>{formatDuration(block.props.duration_ms)}</span>
                    <p>{block.props.transcript || "录音已保存，ASR 完成后会写回转写文本。"}</p>
                  </div>
                </div>
              )}
              {block.type === "image" && (
                <figure className="image-block">
                  <AssetImage alt={block.props.caption || "手稿图片"} assetId={block.props.asset_id} />
                  <figcaption>{block.props.caption || "图片"}</figcaption>
                </figure>
              )}
              {block.type === "handwriting" && (
                <HandwritingCanvas
                  blockId={block.id}
                  brushWidth={brushWidth}
                  color={color}
                  height={blockHeights[block.id] ?? estimateStrokeHeight(block.props.strokes)}
                  isLast={index === visibleBlocks.length - 1}
                  onChange={(strokes) => updateHandwriting(block, strokes)}
                  onResize={(height) => resizeHandwriting(block.id, height)}
                  onSelectionChange={(blockId, strokeIds) => setSelected({ blockId, strokeIds })}
                  showBoundary={activeBlockId === block.id}
                  strokes={block.props.strokes}
                  tool={tool}
                />
              )}
            </div>
            {pendingAudios.filter((audio) => audio.afterBlockId === block.id).map((audio) => <PendingAudioBlock audio={audio} key={audio.id} />)}
          </div>
        ))}
        {pendingAudios.filter((audio) => audio.afterBlockId === null || !visibleBlocks.some((block) => block.id === audio.afterBlockId)).map((audio) => <PendingAudioBlock audio={audio} key={audio.id} />)}
        <div className="blank-paper-zone" onPointerDown={(event) => startLongPress(visibleBlocks.at(-1)?.id ?? null, event)} onPointerMove={cancelLongPress}>
          <BlankHandwritingCanvas brushWidth={brushWidth} color={color} onCommit={commitBlankHandwriting} tool={tool} />
        </div>
      </article>

      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => startRecording(menu.blockId)} type="button">开始录制</button>
          <button onClick={() => chooseImage(menu.blockId)} type="button">插入图片</button>
          <button onClick={() => insertText(menu.blockId)} type="button">插入文字</button>
          {menu.selectedStrokeIds.length > 0 && <button onClick={splitSelectedAsNextLine} type="button">选区作为下一行</button>}
          <button onClick={() => setMenu(null)} type="button">关闭</button>
        </div>
      )}
    </section>
  );
}

function PendingAudioBlock({ audio }: { audio: PendingAudio }) {
  return (
    <div className={audio.status === "failed" ? "paper-block pending-audio failed" : "paper-block pending-audio"}>
      <audio controls preload="metadata" src={audio.objectUrl} />
      <div>
        <span>{formatDuration(audio.durationMs)} · {audio.status === "failed" ? "上传失败" : "上传中"}</span>
        <p>{audio.error ?? "录音已在本机保留，上传完成后会写入手稿并开始 ASR。"}</p>
      </div>
    </div>
  );
}

function TaskBanner({ task }: { task: Task }) {
  return (
    <div className="task-banner">
      <span>{task.status}</span>
      <strong>{task.progress.message || task.type}</strong>
      <small>{task.progress.stage} · {task.progress.current}/{task.progress.total}</small>
    </div>
  );
}

function EditorMessage({ title, message, onBack }: { title: string; message: string; onBack: () => void }) {
  return (
    <section className="editor-screen centered">
      <h1>{title}</h1>
      <p>{message}</p>
      <button className="primary-button" onClick={onBack} type="button">返回</button>
    </section>
  );
}

function pickAudioMimeType() {
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
  return "audio/webm";
}

function estimateStrokeHeight(strokes: Stroke[]) {
  if (strokes.length === 0) return 220;
  const maxY = Math.max(...strokes.flatMap((stroke) => stroke.points.map((point) => point.y)));
  return Math.max(120, Math.ceil(maxY + 44));
}

function normalizeStrokesToTop(strokes: Stroke[]) {
  const minY = Math.min(...strokes.flatMap((stroke) => stroke.points.map((point) => point.y)));
  return strokes.map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point, y: Math.max(0, point.y - minY + 14) })) }));
}
