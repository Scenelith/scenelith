# Scenelith MCP

Scenelith exposes one remote MCP endpoint:

```text
https://<your-scenelith-domain>/api/mcp
```

Users paste this URL into a compatible AI agent. The agent discovers Scenelith OAuth metadata, opens the browser, and asks the user to sign in and approve access. Users do not create API keys or copy access tokens.

## Connection flow

1. The MCP client calls the protected resource and receives an OAuth challenge containing the protected-resource metadata URL.
2. The client discovers the Scenelith authorization server and dynamically registers its HTTPS or localhost callback.
3. Scenelith opens `/oauth/authorize`. The signed-in user chooses workspace scope, all projects/canvases or an explicit project/canvas list, optional Library access, and the requested capabilities.
4. Scenelith returns a short-lived, single-use authorization code bound to the client's PKCE S256 challenge and the exact MCP resource URL.
5. The client exchanges the code for a one-hour access token and a rotating 30-day refresh token.
6. The MCP endpoint exposes only the tools covered by the granted scopes. The user can revoke the connection from `/settings/mcp`.

Tokens are opaque. Only SHA-256 hashes are stored in PostgreSQL. Tokens are accepted only in the `Authorization: Bearer` header and only for the exact MCP resource for which they were issued.

## Built-in connection menu

The user profile dropdown contains an **MCP** section with setup tabs for Codex, Claude, Claude Code, ChatGPT, and other Streamable HTTP clients. It shows the endpoint for the current Scenelith instance, copyable client configuration, and links to the full guide and connection revocation screen.

The menu uses `PUBLIC_URL` when the operator configured one. Otherwise it derives the endpoint from the incoming request origin, so a local self-host displays its local address and a server reached through its domain displays that origin. Localhost is labelled for desktop clients and warns that web agents need a secure tunnel or public deployment. Public HTTPS is marked ready for remote clients. A non-loopback HTTP origin is flagged until the operator configures a public HTTPS `PUBLIC_URL`.

The setup URL is not a credential. Every client still completes OAuth and receives only the resources and capabilities approved by the signed-in user.

## Scopes

| Scope | Capability |
| --- | --- |
| `mcp:read` | Approved workspaces and canvas graphs, identities, workflows, and run history |
| `canvas:write` | Create canvases and patch nodes, edges, names, or viewport state |
| `assistant:run` | Build generator prompts and run Canvas Assistant nodes; may use credits or configured providers |
| `generation:run` | Run image and video generation and reconcile output into Canvas and Library |
| `library:write` | Upload images and videos into an approved canvas Library |
| `import:write` | Import external TikTok media and append its source graph to an approved canvas |
| `identity:write` | Create and maintain single Character or Before/After identities from approved Library images |
| `automation:write` | Create, semantically edit, validate, version, publish, import/export, archive, and configure automation workflows, triggers, fixtures, and deployment bindings |
| `automation:run` | Start, preview, retry, inspect, diagnose, and cancel automation runs; activate or pause configured triggers |
| `automation:credentials` | List safe metadata for already-saved external credentials and connect one to a workflow deployment slot; secret values are never returned to the agent |

Library access is a separate resource grant on the consent screen. Reading Library assets requires that grant; direct uploads additionally require `library:write` but do not require Canvas editing permission. When a connection is limited to selected canvases, canvas reads and writes, automation workflows and runs, and Library results are limited to those canvases. Workspace-level identities remain covered by the visible `mcp:read` permission; creating an identity additionally requires both `identity:write` and Library access. OAuth scopes and resource grants add a second boundary; they never override the signed-in user's Scenelith workspace or Cloud team role. Automation repository permissions remain authoritative.

In the current product model a saved Canvas is the project resource, so the OAuth picker labels the boundary as **Project / canvas access**. A specific-project grant cannot create or import an additional canvas, and every project-scoped tool rechecks both the OAuth grant and the user's current Scenelith access before reading or changing data.

## Canvas node numbers

Every node shows a short number scoped to its type and canvas, such as **Image Generator 3**, **Video Generator 1**, or **Assistant 2**. Existing canvases are backfilled using creation time, with saved order as a fallback. Renaming or moving a node does not change its number. Deleting a node leaves other numbers unchanged; the next new node of that type reuses the smallest free number. Copies receive a new free number.

Ask an agent to use “Image Generator 3 on Canvas 01.” The agent reads `get_canvas`, resolves the label through `nodeDirectory` (`nodeId`, `type`, `number`, `label`, `title`), and passes the returned `nodeId` to semantic tools. Never pass the short number as a node ID. Re-read before writing because a deleted number may have been reused. With collaboration enabled, MCP reads the live document and checks its revision and state vector when writing.

## Tools

### Information architecture for agents

MCP clients receive short server instructions plus four readable resources before they choose tools:

- `scenelith://guide/agent-workflows` defines the typed object model, four tool domains, canonical multi-step recipes, and write-safety rules.
- `scenelith://connection/access` reports the exact approved workspace, canvas IDs, Library grant, and OAuth scopes without exposing credentials or internal user data.
- `scenelith://automation/guide` defines the safe Automation editing, validation, publishing, trigger, deployment-binding, run, and diagnosis lifecycle.
- `scenelith://automation/node-catalog` exposes the current versioned node catalog with exact fields, defaults, inputs, outputs, port types, prompt-variable roots, help text, and run-input binding support.

The tools intentionally use a flat MCP namespace for client compatibility, while their names and the guide divide them into four unambiguous domains:

| Domain | Owns | Typical flow |
| --- | --- | --- |
| Canvas | Visible graph, nodes, edges, references, timelines, generation state | `list_canvases` → `get_canvas` → semantic Canvas tool with `expected_revision` |
| Library | Durable uploaded or generated image/video assets | `list_library_assets` or `upload_library_asset` → returned `asset_id` |
| Identities | Either one Character group or separate Before/After image groups | Library image `asset_id` values → explicit `identity_type` → `create_identity_from_assets` / `add_identity_references` |
| Automations | Canvas-scoped workflow drafts, immutable published versions, triggers, deployment bindings, fixtures, and runs | capabilities → create/semantic edits → validate/publish → preview/run/poll/diagnose |

IDs are typed and never interchangeable. Uploading media creates a Library asset only. The agent must explicitly choose whether to place it visibly with `place_canvas_asset`, attach it as a generation reference with `attach_canvas_reference`, or copy it into an Identity with an Identity tool. Identities also have a strict type: `single` accepts only `reference` (Character), while `before_after` accepts only `before` and `after`; MCP never silently converts or mixes the two.

These read tools are available after `mcp:read` is approved:

- `list_workspaces`
- `list_canvases`
- `get_canvas`
- `get_canvas_capabilities`
- `inspect_canvas_node_inputs`
- `export_canvas_document`
- `list_identities`
- `inspect_identity_reference`
- `list_automation_workflows`
- `get_automation_workflow`
- `get_automation_capabilities`
- `validate_automation_workflow`
- `validate_automation_connection`
- `list_automation_versions`
- `export_automation_workflow`
- `list_automation_triggers`
- `list_automation_trigger_deliveries`
- `list_automation_deployment_bindings`
- `list_automation_fixtures`
- `list_automation_runs`
- `get_automation_run`
- `diagnose_automation_run`

`list_library_assets` and `inspect_library_asset` appear only when the user enables Library access. The list is cursor-paginated and returns media counts plus dimensions, duration, model, and size metadata when known. Its HTTP media URLs are conveniences for an already signed-in browser, not bearer links; agents use `inspect_library_asset` to receive a bounded image thumbnail or representative video frame inside the MCP result. `inspect_identity_reference` provides the equivalent bounded preview for Character, Before, and After groups. `create_canvas` and `import_canvas_document` appear only when the connection is not restricted to an explicit canvas list.

`list_automation_credentials` additionally requires `automation:credentials`. It returns only safe metadata such as ID, name, kind, fingerprint, and timestamps. It never returns decrypted payloads, tokens, passwords, or request headers.

Write tools appear only when their corresponding scope was approved:

- Canvas graph: `create_canvas`, `import_canvas_document`, `patch_canvas`, `create_canvas_node`, `configure_canvas_node`, `connect_canvas_nodes`, `place_canvas_asset`, `attach_canvas_reference`, `detach_canvas_reference`, `place_canvas_identity`, `duplicate_canvas_nodes`, `select_canvas_output`, `create_canvas_remake_branch`
- Video editing: `create_video_master`, `configure_video_master_scene`, `update_canvas_video_timeline`, `create_canvas_segment_node`, `replace_canvas_video_segment`, `add_video_master_asset`, `add_video_master_scene`, `move_video_master_asset_lane`, `copy_video_master_output`, `remove_video_master_scene`, `export_video_master_media`
- Assistant: `run_canvas_assistant`, `compose_canvas_prompt`
- Generation: `run_canvas_generation`, `get_canvas_generation`, `cancel_canvas_generation`, `edit_canvas_image`
- Library upload: `upload_library_asset`
- Import and media derivation: `import_tiktok_to_canvas`, `capture_canvas_video_frame`, `materialize_canvas_video_segment`, `refresh_tiktok_source`
- Identities: `create_identity_from_assets`, `add_identity_references`, `reorder_identity_references`, `remove_identity_reference`
- Automation authoring: `create_automation_workflow`, `import_automation_workflow`, `add_automation_node`, `configure_automation_node`, `set_automation_run_input`, `connect_automation_nodes`, `remove_automation_connection`, `remove_automation_node`, `configure_automation_workflow`, `save_automation_workflow`, `publish_automation_workflow`, `restore_automation_version`, `set_system_automation_model`, `archive_automation_workflow`
- Automation fixtures and deployment: `create_automation_fixture`, `delete_automation_fixture`, `create_automation_trigger`, `delete_automation_trigger`, `bind_automation_subworkflow`, `unbind_automation_deployment_slot`; `bind_automation_credential` additionally requires `automation:credentials`
- Automation execution: `run_automation_workflow`, `preview_automation_node`, `retry_automation_run_from_node`, `cancel_automation_run`, `set_automation_trigger_status`, `replay_automation_trigger_delivery`

`patch_canvas` requires the exact current canvas revision returned by `get_canvas`. A stale write is rejected with a conflict instead of overwriting a human or another agent's newer canvas state.

Automation semantic edits require the exact current `base_draft_version_id` returned by `get_automation_workflow` or the previous edit. A stale agent edit is rejected with `AUTOMATION_DRAFT_CONFLICT` and the current draft ID instead of overwriting newer UI or agent changes.

### Automation node and RUN INPUTS synchronization

The Automation editor's Node library, MCP node catalog, workflow validator, and worker all consume the same versioned node registry. Adding a node definition to that registry makes it discoverable through `get_automation_capabilities` and `scenelith://automation/node-catalog` without adding a separate MCP-specific node tool or manually maintaining a second list. Existing historical versions remain addressable by exact `node_type` and `version`.

For a field marked `runtimeBindable`, use `set_automation_run_input`:

- `mode: "optional"` makes it appear in the left **RUN INPUTS** panel and allows an empty value when the node permits it.
- `mode: "required"` makes it appear in the left **RUN INPUTS** panel and requires a value before a run can start.
- `mode: "fixed"` removes it from **RUN INPUTS** and keeps the current value in the node configuration.

The exact runtime key is always `node-id.field-id`. `get_automation_workflow` returns the derived run-input contract for both draft and published versions, and publish/run/trigger activation revalidate it.

## Cloud

The Cloud deployment publishes the same shared MCP and OAuth routes from the public core. Its user, workspace, team-role, metering, and provider boundaries continue to come from the Cloud edition adapters. The connection URL is the Cloud application's public origin plus `/api/mcp`.

## Self-hosting

Set the canonical public HTTPS origin in the existing deployment configuration:

```dotenv
PUBLIC_URL=https://scenelith.example.com
```

Then apply database migrations and restart the application roles. The web application and workers continue to use the existing PostgreSQL and Redis services; MCP does not require a separate process.

OAuth requires HTTPS for public hosts. Plain HTTP is accepted only for localhost/loopback development callbacks. The reverse proxy must forward the original host and protocol, and `/api/mcp`, `/oauth/authorize`, `/api/mcp/oauth/*`, and `/.well-known/oauth-*` must resolve to the same Scenelith deployment.

Open `https://scenelith.example.com/mcp` to copy the endpoint and `https://scenelith.example.com/settings/mcp` to revoke connected agents.

## Operational notes

- Dynamic client registration and MCP requests use the existing distributed request limiter.
- Library and Identity previews are bounded thumbnails returned through MCP image content. Original private media is never exposed as a public or pre-authenticated URL.
- Direct MCP media upload is limited to 25 MB for images and 32 MB for videos because the bytes travel as base64 JSON. Larger videos use the existing multipart Library upload in the Scenelith UI.
- Authorization codes expire after five minutes and can be used once.
- Access tokens expire after one hour.
- Refresh tokens expire after 30 days and rotate on every use.
- Revoking either token revokes the whole connection.
- Canvas writes use collaboration revisions and audit events include the OAuth connection and client IDs.
- Automation runs use the same immutable input and workflow snapshots as runs started from the Scenelith UI.

## Download original generator output

Call `get_canvas` and resolve a visible label such as `Image Generator 48` through `nodeDirectory`. Then call `download_canvas_node_output` with `canvas_id` and `node_id`. Omitting `output_index` downloads the currently selected result, exactly like the generator toolbar Download button; a positive 1-based `output_index` chooses an entry from `generatedOutputs` without changing the selection. Both image and video generators are supported.

The result contains `downloadUrl`, `expiresAt`, `filename`, `mimeType`, `sizeBytes`, `assetId`, and `variant: "original"`. Fetch the URL as a binary file, following redirects. It requires no browser session, contains no OAuth access token, and never selects a thumbnail. The link expires within 10 minutes (earlier if the access token expires), and refreshing or revoking the connection invalidates it. Treat it as a temporary private capability. Access to the canvas and source asset is rechecked when downloading. R2 delivery redirects to a signed original object URL; an already issued storage URL remains usable until its own short expiry. Local storage streams the original file. The operation needs `mcp:read`, respects approved canvas grants, and does not generate media, consume credits, or mutate the graph.
