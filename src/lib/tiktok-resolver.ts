import { MediaError } from "./media/contracts";

export type TikwmData = {
  id?: string;
  title?: string;
  duration?: number;
  cover?: string;
  play?: string;
  wmplay?: string;
  images?: string[];
  author?: { unique_id?: string; nickname?: string };
  play_count?: number;
  digg_count?: number;
  comment_count?: number;
  share_count?: number;
  collect_count?: number;
  create_time?: number;
};

export async function resolveTikTok(url: string) {
  const response = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
    headers: { "user-agent": "Mozilla/5.0 Frameflow/1.0" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new MediaError(
    response.status === 403 ? "TIKTOK_RESOLVER_BLOCKED" : "TIKTOK_RESOLVER_UNAVAILABLE",
    502, response.status === 429 || response.status >= 500,
  );
  const payload = (await response.json()) as { code?: number; msg?: string; data?: TikwmData };
  if (payload.code !== 0 || !payload.data) throw new MediaError("TIKTOK_POST_UNAVAILABLE", 422);
  return payload.data;
}

export function postDetails(data: TikwmData, url: string) {
  return {
    id: data.id || null,
    title: data.title || "TikTok study",
    author: data.author?.unique_id || data.author?.nickname || "unknown",
    sourceUrl: url,
    publishedAt: data.create_time ? new Date(data.create_time * 1000).toISOString() : null,
    stats: {
      views: Number(data.play_count || 0),
      likes: Number(data.digg_count || 0),
      comments: Number(data.comment_count || 0),
      shares: Number(data.share_count || 0),
      saves: Number(data.collect_count || 0),
    },
  };
}

export async function fetchTikTokStats(url: string) {
  return postDetails(await resolveTikTok(url), url);
}

