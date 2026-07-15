import type { MeetingSchedule } from "../types/meeting";

const MEETINGS_KEY = "meetingmate.local.meetings";

export function loadMeetings(): MeetingSchedule[] {
  const raw = localStorage.getItem(MEETINGS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as MeetingSchedule[];
    return Array.isArray(parsed) ? parsed.filter(isMeetingSchedule).sort(sortByStartAt) : [];
  } catch {
    return [];
  }
}

export function saveMeetings(meetings: MeetingSchedule[]): void {
  localStorage.setItem(MEETINGS_KEY, JSON.stringify(meetings.sort(sortByStartAt)));
}

export function getNextMeeting(meetings: MeetingSchedule[]): MeetingSchedule | null {
  const now = Date.now();
  return meetings.filter((meeting) => new Date(meeting.startAt).getTime() >= now).sort(sortByStartAt)[0] ?? null;
}

function sortByStartAt(a: MeetingSchedule, b: MeetingSchedule): number {
  return new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
}

function isMeetingSchedule(value: unknown): value is MeetingSchedule {
  if (!value || typeof value !== "object") return false;
  const meeting = value as Partial<MeetingSchedule>;
  return typeof meeting.id === "string" && typeof meeting.title === "string" && typeof meeting.address === "string" && typeof meeting.startAt === "string";
}
