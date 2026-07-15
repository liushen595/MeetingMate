import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111827",
        paper: "#f8fafc",
        accent: "#2563eb"
      }
    }
  },
  plugins: []
} satisfies Config;
