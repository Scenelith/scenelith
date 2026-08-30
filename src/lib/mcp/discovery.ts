import type { McpPrincipal } from "@/lib/mcp/oauth";

export const SCENELITH_MCP_INSTRUCTIONS = `Scenelith has four separate tool domains: Canvas, Library, Identities, and Automations. Read scenelith://guide/agent-workflows before the first multi-step task and scenelith://connection/access before choosing a workspace or canvas. Before Automation authoring or repair, read scenelith://automation/guide and call get_automation_capabilities; validate every proposed connection and complete graph. IDs are typed and are never interchangeable: workspace_id selects a workspace, canvas_id selects a project/canvas, asset_id selects Library media, identity_id selects an Identity, and workflow_id/run_id select Automation objects. Always read before writing, use semantic tools instead of patch_canvas when one exists, and fetch get_canvas immediately before a Canvas write so expected_revision is current. Never guess IDs or expand beyond the approved connection. A tool that is absent was not granted.`;

export const SCENELITH_AGENT_GUIDE = `# Scenelith agent workflow guide

## Object model

- A **Workspace** owns canvases and reusable identities.
- A **Canvas** is the project resource. It owns a graph of nodes and connections and has a collaboration revision.
- A **Library asset** is uploaded or generated media belonging to one approved canvas. Its \`asset_id\` can be reused by Canvas and Identity tools.
- An **Identity** belongs to a workspace and has one explicit type: \`single\` uses only the \`reference\` (Character) group, while \`before_after\` uses only \`before\` and \`after\` groups. The types cannot be mixed. Videos cannot be Identity references.
- An **Automation workflow** belongs to one canvas. Published versions and runs are immutable snapshots.

IDs are typed. Never pass a \`canvas_id\` where an \`asset_id\`, \`identity_id\`, \`workflow_id\`, node ID, or run ID is expected.

## Choose one tool domain

### Canvas

Use Canvas tools to read or change the visible creative graph: nodes, connections, placed assets, generation references, identities, timelines, and Video Master scenes. Start with \`list_canvases\`, then \`get_canvas\`. Call \`get_canvas_capabilities\` before choosing node types, models, settings, ports, or reference roles. Prefer semantic tools such as \`create_canvas_node\`, \`place_canvas_asset\`, \`attach_canvas_reference\`, and \`place_canvas_identity\`; use \`patch_canvas\` only for graph edits without a dedicated tool.

### Library

Use Library tools for durable media, not for graph layout. \`list_library_assets\` returns approved images and videos in cursor pages; follow \`next_cursor\` until it is null when a complete search is required. Browser URLs are not agent credentials, so call \`inspect_library_asset\` to actually see a candidate image or a representative video frame. \`upload_library_asset\` adds base64 media to one approved canvas Library and returns an \`asset_id\`; it does not place the media on the Canvas and does not create an Identity.

### Identities

Use Identity tools for reusable visual subjects. First obtain approved image \`asset_id\` values from Library. Choose \`identity_type=single\` for one consistent Character group or \`identity_type=before_after\` for separate transformation stages. Use \`create_identity_from_assets\` to create and initially fill it, then \`add_identity_references\`, \`reorder_identity_references\`, or \`remove_identity_reference\` without changing that type. \`list_identities\` returns explicit \`type\` and \`groups.character/before/after\` fields; call \`inspect_identity_reference\` to see one returned group image. Use \`place_canvas_identity\` only when one group should appear on a Canvas.

### Automations

Use Automation tools for repeatable workflows and runs, not for direct Canvas graph editing. Read \`scenelith://automation/guide\`, then call \`get_automation_capabilities\` for exact versioned node settings, ports, variables, and defaults. Start with \`list_automation_workflows\` and \`get_automation_workflow\`. Validate each edge with \`validate_automation_connection\` and the complete graph with \`validate_automation_workflow\`. The authoring sequence is create, validate, save, re-read, validate again, then publish. The execution sequence is inspect required run inputs, run, poll with \`get_automation_run\`, and cancel only when requested.

## Canonical recipes

### Upload a reference and use it on a Canvas

1. \`list_workspaces\`
2. \`list_canvases\`
3. \`upload_library_asset\` → keep the returned \`asset_id\`
4. \`get_canvas\` → keep the current revision
5. Choose exactly one:
   - \`place_canvas_asset\` to create a visible media node
   - \`attach_canvas_reference\` to feed an existing generator without creating a visible media node

### Create or fill an Identity from uploaded references

1. Upload each image with \`upload_library_asset\`, or find it with \`list_library_assets\` and visually check candidates with \`inspect_library_asset\`
2. Choose one type and keep its roles strict:
   - \`identity_type=single\` with only \`role=reference\`
   - \`identity_type=before_after\` with only \`role=before\` and/or \`role=after\`
3. Use \`create_identity_from_assets\` with the selected image \`asset_id\` values
4. Later use \`add_identity_references\` to add more approved Library images to valid groups
5. Use \`place_canvas_identity\` with one valid variant only if that group should be present in a Canvas graph

### Build and run an Automation

1. Read \`scenelith://automation/guide\`; call \`get_automation_capabilities\`
2. \`list_automation_workflows\` and inspect an existing workflow when useful
3. \`create_automation_workflow\`
4. Validate every new edge with \`validate_automation_connection\`
5. Validate the complete graph with \`validate_automation_workflow\`
6. \`save_automation_workflow\`, re-read it, and validate the saved graph again
7. \`publish_automation_workflow\`
8. \`run_automation_workflow\` with the exact reported run-input keys and poll \`get_automation_run\`

## Safety and access rules

- Read \`scenelith://connection/access\` and operate only inside its approved workspace and canvases.
- An unavailable tool means the user did not grant its scope or resource access. Do not work around it.
- Call \`get_canvas\` immediately before every Canvas write and pass its exact \`revision\` as \`expected_revision\`.
- If a write returns a revision conflict, read the Canvas again and recompute the intended change.
- Do not invent object IDs, model IDs, node types, ports, roles, or workflow versions.
- Running Assistant, generation, or Automation tools may consume credits or configured provider resources.
`;

export function scenelithConnectionAccess(principal: McpPrincipal) {
  return {
    workspace_id: principal.workspaceId,
    canvas_access: principal.projectIds
      ? { mode: "selected", canvas_ids: principal.projectIds }
      : { mode: "all_in_workspace", canvas_ids: null },
    library_access: principal.libraryAccess,
    scopes: principal.scopes,
    guidance: principal.libraryAccess
      ? "Library reads are limited to the approved canvases. Library writes additionally require library:write."
      : "Library tools are unavailable because Library access was not approved.",
  };
}
