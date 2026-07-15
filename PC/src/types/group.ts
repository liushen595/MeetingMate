export type GroupSummary = {
  id: string;
  name: string;
  inviteCode: string;
  inviteCodeExpiresAt: string;
  memberCount: number;
};

export type GroupDocumentMessage = {
  id: string;
  groupId: string;
  senderName: string;
  documentTitle: string;
  sentAt: string;
};
