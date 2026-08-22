import { fetchTikTokStats, importTikTok } from "@/lib/tiktok";

export const tikwmImportProvider = {
  id: "tikwm",
  importTikTok,
  fetchTikTokStats,
} as const;
