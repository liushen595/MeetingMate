import type { DocumentBlock } from "./block";

export type Document = {
  id: string;
  manuscriptId?: string;
  title: string;
  status: "draft" | "reviewing" | "synced";
  updatedAt: string;
  blocks: DocumentBlock[];
};
