import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.meetingmate.mobile",
  appName: "MeetingMate",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
};

export default config;
