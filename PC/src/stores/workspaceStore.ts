import { create } from "zustand";
import { mockDocuments, mockManuscripts } from "../data/mock";
import type { Document } from "../types/document";
import type { Manuscript } from "../types/manuscript";

export type ActiveSection = "library" | "manuscripts" | "ai" | "exports" | "settings";

type WorkspaceState = {
  activeSection: ActiveSection;
  documents: Document[];
  manuscripts: Manuscript[];
  selectedDocumentId: string;
  selectedManuscriptId: string;
  aiOutput: string;
  isHydrated: boolean;
  saveStatus: "idle" | "saving" | "saved" | "error";
  setActiveSection: (section: ActiveSection) => void;
  hydrateWorkspace: (data: { documents: Document[]; manuscripts: Manuscript[] }) => void;
  addDocument: (document: Document) => void;
  updateDocument: (document: Document) => void;
  removeDocument: (id: string) => void;
  addManuscript: (manuscript: Manuscript) => void;
  updateManuscript: (manuscript: Manuscript) => void;
  removeManuscript: (id: string) => void;
  closeSelectedManuscript: () => void;
  setSaveStatus: (status: WorkspaceState["saveStatus"]) => void;
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
  activeSection: "library",
  documents: mockDocuments,
  manuscripts: mockManuscripts,
  selectedDocumentId: mockDocuments[0]?.id ?? "",
  selectedManuscriptId: mockManuscripts[0]?.id ?? "",
  aiOutput: "选择一个 AI 动作后，这里会显示模拟输出。",
  isHydrated: false,
  saveStatus: "idle",
  setActiveSection: (section) => set({ activeSection: section }),
  hydrateWorkspace: (data) =>
    set({
      documents: data.documents,
      manuscripts: data.manuscripts,
      selectedDocumentId: data.documents[0]?.id ?? "",
      selectedManuscriptId: data.manuscripts[0]?.id ?? "",
      isHydrated: true
    }),
  addDocument: (document) =>
    set((state) => ({
      documents: [document, ...state.documents.filter((item) => item.id !== document.id)],
      selectedDocumentId: document.id
    })),
  updateDocument: (document) =>
    set((state) => ({
      documents: state.documents.map((item) => (item.id === document.id ? document : item))
    })),
  removeDocument: (id) =>
    set((state) => {
      const documents = state.documents.filter((item) => item.id !== id);
      return {
        documents,
        selectedDocumentId: state.selectedDocumentId === id ? documents[0]?.id ?? "" : state.selectedDocumentId
      };
    }),
  addManuscript: (manuscript) =>
    set((state) => ({
      manuscripts: [manuscript, ...state.manuscripts.filter((item) => item.id !== manuscript.id)],
      selectedManuscriptId: manuscript.id
    })),
  updateManuscript: (manuscript) =>
    set((state) => ({
      manuscripts: state.manuscripts.map((item) => (item.id === manuscript.id ? manuscript : item))
    })),
  removeManuscript: (id) =>
    set((state) => {
      const manuscripts = state.manuscripts.filter((item) => item.id !== id);
      return {
        documents: state.documents.map((document) =>
          document.manuscriptId === id ? { ...document, manuscriptId: undefined } : document
        ),
        manuscripts,
        selectedManuscriptId: state.selectedManuscriptId === id ? manuscripts[0]?.id ?? "" : state.selectedManuscriptId
      };
    }),
  closeSelectedManuscript: () => set({ selectedManuscriptId: "" }),
  setSaveStatus: (status) => set({ saveStatus: status }),
  selectDocument: (id) => set({ selectedDocumentId: id }),
  selectManuscript: (id) => set({ selectedManuscriptId: id }),
  runAiAction: (action) => set({ aiOutput: aiResponses[action] ?? "AI 动作已触发。" })
}));
