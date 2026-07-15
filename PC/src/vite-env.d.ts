/// <reference types="vite/client" />

interface Window {
  meetingMate?: {
    platform: NodeJS.Platform;
    appMode: string;
    getInitialWorkspace: () => Promise<{
      documents: import("./types/document").Document[];
      manuscripts: import("./types/manuscript").Manuscript[];
    }>;
    saveDocument: (input: {
      id: string;
      title: string;
      status: import("./types/document").Document["status"];
      blocks: import("./types/block").DocumentBlock[];
    }) => Promise<import("./types/document").Document>;
    deleteDocument: (id: string) => Promise<{ ok: boolean }>;
    createManuscript: () => Promise<import("./types/manuscript").Manuscript>;
    openLocalManuscript: () => Promise<import("./types/manuscript").Manuscript | null>;
    renameManuscript: (input: { id: string; title: string }) => Promise<import("./types/manuscript").Manuscript>;
    saveManuscript: (input: {
      id: string;
      title: string;
      blocks: import("./types/block").ManuscriptBlock[];
    }) => Promise<import("./types/manuscript").Manuscript>;
    deleteManuscript: (id: string) => Promise<{ ok: boolean }>;
    exportManuscriptToDocument: (id: string) => Promise<import("./types/document").Document>;
    selectAudioFile: () => Promise<import("./lib/api").SelectedFile | null>;
    selectImageFile: () => Promise<import("./lib/api").SelectedFile | null>;
    uploadFileParts: (input: {
      path: string;
      parts: Array<{ partNumber: number; uploadUrl: string; headers?: Record<string, string> }>;
    }) => Promise<{ ok: boolean; parts: Array<{ part_number: number; etag: string; size_bytes: number }> }>;
  };
}
