import { useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import type { DocumentSummary, ManuscriptSummary } from "../types/api";
import { formatRelativeTime } from "../lib/ids";

type ResourceKind = "manuscript" | "document";
type ResourceMenu = { kind: ResourceKind; id: string; title: string; x: number; y: number } | null;

interface LibraryPageProps {
  manuscripts: ManuscriptSummary[];
  documents: DocumentSummary[];
  loading: boolean;
  onCreateManuscript: () => Promise<void>;
  onCreateDocument: () => Promise<void>;
  onOpenManuscript: (id: string) => void;
  onOpenDocument: (id: string) => void;
  onDeleteManuscript: (id: string) => Promise<void>;
  onDeleteDocument: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function LibraryPage(props: LibraryPageProps) {
  const [tab, setTab] = useState<"all" | "manuscripts" | "documents">("all");
  const [menu, setMenu] = useState<ResourceMenu>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);
  const showManuscripts = tab === "all" || tab === "manuscripts";
  const showDocuments = tab === "all" || tab === "documents";
  const totalCount = props.manuscripts.length + props.documents.length;

  useEffect(() => {
    return () => cancelLongPress();
  }, []);

  function openMenu(kind: ResourceKind, item: ManuscriptSummary | DocumentSummary, point: { x: number; y: number }) {
    longPressedRef.current = true;
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
    setMenu({
      kind,
      id: item.id,
      title: item.title,
      x: Math.min(point.x, window.innerWidth - 188),
      y: Math.min(point.y, window.innerHeight - 160),
    });
  }

  function startLongPress(kind: ResourceKind, item: ManuscriptSummary | DocumentSummary, event: PointerEvent) {
    cancelLongPress();
    longPressedRef.current = false;
    const point = { x: event.clientX, y: event.clientY };
    longPressTimerRef.current = window.setTimeout(() => openMenu(kind, item, point), 520);
  }

  function cancelLongPress() {
    if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }

  function closeMenu() {
    setMenu(null);
    longPressedRef.current = false;
  }

  function openResource(kind: ResourceKind, id: string) {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    kind === "manuscript" ? props.onOpenManuscript(id) : props.onOpenDocument(id);
  }

  async function deleteResource() {
    if (!menu) return;
    if (!window.confirm(`删除「${menu.title}」？此操作无法撤销。`)) {
      closeMenu();
      return;
    }

    const currentMenu = menu;
    setDeletingId(currentMenu.id);
    setError(null);
    try {
      if (currentMenu.kind === "manuscript") await props.onDeleteManuscript(currentMenu.id);
      else await props.onDeleteDocument(currentMenu.id);
      closeMenu();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
      closeMenu();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="screen library-screen">
      <header className="library-hero">
        <div className="library-hero-top">
          <div>
            <p className="eyebrow">库</p>
            <h1>手稿与文档</h1>
          </div>
          <button className="icon-button library-refresh" disabled={props.loading} onClick={props.onRefresh} type="button">
            {props.loading ? "同步中" : "刷新"}
          </button>
        </div>
        <p className="library-copy">集中管理现场手稿和整理后的文档，共 {totalCount} 份内容。</p>
        {error && <button className="toast inline" onClick={() => setError(null)} type="button">{error}</button>}
        <div className="library-action-grid">
          <button className="library-action primary" onClick={() => void props.onCreateManuscript()} type="button">
            <span>创建新手稿</span>
            <small>录音、拍照、手写</small>
          </button>
          <button className="library-action" onClick={() => void props.onCreateDocument()} type="button">
            <span>创建新文档</span>
            <small>直接开始编辑</small>
          </button>
        </div>
        <div className="segmented-control library-tabs">
          {(["all", "manuscripts", "documents"] as const).map((item) => (
            <button aria-pressed={tab === item} className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)} type="button">
              {item === "all" ? "全部" : item === "manuscripts" ? "手稿" : "文档"}
            </button>
          ))}
        </div>
      </header>
      {showManuscripts && (
        <ResourceGroup title="手稿">
          {props.manuscripts.map((item) => (
            <ResourceCard
              item={item}
              key={item.id}
              kind="manuscript"
              onCancelLongPress={cancelLongPress}
              onOpen={openResource}
              onStartLongPress={startLongPress}
            />
          ))}
          {props.manuscripts.length === 0 && <p className="empty-state">没有手稿。</p>}
        </ResourceGroup>
      )}
      {showDocuments && (
        <ResourceGroup title="文本文档">
          {props.documents.map((item) => (
            <ResourceCard
              item={item}
              key={item.id}
              kind="document"
              onCancelLongPress={cancelLongPress}
              onOpen={openResource}
              onStartLongPress={startLongPress}
            />
          ))}
          {props.documents.length === 0 && <p className="empty-state">没有文档。</p>}
        </ResourceGroup>
      )}
      {menu && (
        <div className="context-menu-layer" onPointerDown={closeMenu}>
          <div className="context-menu" onPointerDown={(event) => event.stopPropagation()} style={{ left: menu.x, top: menu.y }}>
            <strong className="context-menu-title">{menu.title}</strong>
            <button className="danger-menu-button" disabled={deletingId === menu.id} onClick={() => void deleteResource()} type="button">
              {deletingId === menu.id ? "删除中" : "删除"}
            </button>
            <button onClick={closeMenu} type="button">关闭</button>
          </div>
        </div>
      )}
    </section>
  );
}

function ResourceCard({
  item,
  kind,
  onCancelLongPress,
  onOpen,
  onStartLongPress,
}: {
  item: ManuscriptSummary | DocumentSummary;
  kind: ResourceKind;
  onCancelLongPress: () => void;
  onOpen: (kind: ResourceKind, id: string) => void;
  onStartLongPress: (kind: ResourceKind, item: ManuscriptSummary | DocumentSummary, event: PointerEvent) => void;
}) {
  return (
    <button
      className={kind === "document" ? "library-card document" : "library-card"}
      onClick={() => onOpen(kind, item.id)}
      onContextMenu={(event) => event.preventDefault()}
      onPointerCancel={onCancelLongPress}
      onPointerDown={(event) => onStartLongPress(kind, item, event)}
      onPointerLeave={onCancelLongPress}
      onPointerMove={onCancelLongPress}
      onPointerUp={onCancelLongPress}
      type="button"
    >
      <span className="card-kind">{kind === "manuscript" ? "Manuscript" : "Document"}</span>
      <strong>{item.title}</strong>
      <small>revision {item.revision} · {formatRelativeTime(item.updated_at)}</small>
    </button>
  );
}

function ResourceGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="resource-group">
      <h2>{title}</h2>
      <div className="library-list">{children}</div>
    </section>
  );
}
