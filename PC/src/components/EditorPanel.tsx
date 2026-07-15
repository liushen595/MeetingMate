import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BaseEditor, createEditor, Descendant } from "slate";
import { Editable, ReactEditor, RenderElementProps, Slate, withReact } from "slate-react";
import { pcApi } from "../lib/api";
import type { DocumentBlock } from "../types/block";
import { useWorkspaceStore } from "../stores/workspaceStore";

type SlateText = {
  text: string;
};

type SlateBlock = {
  type: "heading" | "paragraph" | "list" | "quote" | "action" | "image";
  props?: Record<string, unknown>;
  sourceRefs?: unknown[];
  children: SlateText[];
};

declare module "slate" {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor;
    Element: SlateBlock;
    Text: SlateText;
  }
}

export function EditorPanel(): React.JSX.Element {
  const editor = useMemo(() => withReact(createEditor()), []);
  const document = useWorkspaceStore((state) =>
    state.documents.find((item) => item.id === state.selectedDocumentId)
  );
  const updateDocument = useWorkspaceStore((state) => state.updateDocument);
  const setSaveStatus = useWorkspaceStore((state) => state.setSaveStatus);
  const conversionNotice = useWorkspaceStore((state) => state.conversionNotice);
  const setConversionNotice = useWorkspaceStore((state) => state.setConversionNotice);
  const activeConversionNotice = conversionNotice?.documentId === document?.id ? conversionNotice : null;
  const [editorValue, setEditorValue] = useState<Descendant[]>(() => blocksToSlateValue(document?.blocks ?? []));
  const [editorDocumentId, setEditorDocumentId] = useState(document?.id ?? "");
  const [editorRevision, setEditorRevision] = useState(0);
  const lastSavedValueRef = useRef(serializeValue(editorValue));

  useEffect(() => {
    const nextValue = blocksToSlateValue(document?.blocks ?? []);
    lastSavedValueRef.current = serializeValue(nextValue);
    setEditorDocumentId(document?.id ?? "");
    setEditorValue(nextValue);
    setEditorRevision((revision) => revision + 1);
  }, [document?.id, document?.blocks]);

  useEffect(() => {
    const serializedValue = serializeValue(editorValue);

    if (!document || editorDocumentId !== document.id || serializedValue === lastSavedValueRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const nextBlocks = slateValueToBlocks(editorValue);
      setSaveStatus("saving");
      pcApi.saveDocument({
          ...document,
          title: getTitleFromBlocks(nextBlocks, document.title),
          blocks: nextBlocks
        })
        .then((savedDocument) => {
          const savedValue = blocksToSlateValue(savedDocument.blocks);
          lastSavedValueRef.current = serializeValue(savedValue);
          updateDocument(savedDocument);
          setSaveStatus("saved");
        })
        .catch(() => {
          setSaveStatus("error");
        });
    }, 5000);

    return () => window.clearTimeout(timeoutId);
  }, [document, editorDocumentId, editorValue, setSaveStatus, updateDocument]);

  const renderElement = useCallback((props: RenderElementProps) => <Element {...props} />, []);

  if (!document) {
    return (
      <section className="min-h-0 overflow-auto bg-slate-50 px-10 py-8">
        <div className="mx-auto max-w-3xl rounded-3xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          当前没有选中的文档。
        </div>
      </section>
    );
  }

  return (
    <section className="min-h-0 overflow-auto bg-slate-50 px-10 py-8">
      <div className="mx-auto max-w-4xl rounded-3xl border border-slate-200 bg-white p-10 shadow-sm">
        <div className="mb-8 flex items-center justify-between border-b border-slate-100 pb-5">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Slate Document Editor</div>
            <div className="mt-2 text-sm text-slate-500">正式文档编辑器，停止输入 5 秒后自动保存。</div>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">{document.status}</span>
        </div>
        {activeConversionNotice ? (
          <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-medium">部分手写内容已降级处理</div>
                <ul className="mt-2 space-y-1">
                  {activeConversionNotice.warnings.map((warning) => (
                    <li key={`${warning.block_id}-${warning.code}`}>{warning.message || warning.code}</li>
                  ))}
                </ul>
              </div>
              <button className="rounded-lg px-2 py-1 text-xs text-amber-800 hover:bg-amber-100" onClick={() => setConversionNotice(null)} type="button">关闭</button>
            </div>
          </div>
        ) : null}
        <Slate
          key={`${document.id}-${editorRevision}`}
          editor={editor}
          initialValue={editorValue}
          onChange={(value) => {
            setEditorValue(value);

            if (editor.operations.some((operation) => operation.type !== "set_selection")) {
              setSaveStatus("idle");
            }
          }}
        >
          <Editable
            className="min-h-[620px] rounded-2xl border border-slate-100 bg-slate-50 px-8 py-7 text-slate-800 outline-none focus:border-blue-200 focus:bg-white focus:ring-4 focus:ring-blue-100"
            placeholder="开始编辑正式文档..."
            renderElement={renderElement}
            spellCheck
          />
        </Slate>
        <div className="mt-4 text-xs leading-5 text-slate-400">
          支持基础块：标题、段落、列表、引用、行动项。当前版本保留原有 Block JSON 存储结构，后续可继续扩展工具栏和快捷键。
        </div>
      </div>
    </section>
  );
}

function Element({ attributes, children, element }: RenderElementProps): React.JSX.Element {
  if (element.type === "heading") {
    return (
      <h2 className="mb-5 mt-2 text-3xl font-bold tracking-tight text-slate-950" {...attributes}>
        {children}
      </h2>
    );
  }

  if (element.type === "list") {
    return (
      <div className="my-4 rounded-xl bg-slate-100 px-4 py-3 leading-7 text-slate-700" {...attributes}>
        {children}
      </div>
    );
  }

  if (element.type === "quote") {
    return (
      <blockquote className="my-4 border-l-4 border-blue-500 bg-blue-50 px-4 py-3 leading-7 text-slate-700" {...attributes}>
        {children}
      </blockquote>
    );
  }

  if (element.type === "action") {
    return (
      <div className="my-4 rounded-xl bg-emerald-50 px-4 py-3 leading-7 text-emerald-800" {...attributes}>
        {children}
      </div>
    );
  }

  if (element.type === "image") {
    const extractedText = element.children.map((child) => child.text).join("");
    const assetId = typeof element.props?.asset_id === "string" ? element.props.asset_id : "";
    return (
      <figure className="my-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" {...attributes}>
        <div contentEditable={false}>
          <DocumentAssetImage assetId={assetId} />
        </div>
        <figcaption className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-600">{children || extractedText}</figcaption>
      </figure>
    );
  }

  return (
    <p className="my-4 leading-8 text-slate-700" {...attributes}>
      {children}
    </p>
  );
}

function DocumentAssetImage({ assetId }: { assetId: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!assetId) return;
    let active = true;
    let objectUrl: string | null = null;
    setSrc(null);
    setError(null);
    pcApi
      .getAssetObjectUrl(assetId)
      .then((url) => {
        objectUrl = url;
        if (active) setSrc(url);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "图片加载失败");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);

  if (src) return <img alt="文档图片原图" className="max-h-[460px] w-full rounded-xl object-contain" src={src} />;
  return <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">{error ?? "图片加载中"}</div>;
}

function blocksToSlateValue(blocks: DocumentBlock[]): Descendant[] {
  if (blocks.length === 0) {
    return [{ type: "paragraph", children: [{ text: "" }] }];
  }

  return blocks.map((block) => {
    if (block.type === "list") {
      return {
      type: "list",
      sourceRefs: block.sourceRefs,
      children: [{ text: [block.content, ...(block.items ?? []).map((item) => `- ${item}`)].join("\n") }]
      };
    }

    return {
      type: block.type,
      props: block.props,
      sourceRefs: block.sourceRefs,
      children: [{ text: block.content }]
    };
  });
}

function slateValueToBlocks(value: Descendant[]): DocumentBlock[] {
  return value.map((node, index) => {
    const element = node as SlateBlock;
    const content = element.children.map((child) => child.text).join("");

    if (element.type === "list") {
      const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
      const items = lines.filter((line) => line.startsWith("- ")).map((line) => line.replace(/^-\s+/, ""));

      return {
        id: `slate-${index}`,
        type: "list",
        content: lines.find((line) => !line.startsWith("- ")) ?? "列表",
        items,
        sourceRefs: element.sourceRefs,
      };
    }

    if (element.type === "image") {
      return {
        id: `slate-${index}`,
        type: "image",
        content,
        props: { ...element.props, caption: content },
        sourceRefs: element.sourceRefs,
      };
    }

    return {
      id: `slate-${index}`,
      type: element.type,
      content,
      sourceRefs: element.sourceRefs,
    };
  });
}

function serializeValue(value: Descendant[]): string {
  return JSON.stringify(value);
}

function getTitleFromBlocks(blocks: DocumentBlock[], fallback: string): string {
  const heading = blocks.find((block) => block.type === "heading");
  return heading?.content || fallback;
}
