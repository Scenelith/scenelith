import type { McpPrincipal } from "@/lib/mcp/oauth";

export const SCENELITH_MCP_INSTRUCTIONS = `Scenelith has four separate tool domains: Canvas, Library, Identities, and Automations. Read scenelith://guide/agent-workflows before the first multi-step task and scenelith://connection/access before choosing a workspace or canvas. Before Automation authoring or repair, read scenelith://automation/guide and call get_automation_capabilities; validate every proposed connection and complete graph. IDs are typed and are never interchangeable: workspace_id selects a workspace, canvas_id selects a project/canvas, asset_id selects Library media, identity_id selects an Identity, and workflow_id/run_id select Automation objects. Always read before writing, use semantic tools instead of patch_canvas when one exists, and fetch get_canvas immediately before a Canvas write so expected_revision is current. Canvas nodeDirectory maps visible labels such as Image Generator 3 to nodeId. Resolve the user's type and number within the selected canvas using this directory, then pass nodeId to tools; numbers are not IDs. Creation positions are preferred anchors: the server avoids overlaps using nodeDirectory bounds, including titles, handles and result history. Read returned positions after creation or resizing; align related nodes in rows or columns using those bounds, not a fixed height. Use duplicate_canvas_node to copy one node with its existing inputs; use duplicate_canvas_nodes for a selection. Deleted numbers may be reused, so re-read the directory before acting. Never guess IDs or expand beyond the approved connection. A tool that is absent was not granted.`;

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

Visible Canvas labels have stable per-type numbers (for example Image Generator 3). The get_canvas nodeDirectory includes label, type, number and nodeId. Match the user's label in the selected canvas, then use its nodeId. Numbers are scoped to one type and canvas, survive edits, and may be reused after deletion.

For layout, \`nodeDirectory[].bounds\` gives the reserved rectangle in canvas coordinates (including title, handles, toolbar and result history). Place related nodes in aligned rows or columns with at least 24 canvas units between these rectangles. Creation coordinates are preferred anchors: the server moves a new node to free space if occupied, including nodes added in the same batch. Configuring a larger aspect ratio or width also checks collisions for that node only. Read back the returned position before placing the next node. Do not overwrite it with the original requested coordinates. \`patch_canvas\` position-only edits remain exact for intentional rearrangement; they do not automatically tidy existing nodes.

Use \`download_canvas_node_output\` to download a generator’s full original image or video. Resolve the visible node label with \`nodeDirectory\` first. Omit \`output_index\` for the selected result, or use a 1-based index into \`generatedOutputs\`. Fetch the returned \`downloadUrl\` as a file (following redirects); it needs no browser cookies and expires within 10 minutes. Treat it as a temporary private link. Request a fresh link after expiry or OAuth refresh. This reads existing media without changing the graph or spending credits.

### Library

Use Library tools for durable media, not for graph layout. \`list_library_assets\` returns approved images and videos in cursor pages; follow \`next_cursor\` until it is null when a complete search is required. Browser URLs are not agent credentials, so call \`inspect_library_asset\` to actually see a candidate image or a representative video frame. \`upload_library_asset\` adds base64 media to one approved canvas Library and returns an \`asset_id\`; it does not place the media on the Canvas and does not create an Identity.

### Identities

Use Identity tools for reusable visual subjects. First obtain approved image \`asset_id\` values from Library. Choose \`identity_type=single\` for one consistent Character group or \`identity_type=before_after\` for separate transformation stages. Use \`create_identity_from_assets\` to create and initially fill it, then \`add_identity_references\`, \`reorder_identity_references\`, or \`remove_identity_reference\` without changing that type. \`list_identities\` returns explicit \`type\` and \`groups.character/before/after\` fields; call \`inspect_identity_reference\` to see one returned group image. Use \`place_canvas_identity\` only when one group should appear on a Canvas.

### Automations

Use Automation tools for repeatable workflows and runs, not for direct Canvas graph editing. Read \`scenelith://automation/guide\`, then call \`get_automation_capabilities\` for exact versioned node settings, ports, variables, and defaults. Start with \`list_automation_workflows\` and \`get_automation_workflow\`. Validate each edge with \`validate_automation_connection\` and the complete graph with \`validate_automation_workflow\`. The authoring sequence is create, validate, save, re-read, validate again, then publish. The execution sequence is inspect required run inputs, run, poll with \`get_automation_run\`, and cancel only when requested.

## Canonical recipes

### Copy a node with its inputs

1. \`get_canvas\` → resolve the requested label in \`nodeDirectory\` and keep the current revision.
2. \`duplicate_canvas_node\` with \`canvas_id\`, \`expected_revision\` and \`node_id\`. No position or manual reconnection is needed.
3. Use the returned \`node.id\`, position and canvas revision. Settings, saved outputs, attachments and incoming connections are copied without running generation. Original nodes and their outgoing connections are unchanged.

For a group, use \`duplicate_canvas_nodes\` with \`node_ids\`: internal connections follow the copies and external inputs stay connected to their original sources. On a revision conflict, re-read before retrying; do not blindly repeat a successful copy.

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

### Generate one Video Master scene

Read \`get_canvas\` and resolve the Master from \`nodeDirectory\`. In \`videoMasterScenes\`, select that node's scene by number/title and keep its \`clipId\` and \`generationRevision\`. Call \`run_canvas_generation\` with \`clip_id\`, \`expected_scene_revision\` and the canvas revision. Source clips are prepared automatically; do not manually materialize scenes first. Unrelated node/layout/history updates do not invalidate the scene revision, but source cuts, model, prompt and references do. Poll the returned generation ID. If \`GENERATION_ALREADY_RUNNING\` is returned, poll its \`generationId\` instead of launching again. A new generation after completion is a new billable request.

### Seedance reference modes

Seedance 2.x (including 2.5) supports either strict \`start-frame\` / \`end-frame\` inputs or multimodal \`reference-image\` + \`reference-video\` + \`reference-audio\`. These modes cannot be mixed. For a person's image plus source motion, use multimodal references and describe each role in the prompt; requesting the image as the opening pose does not guarantee an exact first frame. If exact frame matching is required, use frame mode; the provider aspect ratio is automatically \`adaptive\`. Read \`referenceModeRules\` in the model capabilities. Connecting a new input atomically disconnects incompatible inputs on that node or selected Master scene; the last connected mode wins and source timeline media stays intact. Explain this mode change when connecting inputs. Do not reclassify a start image unless that matches the user's intent. An \`INCOMPATIBLE_REFERENCE_MODES\` error is local validation before provider submission, not a provider rejection.

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
