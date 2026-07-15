import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type StoredDocument = {
  id: string;
  manuscriptId?: string;
  title: string;
  status: "draft" | "reviewing" | "synced";
  updatedAt: string;
  blocks: unknown[];
};

type StoredManuscript = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  source: "mobile-web" | "desktop" | "import";
  blocks: unknown[];
};

type WorkspaceData = {
  documents: StoredDocument[];
  manuscripts: StoredManuscript[];
};

type SaveDocumentInput = {
  id: string;
  title: string;
  status: StoredDocument["status"];
  blocks: unknown[];
};

type CreateManuscriptInput = {
  title?: string;
  source?: StoredManuscript["source"];
  blocks?: unknown[];
};

type SaveManuscriptInput = {
  id: string;
  title: string;
  blocks: unknown[];
};

const seedManuscript: StoredManuscript = {
  id: "m-standup-001",
  title: "产品周会原始手稿",
  createdAt: "2026-07-15 09:30",
  updatedAt: "2026-07-15 10:18",
  source: "mobile-web",
  blocks: [
    {
      id: "mb-audio-001",
      type: "audio",
      title: "会议录音 42:18",
      timestamp: "09:31",
      summary: "讨论了 PC 端 MVP、移动端采集入口和后端转换任务。",
      props: {
        duration: 2538,
        transcript: "PC 端先搭 Electron 工作台，移动端先完成录音、拍照和手写采集。"
      }
    },
    {
      id: "mb-image-001",
      type: "image",
      title: "白板架构图",
      timestamp: "09:47",
      summary: "包含 Manuscript、Document、AI Task 和 Export Task 的关系。",
      props: {
        url: "mock://whiteboard-architecture.png",
        caption: "三端架构草图"
      }
    },
    {
      id: "mb-handwriting-001",
      type: "handwriting",
      title: "手写行动项",
      timestamp: "10:04",
      summary: "记录了 PC 端第一阶段要优先完成应用骨架和 mock 工作台。",
      props: {
        aiText: "先跑通桌面壳、文档库、手稿预览、AI 侧栏。"
      }
    },
    {
      id: "mb-text-001",
      type: "text",
      title: "补充说明",
      timestamp: "10:12",
      summary: "MVP 不先接 SQLite、Slate.js 和真实后端。",
      props: {
        content: "第一版需要证明 PC 工作台的产品路径，而不是一次性完成全部工程能力。"
      }
    }
  ]
};

const seedDocument: StoredDocument = {
  id: "d-pc-mvp-plan",
  manuscriptId: "m-standup-001",
  title: "PC 端 MVP 开发计划",
  status: "draft",
  updatedAt: "2026-07-15 11:05",
  blocks: [
    {
      id: "db-heading-001",
      type: "heading",
      content: "PC 端 MVP 开发计划"
    },
    {
      id: "db-para-001",
      type: "paragraph",
      content:
        "PC 端先作为完整文档编辑器和 AI 工作台推进，第一阶段重点是跑通 Electron 应用骨架、三栏工作台和核心数据模型展示。"
    },
    {
      id: "db-list-001",
      type: "list",
      content: "首批能力",
      items: ["桌面应用启动", "文档库 mock", "手稿素材预览", "结构化文档展示", "AI Agent 侧栏"]
    },
    {
      id: "db-quote-001",
      type: "quote",
      content: "MVP 的重点是产品闭环和工程骨架，不是一次性完成完整编辑器。"
    },
    {
      id: "db-action-001",
      type: "action",
      content: "下一步接入 SQLite 和 Slate.js，并将 mock 数据替换为本地持久化数据。"
    }
  ]
};

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(projectRoot: string, legacyUserDataPath: string) {
    const dbDirectory = join(projectRoot, "data");
    const dbPath = join(dbDirectory, "meetingmate.sqlite");
    const legacyDbPath = join(legacyUserDataPath, "data", "meetingmate.sqlite");

    mkdirSync(dbDirectory, { recursive: true });

    if (!existsSync(dbPath) && existsSync(legacyDbPath)) {
      copyFileSync(legacyDbPath, dbPath);
    }

    this.db = new DatabaseSync(dbPath);
    this.migrate();
    this.seed();
  }

  getWorkspaceData(): WorkspaceData {
    const documents = this.db
      .prepare("select id, manuscript_id as manuscriptId, title, status, updated_at as updatedAt, blocks_json as blocksJson from documents order by updated_at desc")
      .all()
      .map((row) => ({
        id: String(row.id),
        manuscriptId: row.manuscriptId ? String(row.manuscriptId) : undefined,
        title: String(row.title),
        status: row.status as StoredDocument["status"],
        updatedAt: String(row.updatedAt),
        blocks: JSON.parse(String(row.blocksJson)) as unknown[]
      }));

    const manuscripts = this.db
      .prepare("select id, title, created_at as createdAt, updated_at as updatedAt, source, blocks_json as blocksJson from manuscripts order by updated_at desc")
      .all()
      .map((row) => ({
        id: String(row.id),
        title: String(row.title),
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
        source: row.source as StoredManuscript["source"],
        blocks: JSON.parse(String(row.blocksJson)) as unknown[]
      }));

    return { documents, manuscripts };
  }

  saveDocument(input: SaveDocumentInput): StoredDocument {
    const updatedAt = new Date().toISOString();

    this.db
      .prepare("update documents set title = ?, status = ?, updated_at = ?, blocks_json = ? where id = ?")
      .run(input.title, input.status, updatedAt, JSON.stringify(input.blocks), input.id);

    const row = this.db
      .prepare("select id, manuscript_id as manuscriptId, title, status, updated_at as updatedAt, blocks_json as blocksJson from documents where id = ?")
      .get(input.id);

    if (!row) {
      throw new Error(`Document not found: ${input.id}`);
    }

    return {
      id: String(row.id),
      manuscriptId: row.manuscriptId ? String(row.manuscriptId) : undefined,
      title: String(row.title),
      status: row.status as StoredDocument["status"],
      updatedAt: String(row.updatedAt),
      blocks: JSON.parse(String(row.blocksJson)) as unknown[]
    };
  }

  deleteDocument(id: string): void {
    this.db.prepare("delete from documents where id = ?").run(id);
  }

  exportManuscriptToDocument(manuscriptId: string): StoredDocument {
    const manuscript = this.getManuscript(manuscriptId);
    const now = new Date().toISOString();
    const document: StoredDocument = {
      id: `d-${randomUUID()}`,
      manuscriptId: manuscript.id,
      title: `${manuscript.title} 文档`,
      status: "draft",
      updatedAt: now,
      blocks: manuscriptToDocumentBlocks(manuscript)
    };

    this.db
      .prepare("insert into documents (id, manuscript_id, title, status, updated_at, blocks_json) values (?, ?, ?, ?, ?, ?)")
      .run(
        document.id,
        document.manuscriptId ?? null,
        document.title,
        document.status,
        document.updatedAt,
        JSON.stringify(document.blocks)
      );

    return document;
  }

  createManuscript(input: CreateManuscriptInput = {}): StoredManuscript {
    const now = new Date().toISOString();
    const manuscript: StoredManuscript = {
      id: `m-${randomUUID()}`,
      title: input.title?.trim() || "未命名手稿",
      createdAt: now,
      updatedAt: now,
      source: input.source ?? "desktop",
      blocks: input.blocks ?? []
    };

    this.db
      .prepare("insert into manuscripts (id, title, created_at, updated_at, source, blocks_json) values (?, ?, ?, ?, ?, ?)")
      .run(
        manuscript.id,
        manuscript.title,
        manuscript.createdAt,
        manuscript.updatedAt,
        manuscript.source,
        JSON.stringify(manuscript.blocks)
      );

    return manuscript;
  }

  importManuscriptFromJson(content: string, fallbackTitle: string): StoredManuscript {
    const parsed = JSON.parse(content) as Partial<StoredManuscript>;
    const title = typeof parsed.title === "string" ? parsed.title : fallbackTitle;
    const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
    const source = parsed.source === "mobile-web" || parsed.source === "desktop" || parsed.source === "import" ? parsed.source : "import";

    return this.createManuscript({ title, source, blocks });
  }

  renameManuscript(id: string, title: string): StoredManuscript {
    const nextTitle = title.trim();

    if (!nextTitle) {
      throw new Error("Manuscript title cannot be empty");
    }

    this.db.prepare("update manuscripts set title = ?, updated_at = ? where id = ?").run(nextTitle, new Date().toISOString(), id);
    return this.getManuscript(id);
  }

  saveManuscript(input: SaveManuscriptInput): StoredManuscript {
    const title = input.title.trim() || "未命名手稿";

    this.db
      .prepare("update manuscripts set title = ?, updated_at = ?, blocks_json = ? where id = ?")
      .run(title, new Date().toISOString(), JSON.stringify(input.blocks), input.id);

    return this.getManuscript(input.id);
  }

  deleteManuscript(id: string): void {
    this.db.exec("begin");

    try {
      this.db.prepare("delete from manuscripts where id = ?").run(id);
      this.db.prepare("update documents set manuscript_id = null where manuscript_id = ?").run(id);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private getManuscript(id: string): StoredManuscript {
    const row = this.db
      .prepare("select id, title, created_at as createdAt, updated_at as updatedAt, source, blocks_json as blocksJson from manuscripts where id = ?")
      .get(id);

    if (!row) {
      throw new Error(`Manuscript not found: ${id}`);
    }

    return {
      id: String(row.id),
      title: String(row.title),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      source: row.source as StoredManuscript["source"],
      blocks: JSON.parse(String(row.blocksJson)) as unknown[]
    };
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists documents (
        id text primary key,
        manuscript_id text,
        title text not null,
        status text not null,
        updated_at text not null,
        blocks_json text not null
      );

      create table if not exists manuscripts (
        id text primary key,
        title text not null,
        created_at text not null,
        updated_at text not null,
        source text not null,
        blocks_json text not null
      );

      create table if not exists settings (
        key text primary key,
        value text not null
      );
    `);
  }

  private seed(): void {
    const documentCount = this.db.prepare("select count(*) as count from documents").get() as { count: number };
    const manuscriptCount = this.db.prepare("select count(*) as count from manuscripts").get() as { count: number };

    if (documentCount.count === 0) {
      this.db
        .prepare(
          "insert into documents (id, manuscript_id, title, status, updated_at, blocks_json) values (?, ?, ?, ?, ?, ?)"
        )
        .run(
          seedDocument.id,
          seedDocument.manuscriptId ?? null,
          seedDocument.title,
          seedDocument.status,
          seedDocument.updatedAt,
          JSON.stringify(seedDocument.blocks)
        );
    }

    if (manuscriptCount.count === 0) {
      this.db
        .prepare(
          "insert into manuscripts (id, title, created_at, updated_at, source, blocks_json) values (?, ?, ?, ?, ?, ?)"
        )
        .run(
          seedManuscript.id,
          seedManuscript.title,
          seedManuscript.createdAt,
          seedManuscript.updatedAt,
          seedManuscript.source,
          JSON.stringify(seedManuscript.blocks)
        );
    }
  }
}

function manuscriptToDocumentBlocks(manuscript: StoredManuscript): unknown[] {
  const contentBlocks = manuscript.blocks
    .map((block, index) => blockToDocumentBlock(block, index))
    .filter(Boolean)
    .map((block) => block as Record<string, unknown>);

  return [
    {
      id: "converted-heading",
      type: "heading",
      content: manuscript.title
    },
    ...contentBlocks
  ];
}

function blockToDocumentBlock(block: unknown, index: number): Record<string, unknown> | null {
  if (!block || typeof block !== "object") {
    return null;
  }

  const record = block as Record<string, unknown>;
  const props = record.props && typeof record.props === "object" ? (record.props as Record<string, unknown>) : {};

  if (record.type === "image") {
    const content = readFirstString(props, ["caption", "ocrText", "content"]) || readFirstString(record, ["summary", "title"]);
    return {
      id: `converted-${index}`,
      type: "image",
      content,
      props: {
        asset_id: typeof props.asset_id === "string" ? props.asset_id : null,
        caption: content,
        width: typeof props.width === "number" ? props.width : null,
        height: typeof props.height === "number" ? props.height : null,
        url: typeof props.url === "string" ? props.url : null
      }
    };
  }

  for (const key of ["content", "transcript", "aiText", "ocrText"]) {
    if (typeof props[key] === "string") {
      return { id: `converted-${index}`, type: "paragraph", content: String(props[key]) };
    }
  }

  const content = [record.title, record.summary].filter((value) => typeof value === "string").join("\n");
  return content ? { id: `converted-${index}`, type: "paragraph", content } : null;
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (typeof record[key] === "string") return String(record[key]);
  }
  return "";
}
