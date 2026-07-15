import type { DocumentSummary, ManuscriptSummary } from "../types/api";
import { formatRelativeTime } from "../lib/ids";

interface HomePageProps {
  manuscripts: ManuscriptSummary[];
  documents: DocumentSummary[];
  loading: boolean;
  onCreateManuscript: () => Promise<void>;
  onCreateDocument: () => Promise<void>;
  onOpenManuscript: (id: string) => void;
  onOpenDocument: (id: string) => void;
}

export function HomePage(props: HomePageProps) {
  const latestManuscript = props.manuscripts[0];
  const latestDocument = props.documents[0];
  return (
    <section className="screen home-screen">
      <header className="hero-card">
        <p className="eyebrow">移动工作台</p>
        <h1>先记录现场，再让 Agent 整理成文档。</h1>
        <p>录音、拍照、手写都进入同一张连续稿纸；转换后的文档保留来源引用，可继续手动编辑或交给 AI 修改。</p>
      </header>

      <div className="quick-grid">
        <button className="quick-card ink" onClick={props.onCreateManuscript} type="button">
          <span>新建手稿</span>
          <strong>录音 / 图片 / 手写</strong>
        </button>
        <button className="quick-card paper" onClick={props.onCreateDocument} type="button">
          <span>新建文档</span>
          <strong>块编辑 / Agent 修改</strong>
        </button>
      </div>

      <div className="section-title-row">
        <h2>最近继续</h2>
        {props.loading && <span>同步中</span>}
      </div>
      <div className="recent-stack">
        {latestManuscript && (
          <button className="library-card" onClick={() => props.onOpenManuscript(latestManuscript.id)} type="button">
            <span className="card-kind">手稿</span>
            <strong>{latestManuscript.title}</strong>
            <small>{formatRelativeTime(latestManuscript.updated_at)}</small>
          </button>
        )}
        {latestDocument && (
          <button className="library-card document" onClick={() => props.onOpenDocument(latestDocument.id)} type="button">
            <span className="card-kind">文档</span>
            <strong>{latestDocument.title}</strong>
            <small>{formatRelativeTime(latestDocument.updated_at)}</small>
          </button>
        )}
        {!latestManuscript && !latestDocument && <p className="empty-state">还没有内容。先创建一份手稿，录入现场素材。</p>}
      </div>
    </section>
  );
}
