import { PointerEvent, useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { ManuscriptBlock } from "../types/block";

type RenameDialogState = {
  manuscriptId: string;
  title: string;
};

export function ManuscriptPanel(): React.JSX.Element {
  const {
    addDocument,
    addManuscript,
    closeSelectedManuscript,
    manuscripts,
    removeManuscript,
    selectedManuscriptId,
    selectManuscript,
    updateManuscript
  } = useWorkspaceStore();
  const manuscript = manuscripts.find((item) => item.id === selectedManuscriptId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastSavedTextRef = useRef("");
  const [captureText, setCaptureText] = useState("");
  const [draftManuscriptId, setDraftManuscriptId] = useState("");
  const [draftText, setDraftText] = useState("");
  const [renameDialog, setRenameDialog] = useState<RenameDialogState | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const createManuscript = async (): Promise<void> => {
    const nextManuscript = await window.meetingMate?.createManuscript();

    if (nextManuscript) {
      addManuscript(nextManuscript);
    }
  };

  const openLocalManuscript = async (): Promise<void> => {
    const nextManuscript = await window.meetingMate?.openLocalManuscript();

    if (nextManuscript) {
      addManuscript(nextManuscript);
    }
  };

  const confirmRename = async (): Promise<void> => {
    if (!renameDialog) {
      return;
    }

    const target = manuscripts.find((item) => item.id === renameDialog.manuscriptId);
    const title = renameDialog.title.trim();

    if (!target || !title || title === target.title) {
      setRenameDialog(null);
      return;
    }

    const renamed = await window.meetingMate?.renameManuscript({ id: target.id, title });

    if (renamed) {
      updateManuscript(renamed);
    }

    setRenameDialog(null);
  };

  const deleteManuscript = async (): Promise<void> => {
    if (!manuscript) {
      return;
    }

    const shouldDelete = window.confirm(`确认删除手稿“${manuscript.title}”？此操作会同步删除本地数据库中的内容。`);

    if (!shouldDelete) {
      return;
    }

    await window.meetingMate?.deleteManuscript(manuscript.id);
    removeManuscript(manuscript.id);
  };

  const exportToDocument = async (): Promise<void> => {
    if (!manuscript) {
      return;
    }

    const document = await window.meetingMate?.exportManuscriptToDocument(manuscript.id);

    if (document) {
      addDocument(document);
    }
  };

  const appendCaptureText = (text: string): void => {
    const value = text.trim();

    if (!value) {
      return;
    }

    setDraftText((current) => (current.trim() ? `${current.trim()}\n\n${value}` : value));
    setSaveStatus("idle");
  };

  const appendSpeechText = async (): Promise<void> => {
    const text = await window.meetingMate?.speechToText();

    if (text) {
      appendCaptureText(text);
    }
  };

  const appendImageText = async (): Promise<void> => {
    const text = await window.meetingMate?.imageToText();

    if (text) {
      appendCaptureText(text);
    }
  };

  const clearCanvas = (): void => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
  };

  const startDrawing = (event: PointerEvent<HTMLCanvasElement>): void => {
    const context = canvasRef.current?.getContext("2d");

    if (!context) {
      return;
    }

    drawingRef.current = true;
    context.beginPath();
    context.moveTo(event.nativeEvent.offsetX, event.nativeEvent.offsetY);
  };

  const draw = (event: PointerEvent<HTMLCanvasElement>): void => {
    const context = canvasRef.current?.getContext("2d");

    if (!context || !drawingRef.current) {
      return;
    }

    context.lineWidth = 2.4;
    context.lineCap = "round";
    context.strokeStyle = "#0f172a";
    context.lineTo(event.nativeEvent.offsetX, event.nativeEvent.offsetY);
    context.stroke();
  };

  const stopDrawing = (): void => {
    drawingRef.current = false;
  };

  useEffect(() => {
    const nextText = manuscript ? blocksToEditableText(manuscript.blocks) : "";
    lastSavedTextRef.current = nextText;
    setDraftManuscriptId(manuscript?.id ?? "");
    setDraftText(nextText);
    setSaveStatus("idle");
  }, [manuscript?.id, manuscript?.blocks]);

  useEffect(() => {
    if (!manuscript || draftManuscriptId !== manuscript.id || draftText === lastSavedTextRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSaveStatus("saving");
      window.meetingMate
        ?.saveManuscript({
          id: manuscript.id,
          title: manuscript.title,
          blocks: editableTextToBlocks(draftText)
        })
        .then((savedManuscript) => {
          lastSavedTextRef.current = blocksToEditableText(savedManuscript.blocks);
          updateManuscript(savedManuscript);
          setSaveStatus("saved");
        })
        .catch(() => {
          setSaveStatus("error");
        });
    }, 5000);

    return () => window.clearTimeout(timeoutId);
  }, [draftManuscriptId, draftText, manuscript, updateManuscript]);

  const saveStatusText = {
    idle: "草稿编辑中",
    saving: "保存中",
    saved: "已自动保存",
    error: "保存失败"
  }[saveStatus];

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(520px,1fr)_320px] gap-px bg-slate-200">
      <aside className="min-h-0 overflow-auto bg-white p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">手稿</h2>
          <span className="rounded-full bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700">采集入口</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button className="rounded-lg bg-emerald-600 px-2 py-2 text-xs font-medium text-white hover:bg-emerald-700" onClick={createManuscript} type="button">
            新建
          </button>
          <button className="rounded-lg border border-slate-200 px-2 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50" onClick={openLocalManuscript} type="button">
            打开
          </button>
        </div>
        <div className="mt-4 space-y-2">
          {manuscripts.map((item) => (
            <button
              className={`w-full rounded-xl border p-3 text-left text-sm transition ${
                item.id === selectedManuscriptId ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white hover:bg-slate-50"
              }`}
              key={item.id}
              onClick={() => selectManuscript(item.id)}
              type="button"
            >
              <div className="font-medium text-slate-950">{item.title}</div>
              <div className="mt-1 text-xs text-slate-500">{item.blocks.length} 个 blocks</div>
            </button>
          ))}
        </div>
      </aside>

      <section className="min-h-0 overflow-auto bg-slate-50 p-8">
        <div className="mx-auto max-w-4xl rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-6 flex items-start justify-between border-b border-slate-100 pb-5">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-emerald-500">Manuscript Editor</div>
              <h1 className="mt-2 text-2xl font-bold text-slate-950">{manuscript?.title ?? "空白手稿"}</h1>
              <p className="mt-2 text-sm text-slate-500">{manuscript ? saveStatusText : "请先新建或打开手稿"}</p>
            </div>
            {manuscript ? <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">{manuscript.source}</span> : null}
          </div>

          <textarea
            className="min-h-[340px] w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm leading-7 text-slate-800 outline-none transition focus:border-emerald-300 focus:bg-white focus:ring-4 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!manuscript}
            onChange={(event) => {
              setDraftText(event.target.value);
              setSaveStatus("idle");
            }}
            placeholder="在这里输入或粘贴手稿内容。右侧可以添加文字、语音识别、图片识别，下面可以直接用鼠标/触控板手写。"
            value={draftText}
          />

          <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-slate-900">手写区域</div>
                <div className="mt-1 text-xs text-slate-500">按住鼠标或触控板拖动即可书写。当前为端侧采集占位，后续可接手写识别 API。</div>
              </div>
              <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50" onClick={clearCanvas} type="button">
                清空
              </button>
            </div>
            <canvas
              className="h-56 w-full touch-none rounded-xl border border-dashed border-slate-300 bg-slate-50"
              height={224}
              onPointerCancel={stopDrawing}
              onPointerDown={startDrawing}
              onPointerLeave={stopDrawing}
              onPointerMove={draw}
              onPointerUp={stopDrawing}
              ref={canvasRef}
              width={780}
            />
          </div>
        </div>
      </section>

      <aside className="min-h-0 overflow-auto bg-white p-4">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-slate-900">手稿操作</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">从这里采集素材，并将手稿导出到文档库。</p>
        </div>

        <div className="space-y-3">
          <button
            className="w-full rounded-xl border border-slate-200 px-3 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!manuscript}
            onClick={() => manuscript && setRenameDialog({ manuscriptId: manuscript.id, title: manuscript.title })}
            type="button"
          >
            重命名手稿
          </button>
          <button
            className="w-full rounded-xl border border-slate-200 px-3 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!manuscript}
            onClick={closeSelectedManuscript}
            type="button"
          >
            关闭手稿
          </button>
          <button
            className="w-full rounded-xl border border-red-200 px-3 py-3 text-left text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!manuscript}
            onClick={deleteManuscript}
            type="button"
          >
            删除手稿
          </button>
          <button
            className="w-full rounded-xl bg-blue-600 px-3 py-3 text-left text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!manuscript}
            onClick={exportToDocument}
            type="button"
          >
            导出为文档
          </button>
        </div>

        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs font-semibold text-slate-700">文字输入</div>
          <textarea
            className="mt-2 min-h-24 w-full resize-none rounded-xl border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-700 outline-none focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
            onChange={(event) => setCaptureText(event.target.value)}
            placeholder="输入一段内容，添加到手稿正文"
            value={captureText}
          />
          <button
            className="mt-2 w-full rounded-xl bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!manuscript}
            onClick={() => {
              appendCaptureText(captureText);
              setCaptureText("");
            }}
            type="button"
          >
            添加文字
          </button>
        </div>

        <div className="mt-4 grid gap-2">
          <button
            className="rounded-xl border border-slate-200 px-3 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!manuscript}
            onClick={appendSpeechText}
            type="button"
          >
            语音输入 / 转文字
          </button>
          <button
            className="rounded-xl border border-slate-200 px-3 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!manuscript}
            onClick={appendImageText}
            type="button"
          >
            图片文字提取
          </button>
        </div>
      </aside>

      {renameDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/20" onClick={() => setRenameDialog(null)}>
          <div className="w-80 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-base font-semibold text-slate-950">重命名手稿</h3>
            <p className="mt-1 text-xs text-slate-500">输入新的手稿名称，确认后会同步保存到本地数据库。</p>
            <input
              autoFocus
              className="mt-4 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
              onChange={(event) => setRenameDialog({ ...renameDialog, title: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  confirmRename();
                }

                if (event.key === "Escape") {
                  setRenameDialog(null);
                }
              }}
              value={renameDialog.title}
            />
            <div className="mt-5 flex justify-end gap-2">
              <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50" onClick={() => setRenameDialog(null)} type="button">
                取消
              </button>
              <button
                className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!renameDialog.title.trim()}
                onClick={confirmRename}
                type="button"
              >
                确认保存
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function blocksToEditableText(blocks: ManuscriptBlock[]): string {
  return blocks
    .map((block) => {
      if (typeof block.props.content === "string") {
        return block.props.content;
      }

      if (typeof block.props.transcript === "string") {
        return block.props.transcript;
      }

      if (typeof block.props.aiText === "string") {
        return block.props.aiText;
      }

      if (typeof block.props.ocrText === "string") {
        return block.props.ocrText;
      }

      return [block.title, block.summary].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function editableTextToBlocks(text: string): ManuscriptBlock[] {
  return text
    .split(/\n{2,}/)
    .map((section) => section.trim())
    .filter(Boolean)
    .map((section, index) => ({
      id: `mb-text-${index}`,
      type: "text",
      title: firstLine(section) || `文本片段 ${index + 1}`,
      timestamp: "编辑中",
      summary: section,
      props: { content: section }
    }));
}

function firstLine(value: string): string {
  return value.split("\n")[0]?.slice(0, 32) ?? "";
}
