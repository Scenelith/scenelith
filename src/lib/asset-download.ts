/** Keep downloads on the authenticated asset endpoint, never an expiring provider URL. */
export function assetDownloadHref(url: string | null | undefined): string | null {
  if (!url || !/^\/api\/assets\/[0-9a-f-]{36}(?:[?#]|$)/i.test(url)) return null;
  const parsed = new URL(url, "https://assets.invalid");
  parsed.searchParams.set("download", "1");
  return parsed.pathname + parsed.search;
}

/** HTTP headers are byte strings; keep Unicode only in the RFC 5987 parameter. */
export function assetContentDisposition(name: string, download = true): string {
  const filename = name.replace(/[\r\n"\\/]/g, "").trim() || "download";
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
