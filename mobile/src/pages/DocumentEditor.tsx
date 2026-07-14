import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { api } from "../lib/api";
import {
  createDocumentImageBlock,
  createHeadingBlock,
  createListBlock,
  createParagraphBlock,
  createQuoteBlock,
  insertAfter,
  mergeServerBlocks,
  replaceBlock,
  touchBlock,
  upsertOperation,
} from "../lib/blocks";
import { captureImageFromCamera, readImageFile } from "../lib/media";
import { readSseText } from "../lib/sse";
import type { Document, DocumentBlock, SyncOperation, Task } from "../types/api";
import { AssetImage } from "../components/AssetImage";

interface DocumentEditorProps {
  id: string;
  onBack: () => void;
}

type PendingOp = SyncOperation<DocumentBlock>;

export function DocumentEditor({ id, onBack }: DocumentEditorProps) {
  const [document, setDocument] = useState<Document | null>(null);
  const [revision, setRevision] = useState(0);
  const [blocks, setBlocks] = useState<DocumentBlock[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [syncState, setSyncState] = useState("未同步");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentDraft, setAgentDraft] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageAfterBlockIdRef = useRef<string | null>(null);
  const pendingOpsRef = useRef<PendingOp[]>([]);
  const syncTimerRef = useRef<number | null>(null);
  const userId = api.currentSession?.user.id ?? "";

  const visibleBlocks = useMemo(() => blocks.filter((block) => !block.deleted), [blocks]);
  const selectedBlocks = useMemo(() => visibleBlocks.filter((block) => selectedIds.includes(block.id)), [selectedIds, visibleBlocks]);

  useEffect(() => {
    let active = true;
    api
      .getDocument(id)
      .then((data) => {
        if (!active) return;
        setDocument(data);
        setRevision(data.revision);
        setBlocks(data.blocks.filter((block) => !block.deleted));
        setSelectedIds(data.blocks[0] ? [data.blocks[0].id] : []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "文档加载失败"));
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    if (!task || task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") return;
    const timer = window.setInterval(async () => {
      const next = await api.getTask(task.id);
      setTask(next);
      if (next.status === "succeeded" && next.result?.export_id) {
        const download = await api.getExportDownloadUrl(next.result.export_id);
        window.open(download.download_url, "_blank");
      }
    }, 1800);
    return () => window.clearInterval(timer);
  }, [task]);

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

  function applyBlock(block: DocumentBlock, afterBlockId: string | null = null) {
    setBlocks((current) => {
      const exists = current.some((item) => item.id === block.id);
      return exists ? replaceBlock(current, block) : insertAfter(current, block, afterBlockId);
    });
    queueOperation(upsertOperation(block, afterBlockId));
  }

  function insertBlock(kind: "paragraph" | "heading" | "list" | "quote") {
    if (!userId) return;
    const after = selectedIds.at(-1) ?? visibleBlocks.at(-1)?.id ?? null;
    const block =
      kind === "heading"
        ? createHeadingBlock(userId)
        : kind === "list"
          ? createListBlock(userId)
          : kind === "quote"
            ? createQuoteBlock(userId)
            : createParagraphBlock(userId);
    applyBlock(block, after);
    setSelectedIds([block.id]);
  }

  function updateBlock(block: DocumentBlock) {
    applyBlock(touchBlock(block));
  }

  function toggleSelect(blockId: string) {
    setSelectedIds((current) => (current.includes(blockId) ? current.filter((id) => id !== blockId) : [...current, blockId]));
  }

  async function chooseImage() {
    imageAfterBlockIdRef.current = selectedIds.at(-1) ?? visibleBlocks.at(-1)?.id ?? null;
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
    applyBlock(block, afterBlockId);
    setSelectedIds([block.id]);
  }

  async function runAgent() {
    if (!agentPrompt.trim()) return;
    await flushOps();
    setAgentBusy(true);
    setAgentDraft("");
    setError(null);
    try {
      const response = await api.streamAgent(id, selectedIds, agentPrompt.trim(), "rewrite");
      let full = "";
      await readSseText(response, (text) => {
        full += text;
        setAgentDraft(full);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent 请求失败");
    } finally {
      setAgentBusy(false);
    }
  }

  function applyAgentDraft() {
    if (!agentDraft.trim() || !userId) return;
    const target = selectedBlocks[0] ?? visibleBlocks[0];
    if (!target) {
      const block = createParagraphBlock(userId, agentDraft.trim());
      applyBlock(block, null);
      setSelectedIds([block.id]);
    } else if ("content" in target.props) {
      updateBlock({ ...target, props: { ...target.props, content: agentDraft.trim() } } as DocumentBlock);
      setSelectedIds([target.id]);
    } else {
      const block = createParagraphBlock(userId, agentDraft.trim());
      applyBlock(block, target.id);
      setSelectedIds([block.id]);
    }
    setAgentDraft("");
    setAgentPrompt("");
  }

  async function exportFile(format: "pdf" | "docx") {
    await flushOps();
    const nextTask = await api.exportDocument(id, format);
    setTask(nextTask);
  }

  if (error && !document) return <DocumentMessage title="文档加载失败" message={error} onBack={onBack} />;
  if (!document) return <DocumentMessage title="加载文档" message="正在读取 DocumentBlock JSON" onBack={onBack} />;

  return (
    <section className="editor-screen document-screen">
      <input accept="image/*" hidden onChange={onImageFile} ref={fileInputRef} type="file" />
      <header className="editor-topbar docbar">
        <button className="ghost-button" onClick={onBack} type="button">返回</button>
        <div>
          <h1>{document.title}</h1>
          <p>{syncState} · revision {revision}</p>
        </div>
        <button className="primary-small" onClick={() => exportFile("pdf")} type="button">PDF</button>
      </header>
      {task && <div className="task-banner"><span>{task.type}</span><strong>{task.progress.message}</strong><small>{task.status}</small></div>}
      {error && <button className="toast inline" onClick={() => setError(null)} type="button">{error}</button>}

      <aside className="agent-panel">
        <div>
          <p className="eyebrow">Agent 代理操作</p>
          <h2>{selectedBlocks.length > 0 ? `将修改 ${selectedBlocks.length} 个选中块` : "可基于全文给出修改"}</h2>
        </div>
        <textarea onChange={(event) => setAgentPrompt(event.target.value)} placeholder="例如：把选中的段落改成更正式的会议纪要语气，并压缩到三句话。" value={agentPrompt} />
        <div className="agent-actions">
          <button className="primary-small" disabled={agentBusy} onClick={runAgent} type="button">{agentBusy ? "生成中" : "交给 Agent"}</button>
          <button disabled={!agentDraft.trim()} onClick={applyAgentDraft} type="button">应用结果</button>
        </div>
        {agentDraft && <pre className="agent-draft">{agentDraft}</pre>}
      </aside>

      <div className="document-toolbar">
        <button onClick={() => insertBlock("paragraph")} type="button">段落</button>
        <button onClick={() => insertBlock("heading")} type="button">标题</button>
        <button onClick={() => insertBlock("list")} type="button">列表</button>
        <button onClick={() => insertBlock("quote")} type="button">引用</button>
        <button onClick={chooseImage} type="button">图片</button>
        <button onClick={() => exportFile("docx")} type="button">DOCX</button>
      </div>

      <article className="document-paper">
        {visibleBlocks.length === 0 && <button className="empty-document" onClick={() => insertBlock("paragraph")} type="button">添加第一个段落</button>}
        {visibleBlocks.map((block) => (
          <DocumentBlockEditor block={block} key={block.id} onChange={updateBlock} onSelect={toggleSelect} selected={selectedIds.includes(block.id)} />
        ))}
      </article>
    </section>
  );
}

function DocumentBlockEditor({ block, selected, onSelect, onChange }: { block: DocumentBlock; selected: boolean; onSelect: (id: string) => void; onChange: (block: DocumentBlock) => void }) {
  const shellClass = selected ? "doc-block selected" : "doc-block";
  return (
    <section className={shellClass}>
      <button className="block-selector" onClick={() => onSelect(block.id)} type="button">{selected ? "已选" : "选择"}</button>
      {block.type === "paragraph" && <textarea onChange={(event) => onChange({ ...block, props: { content: event.target.value } })} placeholder="段落" value={block.props.content} />}
      {block.type === "heading" && (
        <div className="heading-editor">
          <select onChange={(event) => onChange({ ...block, props: { ...block.props, level: Number(event.target.value) as 1 | 2 | 3 } })} value={block.props.level}>
            <option value={1}>H1</option>
            <option value={2}>H2</option>
            <option value={3}>H3</option>
          </select>
          <input onChange={(event) => onChange({ ...block, props: { ...block.props, content: event.target.value } })} placeholder="标题" value={block.props.content} />
        </div>
      )}
      {block.type === "list" && (
        <textarea
          onChange={(event) => onChange({ ...block, props: { ...block.props, items: event.target.value.split("\n") } })}
          placeholder="每行一个列表项"
          value={block.props.items.join("\n")}
        />
      )}
      {block.type === "quote" && <textarea className="quote-input" onChange={(event) => onChange({ ...block, props: { content: event.target.value } })} placeholder="引用" value={block.props.content} />}
      {block.type === "image" && (
        <figure className="image-block">
          <AssetImage alt={block.props.caption || "文档图片"} assetId={block.props.asset_id} />
          <input onChange={(event) => onChange({ ...block, props: { ...block.props, caption: event.target.value } })} placeholder="图片说明" value={block.props.caption} />
        </figure>
      )}
      {block.type === "table" && (
        <textarea
          onChange={(event) => onChange({ ...block, props: { rows: event.target.value.split("\n").map((row) => row.split("\t")) } })}
          value={block.props.rows.map((row) => row.join("\t")).join("\n")}
        />
      )}
      {block.type === "code" && <textarea className="code-input" onChange={(event) => onChange({ ...block, props: { ...block.props, content: event.target.value } })} value={block.props.content} />}
      {block.source_refs && block.source_refs.length > 0 && <small className="source-ref">来源 {block.source_refs.length} 处</small>}
    </section>
  );
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
