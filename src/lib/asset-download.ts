/** Keep downloads on the authenticated asset endpoint, never an expiring provider URL. */
export function assetDownloadHref(url: string | null | undefined): string | null {
  if (!url || !/^\/api\/assets\/[0-9a-f-]{36}(?:[?#]|$)/i.test(url)) return null;
  const parsed = new URL(url, "https://assets.invalid");
  parsed.searchParams.set("download", "1");
  return parsed.pathname + parsed.search;
}
