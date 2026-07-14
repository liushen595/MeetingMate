import { create } from "zustand";
import { mockDocuments, mockManuscripts } from "../data/mock";
import type { Document } from "../types/document";
import type { Manuscript } from "../types/manuscript";

type WorkspaceState = {
  documents: Document[];
  manuscripts: Manuscript[];
  selectedDocumentId: string;
  selectedManuscriptId: string;
  aiOutput: string;
  selectDocument: (id: string) => void;
  selectManuscript: (id: string) => void;
  runAiAction: (action: string) => void;
};

const aiResponses: Record<string, string> = {
  summarize: "总结：本次文档聚焦 PC 端 MVP，先完成 Electron 应用骨架、三栏工作台、mock 手稿预览和 mock AI 面板。",
  polish: "润色建议：将当前文档改写为更正式的项目执行计划，并补充验收标准与后续迭代路径。",
  actions: "行动项：1. 接入 SQLite。2. 引入 Slate.js。3. 封装 API client。4. 对接 AI 转换任务。"
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  documents: mockDocuments,
  manuscripts: mockManuscripts,
  selectedDocumentId: mockDocuments[0]?.id ?? "",
  selectedManuscriptId: mockManuscripts[0]?.id ?? "",
  aiOutput: "选择一个 AI 动作后，这里会显示模拟输出。",
  selectDocument: (id) => set({ selectedDocumentId: id }),
  selectManuscript: (id) => set({ selectedManuscriptId: id }),
  runAiAction: (action) => set({ aiOutput: aiResponses[action] ?? "AI 动作已触发。" })
}));
