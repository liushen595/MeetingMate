export type ManuscriptBlockType = "audio" | "image" | "handwriting" | "text";

export type DocumentBlockType = "heading" | "paragraph" | "list" | "quote" | "action" | "image";

export type ManuscriptBlock = {
  id: string;
  type: ManuscriptBlockType;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
  title: string;
  timestamp: string;
  summary: string;
  props: Record<string, unknown>;
};

export type DocumentBlock = {
  id: string;
  type: DocumentBlockType;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
  content: string;
  items?: string[];
  props?: Record<string, unknown>;
};
