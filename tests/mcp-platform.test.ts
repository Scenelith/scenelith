import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, beforeEach } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createScenelithMcpServer } from "../src/lib/mcp/server";
import { POST as postMcpRequest } from "../src/app/api/mcp/route";
import {
  authenticateMcpBearer,
  createMcpOAuthConsentRequest,
  decideMcpOAuthConsent,
  exchangeMcpOAuthToken,
  mcpOAuthMetadata,
  mcpProtectedResourceMetadata,
  registerMcpOAuthClient,
  revokeMcpOAuthToken,
  type McpPrincipal,
} from "../src/lib/mcp/oauth";
import {
  addMcpVideoMasterAsset,
  addMcpVideoMasterScene,
  applyCanvasPatch,
  copyMcpVideoMasterOutput,
  connectMcpCanvasNodes,
  createMcpCanvasRemakeBranch,
  getMcpCanvas,
  listMcpCanvases,
  listMcpLibraryAssets,
  moveMcpVideoMasterAssetLane,
  removeMcpVideoMasterScene,
  replaceMcpCanvasVideoSegment,
  updateMcpCanvasVideoTimeline,
} from "../src/lib/mcp/service";
import { closeRelationalPool, db, resetTestDatabase } from "./postgres-test-db";

const origin = "https://scenelith.example";
const resource = `${origin}/api/mcp`;
const oauthRequest = new Request(`${origin}/api/mcp/oauth/token`);

beforeEach(async () => {
  await resetTestDatabase();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES ('mcp-user', 'mcp@example.test', 'MCP', ?, ?)").run(now, now);
  await db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('mcp-space', 'MCP workspace', ?, ?)").run(now, now);
  await db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('mcp-space', 'mcp-user', 'owner', ?)").run(now);
  await db.prepare("INSERT INTO projects (id, workspace_id, name, status, graph_json, created_at, updated_at) VALUES ('mcp-canvas-a', 'mcp-space', 'Approved canvas', 'draft', '{}', ?, ?)").run(now, now);
  await db.prepare("INSERT INTO projects (id, workspace_id, name, status, graph_json, created_at, updated_at) VALUES ('mcp-canvas-b', 'mcp-space', 'Hidden canvas', 'draft', '{}', ?, ?)").run(now, now);
});

after(async () => { await closeRelationalPool(); });

test("MCP OAuth discovery, challenge, and Origin protection match the HTTP authorization contract", async () => {
  const request = new Request(resource);
  const authorizationMetadata = mcpOAuthMetadata(request);
  const protectedMetadata = mcpProtectedResourceMetadata(request);
  assert.equal(protectedMetadata.resource, resource);
  assert.deepEqual(protectedMetadata.authorization_servers, [origin]);
  assert.equal(authorizationMetadata.registration_endpoint, `${origin}/api/mcp/oauth/register`);
  assert.deepEqual(authorizationMetadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(authorizationMetadata.authorization_response_iss_parameter_supported, true);
  assert.ok(authorizationMetadata.scopes_supported.includes("offline_access"));

  const unauthorized = await postMcpRequest(new Request(resource, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "discovery-test", version: "1.0.0" } } }),
  }));
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate") || "", /resource_metadata="https:\/\/scenelith\.example\/\.well-known\/oauth-protected-resource\/api\/mcp"/);

  const invalidOrigin = await postMcpRequest(new Request(resource, {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "origin-test", version: "1.0.0" } } }),
  }));
  assert.equal(invalidOrigin.status, 403);
});

async function registeredClient() {
  const response = await registerMcpOAuthClient({
    client_name: "Codex test client",
    redirect_uris: ["http://127.0.0.1:49152/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  assert.equal(response.status, 201);
  return await response.json() as { client_id: string };
}

test("OAuth authorization uses PKCE, rotates refresh tokens, and supports revocation", async () => {
  const client = await registeredClient();
  const verifier = "a".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const consent = await createMcpOAuthConsentRequest({
    userId: "mcp-user",
    clientId: client.client_id,
    redirectUri: "http://127.0.0.1:49152/callback",
    responseType: "code",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    scope: "mcp:read canvas:write automation:run",
    state: "state-1",
    resource,
  }, new Request(`${origin}/oauth/authorize`));
  assert.equal(consent.workspaces[0]?.id, "mcp-space");

  const callback = new URL(await decideMcpOAuthConsent({
    userId: "mcp-user",
    requestId: consent.id,
    allow: true,
    workspaceId: "mcp-space",
    projectIds: ["mcp-canvas-a"],
    restrictToProjects: true,
    libraryAccess: true,
    scopes: ["mcp:read", "canvas:write"],
  }));
  const code = callback.searchParams.get("code");
  assert.ok(code);
  assert.equal(callback.searchParams.get("state"), "state-1");
  assert.equal(callback.searchParams.get("iss"), origin);

  const tokenResponse = await exchangeMcpOAuthToken(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: "http://127.0.0.1:49152/callback",
    code_verifier: verifier,
    resource,
  }), oauthRequest);
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string; scope: string };
  assert.equal(tokens.scope, "mcp:read canvas:write");
  const principal = await authenticateMcpBearer(new Request(resource, { headers: { authorization: `Bearer ${tokens.access_token}` } }));
  assert.equal(principal?.workspaceId, "mcp-space");
  assert.deepEqual(principal?.projectIds, ["mcp-canvas-a"]);
  assert.equal(principal?.libraryAccess, true);

  const replay = await exchangeMcpOAuthToken(new URLSearchParams({
    grant_type: "authorization_code", client_id: client.client_id, code,
    redirect_uri: "http://127.0.0.1:49152/callback", code_verifier: verifier, resource,
  }), oauthRequest);
  assert.equal(replay.status, 400);

  const refreshResponse = await exchangeMcpOAuthToken(new URLSearchParams({
    grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource,
  }), oauthRequest);
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json() as { access_token: string; refresh_token: string };
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
  const oldRefresh = await exchangeMcpOAuthToken(new URLSearchParams({
    grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource,
  }), oauthRequest);
  assert.equal(oldRefresh.status, 400);

  await revokeMcpOAuthToken(new URLSearchParams({ token: refreshed.refresh_token, client_id: client.client_id }));
  const revoked = await authenticateMcpBearer(new Request(resource, { headers: { authorization: `Bearer ${refreshed.access_token}` } }));
  assert.equal(revoked, null);

  const stored = await db.prepare("SELECT access_token_hash, refresh_token_hash FROM mcp_oauth_connections LIMIT 1").get() as { access_token_hash: string; refresh_token_hash: string };
  assert.notEqual(stored.access_token_hash, refreshed.access_token);
  assert.notEqual(stored.refresh_token_hash, refreshed.refresh_token);
});

test("OAuth approval recovers when a second submit replaces the first callback navigation", async () => {
  const client = await registeredClient();
  const verifier = "r".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const consent = await createMcpOAuthConsentRequest({
    userId: "mcp-user",
    clientId: client.client_id,
    redirectUri: "http://127.0.0.1:49152/callback",
    responseType: "code",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    scope: "mcp:read canvas:write",
    state: "double-submit",
    resource,
  }, new Request(`${origin}/oauth/authorize`));
  const decision = {
    userId: "mcp-user",
    requestId: consent.id,
    allow: true,
    workspaceId: "mcp-space",
    projectIds: ["mcp-canvas-a"],
    restrictToProjects: true,
    libraryAccess: true,
    scopes: ["mcp:read", "canvas:write"] as Array<"mcp:read" | "canvas:write">,
  };
  const firstCallback = new URL(await decideMcpOAuthConsent(decision));
  const replacementCallback = new URL(await decideMcpOAuthConsent(decision));
  const firstCode = firstCallback.searchParams.get("code") || "";
  const replacementCode = replacementCallback.searchParams.get("code") || "";
  assert.ok(firstCode);
  assert.ok(replacementCode);
  assert.notEqual(replacementCode, firstCode);
  assert.equal(replacementCallback.searchParams.get("state"), "double-submit");

  const staleResponse = await exchangeMcpOAuthToken(new URLSearchParams({
    grant_type: "authorization_code", client_id: client.client_id, code: firstCode,
    redirect_uri: "http://127.0.0.1:49152/callback", code_verifier: verifier, resource,
  }), oauthRequest);
  assert.equal(staleResponse.status, 400);

  const recoveredResponse = await exchangeMcpOAuthToken(new URLSearchParams({
    grant_type: "authorization_code", client_id: client.client_id, code: replacementCode,
    redirect_uri: "http://127.0.0.1:49152/callback", code_verifier: verifier, resource,
  }), oauthRequest);
  assert.equal(recoveredResponse.status, 200);
});

test("OAuth DCR accepts Codex loopback paths and Claude HTTPS callbacks", async () => {
  for (const redirectUri of [
    "http://127.0.0.1:52048/callback/IsICn7mwPa0I",
    "https://claude.ai/api/mcp/auth_callback",
  ]) {
    const response = await registerMcpOAuthClient({
      client_name: redirectUri.includes("claude.ai") ? "Claude" : "Codex",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    assert.equal(response.status, 201);
    const registration = await response.json() as { redirect_uris: string[]; scope: string };
    assert.deepEqual(registration.redirect_uris, [redirectUri]);
    assert.match(registration.scope, /offline_access/);
  }
});

test("OAuth bearer reaches the real Streamable HTTP MCP route", async () => {
  const client = await registeredClient();
  const verifier = "b".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const consent = await createMcpOAuthConsentRequest({
    userId: "mcp-user", clientId: client.client_id, redirectUri: "http://127.0.0.1:49152/callback", responseType: "code",
    codeChallenge: challenge, codeChallengeMethod: "S256", scope: "mcp:read canvas:write", state: "http-route", resource,
  }, new Request(`${origin}/oauth/authorize`));
  const callback = new URL(await decideMcpOAuthConsent({ userId: "mcp-user", requestId: consent.id, allow: true, workspaceId: "mcp-space", projectIds: ["mcp-canvas-a"], restrictToProjects: true, libraryAccess: true, scopes: ["mcp:read", "canvas:write"] }));
  const tokenResponse = await exchangeMcpOAuthToken(new URLSearchParams({
    grant_type: "authorization_code", client_id: client.client_id, code: callback.searchParams.get("code")!, redirect_uri: "http://127.0.0.1:49152/callback", code_verifier: verifier, resource,
  }), oauthRequest);
  const token = (await tokenResponse.json() as { access_token: string }).access_token;
  const response = await postMcpRequest(new Request(resource, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "http-route-test", version: "1.0.0" } } }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/json|text\/event-stream/);
  assert.match(await response.text(), /Scenelith Creative Platform|scenelith/);
});

test("MCP client negotiates with the server and receives only scope-approved tools", async () => {
  const principal: McpPrincipal = {
    connectionId: "connection-1", clientId: "client-1", userId: "mcp-user", workspaceId: "mcp-space",
    projectIds: ["mcp-canvas-a"], libraryAccess: false,
    scopes: ["mcp:read", "canvas:write"], resource, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const server = createScenelithMcpServer(principal, origin);
  const client = new Client({ name: "scenelith-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.ok(names.includes("list_workspaces"));
  assert.ok(names.includes("patch_canvas"));
  assert.ok(names.includes("get_canvas_capabilities"));
  assert.ok(names.includes("get_automation_capabilities"));
  assert.ok(names.includes("validate_automation_workflow"));
  assert.ok(names.includes("validate_automation_connection"));
  assert.ok(names.includes("list_automation_triggers"));
  assert.ok(names.includes("list_automation_trigger_deliveries"));
  assert.ok(names.includes("list_automation_deployment_bindings"));
  assert.ok(names.includes("inspect_canvas_node_inputs"));
  assert.ok(names.includes("create_canvas_node"));
  assert.ok(names.includes("configure_canvas_node"));
  assert.ok(names.includes("connect_canvas_nodes"));
  assert.ok(names.includes("place_canvas_identity"));
  assert.ok(names.includes("inspect_identity_reference"));
  assert.ok(names.includes("duplicate_canvas_nodes"));
  assert.ok(names.includes("select_canvas_output"));
  assert.ok(names.includes("create_video_master"));
  assert.ok(names.includes("configure_video_master_scene"));
  assert.ok(names.includes("create_canvas_segment_node"));
  assert.ok(names.includes("update_canvas_video_timeline"));
  assert.ok(names.includes("create_canvas_remake_branch"));
  assert.ok(names.includes("copy_video_master_output"));
  assert.ok(names.includes("add_video_master_scene"));
  assert.ok(names.includes("move_video_master_asset_lane"));
  assert.ok(names.includes("remove_video_master_scene"));
  assert.ok(!names.includes("create_canvas"));
  assert.ok(!names.includes("place_canvas_asset"));
  assert.ok(!names.includes("list_library_assets"));
  assert.ok(!names.includes("inspect_library_asset"));
  assert.ok(!names.includes("create_identity_from_assets"));
  assert.ok(!names.includes("run_automation_workflow"));
  assert.ok(!names.includes("add_automation_node"));
  assert.ok(!names.includes("create_automation_trigger"));
  assert.ok(!names.includes("set_automation_trigger_status"));
  assert.ok(!names.includes("replay_automation_trigger_delivery"));
  assert.ok(!names.includes("list_automation_credentials"));
  assert.ok(!names.includes("bind_automation_credential"));
  assert.ok(!names.includes("configure_automation_node"));
  assert.ok(!names.includes("connect_automation_nodes"));
  assert.ok(!names.includes("run_canvas_assistant"));
  assert.ok(!names.includes("compose_canvas_prompt"));
  assert.ok(!names.includes("run_canvas_generation"));
  assert.ok(!names.includes("import_tiktok_to_canvas"));
  assert.ok(!names.includes("upload_library_asset"));
  assert.ok(!names.includes("add_video_master_asset"));
  assert.ok(!names.includes("replace_canvas_video_segment"));
  assert.ok(!names.includes("export_video_master_media"));
  assert.ok(!names.includes("detach_canvas_reference"));
  const resources = await client.listResources();
  assert.deepEqual(resources.resources.map((item) => item.uri).sort(), [
    "scenelith://automation/guide",
    "scenelith://automation/node-catalog",
    "scenelith://connection/access",
    "scenelith://guide/agent-workflows",
  ]);
  const guide = await client.readResource({ uri: "scenelith://guide/agent-workflows" });
  assert.match(JSON.stringify(guide.contents), /four tool domains|Choose one tool domain/);
  assert.match(JSON.stringify(guide.contents), /upload_library_asset/);
  assert.match(JSON.stringify(guide.contents), /create_identity_from_assets/);
  const automationGuide = await client.readResource({ uri: "scenelith://automation/guide" });
  assert.match(JSON.stringify(automationGuide.contents), /validate_automation_connection/);
  const automationCatalog = await client.readResource({ uri: "scenelith://automation/node-catalog" });
  assert.match(JSON.stringify(automationCatalog.contents), /ai\.structured-task/);
  const access = await client.readResource({ uri: "scenelith://connection/access" });
  assert.match(JSON.stringify(access.contents), /mcp-canvas-a/);
  assert.match(JSON.stringify(access.contents), /Library tools are unavailable/);
  assert.doesNotMatch(JSON.stringify(access.contents), /access_token|refresh_token|mcp-user/);
  const listed = await client.callTool({ name: "list_workspaces", arguments: {} });
  assert.equal(listed.isError, undefined);
  assert.match(JSON.stringify(listed.structuredContent), /mcp-space/);
  const canvases = await client.callTool({ name: "list_canvases", arguments: {} });
  assert.match(JSON.stringify(canvases.structuredContent), /mcp-canvas-a/);
  assert.doesNotMatch(JSON.stringify(canvases.structuredContent), /mcp-canvas-b/);

  const capabilities = await client.callTool({ name: "get_canvas_capabilities", arguments: { canvas_id: "mcp-canvas-a" } });
  assert.match(JSON.stringify(capabilities.structuredContent), /nano-banana-2/);
  assert.match(JSON.stringify(capabilities.structuredContent), /reference-video/);
  assert.match(JSON.stringify(capabilities.structuredContent), /google\/gemini-3\.7-flash/);
  const automationCapabilities = await client.callTool({ name: "get_automation_capabilities", arguments: { node_type: "logic.merge" } });
  assert.match(JSON.stringify(automationCapabilities.structuredContent), /input-1/);

  const initialCanvas = await client.callTool({ name: "get_canvas", arguments: { canvas_id: "mcp-canvas-a" } });
  let revision = Number((initialCanvas.structuredContent as { canvas: { revision: number } }).canvas.revision);
  const assistantCreated = await client.callTool({ name: "create_canvas_node", arguments: {
    canvas_id: "mcp-canvas-a", expected_revision: revision, type: "assistant", position: { x: 40, y: 60 }, instruction: "Write a compact image prompt",
  } });
  assert.equal(assistantCreated.isError, undefined, JSON.stringify(assistantCreated.structuredContent));
  const assistantResult = assistantCreated.structuredContent as { canvas: { revision: number }; node: { id: string } };
  revision = assistantResult.canvas.revision;
  const imageCreated = await client.callTool({ name: "create_canvas_node", arguments: {
    canvas_id: "mcp-canvas-a", expected_revision: revision, type: "image_generator", position: { x: 420, y: 60 }, model_id: "nano-banana-2",
  } });
  const imageResult = imageCreated.structuredContent as { canvas: { revision: number }; node: { id: string } };
  revision = imageResult.canvas.revision;
  const configured = await client.callTool({ name: "configure_canvas_node", arguments: {
    canvas_id: "mcp-canvas-a", expected_revision: revision, node_id: imageResult.node.id, prompt: "Original editorial portrait", resolution: "4K", aspect_ratio: "4:5", generation_count: 2,
  } });
  revision = Number((configured.structuredContent as { canvas: { revision: number } }).canvas.revision);
  const connected = await client.callTool({ name: "connect_canvas_nodes", arguments: {
    canvas_id: "mcp-canvas-a", expected_revision: revision, source_node_id: assistantResult.node.id, target_node_id: imageResult.node.id,
  } });
  const connectedCanvas = (connected.structuredContent as { canvas: { revision: number; graph: { edges: Array<{ targetHandle?: string }> } } }).canvas;
  assert.equal(connectedCanvas.graph.edges[0]?.targetHandle, "text-input");
  revision = connectedCanvas.revision;
  const duplicated = await client.callTool({ name: "duplicate_canvas_nodes", arguments: {
    canvas_id: "mcp-canvas-a", expected_revision: revision, node_ids: [assistantResult.node.id, imageResult.node.id], offset: { x: 80, y: 80 },
  } });
  assert.equal((duplicated.structuredContent as { duplicatedNodeIds: string[] }).duplicatedNodeIds.length, 2);
  assert.equal((duplicated.structuredContent as { duplicatedEdgeIds: string[] }).duplicatedEdgeIds.length, 1);
  await client.close();
  await server.close();
});

test("MCP semantic Automation tools create, configure, connect, validate, publish, and run a workflow", async () => {
  const principal: McpPrincipal = {
    connectionId: "automation-connection", clientId: "automation-client", userId: "mcp-user", workspaceId: "mcp-space",
    projectIds: ["mcp-canvas-a"], libraryAccess: false,
    scopes: ["mcp:read", "automation:write", "automation:credentials", "automation:run"], resource, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const server = createScenelithMcpServer(principal, origin);
  const client = new Client({ name: "scenelith-automation-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["add_automation_node", "configure_automation_node", "set_automation_run_input", "connect_automation_nodes", "remove_automation_connection", "remove_automation_node", "configure_automation_workflow", "diagnose_automation_run", "list_automation_credentials", "bind_automation_credential", "bind_automation_subworkflow", "unbind_automation_deployment_slot", "list_automation_versions", "export_automation_workflow", "import_automation_workflow", "restore_automation_version", "create_automation_fixture", "preview_automation_node", "retry_automation_run_from_node", "archive_automation_workflow", "list_automation_trigger_deliveries", "replay_automation_trigger_delivery"]) {
    assert.ok(names.includes(name), name);
  }
  const credentials = await client.callTool({ name: "list_automation_credentials", arguments: { workspace_id: "mcp-space" } });
  assert.deepEqual((credentials.structuredContent as { credentials: unknown[] }).credentials, []);

  const created = await client.callTool({ name: "create_automation_workflow", arguments: {
    canvas_id: "mcp-canvas-a", name: "MCP semantic lifecycle",
  } });
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
  const createdWorkflow = (created.structuredContent as { workflow: { workflow: { id: string }; draft: { id: string } } }).workflow;
  const workflowId = createdWorkflow.workflow.id;
  let draftId = createdWorkflow.draft.id;

  const inputAdded = await client.callTool({ name: "add_automation_node", arguments: {
    workflow_id: workflowId, base_draft_version_id: draftId, type: "input.workflow-data", node_id: "payload", position: { x: 280, y: 0 },
  } });
  assert.equal(inputAdded.isError, undefined, JSON.stringify(inputAdded.structuredContent));
  draftId = (inputAdded.structuredContent as { workflow: { draft: { id: string } } }).workflow.draft.id;
  assert.notEqual(draftId, createdWorkflow.draft.id);

  const hiddenFromSidebar = await client.callTool({ name: "set_automation_run_input", arguments: {
    workflow_id: workflowId, base_draft_version_id: draftId, node_id: "payload", field_id: "value", mode: "fixed", fixed_value: { saved: true },
  } });
  assert.equal(hiddenFromSidebar.isError, undefined, JSON.stringify(hiddenFromSidebar.structuredContent));
  assert.equal((hiddenFromSidebar.structuredContent as { sidebar: { visible: boolean } }).sidebar.visible, false);
  draftId = (hiddenFromSidebar.structuredContent as { workflow: { draft: { id: string } } }).workflow.draft.id;

  const shownInSidebar = await client.callTool({ name: "set_automation_run_input", arguments: {
    workflow_id: workflowId, base_draft_version_id: draftId, node_id: "payload", field_id: "value", mode: "optional", label: "Campaign payload",
  } });
  assert.equal(shownInSidebar.isError, undefined, JSON.stringify(shownInSidebar.structuredContent));
  const sidebar = (shownInSidebar.structuredContent as { sidebar: { visible: boolean; mode: string; key: string; runInput: { label: string } } }).sidebar;
  assert.equal(sidebar.visible, true);
  assert.equal(sidebar.mode, "optional");
  assert.equal(sidebar.key, "payload.value");
  assert.equal(sidebar.runInput.label, "Campaign payload");
  draftId = (shownInSidebar.structuredContent as { workflow: { draft: { id: string } } }).workflow.draft.id;

  const finishAdded = await client.callTool({ name: "add_automation_node", arguments: {
    workflow_id: workflowId, base_draft_version_id: draftId, type: "output.finish", node_id: "finish", position: { x: 560, y: 0 },
  } });
  assert.equal(finishAdded.isError, undefined, JSON.stringify(finishAdded.structuredContent));
  draftId = (finishAdded.structuredContent as { workflow: { draft: { id: string } } }).workflow.draft.id;

  const configured = await client.callTool({ name: "configure_automation_node", arguments: {
    workflow_id: workflowId, base_draft_version_id: draftId, node_id: "finish", config: { message: "Received {{ data }}" },
  } });
  assert.equal(configured.isError, undefined, JSON.stringify(configured.structuredContent));
  draftId = (configured.structuredContent as { workflow: { draft: { id: string } } }).workflow.draft.id;

  const firstEdge = await client.callTool({ name: "connect_automation_nodes", arguments: {
    workflow_id: workflowId, base_draft_version_id: draftId, edge_id: "start-payload",
    source_node_id: "manual-run", source_port: "run", target_node_id: "payload", target_port: "run", role: "flow",
  } });
  assert.equal(firstEdge.isError, undefined, JSON.stringify(firstEdge.structuredContent));
  draftId = (firstEdge.structuredContent as { workflow: { draft: { id: string } } }).workflow.draft.id;

  const secondEdge = await client.callTool({ name: "connect_automation_nodes", arguments: {
    workflow_id: workflowId, base_draft_version_id: draftId, edge_id: "payload-finish",
    source_node_id: "payload", source_port: "data", target_node_id: "finish", target_port: "data", role: "flow",
  } });
  assert.equal(secondEdge.isError, undefined, JSON.stringify(secondEdge.structuredContent));
  const connectedWorkflow = (secondEdge.structuredContent as { workflow: { draft: { id: string; graph: unknown; validation: { valid: boolean } } } }).workflow;
  draftId = connectedWorkflow.draft.id;
  assert.equal(connectedWorkflow.draft.validation.valid, true, JSON.stringify(connectedWorkflow.draft.validation));

  const staleEdit = await client.callTool({ name: "configure_automation_node", arguments: {
    workflow_id: workflowId, base_draft_version_id: createdWorkflow.draft.id, node_id: "finish", config: { message: "stale" },
  } });
  assert.equal(staleEdit.isError, true);
  assert.match(JSON.stringify(staleEdit.structuredContent), /AUTOMATION_DRAFT_CONFLICT/);

  const validated = await client.callTool({ name: "validate_automation_workflow", arguments: { graph: connectedWorkflow.draft.graph } });
  assert.equal((validated.structuredContent as { inspection: { validation: { valid: boolean } } }).inspection.validation.valid, true);

  const published = await client.callTool({ name: "publish_automation_workflow", arguments: { workflow_id: workflowId } });
  assert.equal(published.isError, undefined, JSON.stringify(published.structuredContent));
  const versions = await client.callTool({ name: "list_automation_versions", arguments: { workflow_id: workflowId } });
  assert.match(JSON.stringify(versions.structuredContent), /published/);
  const exported = await client.callTool({ name: "export_automation_workflow", arguments: { workflow_id: workflowId, version: "published" } });
  assert.equal(exported.isError, undefined, JSON.stringify(exported.structuredContent));

  const fixtureCreated = await client.callTool({ name: "create_automation_fixture", arguments: {
    workflow_id: workflowId, name: "Finish preview", node_inputs: { finish: { data: { preview: true } } }, runtime_inputs: {},
  } });
  assert.equal(fixtureCreated.isError, undefined, JSON.stringify(fixtureCreated.structuredContent));
  const fixtureId = (fixtureCreated.structuredContent as { fixture: { id: string } }).fixture.id;
  const preview = await client.callTool({ name: "preview_automation_node", arguments: { workflow_id: workflowId, fixture_id: fixtureId, node_id: "finish" } });
  assert.equal(preview.isError, undefined, JSON.stringify(preview.structuredContent));
  const previewRunId = (preview.structuredContent as { run: { runId: string } }).run.runId;
  let previewStatus = "queued";
  for (let attempt = 0; attempt < 50 && !["completed", "failed", "cancelled"].includes(previewStatus); attempt += 1) {
    const previewDetail = await client.callTool({ name: "get_automation_run", arguments: { run_id: previewRunId } });
    previewStatus = String((previewDetail.structuredContent as { run: { status: string } }).run.status);
    if (!["completed", "failed", "cancelled"].includes(previewStatus)) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(previewStatus, "completed");
  const fixtureDeleted = await client.callTool({ name: "delete_automation_fixture", arguments: { workflow_id: workflowId, fixture_id: fixtureId } });
  assert.equal(fixtureDeleted.isError, undefined, JSON.stringify(fixtureDeleted.structuredContent));
  const createdTrigger = await client.callTool({ name: "create_automation_trigger", arguments: {
    workflow_id: workflowId, canvas_id: "mcp-canvas-a", type: "schedule", name: "Hourly payload",
    schedule: { mode: "interval", everyMinutes: 60, misfirePolicy: "catch-up-once" },
    inputs: { "payload.value": { hello: "scheduled" } }, overlap_policy: "skip", max_concurrent_runs: 1,
  } });
  assert.equal(createdTrigger.isError, undefined, JSON.stringify(createdTrigger.structuredContent));
  const triggerId = (createdTrigger.structuredContent as { trigger: { id: string; status: string } }).trigger.id;
  assert.equal((createdTrigger.structuredContent as { trigger: { status: string } }).trigger.status, "paused");
  const activated = await client.callTool({ name: "set_automation_trigger_status", arguments: { trigger_id: triggerId, status: "active" } });
  assert.equal(activated.isError, undefined, JSON.stringify(activated.structuredContent));
  assert.match(JSON.stringify(activated.structuredContent), /activeVersionId/);
  const triggers = await client.callTool({ name: "list_automation_triggers", arguments: { workflow_id: workflowId } });
  assert.match(JSON.stringify(triggers.structuredContent), /Hourly payload/);
  const deliveries = await client.callTool({ name: "list_automation_trigger_deliveries", arguments: { canvas_id: "mcp-canvas-a", workflow_id: workflowId } });
  assert.deepEqual((deliveries.structuredContent as { deliveries: unknown[] }).deliveries, []);
  const paused = await client.callTool({ name: "set_automation_trigger_status", arguments: { trigger_id: triggerId, status: "paused" } });
  assert.equal(paused.isError, undefined, JSON.stringify(paused.structuredContent));
  const deletedTrigger = await client.callTool({ name: "delete_automation_trigger", arguments: { trigger_id: triggerId } });
  assert.equal(deletedTrigger.isError, undefined, JSON.stringify(deletedTrigger.structuredContent));
  const run = await client.callTool({ name: "run_automation_workflow", arguments: {
    canvas_id: "mcp-canvas-a", workflow_id: workflowId, inputs: { "payload.value": { hello: "world" } }, mode: "production",
  } });
  assert.equal(run.isError, undefined, JSON.stringify(run.structuredContent));
  const runId = (run.structuredContent as { run: { runId: string } }).run.runId;

  let runDetail: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await client.callTool({ name: "get_automation_run", arguments: { run_id: runId } });
    runDetail = (response.structuredContent as { run: Record<string, unknown> }).run;
    if (["completed", "failed", "cancelled"].includes(String(runDetail.status))) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(runDetail?.status, "completed", JSON.stringify(runDetail));
  assert.deepEqual((runDetail?.runtimeInputs as Record<string, unknown> | undefined)?.["payload.value"], { hello: "world" });
  assert.ok(Array.isArray(runDetail?.nodeRunDetails));
  assert.ok((runDetail?.nodeRunDetails as Array<{ nodeId: string; input: unknown; output: unknown }>).some((node) => node.nodeId === "finish" && node.input && node.output));
  const diagnosis = await client.callTool({ name: "diagnose_automation_run", arguments: { run_id: runId } });
  assert.match(JSON.stringify(diagnosis.structuredContent), /The run is complete/);

  const packageValue = (exported.structuredContent as { package: unknown }).package;
  const imported = await client.callTool({ name: "import_automation_workflow", arguments: { canvas_id: "mcp-canvas-a", package: packageValue } });
  assert.equal(imported.isError, undefined, JSON.stringify(imported.structuredContent));
  const importedWorkflowId = (imported.structuredContent as { detail: { workflow: { id: string } } }).detail.workflow.id;
  const archived = await client.callTool({ name: "archive_automation_workflow", arguments: { workflow_id: importedWorkflowId } });
  assert.equal(archived.isError, undefined, JSON.stringify(archived.structuredContent));

  await client.close();
  await server.close();
});

test("selected project grants isolate both canvases and their Library assets", async () => {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO assets
    (id, workspace_id, project_id, kind, role, filename, storage_path, mime_type, created_at)
    VALUES ('asset-approved', 'mcp-space', 'mcp-canvas-a', 'library_image', 'library', 'approved.png', 'approved.png', 'image/png', ?),
           ('asset-hidden', 'mcp-space', 'mcp-canvas-b', 'library_image', 'library', 'hidden.png', 'hidden.png', 'image/png', ?)`)
    .run(now, now);
  await db.prepare("INSERT INTO personas (id, workspace_id, name, notes, created_at, updated_at) VALUES ('identity-hidden-lineage', 'mcp-space', 'Workspace identity', '', ?, ?)").run(now, now);
  await db.prepare(`INSERT INTO assets
    (id, workspace_id, persona_id, kind, role, sort_order, filename, storage_path, mime_type, metadata_json, created_at)
    VALUES ('identity-hidden-copy', 'mcp-space', 'identity-hidden-lineage', 'persona_ref', 'reference', 0, 'copy.png', 'copy.png', 'image/png', ?, ?)`)
    .run(JSON.stringify({ sourceAssetId: "asset-hidden" }), now);
  const principal: McpPrincipal = {
    connectionId: "project-isolation", clientId: "project-isolation", userId: "mcp-user", workspaceId: "mcp-space",
    projectIds: ["mcp-canvas-a"], libraryAccess: true, scopes: ["mcp:read"], resource,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  assert.deepEqual((await listMcpCanvases(principal)).map((canvas) => canvas.id), ["mcp-canvas-a"]);
  assert.deepEqual((await listMcpLibraryAssets(principal, { workspaceId: "mcp-space" }, origin)).assets.map((asset) => asset.id), ["asset-approved"]);
  await assert.rejects(() => listMcpLibraryAssets({ ...principal, libraryAccess: false }, { workspaceId: "mcp-space" }, origin), /Library access was not approved/);

  const server = createScenelithMcpServer({ ...principal, scopes: ["mcp:read", "identity:write"] }, origin);
  const client = new Client({ name: "scenelith-identity-isolation-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const identities = await client.callTool({ name: "list_identities", arguments: { workspace_id: "mcp-space" } });
  const workspaceIdentity = (identities.structuredContent as { identities: Array<{ id: string; type: string; groups: { character: Array<{ sourceAssetId: string | null }> } }> }).identities.find((identity) => identity.id === "identity-hidden-lineage")!;
  assert.equal(workspaceIdentity.type, "single");
  assert.equal(workspaceIdentity.groups.character[0]?.sourceAssetId, null);
  const hiddenReference = await client.callTool({ name: "create_identity_from_assets", arguments: {
    workspace_id: "mcp-space", name: "Must not exist", identity_type: "single",
    references: [{ asset_id: "asset-hidden", role: "reference" }],
  } });
  assert.equal(hiddenReference.isError, true);
  assert.match(JSON.stringify(hiddenReference.structuredContent), /accessible image from this workspace/);
  await client.close();
  await server.close();
});

test("full Canvas grant exposes Library upload, replacement, Video Master and provider-running tools", async () => {
  const principal: McpPrincipal = {
    connectionId: "connection-full", clientId: "client-full", userId: "mcp-user", workspaceId: "mcp-space",
    projectIds: ["mcp-canvas-a"], libraryAccess: true,
    scopes: ["mcp:read", "canvas:write", "assistant:run", "generation:run", "library:write", "import:write", "identity:write"], resource, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const server = createScenelithMcpServer(principal, origin);
  const client = new Client({ name: "scenelith-full-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    "list_library_assets", "inspect_library_asset", "inspect_identity_reference", "place_canvas_asset", "attach_canvas_reference", "upload_library_asset",
    "detach_canvas_reference",
    "create_identity_from_assets", "add_identity_references", "reorder_identity_references", "remove_identity_reference",
    "replace_canvas_video_segment", "add_video_master_asset", "export_video_master_media",
    "run_canvas_assistant", "compose_canvas_prompt", "run_canvas_generation", "edit_canvas_image",
    "import_tiktok_to_canvas", "capture_canvas_video_frame", "materialize_canvas_video_segment", "refresh_tiktok_source",
  ]) assert.ok(names.includes(name), `${name} should be available`);
  await client.close();
  await server.close();
});

test("Library upload needs its own scope instead of borrowing external import access", async () => {
  const base: McpPrincipal = {
    connectionId: "library-scope", clientId: "library-scope", userId: "mcp-user", workspaceId: "mcp-space",
    projectIds: ["mcp-canvas-a"], libraryAccess: true,
    scopes: ["mcp:read", "canvas:write", "import:write"], resource, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const toolNames = async (principal: McpPrincipal) => {
    const server = createScenelithMcpServer(principal, origin);
    const client = new Client({ name: "scenelith-library-scope-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    await client.close();
    await server.close();
    return names;
  };
  const importOnly = await toolNames(base);
  assert.ok(importOnly.includes("import_tiktok_to_canvas"));
  assert.ok(!importOnly.includes("upload_library_asset"));
  const libraryWrite = await toolNames({ ...base, scopes: ["mcp:read", "library:write"] });
  assert.ok(libraryWrite.includes("upload_library_asset"));
  assert.ok(!libraryWrite.includes("import_tiktok_to_canvas"));
});

test("MCP completes Library to single and Before / After Identity workflows without mixing groups", async () => {
  const principal: McpPrincipal = {
    connectionId: "identity-e2e", clientId: "identity-e2e", userId: "mcp-user", workspaceId: "mcp-space",
    projectIds: ["mcp-canvas-a"], libraryAccess: true,
    scopes: ["mcp:read", "library:write", "identity:write", "canvas:write"], resource, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const server = createScenelithMcpServer(principal, origin);
  const client = new Client({ name: "scenelith-identity-e2e-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const libraryAssetIds: string[] = [];
  for (const filename of ["character-a.png", "character-b.png", "before-a.png", "after-a.png", "before-b.png"]) {
    const uploaded = await client.callTool({ name: "upload_library_asset", arguments: {
      canvas_id: "mcp-canvas-a", filename, mime_type: "image/png", content_base64: tinyPng,
    } });
    assert.equal(uploaded.isError, undefined, JSON.stringify(uploaded.structuredContent));
    libraryAssetIds.push(String((uploaded.structuredContent as { asset: { id: string } }).asset.id));
  }
  const firstLibraryPage = await client.callTool({ name: "list_library_assets", arguments: { workspace_id: "mcp-space", media_type: "image", limit: 2 } });
  const firstLibraryContent = firstLibraryPage.structuredContent as { assets: Array<{ id: string }>; counts: { all: number; image: number; video: number }; next_cursor: string | null };
  assert.equal(firstLibraryContent.assets.length, 2);
  assert.equal(firstLibraryContent.counts.image, 5);
  assert.ok(firstLibraryContent.next_cursor);
  const secondLibraryPage = await client.callTool({ name: "list_library_assets", arguments: { workspace_id: "mcp-space", media_type: "image", limit: 2, cursor: firstLibraryContent.next_cursor } });
  const secondLibraryIds = (secondLibraryPage.structuredContent as { assets: Array<{ id: string }> }).assets.map((asset) => asset.id);
  assert.equal(secondLibraryIds.some((id) => firstLibraryContent.assets.some((asset) => asset.id === id)), false);

  const library = await client.callTool({ name: "list_library_assets", arguments: { workspace_id: "mcp-space", media_type: "image", limit: 20 } });
  const listedLibraryIds = (library.structuredContent as { assets: Array<{ id: string }>; next_cursor: string | null }).assets.map((asset) => asset.id);
  for (const assetId of libraryAssetIds) assert.ok(listedLibraryIds.includes(assetId));
  const libraryPreview = await client.callTool({ name: "inspect_library_asset", arguments: { workspace_id: "mcp-space", asset_id: libraryAssetIds[0] } });
  assert.equal(libraryPreview.isError, undefined, JSON.stringify(libraryPreview.structuredContent));
  assert.equal(libraryPreview.content.some((item) => item.type === "image"), true);

  const singleCreated = await client.callTool({ name: "create_identity_from_assets", arguments: {
    workspace_id: "mcp-space", name: "Olivia", notes: "Consistent character", identity_type: "single",
    references: [{ asset_id: libraryAssetIds[0], role: "reference" }],
  } });
  assert.equal(singleCreated.isError, undefined, JSON.stringify(singleCreated.structuredContent));
  let single = (singleCreated.structuredContent as { identity: { id: string; type: string; groups: { character: Array<{ id: string }>; before: Array<{ id: string }>; after: Array<{ id: string }> } } }).identity;
  assert.equal(single.type, "single");
  assert.equal(single.groups.character.length, 1);
  assert.equal(single.groups.before.length, 0);
  assert.equal(single.groups.after.length, 0);
  const identityPreview = await client.callTool({ name: "inspect_identity_reference", arguments: {
    workspace_id: "mcp-space", identity_id: single.id, asset_id: single.groups.character[0].id,
  } });
  assert.equal(identityPreview.isError, undefined, JSON.stringify(identityPreview.structuredContent));
  assert.equal(identityPreview.content.some((item) => item.type === "image"), true);
  assert.doesNotMatch(JSON.stringify(identityPreview.structuredContent), /sourceAssetId/);
  const singleAdded = await client.callTool({ name: "add_identity_references", arguments: {
    workspace_id: "mcp-space", identity_id: single.id, references: [{ asset_id: libraryAssetIds[1], role: "reference" }],
  } });
  single = (singleAdded.structuredContent as { identity: typeof single }).identity;
  assert.equal(single.groups.character.length, 2);
  const singleMixRejected = await client.callTool({ name: "add_identity_references", arguments: {
    workspace_id: "mcp-space", identity_id: single.id, references: [{ asset_id: libraryAssetIds[2], role: "before" }],
  } });
  assert.equal(singleMixRejected.isError, true);
  assert.match(JSON.stringify(singleMixRejected.structuredContent), /single Identity accepts only Character/);

  const transformationCreated = await client.callTool({ name: "create_identity_from_assets", arguments: {
    workspace_id: "mcp-space", name: "Olivia transformation", identity_type: "before_after",
    references: [
      { asset_id: libraryAssetIds[2], role: "before" },
      { asset_id: libraryAssetIds[3], role: "after" },
    ],
  } });
  assert.equal(transformationCreated.isError, undefined, JSON.stringify(transformationCreated.structuredContent));
  let transformation = (transformationCreated.structuredContent as { identity: {
    id: string; type: string;
    groups: { character: Array<{ id: string; sourceAssetId: string | null }>; before: Array<{ id: string; sourceAssetId: string | null }>; after: Array<{ id: string; sourceAssetId: string | null }> };
  } }).identity;
  assert.equal(transformation.type, "before_after");
  assert.equal(transformation.groups.character.length, 0);
  assert.deepEqual(transformation.groups.before.map((asset) => asset.sourceAssetId), [libraryAssetIds[2]]);
  assert.deepEqual(transformation.groups.after.map((asset) => asset.sourceAssetId), [libraryAssetIds[3]]);

  const beforeAdded = await client.callTool({ name: "add_identity_references", arguments: {
    workspace_id: "mcp-space", identity_id: transformation.id, references: [{ asset_id: libraryAssetIds[4], role: "before" }],
  } });
  transformation = (beforeAdded.structuredContent as { identity: typeof transformation }).identity;
  assert.equal(transformation.groups.before.length, 2);
  const transformMixRejected = await client.callTool({ name: "add_identity_references", arguments: {
    workspace_id: "mcp-space", identity_id: transformation.id, references: [{ asset_id: libraryAssetIds[0], role: "reference" }],
  } });
  assert.equal(transformMixRejected.isError, true);
  assert.match(JSON.stringify(transformMixRejected.structuredContent), /Before \/ After Identity accepts only Before or After/);

  const reversedBeforeIds = transformation.groups.before.map((asset) => asset.id).reverse();
  const reordered = await client.callTool({ name: "reorder_identity_references", arguments: {
    workspace_id: "mcp-space", identity_id: transformation.id, role: "before", asset_ids: reversedBeforeIds,
  } });
  transformation = (reordered.structuredContent as { identity: typeof transformation }).identity;
  assert.deepEqual(transformation.groups.before.map((asset) => asset.id), reversedBeforeIds);
  const removed = await client.callTool({ name: "remove_identity_reference", arguments: {
    workspace_id: "mcp-space", identity_id: transformation.id, asset_id: transformation.groups.before[1].id,
  } });
  transformation = (removed.structuredContent as { identity: typeof transformation }).identity;
  assert.equal(transformation.groups.before.length, 1);
  assert.equal(transformation.groups.after.length, 1);

  const listed = await client.callTool({ name: "list_identities", arguments: { workspace_id: "mcp-space" } });
  const listedTransformation = (listed.structuredContent as { identities: Array<typeof transformation> }).identities.find((identity) => identity.id === transformation.id)!;
  assert.equal(listedTransformation.type, "before_after");
  assert.equal(listedTransformation.groups.character.length, 0);

  const canvasRead = await client.callTool({ name: "get_canvas", arguments: { canvas_id: "mcp-canvas-a" } });
  const revision = Number((canvasRead.structuredContent as { canvas: { revision: number } }).canvas.revision);
  const wrongVariant = await client.callTool({ name: "place_canvas_identity", arguments: {
    canvas_id: "mcp-canvas-a", expected_revision: revision, identity_id: transformation.id, variant: "reference", position: { x: 100, y: 100 },
  } });
  assert.equal(wrongVariant.isError, true);
  const placed = await client.callTool({ name: "place_canvas_identity", arguments: {
    canvas_id: "mcp-canvas-a", expected_revision: revision, identity_id: transformation.id, variant: "after", position: { x: 100, y: 100 },
  } });
  assert.equal(placed.isError, undefined, JSON.stringify(placed.structuredContent));
  assert.equal((placed.structuredContent as { node: { data: { personaVariant: string; referenceAssetIds: string[] } } }).node.data.personaVariant, "after");
  assert.deepEqual((placed.structuredContent as { node: { data: { referenceAssetIds: string[] } } }).node.data.referenceAssetIds, transformation.groups.after.map((asset) => asset.id));

  await client.close();
  await server.close();
});

test("semantic Canvas tools preserve Video Master history, source lineage, order and edge cleanup", async () => {
  const videoAssetId = "00000000-0000-4000-8000-000000000001";
  const generatedAssetId = "00000000-0000-4000-8000-000000000002";
  const graph = {
    nodes: [
      { id: "image-source", type: "frameNode", position: { x: 0, y: 0 }, data: { kind: "scene", title: "Source image", mediaType: "image", imageUrl: "/api/assets/image-source" } },
      { id: "video-source", type: "frameNode", position: { x: 0, y: 400 }, data: { kind: "source", title: "Source video", mediaType: "video", outputUrl: "/api/assets/source-video", videoSegments: [{ id: "segment-a", index: 0, sequenceIndex: 0, label: "Scene 01", role: "scene", start: 0, end: 5 }] } },
      { id: "master", type: "frameNode", position: { x: 800, y: 400 }, data: { kind: "videoMaster", title: "Video Master", mediaType: "video", videoMasterSelectedClipId: "clip-a", videoMasterClips: [
        { id: "clip-a", sequenceIndex: 0, title: "Scene A", role: "scene", origin: "source", duration: 5, prompt: "", generatedOutputs: [{ assetId: generatedAssetId, url: `/api/assets/${generatedAssetId}`, mediaType: "video", modelId: "seedance-2-fast", durationSeconds: 5 }] },
        { id: "clip-b", sequenceIndex: 1, title: "Scene B", role: "scene", origin: "source", duration: 5, prompt: "" },
      ] } },
    ],
    edges: [{ id: "master-edge-b", source: "video-source", target: "master", data: { portType: "video", inputRole: "reference-video", masterClipId: "clip-b" } }],
  };
  await db.prepare("UPDATE projects SET graph_json = ? WHERE id = 'mcp-canvas-a'").run(JSON.stringify(graph));
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO assets (id, workspace_id, project_id, kind, role, filename, storage_path, mime_type, metadata_json, created_at)
    VALUES (?, 'mcp-space', 'mcp-canvas-a', 'library_video', 'library', 'clip.mp4', '/tmp/not-read.mp4', 'video/mp4', ?, ?)`)
    .run(videoAssetId, JSON.stringify({ originalName: "clip.mp4", durationSeconds: 7, width: 1080, height: 1920, aspectRatio: 0.5625 }), now);
  const principal: McpPrincipal = {
    connectionId: "semantic-tools", clientId: "semantic-tools", userId: "mcp-user", workspaceId: "mcp-space", projectIds: ["mcp-canvas-a"], libraryAccess: true,
    scopes: ["mcp:read", "canvas:write"], resource, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  const initialRevision = (await getMcpCanvas(principal, "mcp-canvas-a")).revision;
  const remake = await createMcpCanvasRemakeBranch(principal, { projectId: "mcp-canvas-a", expectedRevision: initialRevision, sourceNodeId: "image-source" });
  assert.equal(remake.canvas.graph.edges.some((edge) => edge.source === "image-source" && edge.target === remake.node.id && edge.data?.inputRole === "reference-image"), true);
  const replaced = await replaceMcpCanvasVideoSegment(principal, { projectId: "mcp-canvas-a", expectedRevision: remake.canvas.revision, sourceNodeId: "video-source", segmentId: "segment-a", replacementAssetId: videoAssetId });
  assert.equal(replaced.graph.nodes.find((node) => node.id === "video-source")?.data.videoSegments?.[0]?.replacementAssetId, videoAssetId);
  const added = await addMcpVideoMasterAsset(principal, { projectId: "mcp-canvas-a", expectedRevision: replaced.revision, nodeId: "master", assetId: videoAssetId });
  assert.equal(added.clip.duration, 7);
  const moved = await moveMcpVideoMasterAssetLane(principal, { projectId: "mcp-canvas-a", expectedRevision: added.canvas.revision, nodeId: "master", clipId: added.clip.id, lane: "original" });
  assert.equal(moved.graph.nodes.find((node) => node.id === "master")?.data.videoMasterClips?.find((clip) => clip.id === added.clip.id)?.origin, "source");
  const blank = await addMcpVideoMasterScene(principal, { projectId: "mcp-canvas-a", expectedRevision: moved.revision, nodeId: "master" });
  assert.equal(blank.clip.origin, "generated");
  const masterConnected = await connectMcpCanvasNodes(principal, { projectId: "mcp-canvas-a", expectedRevision: blank.canvas.revision, sourceNodeId: "image-source", targetNodeId: "master", targetClipId: blank.clip.id, inputRole: "reference-image" });
  assert.equal(masterConnected.graph.edges.some((edge) => edge.target === "master" && edge.data?.masterClipId === blank.clip.id && edge.data?.inputRole === "reference-image"), true);
  const timeline = await updateMcpCanvasVideoTimeline(principal, { projectId: "mcp-canvas-a", expectedRevision: masterConnected.revision, sourceNodeId: "video-source", cuts: [2] });
  assert.deepEqual(timeline.graph.nodes.find((node) => node.id === "video-source")?.data.videoSegments?.map((segment) => [segment.start, segment.end]), [[0, 2], [2, 5]]);
  const copied = await copyMcpVideoMasterOutput(principal, { projectId: "mcp-canvas-a", expectedRevision: timeline.revision, nodeId: "master", sourceClipId: "clip-a", outputIndex: 0, targetClipId: "clip-b" });
  const copiedClip = copied.graph.nodes.find((node) => node.id === "master")?.data.videoMasterClips?.find((clip) => clip.id === "clip-b");
  assert.equal(copiedClip?.outputAssetId, generatedAssetId);
  assert.equal(copiedClip?.generatedOutputs?.length, 1);
  const removed = await removeMcpVideoMasterScene(principal, { projectId: "mcp-canvas-a", expectedRevision: copied.revision, nodeId: "master", clipId: "clip-b" });
  const clips = removed.graph.nodes.find((node) => node.id === "master")?.data.videoMasterClips || [];
  assert.deepEqual(clips.map((clip) => clip.sequenceIndex), clips.map((_, index) => index));
  assert.equal(removed.graph.edges.some((edge) => edge.data?.masterClipId === "clip-b"), false);
});

test("canvas patches are atomic and preserve unrelated graph state", () => {
  const next = applyCanvasPatch({
    nodes: [{ id: "note-1", type: "frameNode", position: { x: 0, y: 0 }, data: { kind: "note", title: "Original", note: "keep" } }],
    edges: [], viewport: { x: 4, y: 5, zoom: 1 },
  }, [
    { type: "update_node", nodeId: "note-1", data: { title: "Updated" } },
    { type: "add_node", id: "note-2", position: { x: 100, y: 80 }, data: { kind: "note", title: "Second" } },
    { type: "add_edge", id: "edge-1", source: "note-1", target: "note-2" },
  ]);
  assert.equal(next.nodes[0]?.data.note, "keep");
  assert.equal(next.nodes[0]?.data.title, "Updated");
  assert.equal(next.edges[0]?.target, "note-2");
  assert.deepEqual(next.viewport, { x: 4, y: 5, zoom: 1 });
});
