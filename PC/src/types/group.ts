export type GroupSummary = {
  id: string;
  name: string;
  inviteCode: string;
  inviteCodeExpiresAt: string;
  memberCount: number;
  role: "owner" | "member";
  createdAt: string;
  updatedAt: string;
};

export type GroupDocumentMessage = {
  id: string;
  groupId: string;
  senderId: string;
  senderName: string;
  documentId: string;
  documentTitle: string;
  documentRevision: number;
  sentAt: string;
};
