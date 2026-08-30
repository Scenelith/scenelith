import { createHash } from "node:crypto";
import { baseUrl, hashOpaqueToken, randomToken } from "@/lib/auth";
import {
  db,
  listAccessibleProjectRows,
  listAccessibleWorkspaceRows,
  rowToProjectListItem,
  rowToWorkspace,
  userCanAccessProject,
  userCanAccessWorkspace,
  workspaceIdForProject,
} from "@/lib/postgres-db";

export const mcpScopes = [
  "mcp:read",
  "canvas:write",
  "assistant:run",
  "generation:run",
  "library:write",
  "import:write",
  "identity:write",
  "automation:write",
  "automation:credentials",
  "automation:run",
] as const;

export type McpScope = (typeof mcpScopes)[number];

export type McpPrincipal = {
  connectionId: string;
  clientId: string;
  userId: string;
  workspaceId: string | null;
  projectIds: string[] | null;
  libraryAccess: boolean;
  scopes: McpScope[];
  resource: string;
  expiresAt: string;
};

type OAuthClientRow = {
  client_id: string;
  client_name: string;
  client_uri: string | null;
  redirect_uris_json: unknown;
  grant_types_json: unknown;
  response_types_json: unknown;
  token_endpoint_auth_method: "none";
  created_at: string;
};

type AuthorizationRow = {
  id: string;
  user_id: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  state: string | null;
  code_challenge: string;
  requested_scopes_json: unknown;
  granted_scopes_json: unknown;
  workspace_id: string | null;
  project_ids_json: unknown;
  library_access: boolean;
  code_hash: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  code_expires_at: string | null;
  code_consumed_at: string | null;
};

type ConnectionRow = {
  id: string;
  user_id: string;
  client_id: string;
  workspace_id: string | null;
  project_ids_json: unknown;
  library_access: boolean;
  resource: string;
  scopes_json: unknown;
  access_token_hash: string;
  refresh_token_hash: string;
  access_expires_at: string;
  refresh_expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

function jsonStrings(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch { return []; }
  }
  return [];
}

function normalizedScopes(value: unknown): McpScope[] {
  const requested = jsonStrings(value);
  return mcpScopes.filter((scope) => requested.includes(scope));
}

function normalizedProjectIds(value: unknown) {
  const ids = [...new Set(jsonStrings(value).map((id) => id.trim()).filter(Boolean))];
  return ids.length ? ids : null;
}

function oauthError(error: string, description: string, status = 400) {
  return Response.json({ error, error_description: description }, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache", "access-control-allow-origin": "*" },
  });
}

export function mcpResource(request?: Request) {
  return new URL("/api/mcp", baseUrl(request)).toString();
}

export function mcpProtectedResourceMetadataUrl(request?: Request) {
  return new URL("/.well-known/oauth-protected-resource/api/mcp", baseUrl(request)).toString();
}

export function mcpOAuthMetadata(request?: Request) {
  const issuer = baseUrl(request);
  return {
    issuer,
    authorization_endpoint: new URL("/oauth/authorize", issuer).toString(),
    token_endpoint: new URL("/api/mcp/oauth/token", issuer).toString(),
    registration_endpoint: new URL("/api/mcp/oauth/register", issuer).toString(),
    revocation_endpoint: new URL("/api/mcp/oauth/revoke", issuer).toString(),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...mcpScopes],
    service_documentation: new URL("/mcp", issuer).toString(),
  };
}

export function mcpProtectedResourceMetadata(request?: Request) {
  const resource = mcpResource(request);
  return {
    resource,
    authorization_servers: [baseUrl(request)],
    scopes_supported: [...mcpScopes],
    resource_name: "Scenelith Creative Platform",
  };
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function validRedirectUri(value: string) {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  } catch { return false; }
}

function validClientUri(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

export async function registerMcpOAuthClient(value: unknown) {
  const body = value as Record<string, unknown> | null;
  const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
  const clientName = String(body?.client_name || "MCP client").trim().slice(0, 120);
  const tokenMethod = String(body?.token_endpoint_auth_method || "none");
  const requestedGrants = Array.isArray(body?.grant_types) ? body.grant_types.map(String) : ["authorization_code", "refresh_token"];
  const requestedResponses = Array.isArray(body?.response_types) ? body.response_types.map(String) : ["code"];
  if (!redirectUris.length || redirectUris.length > 20 || redirectUris.some((uri) => !validRedirectUri(uri))) {
    return oauthError("invalid_redirect_uri", "Redirect URIs must use HTTPS, except localhost loopback callbacks", 400);
  }
  if (tokenMethod !== "none") return oauthError("invalid_client_metadata", "Scenelith supports public MCP clients with PKCE", 400);
  if (!requestedGrants.includes("authorization_code") || requestedGrants.some((grant) => !["authorization_code", "refresh_token"].includes(grant))) {
    return oauthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported", 400);
  }
  if (requestedResponses.length !== 1 || requestedResponses[0] !== "code") {
    return oauthError("invalid_client_metadata", "Only the code response type is supported", 400);
  }
  const clientId = `scn_client_${randomToken(24)}`;
  const now = new Date().toISOString();
  const clientUri = validClientUri(typeof body?.client_uri === "string" ? body.client_uri : undefined);
  await db.prepare(`INSERT INTO mcp_oauth_clients
    (client_id, client_name, client_uri, redirect_uris_json, grant_types_json, response_types_json, token_endpoint_auth_method, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'none', ?)`)
    .run(clientId, clientName || "MCP client", clientUri, JSON.stringify(redirectUris), JSON.stringify(requestedGrants), JSON.stringify(["code"]), now);
  return Response.json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.parse(now) / 1000),
    client_name: clientName || "MCP client",
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: redirectUris,
    grant_types: requestedGrants,
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: mcpScopes.join(" "),
  }, { status: 201, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
}

function sameResource(left: string, right: string) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = "";
    b.hash = "";
    return a.toString() === b.toString();
  } catch { return false; }
}

async function oauthClient(clientId: string) {
  return await db.prepare("SELECT * FROM mcp_oauth_clients WHERE client_id = ?").get(clientId) as OAuthClientRow | undefined;
}

export async function createMcpOAuthConsentRequest(input: {
  userId: string;
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope?: string;
  state?: string;
  resource: string;
}, request?: Request) {
  const client = await oauthClient(input.clientId);
  if (!client) throw new Error("This MCP client is not registered with Scenelith");
  if (!jsonStrings(client.redirect_uris_json).includes(input.redirectUri)) throw new Error("The MCP client requested an unregistered redirect address");
  if (input.responseType !== "code") throw new Error("This MCP client requested an unsupported response type");
  if (input.codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)) throw new Error("This MCP client must use PKCE with S256");
  if (!sameResource(input.resource, mcpResource(request))) throw new Error("This authorization request targets a different MCP server");
  const requested = [...new Set(String(input.scope || "mcp:read").split(/\s+/).filter(Boolean))];
  if (!requested.includes("mcp:read") || requested.some((scope) => !mcpScopes.includes(scope as McpScope))) throw new Error("This MCP client requested unsupported permissions");
  if ((input.state || "").length > 2000) throw new Error("The authorization state is too large");
  const id = crypto.randomUUID();
  const now = new Date();
  await db.prepare("DELETE FROM mcp_oauth_authorizations WHERE expires_at <= ?").run(now.toISOString());
  await db.prepare(`INSERT INTO mcp_oauth_authorizations
    (id, user_id, client_id, redirect_uri, resource, state, code_challenge, requested_scopes_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.userId, input.clientId, input.redirectUri, input.resource, input.state || null, input.codeChallenge, JSON.stringify(requested), now.toISOString(), new Date(now.getTime() + 10 * 60 * 1000).toISOString());
  const workspaces = (await listAccessibleWorkspaceRows(input.userId)).map(rowToWorkspace);
  const canvases = (await listAccessibleProjectRows(input.userId)).map(rowToProjectListItem);
  return {
    id,
    client: { id: client.client_id, name: client.client_name, uri: client.client_uri, redirectUri: input.redirectUri, redirectHost: new URL(input.redirectUri).host },
    requestedScopes: normalizedScopes(requested),
    workspaces,
    canvases,
  };
}

function authorizationRedirect(row: AuthorizationRow, params: Record<string, string>) {
  const url = new URL(row.redirect_uri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (row.state) url.searchParams.set("state", row.state);
  return url.toString();
}

export async function decideMcpOAuthConsent(input: {
  userId: string;
  requestId: string;
  allow: boolean;
  workspaceId?: string | null;
  projectIds?: string[];
  restrictToProjects: boolean;
  libraryAccess: boolean;
  scopes: McpScope[];
}) {
  return await db.transaction(async () => {
    const row = await db.prepare("SELECT * FROM mcp_oauth_authorizations WHERE id = ? FOR UPDATE").get(input.requestId) as AuthorizationRow | undefined;
    if (!row || row.user_id !== input.userId || row.decided_at || Date.parse(row.expires_at) <= Date.now()) throw new Error("This authorization request expired. Return to your agent and connect again.");
    const now = new Date();
    if (!input.allow) {
      await db.prepare("UPDATE mcp_oauth_authorizations SET decided_at = ? WHERE id = ?").run(now.toISOString(), row.id);
      return authorizationRedirect(row, { error: "access_denied", error_description: "The user denied access" });
    }
    const requested = normalizedScopes(row.requested_scopes_json);
    const granted = mcpScopes.filter((scope) => input.scopes.includes(scope) && requested.includes(scope));
    if (!granted.includes("mcp:read")) throw new Error("Read access is required for an MCP connection");
    if (input.workspaceId && !await userCanAccessWorkspace(input.userId, input.workspaceId)) throw new Error("Workspace not found");
    const projectIds = input.restrictToProjects ? [...new Set((input.projectIds || []).map((id) => id.trim()).filter(Boolean))] : [];
    if (input.restrictToProjects && !projectIds.length) throw new Error("Choose at least one canvas or allow all canvases");
    if (projectIds.length > 200) throw new Error("Choose no more than 200 canvases");
    for (const projectId of projectIds) {
      if (!await userCanAccessProject(input.userId, projectId)) throw new Error("One of the selected canvases is unavailable");
      if (input.workspaceId && await workspaceIdForProject(projectId) !== input.workspaceId) throw new Error("A selected canvas is outside the chosen workspace");
    }
    const code = `scn_code_${randomToken(32)}`;
    await db.prepare(`UPDATE mcp_oauth_authorizations SET granted_scopes_json = ?, workspace_id = ?, project_ids_json = ?, library_access = ?, code_hash = ?, decided_at = ?, code_expires_at = ?
      WHERE id = ?`).run(JSON.stringify(granted), input.workspaceId || null, projectIds.length ? JSON.stringify(projectIds) : null, input.libraryAccess,
        hashOpaqueToken(code), now.toISOString(), new Date(now.getTime() + 5 * 60 * 1000).toISOString(), row.id);
    return authorizationRedirect(row, { code });
  })();
}

function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function tokenPayload(accessToken: string, refreshToken: string, scopes: McpScope[]) {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  };
}

export async function exchangeMcpOAuthToken(form: URLSearchParams, request: Request) {
  const grantType = form.get("grant_type") || "";
  const clientId = form.get("client_id") || "";
  const resource = form.get("resource") || "";
  if (!clientId || !await oauthClient(clientId)) return oauthError("invalid_client", "Unknown MCP client", 401);
  if (!resource || !sameResource(resource, mcpResource(request))) return oauthError("invalid_target", "The token must target this Scenelith MCP endpoint");
  if (grantType === "authorization_code") {
    const code = form.get("code") || "";
    const redirectUri = form.get("redirect_uri") || "";
    const verifier = form.get("code_verifier") || "";
    if (!code || !redirectUri || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError("invalid_grant", "The authorization code, redirect URI, or PKCE verifier is invalid");
    const issued = await db.transaction(async () => {
      const authorization = await db.prepare("SELECT * FROM mcp_oauth_authorizations WHERE code_hash = ? FOR UPDATE")
        .get(hashOpaqueToken(code)) as AuthorizationRow | undefined;
      if (!authorization || authorization.client_id !== clientId || authorization.redirect_uri !== redirectUri || !sameResource(authorization.resource, resource)
        || !authorization.code_expires_at || Date.parse(authorization.code_expires_at) <= Date.now() || authorization.code_consumed_at
        || pkceChallenge(verifier) !== authorization.code_challenge) return null;
      const now = new Date();
      const accessToken = `scn_access_${randomToken(32)}`;
      const refreshToken = `scn_refresh_${randomToken(40)}`;
      const scopes = normalizedScopes(authorization.granted_scopes_json);
      const connectionId = crypto.randomUUID();
      await db.prepare("UPDATE mcp_oauth_authorizations SET code_consumed_at = ? WHERE id = ?").run(now.toISOString(), authorization.id);
      await db.prepare(`INSERT INTO mcp_oauth_connections
        (id, user_id, client_id, workspace_id, project_ids_json, library_access, resource, scopes_json, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(connectionId, authorization.user_id, clientId, authorization.workspace_id, authorization.project_ids_json, authorization.library_access, resource, JSON.stringify(scopes), hashOpaqueToken(accessToken), hashOpaqueToken(refreshToken),
          new Date(now.getTime() + 60 * 60 * 1000).toISOString(), new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(), now.toISOString());
      await db.prepare("UPDATE mcp_oauth_clients SET last_used_at = ? WHERE client_id = ?").run(now.toISOString(), clientId);
      return tokenPayload(accessToken, refreshToken, scopes);
    })();
    return issued ? Response.json(issued, { headers: { "cache-control": "no-store", pragma: "no-cache", "access-control-allow-origin": "*" } }) : oauthError("invalid_grant", "The authorization code is invalid, expired, or already used");
  }
  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token") || "";
    if (!refreshToken) return oauthError("invalid_grant", "A refresh token is required");
    const refreshed = await db.transaction(async () => {
      const connection = await db.prepare(`SELECT * FROM mcp_oauth_connections
        WHERE refresh_token_hash = ? AND revoked_at IS NULL FOR UPDATE`).get(hashOpaqueToken(refreshToken)) as ConnectionRow | undefined;
      if (!connection || connection.client_id !== clientId || !sameResource(connection.resource, resource) || Date.parse(connection.refresh_expires_at) <= Date.now()) return null;
      if (connection.workspace_id && !await userCanAccessWorkspace(connection.user_id, connection.workspace_id)) return null;
      const now = new Date();
      const nextAccess = `scn_access_${randomToken(32)}`;
      const nextRefresh = `scn_refresh_${randomToken(40)}`;
      const scopes = normalizedScopes(connection.scopes_json);
      await db.prepare(`UPDATE mcp_oauth_connections SET access_token_hash = ?, refresh_token_hash = ?, access_expires_at = ?, refresh_expires_at = ?, last_used_at = ?
        WHERE id = ?`).run(hashOpaqueToken(nextAccess), hashOpaqueToken(nextRefresh), new Date(now.getTime() + 60 * 60 * 1000).toISOString(), new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(), now.toISOString(), connection.id);
      return tokenPayload(nextAccess, nextRefresh, scopes);
    })();
    return refreshed ? Response.json(refreshed, { headers: { "cache-control": "no-store", pragma: "no-cache", "access-control-allow-origin": "*" } }) : oauthError("invalid_grant", "The refresh token is invalid, expired, or revoked");
  }
  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

export async function revokeMcpOAuthToken(form: URLSearchParams) {
  const token = form.get("token") || "";
  const clientId = form.get("client_id") || "";
  if (token && clientId) {
    const hash = hashOpaqueToken(token);
    await db.prepare(`UPDATE mcp_oauth_connections SET revoked_at = ?
      WHERE client_id = ? AND revoked_at IS NULL AND (access_token_hash = ? OR refresh_token_hash = ?)`)
      .run(new Date().toISOString(), clientId, hash, hash);
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
}

export async function authenticateMcpBearer(request: Request): Promise<McpPrincipal | null> {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(scn_access_[^\s]+)$/i.exec(authorization);
  if (!match) return null;
  const now = new Date().toISOString();
  const row = await db.prepare(`SELECT * FROM mcp_oauth_connections
    WHERE access_token_hash = ? AND revoked_at IS NULL AND access_expires_at > ?`).get(hashOpaqueToken(match[1]), now) as ConnectionRow | undefined;
  if (!row || !sameResource(row.resource, mcpResource(request))) return null;
  if (row.workspace_id && !await userCanAccessWorkspace(row.user_id, row.workspace_id)) return null;
  const lastUsedAt = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (!Number.isFinite(lastUsedAt) || Date.now() - lastUsedAt > 5 * 60 * 1000) {
    await db.prepare("UPDATE mcp_oauth_connections SET last_used_at = ? WHERE id = ?").run(now, row.id);
  }
  return {
    connectionId: row.id,
    clientId: row.client_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    projectIds: normalizedProjectIds(row.project_ids_json),
    libraryAccess: Boolean(row.library_access),
    scopes: normalizedScopes(row.scopes_json),
    resource: row.resource,
    expiresAt: row.access_expires_at,
  };
}

export function principalHasScope(principal: McpPrincipal, scope: McpScope) {
  return principal.scopes.includes(scope);
}

export async function listMcpOAuthConnections(userId: string) {
  const rows = await db.prepare(`SELECT c.*, o.client_name FROM mcp_oauth_connections c
    JOIN mcp_oauth_clients o ON o.client_id = c.client_id
    WHERE c.user_id = ? ORDER BY c.created_at DESC`).all(userId) as Array<ConnectionRow & { client_name: string }>;
  const projectNames = new Map((await listAccessibleProjectRows(userId)).map(rowToProjectListItem).map((project) => [project.id, project.name]));
  return rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    workspaceId: row.workspace_id,
    projectIds: normalizedProjectIds(row.project_ids_json),
    projectNames: normalizedProjectIds(row.project_ids_json)?.map((projectId) => projectNames.get(projectId) || "Unavailable canvas") || null,
    libraryAccess: Boolean(row.library_access),
    scopes: normalizedScopes(row.scopes_json),
    expiresAt: row.refresh_expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }));
}

export async function revokeMcpOAuthConnection(userId: string, connectionId: string) {
  const result = await db.prepare(`UPDATE mcp_oauth_connections SET revoked_at = ?
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), connectionId, userId);
  return result.changes === 1;
}
