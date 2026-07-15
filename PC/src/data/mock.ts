import type { Document } from "../types/document";
import type { Manuscript } from "../types/manuscript";

export const mockManuscripts: Manuscript[] = [
  {
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
  }
];

export const mockDocuments: Document[] = [
  {
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
  }
];
