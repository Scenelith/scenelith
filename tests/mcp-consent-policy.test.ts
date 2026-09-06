import assert from "node:assert/strict";
import test from "node:test";
import { availableMcpConsentScopes, mcpConsentPermissionCopy, type McpConsentWorkspace } from "../src/lib/mcp/consent-policy";
import { mcpScopes } from "../src/lib/mcp/oauth";

const member: McpConsentWorkspace = { id: "team", name: "Team", role: "member", automation: { run: true, edit: true, publish: false, manageTriggers: false, manageCredentials: false } };
const owner: McpConsentWorkspace = { id: "own", name: "Own", role: "owner", automation: { run: true, edit: true, publish: true, manageTriggers: true, manageCredentials: true } };

test("teammate consent offers existing editing rights without credential administration", () => {
  const scopes = availableMcpConsentScopes(mcpScopes, [member]);
  assert.ok(scopes.includes("canvas:write"));
  assert.ok(scopes.includes("automation:write"));
  assert.ok(scopes.includes("generation:run"));
  assert.ok(!scopes.includes("automation:credentials"));
  assert.match(mcpConsentPermissionCopy("canvas:write", [member]).detail, /Creating canvases requires an owner/);
  assert.match(mcpConsentPermissionCopy("automation:write", [member]).detail, /drafts/);
  assert.doesNotMatch(mcpConsentPermissionCopy("automation:write", [member]).detail, /Create, edit and publish/);
});

test("workspace selection changes consent capabilities without widening the client's request", () => {
  assert.deepEqual(availableMcpConsentScopes(mcpScopes, [owner]), [...mcpScopes]);
  assert.ok(availableMcpConsentScopes(mcpScopes, [owner, member]).includes("automation:credentials"));
  assert.deepEqual(availableMcpConsentScopes(mcpScopes, []), ["mcp:read"]);
  assert.deepEqual(availableMcpConsentScopes(["mcp:read"], [owner]), ["mcp:read"]);
  assert.match(mcpConsentPermissionCopy("automation:write", [owner, member]).detail, /only in workspaces/);
  assert.deepEqual(availableMcpConsentScopes(mcpScopes, [{ ...member, automation: { run: false, edit: false, publish: false, manageTriggers: false, manageCredentials: false } }]).filter(scope => scope.startsWith("automation:")), []);
});
