export type ManuscriptBlockType = "audio" | "image" | "handwriting" | "text";

export type DocumentBlockType = "heading" | "paragraph" | "list" | "quote" | "action";

export type ManuscriptBlock = {
  id: string;
  type: ManuscriptBlockType;
  title: string;
  timestamp: string;
  summary: string;
  props: Record<string, string | number | string[]>;
};

export type DocumentBlock = {
  id: string;
  type: DocumentBlockType;
  content: string;
  items?: string[];
};
