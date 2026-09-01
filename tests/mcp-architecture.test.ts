import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("MCP is a link-first OAuth connection and never an API-key setup", () => {
  const oauth = source("src/lib/mcp/oauth.ts");
  const endpoint = source("src/app/api/mcp/route.ts");
  const setup = source("src/app/mcp/page.tsx");
  assert.match(oauth, /codeChallengeMethod !== "S256"/);
  assert.match(oauth, /hashOpaqueToken\(accessToken\)/);
  assert.match(oauth, /hashOpaqueToken\(refreshToken\)/);
  assert.match(endpoint, /resource_metadata=/);
  assert.match(setup, /No API key or manual token is needed/);
  assert.doesNotMatch(`${oauth}\n${endpoint}\n${setup}`, /createMcpApiKey|x-api-key|api_key=/i);
});

test("MCP setup uses the Scenelith marketing shell across Cloud and self-host", () => {
  const setup = source("src/app/mcp/page.tsx");
  const styles = source("src/app/mcp/mcp.module.css");
  const header = source("src/components/marketing/MarketingHeader.tsx");
  const footer = source("src/components/marketing/MarketingFooter.tsx");
  const chrome = source("src/components/marketing/MarketingChrome.module.css");
  const selfhostChrome = source("src/editions/selfhost/marketing.ts");
  assert.match(setup, /import MarketingHeader from "@\/components\/marketing\/MarketingHeader"/);
  assert.match(setup, /import MarketingFooter from "@\/components\/marketing\/MarketingFooter"/);
  assert.match(setup, /<MarketingHeader active="MCP" authenticated=\{authenticated\}/);
  assert.match(setup, /<MarketingFooter authenticated=\{authenticated\}/);
  assert.match(header, /import BrandMark from "@\/components\/BrandMark"/);
  assert.match(header, /editionMarketingChrome\.navigation\.map/);
  assert.match(footer, /editionMarketingChrome\.footerGroups\.map/);
  for (const label of ["Product", "Models", "MCP", "Docs", "Connected agents"]) assert.match(selfhostChrome, new RegExp(`"${label}"`));
  assert.doesNotMatch(setup, /Sparkles/);
  assert.match(styles, /font-size: clamp\(70px, 7\.2vw, 118px\)/);
  assert.match(chrome, /\.footerSignal/);
});

test("MCP capabilities are scope-gated and canvas writes are revision-safe", () => {
  const server = source("src/lib/mcp/server.ts");
  const service = source("src/lib/mcp/service.ts");
  for (const scope of ["canvas:write", "assistant:run", "generation:run", "library:write", "import:write", "identity:write", "automation:write", "automation:credentials", "automation:run"]) {
    assert.match(server, new RegExp(`principalHasScope\\(principal, "${scope.replace(":", "\\:")}"\\)`));
  }
  assert.match(service, /current\.revision !== input\.expectedRevision/);
  assert.match(service, /writeCollaborativeGraph\(input\.projectId, nextGraph, input\.expectedRevision\)/);
  assert.match(service, /automationCapabilitiesForWorkspace/);
  assert.match(server, /principal\.libraryAccess/);
  assert.match(server, /!principal\.projectIds/);
  assert.match(service, /tokenAllowsProject\(principal, projectId\)/);
  assert.match(service, /Library access was not approved/);
  assert.match(service, /detail\.workflow\.projectId\) await assertProject/);
});

test("MCP teaches agents the typed four-domain architecture", () => {
  const discovery = source("src/lib/mcp/discovery.ts");
  const server = source("src/lib/mcp/server.ts");
  for (const domain of ["Canvas", "Library", "Identities", "Automations"]) assert.match(discovery, new RegExp(domain));
  for (const uri of ["scenelith://guide/agent-workflows", "scenelith://connection/access"]) assert.match(server, new RegExp(uri.replaceAll("/", "\\/")));
  assert.match(discovery, /IDs are typed/);
  assert.match(discovery, /upload_library_asset/);
  assert.match(discovery, /create_identity_from_assets/);
  assert.match(discovery, /inspect_library_asset/);
  assert.match(discovery, /inspect_identity_reference/);
  assert.match(server, /next_cursor/);
  assert.match(server, /type: "image"/);
});

test("Cloud and self-host consume the same public MCP implementation", () => {
  const docs = source("docs/MCP.md");
  assert.match(docs, /Cloud deployment publishes the same shared MCP and OAuth routes from the public core/);
  assert.match(docs, /PUBLIC_URL=https:\/\/scenelith\.example\.com/);
  assert.match(docs, /MCP does not require a separate process/);
});

test("the profile menu derives MCP setup from each Cloud or self-host instance", () => {
  const menu = source("src/components/ProfileMenu.tsx");
  const setup = source("src/app/api/mcp/setup/route.ts");
  assert.match(setup, /new URL\("\/api\/mcp", baseUrl\(request\)\)/);
  assert.match(setup, /"local" : endpoint\.protocol === "https:" \? "https" : "insecure_remote"/);
  assert.match(setup, /"cache-control": "no-store"/);
  assert.match(menu, /Connect an AI agent/);
  for (const client of ["Codex", "Claude", "Claude Code", "ChatGPT", "Other"]) assert.match(menu, new RegExp(client));
  assert.match(menu, /Settings → Plugins → MCPs → Add server/);
  assert.match(menu, /Choose Streamable HTTP/);
  assert.match(menu, /click Authenticate/);
  assert.match(menu, /No API key or manual token is needed/);
  assert.match(menu, /set PUBLIC_URL to the public HTTPS origin/);
  assert.match(menu, /ChatGPT cannot reach localhost directly/);
});

test("OAuth consent prevents duplicate submits while the loopback callback is pending", () => {
  const form = source("src/app/oauth/authorize/OAuthConsentForm.tsx");
  const route = source("src/app/api/mcp/oauth/authorize/route.ts");
  const oauth = source("src/lib/mcp/oauth.ts");
  assert.match(form, /pendingDecision !== null/);
  assert.match(form, /Connecting…/);
  assert.match(form, /disabled=\{pendingDecision !== null\}/);
  assert.match(form, /window\.location\.assign\(payload\.redirectTo\)/);
  assert.match(form, /AbortController/);
  assert.match(route, /redirectTo: destination/);
  assert.match(oauth, /canRetryApproval/);
  assert.match(oauth, /replacementCode/);
  assert.match(oauth, /code_consumed_at/);
  assert.match(oauth, /authorization_response_iss_parameter_supported: true/);
  assert.match(oauth, /"offline_access"/);
});
