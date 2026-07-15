import type { ManuscriptBlock } from "./block";

export type Manuscript = {
  id: string;
  title: string;
  revision?: number;
  createdAt: string;
  updatedAt: string;
  source: "mobile-web" | "desktop" | "import";
  blocks: ManuscriptBlock[];
};
