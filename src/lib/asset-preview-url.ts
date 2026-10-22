export function assetThumbnailUrl(url: string) {
  if (!url.startsWith("/api/assets/")) return url;
  const parsed = new URL(url, "http://scenelith.local");
  parsed.searchParams.delete("download");
  parsed.searchParams.delete("thumbnail");
  parsed.searchParams.set("variant", "thumbnail");
  // Let object storage serve many restored previews concurrently. Proxying
  // every image stream through the application makes a large canvas exhaust
  // the browser's origin connection pool while those streams stay open.
  parsed.searchParams.set("delivery", "direct");
  parsed.searchParams.set("v", "4");
  return `${parsed.pathname}${parsed.search}`;
}
