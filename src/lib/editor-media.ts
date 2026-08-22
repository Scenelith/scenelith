export function editorPlaybackUrl(url: string) {
  if (!url.startsWith("/api/assets/")) return url;
  const parsed = new URL(url, "http://scenelith.local");
  parsed.searchParams.delete("download");
  parsed.searchParams.delete("variant");
  // Keep video byte ranges off the application server. Video Master owns a
  // persistent decoder pool and browsers routinely cancel superseded range
  // reads while switching scenes; R2 should absorb those transport details
  // instead of turning them into incomplete app responses.
  parsed.searchParams.set("delivery", "direct");
  parsed.searchParams.set("v", "10");
  return `${parsed.pathname}${parsed.search}`;
}

export function editorSourcePlaybackUrl(url: string) {
  if (!url.startsWith("/api/assets/")) return url;
  const parsed = new URL(url, "http://scenelith.local");
  parsed.searchParams.delete("download");
  parsed.searchParams.delete("variant");
  parsed.searchParams.set("delivery", "direct");
  parsed.searchParams.set("v", "9");
  return `${parsed.pathname}${parsed.search}`;
}

export function editorThumbnailUrl(url: string | undefined) {
  if (!url) return "";
  if (!url.startsWith("/api/assets/")) return url;
  const parsed = new URL(url, "http://scenelith.local");
  parsed.searchParams.delete("download");
  parsed.searchParams.set("variant", "thumbnail");
  parsed.searchParams.set("delivery", "direct");
  parsed.searchParams.set("v", "3");
  return `${parsed.pathname}${parsed.search}`;
}
