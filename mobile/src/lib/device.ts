import type { DevicePayload, Platform } from "../types/api";
import { makeId } from "./ids";

const CLIENT_ID_KEY = "meetingmate.client_id";
const APP_VERSION = "0.1.0";

export function getPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/android/.test(ua)) return "android";
  return "web";
}

export function getClientId() {
  const stored = localStorage.getItem(CLIENT_ID_KEY);
  if (stored) return stored;
  const id = makeId("device");
  localStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}

export function getDevicePayload(): DevicePayload {
  return {
    client_id: getClientId(),
    platform: getPlatform(),
    app_version: APP_VERSION,
    name: navigator.userAgent.includes("Mobile") ? "Mobile App" : "Mobile Web",
  };
}
