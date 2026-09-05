import { createHmac, timingSafeEqual } from "node:crypto";
import { db, userCanAccessAsset, userCanAccessProject, workspaceIdForProject } from "@/lib/postgres-db";
import { mcpDownloadConnection, type McpPrincipal } from "@/lib/mcp/oauth";
import { signedStorageReadUrl, statStorageObject, streamStorageObject } from "@/lib/storage";

const LINK_LIFETIME_MS = 10 * 60 * 1000;
const privateHeaders = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
type DownloadAsset = { id: string; workspace_id: string; project_id: string | null; filename: string; storage_path: string; mime_type: string; size_bytes: number | null };
type Ticket = { connection: string; canvas: string; asset: string; expires: number };

function notFound(): never {
  throw Object.assign(new Error("Original media download not found or expired"), { status: 404 });
}

async function authorizedAsset(principal: McpPrincipal, canvasId: string, assetId: string) {
  const workspaceId = await workspaceIdForProject(canvasId);
  if (!workspaceId || !principal.scopes.includes("mcp:read")
    || (principal.workspaceId && principal.workspaceId !== workspaceId)
    || (principal.projectIds && !principal.projectIds.includes(canvasId))
    || !await userCanAccessProject(principal.userId, canvasId)) notFound();
  const asset = await db.prepare("SELECT id, workspace_id, project_id, filename, storage_path, mime_type, size_bytes FROM assets WHERE id = ?")
    .get(assetId) as DownloadAsset | undefined;
  if (!asset || asset.workspace_id !== workspaceId
    || (principal.projectIds && (!asset.project_id || !principal.projectIds.includes(asset.project_id)))
    || !await userCanAccessAsset(principal.userId, asset.id)) notFound();
  return asset;
}

function signature(payload: string, key: string) {
  return createHmac("sha256", key).update(`scenelith:mcp:original-download:v1:${payload}`).digest();
}

export async function createMcpOriginalDownload(principal: McpPrincipal, canvasId: string, assetId: string) {
  const connection = await mcpDownloadConnection(principal.connectionId);
  if (!connection || connection.principal.userId !== principal.userId) notFound();
  const asset = await authorizedAsset(connection.principal, canvasId, assetId);
  // Stat the original, never the thumbnail, so a missing file is reported by
  // the tool instead of returning a successful but unusable download link.
  const stat = await statStorageObject(asset.storage_path);
  const expires = Math.min(Date.now() + LINK_LIFETIME_MS, Date.parse(connection.principal.expiresAt));
  const payload = Buffer.from(JSON.stringify({ connection: principal.connectionId, canvas: canvasId, asset: asset.id, expires } satisfies Ticket)).toString("base64url");
  const url = new URL("/api/mcp/download", connection.principal.resource);
  url.searchParams.set("ticket", `${payload}.${signature(payload, connection.signingKey).toString("base64url")}`);
  return { assetId: asset.id, filename: asset.filename, mimeType: asset.mime_type, sizeBytes: Number(stat.size), variant: "original" as const, downloadUrl: url.toString(), expiresAt: new Date(expires).toISOString() };
}

export async function serveMcpOriginalDownload(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("ticket") || "";
    if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) notFound();
    const [payload, mac] = token.split(".");
    let ticket: Ticket;
    try { ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { notFound(); }
    if (!ticket || typeof ticket.connection !== "string" || typeof ticket.canvas !== "string" || typeof ticket.asset !== "string"
      || !Number.isSafeInteger(ticket.expires) || ticket.expires <= Date.now() || ticket.expires > Date.now() + LINK_LIFETIME_MS) notFound();
    const connection = await mcpDownloadConnection(ticket.connection);
    if (!connection || !timingSafeEqual(Buffer.from(mac, "base64url"), signature(payload, connection.signingKey))) notFound();
    const asset = await authorizedAsset(connection.principal, ticket.canvas, ticket.asset);
    const directUrl = await signedStorageReadUrl(asset.storage_path, { downloadName: asset.filename });
    if (directUrl) return new Response(null, { status: 307, headers: { ...privateHeaders, location: directUrl } });
    const stat = await statStorageObject(asset.storage_path);
    const encodedName = encodeURIComponent(asset.filename).replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    const stream = await streamStorageObject(asset.storage_path);
    return new Response(stream, { headers: {
      ...privateHeaders, "content-type": asset.mime_type, "content-length": String(stat.size),
      "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodedName}`,
    } });
  } catch {
    return Response.json({ error: "Original media download not found or expired" }, { status: 404, headers: privateHeaders });
  }
}
