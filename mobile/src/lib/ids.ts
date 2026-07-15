import { nanoid } from "nanoid";

export function makeId(prefix: string) {
  return `${prefix}_${nanoid(12)}`;
}

export function makeIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? makeId("idem");
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatRelativeTime(value: string) {
  const diffMs = Date.now() - new Date(value).getTime();
  const diffMin = Math.max(0, Math.round(diffMs / 60000));
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const hours = Math.round(diffMin / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
