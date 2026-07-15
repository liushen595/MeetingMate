import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Layer, Line, Rect, Stage } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { pcApi, type AudioTranscription, type ImageRecognitionResult, type Task } from "../lib/api";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { ManuscriptBlock } from "../types/block";
import type { Manuscript } from "../types/manuscript";

type StrokeTool = "pen" | "highlighter" | "eraser" | "lasso";
type StrokePoint = { x: number; y: number; t: number; pressure: number };
type Stroke = {
  id: string;
  tool: StrokeTool;
  color: string;
  width: number;
  points: StrokePoint[];
};
type HandwritingBlock = ManuscriptBlock & {
  type: "handwriting";
  props: Record<string, unknown> & { strokes?: Stroke[] };
};
type TextBlock = ManuscriptBlock & {
  type: "text";
  props: Record<string, unknown> & { content?: string };
};
type AudioBlock = ManuscriptBlock & {
  type: "audio";
  props: Record<string, unknown> & {
    asset_id?: string;
    duration_ms?: number;
    transcript?: string;
    speaker_segments?: unknown[];
  };
};
type MenuState = {
  blockId: string | null;
  x: number;
  y: number;
  selectedStrokeIds: string[];
} | null;
type RenameDialogState = { manuscriptId: string; title: string };
type ConvertDialogState = {
  title: string;
  optimizeAudio: boolean;
  submitting: boolean;
};
type UiPointEvent = MouseEvent<Element> | ReactPointerEvent<Element>;
type DrawingState =
  | { mode: "none" }
  | { mode: "draw"; stroke: Stroke }
  | { mode: "erase" }
  | { mode: "lasso"; points: StrokePoint[] }
  | { mode: "drag"; pointer: StrokePoint; original: Stroke[] };
type EyeDropperConstructor = new () => {
  open: () => Promise<{ sRGBHex?: string }>;
};

const PEN_COLORS = [
  "#1f1b14",
  "#111827",
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#7c3aed",
];
const HIGHLIGHTER_COLORS = [
  "#fef08a",
  "#fde68a",
  "#bbf7d0",
  "#bfdbfe",
  "#fecdd3",
  "#ddd6fe",
];
const PEN_COLOR_KEY = "meetingmate.pen.color";
const PEN_WIDTH_KEY = "meetingmate.pen.width";
const HIGHLIGHTER_COLOR_KEY = "meetingmate.highlighter.color";
const HIGHLIGHTER_WIDTH_KEY = "meetingmate.highlighter.width";

export function ManuscriptPanel(): React.JSX.Element {
  const {
    addDocument,
    addManuscript,
    closeSelectedManuscript,
    manuscripts,
    openDocumentEditor,
    removeManuscript,
    selectedManuscriptId,
    selectManuscript,
    updateManuscript,
  } = useWorkspaceStore();
  const manuscript = manuscripts.find(
    (item) => item.id === selectedManuscriptId,
  );
  const [blocks, setBlocks] = useState<ManuscriptBlock[]>([]);
  const [tool, setTool] = useState<StrokeTool>("pen");
  const [penColor, setPenColorState] = useState(
    () => localStorage.getItem(PEN_COLOR_KEY) ?? "#1f1b14",
  );
  const [penWidth, setPenWidthState] = useState(() =>
    readStoredNumber(PEN_WIDTH_KEY, 3),
  );
  const [highlighterColor, setHighlighterColorState] = useState(
    () => localStorage.getItem(HIGHLIGHTER_COLOR_KEY) ?? "#fef08a",
  );
  const [highlighterWidth, setHighlighterWidthState] = useState(() =>
    readStoredNumber(HIGHLIGHTER_WIDTH_KEY, 6),
  );
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    blockId: string;
    strokeIds: string[];
  } | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [blockHeights, setBlockHeights] = useState<Record<string, number>>({});
  const [saveStatus, setSaveStatus] = useState("未同步");
  const [renameDialog, setRenameDialog] = useState<RenameDialogState | null>(
    null,
  );
  const [convertDialog, setConvertDialog] = useState<ConvertDialogState | null>(
    null,
  );
  const [convertTask, setConvertTask] = useState<Task | null>(null);
  const [convertError, setConvertError] = useState<string | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const openedDocumentTaskRef = useRef<string | null>(null);
  const lastSavedBlocksRef = useRef("");
  const isColorTool = tool === "pen" || tool === "highlighter";
  const color = tool === "highlighter" ? highlighterColor : penColor;
  const brushWidth = tool === "highlighter" ? highlighterWidth : penWidth;
  const palette = tool === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS;

  useEffect(() => {
    const nextBlocks = manuscript?.blocks ?? [];
    setBlocks(nextBlocks);
    lastSavedBlocksRef.current = JSON.stringify(nextBlocks);
    setSaveStatus("未同步");
    setMenu(null);
    setSelected(null);
  }, [manuscript?.id, manuscript?.blocks]);

  useEffect(() => {
    if (!manuscript) return;
    const serialized = JSON.stringify(blocks);
    if (serialized === lastSavedBlocksRef.current) return;

    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(() => {
      setSaveStatus("自动保存中");
      pcApi
        .saveManuscript({ ...manuscript, blocks })
        .then((savedManuscript) => {
          lastSavedBlocksRef.current = JSON.stringify(savedManuscript.blocks);
          updateManuscript(savedManuscript);
          setSaveStatus("已保存");
        })
        .catch(() => setSaveStatus("保存失败，将重试"));
    }, 700);

    return () => {
      if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    };
  }, [blocks, manuscript, updateManuscript]);

  useEffect(() => {
    if (!convertTask) return;
    if (
      convertTask.status === "succeeded" &&
      convertTask.result?.document_id &&
      openedDocumentTaskRef.current !== convertTask.id
    ) {
      openedDocumentTaskRef.current = convertTask.id;
      let active = true;
      pcApi
        .getDocument(convertTask.result.document_id)
        .then((document) => {
          if (!active) return;
          addDocument(document);
          openDocumentEditor(document.id);
        })
        .catch((error) => {
          if (active)
            setConvertError(
              error instanceof Error ? error.message : "生成文档加载失败",
            );
        });
      return () => {
        active = false;
      };
    }
    if (
      convertTask.status === "succeeded" ||
      convertTask.status === "failed" ||
      convertTask.status === "cancelled"
    )
      return;
    const timer = window.setInterval(() => {
      pcApi
        .getTask(convertTask.id)
        .then(setConvertTask)
        .catch((error) =>
          setConvertError(
            error instanceof Error ? error.message : "转换任务状态刷新失败",
          ),
        );
    }, 1800);
    return () => window.clearInterval(timer);
  }, [addDocument, convertTask, openDocumentEditor]);

  const createManuscript = async (): Promise<void> => {
    const nextManuscript = await pcApi.createManuscript("未命名手稿");
    if (nextManuscript) addManuscript(nextManuscript);
  };

  const openLocalManuscript = async (): Promise<void> => {
    window.alert("当前版本不支持打开本地手稿，请登录服务器后从库中打开。");
  };

  const confirmRename = async (): Promise<void> => {
    if (!renameDialog) return;
    const title = renameDialog.title.trim();
    if (!title) return;
    window.alert(
      "服务器契约暂未提供手稿重命名接口，当前版本不能重命名远端手稿。",
    );
    setRenameDialog(null);
  };

  const deleteManuscript = async (): Promise<void> => {
    if (!manuscript) return;
    if (
      !window.confirm(
        `确认删除手稿“${manuscript.title}”？此操作会同步删除本地数据库中的内容。`,
      )
    )
      return;
    await pcApi.deleteManuscript(manuscript.id);
    removeManuscript(manuscript.id);
  };

  async function persistBlocksNow(): Promise<Manuscript> {
    if (!manuscript) throw new Error("请先选择手稿");
    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    const serialized = JSON.stringify(blocks);
    if (serialized === lastSavedBlocksRef.current) return manuscript;
    setSaveStatus("保存中");
    const savedManuscript = await pcApi.saveManuscript({ ...manuscript, blocks });
    lastSavedBlocksRef.current = JSON.stringify(savedManuscript.blocks);
    setBlocks(savedManuscript.blocks);
    updateManuscript(savedManuscript);
    setSaveStatus("已保存");
    return savedManuscript;
  }

  const openConvertDialog = (): void => {
    if (!manuscript) return;
    setConvertError(null);
    setConvertDialog({
      title: defaultDocumentTitle(manuscript.title),
      optimizeAudio: false,
      submitting: false,
    });
  };

  const submitConvertDialog = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!manuscript || !convertDialog) return;
    const title = convertDialog.title.trim();
    if (!title) {
      setConvertError("文档标题不能为空");
      return;
    }
    const hasAudioWithoutTranscript = blocks.some(
      (block) =>
        block.type === "audio" &&
        !String(block.props.transcript ?? block.summary ?? "").trim(),
    );
    if (
      hasAudioWithoutTranscript &&
      !window.confirm(
        "存在尚未完成 ASR 的录音。继续转换会跳过或降级这些录音，是否继续？",
      )
    )
      return;
    setConvertDialog({ ...convertDialog, submitting: true });
    setConvertError(null);
    try {
      const savedManuscript = await persistBlocksNow();
      const task = await pcApi.convertManuscript(
        savedManuscript.id,
        title,
        convertDialog.optimizeAudio,
      );
      openedDocumentTaskRef.current = null;
      setConvertTask(task);
      setConvertDialog(null);
    } catch (error) {
      setConvertError(error instanceof Error ? error.message : "转文档失败");
      setConvertDialog({ ...convertDialog, submitting: false });
    }
  };

  const visibleBlocks = blocks;

  function applyBlock(
    block: ManuscriptBlock,
    afterBlockId: string | null = null,
  ) {
    setBlocks((current) => {
      const exists = current.some((item) => item.id === block.id);
      return exists
        ? current.map((item) => (item.id === block.id ? block : item))
        : insertAfter(current, block, afterBlockId);
    });
    setSaveStatus("等待自动保存");
  }

  function insertBlockRespectingSelection(
    block: ManuscriptBlock,
    afterBlockId: string | null,
  ) {
    const split = buildSelectedContinuation(afterBlockId);
    if (!split) {
      applyBlock(block, afterBlockId);
      return;
    }

    setBlockHeights((current) => ({
      ...current,
      [split.continuation.id]: Math.max(
        120,
        estimateStrokeHeight(split.continuation.props.strokes ?? []),
      ),
    }));
    setBlocks((current) =>
      insertAfter(
        insertAfter(
          replaceBlock(current, split.updatedSource),
          block,
          split.source.id,
        ),
        split.continuation,
        block.id,
      ),
    );
    setSelected(null);
    setSaveStatus("等待自动保存");
  }

  function buildSelectedContinuation(afterBlockId: string | null) {
    if (!selected?.strokeIds.length || selected.blockId !== afterBlockId)
      return null;
    const source = blocks.find(
      (block): block is HandwritingBlock =>
        block.id === selected.blockId && block.type === "handwriting",
    );
    if (!source) return null;
    const strokes = source.props.strokes ?? [];
    const picked = strokes.filter((stroke) =>
      selected.strokeIds.includes(stroke.id),
    );
    const remaining = strokes.filter(
      (stroke) => !selected.strokeIds.includes(stroke.id),
    );
    if (picked.length === 0) return null;
    const updatedSource = touchBlock({
      ...source,
      props: { ...source.props, strokes: remaining },
    });
    const continuation = createHandwritingBlock(normalizeStrokesToTop(picked));
    return { source, updatedSource, continuation };
  }

  function deleteManuscriptBlock(blockId: string) {
    const index = visibleBlocks.findIndex((block) => block.id === blockId);
    if (index === -1) return;
    const previous = visibleBlocks[index - 1];
    const next = visibleBlocks[index + 1];

    if (previous?.type === "handwriting" && next?.type === "handwriting") {
      const previousStrokes =
        (previous as HandwritingBlock).props.strokes ?? [];
      const nextStrokes = (next as HandwritingBlock).props.strokes ?? [];
      const previousHeight =
        blockHeights[previous.id] ?? estimateStrokeHeight(previousStrokes);
      const nextHeight =
        blockHeights[next.id] ?? estimateStrokeHeight(nextStrokes);
      const mergedStrokes = appendStrokesAtOffset(
        previousStrokes,
        nextStrokes,
        previousHeight,
      );
      const mergedBlock = touchBlock({
        ...(previous as HandwritingBlock),
        props: {
          ...(previous as HandwritingBlock).props,
          strokes: mergedStrokes,
        },
      });
      const mergedHeight = Math.max(
        previousHeight + nextHeight,
        estimateStrokeHeight(mergedStrokes),
      );

      setBlocks((current) =>
        current
          .filter((block) => block.id !== blockId && block.id !== next.id)
          .map((block) => (block.id === previous.id ? mergedBlock : block)),
      );
      setBlockHeights((current) => {
        const heights = { ...current, [previous.id]: mergedHeight };
        delete heights[blockId];
        delete heights[next.id];
        return heights;
      });
      setActiveBlockId(previous.id);
    } else {
      setBlocks((current) => current.filter((block) => block.id !== blockId));
      setBlockHeights((current) => {
        const heights = { ...current };
        delete heights[blockId];
        return heights;
      });
      if (activeBlockId === blockId) setActiveBlockId(null);
    }

    if (selected?.blockId === blockId || selected?.blockId === next?.id)
      setSelected(null);
    setMenu(null);
    setSaveStatus("等待自动保存");
  }

  function insertText(afterBlockId: string | null = null) {
    const block = createTextBlock("");
    insertBlockRespectingSelection(block, afterBlockId);
    setActiveBlockId(block.id);
    setMenu(null);
  }

  async function insertAudio(afterBlockId: string | null = null) {
    try {
      const file = await window.meetingMate?.selectAudioFile();
      if (!file) return;
      const audio = await pcApi.transcribeAudio(file);
      insertBlockRespectingSelection(createAudioBlock(audio), afterBlockId);
      setMenu(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  async function insertImage(afterBlockId: string | null = null) {
    try {
      const file = await window.meetingMate?.selectImageFile();
      if (!file) return;
      const result = await pcApi.recognizeImage(file);
      insertBlockRespectingSelection(createImageBlock(result), afterBlockId);
      setMenu(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  function commitBlankHandwriting(strokes: Stroke[], height: number) {
    const lastBlock = visibleBlocks[visibleBlocks.length - 1];
    if (lastBlock?.type === "handwriting") {
      const lastStrokes = (lastBlock as HandwritingBlock).props.strokes ?? [];
      const currentHeight =
        blockHeights[lastBlock.id] ?? estimateStrokeHeight(lastStrokes);
      const nextStrokes = appendStrokesAtOffset(
        lastStrokes,
        strokes,
        currentHeight,
      );
      const block = touchBlock({
        ...(lastBlock as HandwritingBlock),
        props: {
          ...(lastBlock as HandwritingBlock).props,
          strokes: nextStrokes,
        },
      });
      setBlockHeights((current) => ({
        ...current,
        [block.id]: Math.max(
          currentHeight + height,
          estimateStrokeHeight(nextStrokes),
        ),
      }));
      applyBlock(block);
      setActiveBlockId(block.id);
      return;
    }

    const block = createHandwritingBlock(strokes);
    setBlockHeights((current) => ({ ...current, [block.id]: height }));
    applyBlock(block, visibleBlocks[visibleBlocks.length - 1]?.id ?? null);
    setActiveBlockId(block.id);
  }

  function updateHandwriting(block: HandwritingBlock, strokes: Stroke[]) {
    applyBlock(touchBlock({ ...block, props: { ...block.props, strokes } }));
  }

  function resizeHandwriting(blockId: string, height: number) {
    setBlockHeights((current) => ({
      ...current,
      [blockId]: Math.max(height, current[blockId] ?? 220),
    }));
  }

  function handleTextInput(block: TextBlock, content: string) {
    if (content.length === 0) {
      deleteManuscriptBlock(block.id);
      return;
    }
    applyBlock(
      touchBlock({
        ...block,
        summary: content,
        props: { ...block.props, content },
      }),
    );
  }

  function showBlockMenu(blockId: string | null, event: UiPointEvent) {
    event.preventDefault();
    setActiveBlockId(blockId);
    setMenu({
      blockId,
      x: Math.min(event.clientX, window.innerWidth - 188),
      y: Math.min(event.clientY, window.innerHeight - 220),
      selectedStrokeIds:
        selected?.blockId === blockId ? selected.strokeIds : [],
    });
  }

  function startLongPress(blockId: string | null, event: ReactPointerEvent) {
    if (longPressTimerRef.current)
      window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = window.setTimeout(
      () => showBlockMenu(blockId, event),
      520,
    );
  }

  function cancelLongPress() {
    if (longPressTimerRef.current)
      window.clearTimeout(longPressTimerRef.current);
  }

  function splitSelectedAsNextLine() {
    const split = buildSelectedContinuation(selected?.blockId ?? null);
    if (!split) return;
    setBlockHeights((current) => ({
      ...current,
      [split.continuation.id]: Math.max(
        120,
        estimateStrokeHeight(split.continuation.props.strokes ?? []),
      ),
    }));
    setBlocks((current) =>
      insertAfter(
        replaceBlock(current, split.updatedSource),
        split.continuation,
        split.source.id,
      ),
    );
    setSelected(null);
    setMenu(null);
    setSaveStatus("等待自动保存");
  }

  function setActiveColor(nextColor: string) {
    if (tool === "highlighter") {
      setHighlighterColorState(nextColor);
      localStorage.setItem(HIGHLIGHTER_COLOR_KEY, nextColor);
      return;
    }
    setPenColorState(nextColor);
    localStorage.setItem(PEN_COLOR_KEY, nextColor);
  }

  function setActiveWidth(nextWidth: number) {
    const normalizedWidth = Math.max(1, Math.min(18, Math.round(nextWidth)));
    if (tool === "highlighter") {
      setHighlighterWidthState(normalizedWidth);
      localStorage.setItem(HIGHLIGHTER_WIDTH_KEY, String(normalizedWidth));
      return;
    }
    setPenWidthState(normalizedWidth);
    localStorage.setItem(PEN_WIDTH_KEY, String(normalizedWidth));
  }

  async function pickScreenColor() {
    const eyeDropper = getEyeDropper();
    if (!eyeDropper) {
      window.alert("当前系统或浏览器内核不支持取色器。请使用调色盘选择颜色。");
      return;
    }
    const result = await eyeDropper.open();
    if (result.sRGBHex) setActiveColor(result.sRGBHex);
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(620px,1fr)_300px] gap-px bg-slate-200">
      <aside className="min-h-0 overflow-auto bg-white p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">手稿</h2>
          <span className="rounded-full bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700">
            Paper
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            className="rounded-lg bg-emerald-600 px-2 py-2 text-xs font-medium text-white hover:bg-emerald-700"
            onClick={createManuscript}
            type="button"
          >
            新建
          </button>
          <button
            className="rounded-lg border border-slate-200 px-2 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            onClick={openLocalManuscript}
            type="button"
          >
            打开
          </button>
        </div>
        <div className="mt-4 space-y-2">
          {manuscripts.map((item) => (
            <button
              className={`w-full rounded-xl border p-3 text-left text-sm transition ${item.id === selectedManuscriptId ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
              key={item.id}
              onClick={() => selectManuscript(item.id)}
              type="button"
            >
              <div className="font-medium text-slate-950">{item.title}</div>
              <div className="mt-1 text-xs text-slate-500">
                {item.blocks.length} blocks
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="relative min-h-0 overflow-auto bg-[#f6f1e8] p-8">
        <header className="mb-5 flex items-center justify-between rounded-3xl border border-[#e4d7c4] bg-[#fffaf0] px-6 py-4 shadow-sm">
          <div>
            <h1 className="text-2xl font-bold text-[#2c2115]">
              {manuscript?.title ?? "选择或新建手稿"}
            </h1>
            <p className="mt-1 text-sm text-[#7c6a55]">
              {manuscript ? saveStatus : "长按稿纸可以选择插入位置"}
            </p>
          </div>
          <button
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            disabled={!manuscript || isConvertTaskRunning(convertTask)}
            onClick={openConvertDialog}
            type="button"
          >
            {isConvertTaskRunning(convertTask) ? "转换中" : "转文档"}
          </button>
        </header>

        {convertTask ? <ConvertTaskBanner task={convertTask} /> : null}
        {convertError ? (
          <button
            className="mx-auto mb-4 block max-w-4xl rounded-2xl bg-red-50 px-4 py-3 text-left text-sm text-red-700"
            onClick={() => setConvertError(null)}
            type="button"
          >
            {convertError}
          </button>
        ) : null}

        <div className="sticky top-4 z-40 mx-auto mb-4 flex w-fit flex-wrap items-center gap-2 rounded-2xl border border-[#e4d7c4] bg-[#fffaf0]/95 p-2 shadow-2xl backdrop-blur">
          {(["pen", "highlighter", "eraser", "lasso"] as StrokeTool[]).map(
            (item) => (
              <button
                className={`rounded-lg px-3 py-2 text-sm ${tool === item ? "bg-[#2c2115] text-white" : "bg-white text-[#2c2115]"}`}
                key={item}
                onClick={() => setTool(item)}
                type="button"
              >
                {item === "pen"
                  ? "笔"
                  : item === "highlighter"
                    ? "荧光"
                    : item === "eraser"
                      ? "橡皮"
                      : "套索"}
              </button>
            ),
          )}
          {isColorTool ? (
            <div className="flex items-center gap-2 rounded-xl bg-white px-2 py-1 shadow-sm">
              <span className="px-1 text-xs text-[#7c6a55]">
                {tool === "highlighter" ? "荧光笔" : "签字笔"}
              </span>
              <div className="flex gap-1">
                {palette.map((item) => (
                  <button
                    aria-label={`选择颜色 ${item}`}
                    className={`h-6 w-6 rounded-full border ${color.toLowerCase() === item.toLowerCase() ? "border-[#2c2115] ring-2 ring-[#2c2115]/20" : "border-slate-200"}`}
                    key={item}
                    onClick={() => setActiveColor(item)}
                    style={{ backgroundColor: item }}
                    type="button"
                  />
                ))}
              </div>
              <label className="flex cursor-pointer items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-[#2c2115] hover:bg-[#f8efe0]">
                调色盘
                <input
                  aria-label="调色盘"
                  className="h-0 w-0 opacity-0"
                  onChange={(event) => setActiveColor(event.target.value)}
                  type="color"
                  value={color}
                />
              </label>
              <button
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-[#2c2115] hover:bg-[#f8efe0]"
                onClick={() => void pickScreenColor()}
                type="button"
              >
                取色器
              </button>
              <span className="ml-1 text-xs text-[#7c6a55]">
                {brushWidth}px
              </span>
              <input
                aria-label="画笔粗细"
                max={tool === "highlighter" ? "18" : "9"}
                min="1"
                onChange={(event) => setActiveWidth(Number(event.target.value))}
                type="range"
                value={brushWidth}
              />
            </div>
          ) : null}
        </div>

        <article
          className="mx-auto max-w-4xl rounded-[32px] border border-[#e4d7c4] bg-[#fffaf0] p-6 shadow-sm"
          onPointerCancel={cancelLongPress}
          onPointerLeave={cancelLongPress}
          onPointerUp={cancelLongPress}
        >
          {visibleBlocks.map((block, index) => (
            <div key={block.id}>
              <div
                className={
                  activeBlockId === block.id
                    ? "rounded-xl outline outline-1 outline-[#7c5c2f]"
                    : "rounded-xl"
                }
                onContextMenu={(event) => showBlockMenu(block.id, event)}
                onPointerDown={(event) => startLongPress(block.id, event)}
                onPointerMove={cancelLongPress}
              >
                {block.type === "text" && (
                  <textarea
                    className="block min-h-24 w-full resize-none border-0 bg-transparent p-3 text-sm leading-7 text-[#2c2115] outline-none"
                    onChange={(event) =>
                      handleTextInput(block as TextBlock, event.target.value)
                    }
                    placeholder="输入文字"
                    value={String(block.props.content ?? "")}
                  />
                )}
                {block.type === "audio" && (
                  <AudioCard block={block as AudioBlock} />
                )}
                {block.type === "image" && (
                  <PaperCard
                    label="Image"
                    text={String(block.props.ocrText ?? block.summary)}
                  />
                )}
                {block.type === "handwriting" && (
                  <HandwritingCanvas
                    blockId={block.id}
                    brushWidth={brushWidth}
                    color={color}
                    height={
                      blockHeights[block.id] ??
                      estimateStrokeHeight(
                        (block as HandwritingBlock).props.strokes ?? [],
                      )
                    }
                    isLast={index === visibleBlocks.length - 1}
                    onChange={(strokes) =>
                      updateHandwriting(block as HandwritingBlock, strokes)
                    }
                    onResize={(height) => resizeHandwriting(block.id, height)}
                    onSelectionChange={(blockId, strokeIds) =>
                      setSelected({ blockId, strokeIds })
                    }
                    showBoundary={activeBlockId === block.id}
                    strokes={
                      ((block as HandwritingBlock).props.strokes ??
                        []) as Stroke[]
                    }
                    tool={tool}
                  />
                )}
              </div>
            </div>
          ))}
          <div
            className="blank-paper-zone mt-1"
            onContextMenu={(event) =>
              showBlockMenu(
                visibleBlocks[visibleBlocks.length - 1]?.id ?? null,
                event,
              )
            }
            onPointerDown={(event) =>
              startLongPress(
                visibleBlocks[visibleBlocks.length - 1]?.id ?? null,
                event,
              )
            }
            onPointerMove={cancelLongPress}
          >
            <BlankHandwritingCanvas
              brushWidth={brushWidth}
              color={color}
              onCommit={commitBlankHandwriting}
              tool={tool}
            />
          </div>
        </article>

        <div className="sticky bottom-6 z-40 mx-auto mt-6 flex w-fit items-center gap-2 rounded-2xl border border-[#e4d7c4] bg-[#fffaf0]/95 p-2 shadow-2xl backdrop-blur">
          <button
            className="rounded-xl bg-white px-4 py-3 text-sm font-medium text-[#2c2115] shadow-sm hover:bg-[#f8efe0] disabled:opacity-50"
            disabled={!manuscript}
            onClick={() => insertText(null)}
            type="button"
          >
            文字追加
          </button>
          <button
            className="rounded-xl bg-white px-4 py-3 text-sm font-medium text-[#2c2115] shadow-sm hover:bg-[#f8efe0] disabled:opacity-50"
            disabled={!manuscript}
            onClick={() => insertAudio(null)}
            type="button"
          >
            录音追加
          </button>
          <button
            className="rounded-xl bg-white px-4 py-3 text-sm font-medium text-[#2c2115] shadow-sm hover:bg-[#f8efe0] disabled:opacity-50"
            disabled={!manuscript}
            onClick={() => insertImage(null)}
            type="button"
          >
            图像追加
          </button>
        </div>

        {menu && (
          <div
            className="fixed z-50 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-sm shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              className="block w-full px-3 py-2 text-left hover:bg-slate-50"
              onClick={() => insertAudio(menu.blockId)}
              type="button"
            >
              开始录制
            </button>
            <button
              className="block w-full px-3 py-2 text-left hover:bg-slate-50"
              onClick={() => insertImage(menu.blockId)}
              type="button"
            >
              插入图片
            </button>
            <button
              className="block w-full px-3 py-2 text-left hover:bg-slate-50"
              onClick={() => insertText(menu.blockId)}
              type="button"
            >
              插入文字
            </button>
            {menu.selectedStrokeIds.length > 0 && (
              <button
                className="block w-full px-3 py-2 text-left hover:bg-slate-50"
                onClick={splitSelectedAsNextLine}
                type="button"
              >
                选区作为下一行
              </button>
            )}
            {menu.blockId && (
              <button
                className="block w-full px-3 py-2 text-left text-red-600 hover:bg-red-50"
                onClick={() =>
                  menu.blockId && deleteManuscriptBlock(menu.blockId)
                }
                type="button"
              >
                删除该块
              </button>
            )}
            <button
              className="block w-full px-3 py-2 text-left text-slate-500 hover:bg-slate-50"
              onClick={() => setMenu(null)}
              type="button"
            >
              关闭
            </button>
          </div>
        )}
      </section>

      <aside className="min-h-0 overflow-auto bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">手稿操作</h2>
        <div className="mt-4 grid gap-2">
          <button
            className="rounded-xl border border-slate-200 px-3 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            disabled={!manuscript}
            onClick={() =>
              manuscript &&
              setRenameDialog({
                manuscriptId: manuscript.id,
                title: manuscript.title,
              })
            }
            type="button"
          >
            重命名手稿
          </button>
          <button
            className="rounded-xl border border-slate-200 px-3 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            disabled={!manuscript}
            onClick={closeSelectedManuscript}
            type="button"
          >
            关闭手稿
          </button>
          <button
            className="rounded-xl border border-red-200 px-3 py-3 text-left text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            disabled={!manuscript}
            onClick={deleteManuscript}
            type="button"
          >
            删除手稿
          </button>
        </div>
      </aside>

      {renameDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/20"
          onClick={() => setRenameDialog(null)}
        >
          <div
            className="w-80 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-slate-950">
              重命名手稿
            </h3>
            <input
              autoFocus
              className="mt-4 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
              onChange={(event) =>
                setRenameDialog({ ...renameDialog, title: event.target.value })
              }
              value={renameDialog.title}
            />
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                onClick={() => setRenameDialog(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                onClick={confirmRename}
                type="button"
              >
                确认保存
              </button>
            </div>
          </div>
        </div>
      )}

      {convertDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 px-4"
          onClick={() => !convertDialog.submitting && setConvertDialog(null)}
        >
          <form
            className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            onSubmit={submitConvertDialog}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
                  Convert Manuscript
                </p>
                <h3 className="mt-1 text-lg font-semibold text-slate-950">
                  转为文档
                </h3>
              </div>
              <button
                className="rounded-full bg-slate-100 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 disabled:opacity-50"
                disabled={convertDialog.submitting}
                onClick={() => setConvertDialog(null)}
                type="button"
              >
                关闭
              </button>
            </div>
            <label className="mt-5 block text-sm font-medium text-slate-700">
              文档标题
              <input
                autoFocus
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-100"
                onChange={(event) =>
                  setConvertDialog({
                    ...convertDialog,
                    title: event.target.value,
                  })
                }
                required
                value={convertDialog.title}
              />
            </label>
            <label className="mt-4 flex items-center justify-between gap-4 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
              <span>
                <strong className="block text-slate-950">启用录音内容优化</strong>
                <small className="mt-1 block leading-5 text-slate-500">
                  由后端清理口水词和无意义重复，客户端只提交开关。
                </small>
              </span>
              <input
                checked={convertDialog.optimizeAudio}
                className="h-5 w-5"
                onChange={(event) =>
                  setConvertDialog({
                    ...convertDialog,
                    optimizeAudio: event.target.checked,
                  })
                }
                type="checkbox"
              />
            </label>
            <button
              className="mt-5 w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={convertDialog.submitting}
              type="submit"
            >
              {convertDialog.submitting ? "正在提交" : "开始转换"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function ConvertTaskBanner({ task }: { task: Task }): React.JSX.Element {
  const total = Math.max(1, task.progress?.total || 1);
  const current = Math.max(0, Math.min(task.progress?.current || 0, total));
  const percent = Math.round((current / total) * 100);
  return (
    <div className="mx-auto mb-4 max-w-4xl rounded-2xl bg-slate-950 px-4 py-3 text-sm text-white shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <strong className="block">{task.progress?.message || "转换任务已创建"}</strong>
          <span className="mt-1 block text-xs text-slate-300">
            {task.status} · {task.progress?.stage || "queued"} · {current}/{total}
          </span>
        </div>
        <span className="rounded-full bg-white/10 px-2 py-1 text-xs">
          {percent}%
        </span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-blue-400 transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
      {task.result?.warnings?.length ? (
        <p className="mt-2 text-xs text-amber-200">
          部分内容已降级处理：{task.result.warnings.length} 项
        </p>
      ) : null}
      {task.error?.message ? (
        <p className="mt-2 text-xs text-red-200">{task.error.message}</p>
      ) : null}
    </div>
  );
}

function PaperCard({
  label,
  text,
}: {
  label: string;
  text: string;
}): React.JSX.Element {
  return (
    <div className="my-1 rounded-xl bg-white/75 p-3 text-sm leading-7 text-[#2c2115] shadow-sm">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-[#7c5c2f]">
        {label}
      </span>
      {text}
    </div>
  );
}

function AudioCard({ block }: { block: AudioBlock }): React.JSX.Element {
  const assetId =
    typeof block.props.asset_id === "string" ? block.props.asset_id : "";
  const transcript = String(block.props.transcript ?? block.summary ?? "");
  const durationMs =
    typeof block.props.duration_ms === "number" ? block.props.duration_ms : 0;
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSrc(null);
    setError(null);
    if (!assetId) return;
    let active = true;
    let objectUrl: string | null = null;
    pcApi
      .getAssetObjectUrl(assetId)
      .then((url) => {
        objectUrl = url;
        if (active) setSrc(url);
        else URL.revokeObjectURL(url);
      })
      .catch((err) => {
        if (active)
          setError(err instanceof Error ? err.message : "音频加载失败");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);

  return (
    <div className="my-1 grid gap-3 rounded-xl bg-white/75 p-3 text-sm leading-7 text-[#2c2115] shadow-sm">
      {src ? (
        <audio className="w-full" controls preload="metadata" src={src} />
      ) : (
        <div className="rounded-lg bg-[#f8efe0] px-3 py-2 text-xs text-[#7c5c2f]">
          {assetId ? "音频加载中" : "音频资源缺失"}
        </div>
      )}
      <div>
        <span className="mb-1 block text-[11px] uppercase tracking-wide text-[#7c5c2f]">
          Audio · {formatDuration(durationMs)}
        </span>
        <p>{transcript || "录音已保存，ASR 完成后会写回转写文本。"}</p>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}

function BlankHandwritingCanvas({
  tool,
  color,
  brushWidth,
  onCommit,
}: {
  tool: StrokeTool;
  color: string;
  brushWidth: number;
  onCommit: (strokes: Stroke[], height: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);
  const [height, setHeight] = useState(220);
  const [draft, setDraft] = useState<Stroke[]>([]);
  const [activeStroke, setActiveStroke] = useState<Stroke | null>(null);

  useResizeWidth(containerRef, setWidth);

  function start(event: KonvaEventObject<globalThis.PointerEvent>) {
    if (tool === "lasso" || tool === "eraser") return;
    const point = pointFromEvent(event, width, height, true);
    if (!point) return;
    event.evt.preventDefault();
    const stroke: Stroke = {
      id: makeId("stroke"),
      tool: tool === "highlighter" ? "highlighter" : "pen",
      color,
      width: Math.round(brushWidth),
      points: [point],
    };
    setDraft([stroke]);
    setActiveStroke(stroke);
  }

  function move(event: KonvaEventObject<globalThis.PointerEvent>) {
    if (!activeStroke) return;
    const point = pointFromEvent(event, width, height, true);
    if (!point) return;
    event.evt.preventDefault();
    if (point.y > height - 36) setHeight(Math.ceil(point.y + 160));
    const nextStroke = {
      ...activeStroke,
      points: [...activeStroke.points, point],
    };
    setActiveStroke(nextStroke);
    setDraft([nextStroke]);
  }

  function end() {
    if (draft.length === 0) return;
    onCommit(draft, height);
    setDraft([]);
    setActiveStroke(null);
    setHeight(220);
  }

  return (
    <div
      className="relative min-h-[220px] rounded-2xl bg-white/50"
      ref={containerRef}
    >
      <Stage
        height={height}
        onPointerDown={start}
        onPointerLeave={end}
        onPointerMove={move}
        onPointerUp={end}
        width={width}
      >
        <Layer>
          <Rect fill="rgba(255,255,255,0.02)" height={height} width={width} />
          {draft.map((stroke) => (
            <StrokeLine key={stroke.id} selected={false} stroke={stroke} />
          ))}
        </Layer>
      </Stage>
      {draft.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-[#9a8265]">
          在空白稿纸写下去，会自动创建手写块
        </div>
      )}
    </div>
  );
}

function HandwritingCanvas({
  blockId,
  strokes,
  tool,
  color,
  brushWidth,
  height,
  isLast,
  showBoundary,
  onChange,
  onResize,
  onSelectionChange,
}: {
  blockId: string;
  strokes: Stroke[];
  tool: StrokeTool;
  color: string;
  brushWidth: number;
  height: number;
  isLast: boolean;
  showBoundary: boolean;
  onChange: (strokes: Stroke[]) => void;
  onResize: (height: number) => void;
  onSelectionChange: (blockId: string, strokeIds: string[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const strokesRef = useRef(strokes);
  const [width, setWidth] = useState(720);
  const [drawing, setDrawing] = useState<DrawingState>({ mode: "none" });
  const [lassoPoints, setLassoPoints] = useState<StrokePoint[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useResizeWidth(containerRef, setWidth);
  useEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);
  useEffect(() => {
    setSelectedIds((ids) =>
      ids.filter((id) => strokes.some((stroke) => stroke.id === id)),
    );
  }, [strokes]);

  const selectedBounds = getStrokeBounds(
    strokes.filter((stroke) => selectedIds.includes(stroke.id)),
  );

  function start(event: KonvaEventObject<globalThis.PointerEvent>) {
    const point = pointFromEvent(event, width, height, isLast);
    if (!point) return;
    event.evt.preventDefault();

    if (
      tool === "lasso" &&
      selectedBounds &&
      point.x >= selectedBounds.x - 16 &&
      point.x <= selectedBounds.maxX + 16 &&
      point.y >= selectedBounds.y - 16 &&
      point.y <= selectedBounds.maxY + 16
    ) {
      setDrawing({
        mode: "drag",
        pointer: point,
        original: strokesRef.current,
      });
      return;
    }
    if (tool === "lasso") {
      setLassoPoints([point]);
      setDrawing({ mode: "lasso", points: [point] });
      return;
    }
    if (tool === "eraser") {
      eraseAt(point);
      setDrawing({ mode: "erase" });
      return;
    }
    const stroke: Stroke = {
      id: makeId("stroke"),
      tool: tool === "highlighter" ? "highlighter" : "pen",
      color,
      width: Math.round(brushWidth),
      points: [point],
    };
    maybeExtend(point);
    setDrawing({ mode: "draw", stroke });
    const next = [...strokesRef.current, stroke];
    strokesRef.current = next;
    onChange(next);
  }

  function move(event: KonvaEventObject<globalThis.PointerEvent>) {
    const point = pointFromEvent(event, width, height, isLast);
    if (!point) return;
    event.evt.preventDefault();
    if (tool === "eraser" && drawing.mode === "erase") return eraseAt(point);
    if (drawing.mode === "draw") {
      maybeExtend(point);
      const nextStroke = {
        ...drawing.stroke,
        points: [...drawing.stroke.points, point],
      };
      setDrawing({ mode: "draw", stroke: nextStroke });
      const current = strokesRef.current.some(
        (stroke) => stroke.id === nextStroke.id,
      )
        ? strokesRef.current.map((stroke) =>
            stroke.id === nextStroke.id ? nextStroke : stroke,
          )
        : [...strokesRef.current, nextStroke];
      strokesRef.current = current;
      onChange(current);
      return;
    }
    if (drawing.mode === "lasso") {
      const nextPoints = [...drawing.points, point];
      setLassoPoints(nextPoints);
      setDrawing({ mode: "lasso", points: nextPoints });
      return;
    }
    if (drawing.mode === "drag") {
      const dx = point.x - drawing.pointer.x;
      const dy = point.y - drawing.pointer.y;
      const next = drawing.original.map((stroke) =>
        selectedIds.includes(stroke.id)
          ? {
              ...stroke,
              points: stroke.points.map((p) => ({
                ...p,
                x: clamp(p.x + dx, 0, width),
                y: clamp(p.y + dy, 0, height),
              })),
            }
          : stroke,
      );
      strokesRef.current = next;
      onChange(next);
    }
  }

  function end() {
    if (drawing.mode === "lasso") {
      const selected = selectStrokes(strokesRef.current, drawing.points);
      setSelectedIds(selected);
      onSelectionChange(blockId, selected);
    }
    setDrawing({ mode: "none" });
    setLassoPoints([]);
  }

  function maybeExtend(point: StrokePoint) {
    if (isLast && point.y > height - 36) onResize(Math.ceil(point.y + 160));
  }
  function eraseAt(point: StrokePoint) {
    const radius = Math.max(8, brushWidth * 2.4);
    const next = strokesRef.current.filter(
      (stroke) => !stroke.points.some((p) => distance(p, point) <= radius),
    );
    if (next.length !== strokesRef.current.length) {
      strokesRef.current = next;
      onChange(next);
    }
  }

  return (
    <div className="rounded-xl bg-white/40" ref={containerRef}>
      <Stage
        height={height}
        onPointerDown={start}
        onPointerLeave={end}
        onPointerMove={move}
        onPointerUp={end}
        width={width}
      >
        <Layer>
          {showBoundary && (
            <Rect
              dash={[8, 8]}
              height={height - 2}
              stroke="#7c5c2f"
              strokeWidth={1}
              width={width - 2}
              x={1}
              y={1}
            />
          )}
          {strokes.map((stroke) => (
            <StrokeLine
              key={stroke.id}
              selected={selectedIds.includes(stroke.id)}
              stroke={stroke}
            />
          ))}
          {lassoPoints.length > 1 && (
            <Line
              closed
              dash={[6, 6]}
              lineCap="round"
              lineJoin="round"
              points={lassoPoints.flatMap((point) => [point.x, point.y])}
              stroke="#2c6cff"
              strokeWidth={2}
            />
          )}
          {selectedBounds && (
            <Rect
              dash={[5, 6]}
              fill="rgba(44,108,255,0.05)"
              height={selectedBounds.maxY - selectedBounds.y + 18}
              stroke="#2c6cff"
              strokeWidth={1}
              width={selectedBounds.maxX - selectedBounds.x + 18}
              x={selectedBounds.x - 9}
              y={selectedBounds.y - 9}
            />
          )}
        </Layer>
      </Stage>
    </div>
  );
}

function StrokeLine({
  selected,
  stroke,
}: {
  selected: boolean;
  stroke: Stroke;
}): React.JSX.Element {
  return (
    <Line
      globalCompositeOperation={
        stroke.tool === "highlighter" ? "multiply" : "source-over"
      }
      lineCap="round"
      lineJoin="round"
      opacity={stroke.tool === "highlighter" ? 0.35 : 1}
      points={stroke.points.flatMap((point) => [point.x, point.y])}
      stroke={selected ? "#2c6cff" : stroke.color}
      strokeWidth={selected ? stroke.width + 1.2 : stroke.width}
      tension={0.42}
    />
  );
}

function useResizeWidth(
  ref: React.RefObject<HTMLDivElement | null>,
  setWidth: (width: number) => void,
) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const resize = () => setWidth(node.clientWidth || 720);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, setWidth]);
}

function createTextBlock(content: string): TextBlock {
  return {
    id: makeId("block"),
    type: "text",
    title: content ? firstLine(content) : "文字",
    timestamp: "刚刚",
    summary: content,
    props: { content },
  };
}
function createAudioBlock(audio: AudioTranscription): ManuscriptBlock {
  return {
    id: makeId("block"),
    type: "audio",
    title: "录音",
    timestamp: "刚刚",
    summary: audio.transcript,
    props: {
      asset_id: audio.assetId,
      duration_ms: audio.durationMs,
      transcript: audio.transcript,
      speaker_segments: audio.speakerSegments,
    },
  };
}
function createImageBlock(result: ImageRecognitionResult): ManuscriptBlock {
  return {
    id: makeId("block"),
    type: "image",
    title: "图片",
    timestamp: "刚刚",
    summary: result.text,
    props: {
      asset_id: result.assetId,
      caption: result.text,
      width: result.width,
      height: result.height,
      recognition_task_id: result.taskId,
      recognition_generated_at: result.generatedAt,
    },
  };
}
function createHandwritingBlock(strokes: Stroke[]): HandwritingBlock {
  return {
    id: makeId("block"),
    type: "handwriting",
    title: "手写",
    timestamp: "刚刚",
    summary: "手写内容",
    props: { strokes, aiText: "" },
  };
}
function touchBlock<T extends ManuscriptBlock>(block: T): T {
  return { ...block, timestamp: "刚刚" };
}
function insertAfter(
  blocks: ManuscriptBlock[],
  next: ManuscriptBlock,
  afterBlockId: string | null,
) {
  if (!afterBlockId) return [...blocks, next];
  const index = blocks.findIndex((block) => block.id === afterBlockId);
  return index === -1
    ? [...blocks, next]
    : [...blocks.slice(0, index + 1), next, ...blocks.slice(index + 1)];
}
function replaceBlock(blocks: ManuscriptBlock[], next: ManuscriptBlock) {
  return blocks.map((block) => (block.id === next.id ? next : block));
}
function pointFromEvent(
  event: KonvaEventObject<globalThis.PointerEvent>,
  width: number,
  height: number,
  isLast: boolean,
): StrokePoint | null {
  const pointer = event.target.getStage()?.getPointerPosition();
  if (!pointer) return null;
  return {
    x: clamp(pointer.x, 0, width),
    y: isLast ? Math.max(0, pointer.y) : clamp(pointer.y, 0, height),
    t: Math.round(performance.now()),
    pressure: event.evt.pressure || 0.5,
  };
}
function selectStrokes(strokes: Stroke[], polygon: StrokePoint[]) {
  if (polygon.length < 3) return [];
  return strokes
    .filter((stroke) =>
      stroke.points.some((point) => pointInPolygon(point, polygon)),
    )
    .map((stroke) => stroke.id);
}
function pointInPolygon(point: StrokePoint, polygon: StrokePoint[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (
      pi &&
      pj &&
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y || 1) + pi.x
    )
      inside = !inside;
  }
  return inside;
}
function getStrokeBounds(strokes: Stroke[]) {
  if (strokes.length === 0) return null;
  const points = strokes.flatMap((stroke) => stroke.points);
  return {
    x: Math.min(...points.map((point) => point.x)),
    y: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}
function estimateStrokeHeight(strokes: Stroke[]) {
  if (strokes.length === 0) return 220;
  return Math.max(
    120,
    Math.ceil(
      Math.max(
        ...strokes.flatMap((stroke) => stroke.points.map((point) => point.y)),
      ) + 44,
    ),
  );
}
function normalizeStrokesToTop(strokes: Stroke[]) {
  const minY = Math.min(
    ...strokes.flatMap((stroke) => stroke.points.map((point) => point.y)),
  );
  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({
      ...point,
      y: Math.max(0, point.y - minY + 14),
    })),
  }));
}
function appendStrokesAtOffset(
  existing: Stroke[],
  incoming: Stroke[],
  offsetY: number,
) {
  return [
    ...existing,
    ...incoming.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({
        ...point,
        y: point.y + offsetY,
      })),
    })),
  ];
}
function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
function distance(a: StrokePoint, b: StrokePoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function firstLine(value: string) {
  return value.split("\n")[0]?.slice(0, 32) ?? "";
}
function readStoredNumber(key: string, fallback: number) {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function getEyeDropper() {
  const candidate = (window as Window & { EyeDropper?: EyeDropperConstructor })
    .EyeDropper;
  return candidate ? new candidate() : null;
}

function defaultDocumentTitle(manuscriptTitle: string): string {
  const trimmed = manuscriptTitle.trim();
  if (!trimmed) return "未命名文档";
  return trimmed.endsWith("手稿") ? trimmed.replace(/手稿$/, "文档") : `${trimmed} 文档`;
}

function isConvertTaskRunning(task: Task | null): boolean {
  return Boolean(
    task &&
      task.status !== "succeeded" &&
      task.status !== "failed" &&
      task.status !== "cancelled",
  );
}
