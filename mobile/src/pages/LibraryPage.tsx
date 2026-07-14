import { useState } from "react";
import type { ReactNode } from "react";
import type { DocumentSummary, ManuscriptSummary } from "../types/api";
import { formatRelativeTime } from "../lib/ids";

interface LibraryPageProps {
  manuscripts: ManuscriptSummary[];
  documents: DocumentSummary[];
  loading: boolean;
  onCreateManuscript: () => Promise<void>;
  onCreateDocument: () => Promise<void>;
  onOpenManuscript: (id: string) => void;
  onOpenDocument: (id: string) => void;
  onRefresh: () => Promise<void>;
}

export function LibraryPage(props: LibraryPageProps) {
  const [tab, setTab] = useState<"all" | "manuscripts" | "documents">("all");
  const showManuscripts = tab === "all" || tab === "manuscripts";
  const showDocuments = tab === "all" || tab === "documents";
  return (
    <section className="screen library-screen">
      <header className="top-bar loose">
        <div>
          <p className="eyebrow">库</p>
          <h1>手稿与对应文档</h1>
        </div>
        <button className="icon-button" onClick={props.onRefresh} type="button">
          {props.loading ? "同步" : "刷新"}
        </button>
      </header>
      <div className="segmented-control">
        {(["all", "manuscripts", "documents"] as const).map((item) => (
          <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)} type="button">
            {item === "all" ? "全部" : item === "manuscripts" ? "手稿" : "文档"}
          </button>
        ))}
      </div>
      <div className="inline-actions">
        <button onClick={props.onCreateManuscript} type="button">新手稿</button>
        <button onClick={props.onCreateDocument} type="button">新文档</button>
      </div>
      {showManuscripts && (
        <ResourceGroup title="手稿">
          {props.manuscripts.map((item) => (
            <button className="library-card" key={item.id} onClick={() => props.onOpenManuscript(item.id)} type="button">
              <span className="card-kind">Manuscript</span>
              <strong>{item.title}</strong>
              <small>revision {item.revision} · {formatRelativeTime(item.updated_at)}</small>
            </button>
          ))}
          {props.manuscripts.length === 0 && <p className="empty-state">没有手稿。</p>}
        </ResourceGroup>
      )}
      {showDocuments && (
        <ResourceGroup title="文本文档">
          {props.documents.map((item) => (
            <button className="library-card document" key={item.id} onClick={() => props.onOpenDocument(item.id)} type="button">
              <span className="card-kind">Document</span>
              <strong>{item.title}</strong>
              <small>revision {item.revision} · {formatRelativeTime(item.updated_at)}</small>
            </button>
          ))}
          {props.documents.length === 0 && <p className="empty-state">没有文档。</p>}
        </ResourceGroup>
      )}
    </section>
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
