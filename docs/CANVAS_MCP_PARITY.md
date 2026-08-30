# Canvas MCP parity audit

This is the requirement ledger for giving an OAuth-connected agent the same meaningful Canvas operations that a signed-in user has in the main Scenelith canvas. A green implementation test is not enough by itself: the final audit must exercise the tool through an MCP client and verify the persisted graph or durable operation result.

Status values:

- `implemented`: code exists, but the final end-to-end audit may still be pending;
- `verified`: unit/integration and protocol-level evidence exists;
- `pending`: the manual Canvas capability is not yet represented by a safe MCP operation.

## Canvas and graph

| Manual capability | MCP operation | Status | Required evidence |
| --- | --- | --- | --- |
| List and open allowed canvases | `list_canvases`, `get_canvas` | verified | OAuth resource-grant integration test |
| Create a canvas | `create_canvas` | verified | Tool hidden for explicit-canvas grants |
| Rename canvas | `patch_canvas.name` | implemented | Protocol mutation + revision assertion |
| Move and resize nodes | `configure_canvas_node`, `patch_canvas` | implemented | Persisted position/size test |
| Delete nodes and their edges | `patch_canvas.remove_node` | implemented | Atomic graph test |
| Create/remove raw edges | `patch_canvas` | implemented | Structural test; semantic tools remain preferred |
| Connect typed inputs | `connect_canvas_nodes` | implemented | Text/image/video/audio compatibility and capacity tests |
| Remove a connection | `patch_canvas.remove_edge` | implemented | Protocol test |
| Duplicate a selection | `duplicate_canvas_nodes` | implemented | Internal-edge and lineage-removal protocol test |
| Set viewport | `patch_canvas.set_viewport` | implemented | Persisted viewport test |
| Concurrent human/agent writes | every canvas mutation | verified | Exact revision conflict test |
| Undo/redo | client-local UI history | not applicable | Agents use explicit revision-safe inverse mutations |

## Node catalogue

| Manual node/path | MCP operation | Status | Required evidence |
| --- | --- | --- | --- |
| Image Generator | `create_canvas_node(image_generator)` | implemented | Defaults and selected model protocol test |
| Video Generator | `create_canvas_node(video_generator)` | implemented | Defaults and selected model protocol test |
| Assistant | `create_canvas_node(assistant)` | implemented | Model and instruction protocol test |
| Sticky Note | `create_canvas_node(note)` | implemented | Text/color/size protocol test |
| Library image/video scene | `place_canvas_asset` | implemented | Resource-grant and media-kind tests |
| Identity Character/Before/After | `place_canvas_identity` | implemented | Variant and selected-reference tests |
| TikTok source + slideshow scenes | `import_tiktok_to_canvas` | implemented | Provider fixture plus persisted graph |
| TikTok video timeline | `import_tiktok_to_canvas` | implemented | Detected segments and source edges |
| Edit/reset source video cuts and active output | `update_canvas_video_timeline` | implemented | Boundary validation, stale clip invalidation and detected-baseline restore |
| Video Master | `create_video_master` | implemented | Full clip sequence and per-clip edges |
| Captured video frame scene | `capture_canvas_video_frame` | implemented | ffmpeg fixture and persisted asset/node |
| Extracted video segment scene | `materialize_canvas_video_segment` | implemented | ffmpeg fixture and persisted asset/node |
| Add an extracted segment as a standalone clip node | `create_canvas_segment_node` | implemented | Source lineage and materialized asset update |
| Replace a source segment with an uploaded clip | `replace_canvas_video_segment` | implemented | Safe upload/resource contract and replacement lineage |

## Models and settings

| Manual capability | MCP operation | Status | Required evidence |
| --- | --- | --- | --- |
| Discover every live generation model | `get_canvas_capabilities` | implemented | Catalogue equality test against provider registry |
| Discover Assistant models and vision support | `get_canvas_capabilities` | implemented | Catalogue equality test |
| Set generator model | `configure_canvas_node` | implemented | Media-type and unknown-model rejection |
| Set ratio/resolution/duration | `configure_canvas_node` | implemented | Live provider compatibility tests |
| Enable supported audio | `configure_canvas_node` | implemented | Unsupported models force audio off |
| Set generation batch count | `configure_canvas_node` | implemented | Bounded 1–8 test |
| Set Assistant model/system prompt/instruction | `configure_canvas_node` | implemented | Model and length tests |
| Set note text/color/dimensions | `configure_canvas_node` | implemented | Type-specific settings test |
| Configure Video Master clip model/settings | `configure_video_master_scene` | implemented | Per-clip compatibility and edge pruning |
| Reorder Video Master scenes | `configure_video_master_scene.sequence_index` | implemented | Deterministic ordering test |
| Move a Video Master output into another scene | `copy_video_master_output` | implemented | Preserve per-scene history and selected lane |
| Add uploaded clips to Video Master | `add_video_master_asset` | implemented | Accessible Library video and measured metadata |
| Add a blank generator-only Video Master scene | `add_video_master_scene` | implemented | Selected-scene defaults and normalized order |
| Move a standalone uploaded clip between OUTPUT and ORIGINAL | `move_video_master_asset_lane` | implemented | Implicit reference and lane-state parity |
| Remove a Video Master scene | `remove_video_master_scene` | implemented | Selection fallback and edge cleanup |

## References, inputs and outputs

| Manual capability | MCP operation | Status | Required evidence |
| --- | --- | --- | --- |
| Connect Assistant text to generator | `connect_canvas_nodes` | verified | Protocol test persists `text-input` |
| Connect image/reference-image | `connect_canvas_nodes` | implemented | Model capacity test |
| Connect start/end frames | `connect_canvas_nodes` | implemented | Media type, capacity and start-before-end validation |
| Connect reference/motion video | `connect_canvas_nodes` | implemented | Segment lineage and duration metadata test |
| Connect reference audio | `connect_canvas_nodes` | implemented | Typed audio edge/asset validation; the current manual Library uploader does not expose audio files |
| Connect media to one exact Video Master scene | `connect_canvas_nodes.target_clip_id` | implemented | Scene-scoped handle, model port and capacity validation |
| Attach Library asset without a visible source node | `attach_canvas_reference` | implemented | Typed attached-reference test |
| Attach identity references without a visible persona node | `attach_canvas_reference` | implemented | Persona ownership/variant test |
| Attach/detach direct references on a Video Master scene | `attach_canvas_reference.clip_id`, `detach_canvas_reference` | implemented | Scene-scoped attached-reference persistence |
| Inspect effective connected prompt/references | `inspect_canvas_node_inputs` | implemented | Exact flattened provider-input test |
| List saved generator outputs | `get_canvas` | implemented | Output history fixture test |
| Select an older saved output | `select_canvas_output` | implemented | Persisted active output test |
| Add generated output to identity | `create_identity_from_assets` | implemented | Source asset and variant integration test |
| Add Library images to an existing identity | `add_identity_references` | implemented | Copy semantics, duplicate guard and 100-image limit |
| Reorder Character/Before/After references | `reorder_identity_references` | implemented | Complete-set concurrency validation |
| Remove identity reference | `remove_identity_reference` | implemented | Storage deletion queue and at-least-one-reference guard |

## Intelligence and generation

| Manual capability | MCP operation | Status | Required evidence |
| --- | --- | --- | --- |
| Run an Assistant node | `run_canvas_assistant` | implemented | Metering, model, vision references, persisted output |
| Build a structured generation prompt | `compose_canvas_prompt` | implemented | Reference tokens and model context |
| Run one generator | `run_canvas_generation` | implemented | Admission, durable task and graph completion |
| Run generation batch | `run_canvas_generation` | implemented | Separate cloned nodes and bounded concurrency |
| Run connected Assistant/generator chain | sequential semantic tools | implemented | Exact revisions make every intermediate result explicit |
| Create a remake branch from a generated scene | `create_canvas_remake_branch` | implemented | Copied prompt/reference lineage and edge topology |
| Edit an image in place | `edit_canvas_image` | implemented | Base image ownership, additional refs, output history |
| Poll generation | `get_canvas_generation` | implemented | Reconciliation and public error mapping |
| Cancel generation | `cancel_canvas_generation` | implemented | Durable cancellation and node-state clearing |
| Generate Video Master scene | `run_canvas_generation(clip_id)` | implemented | Exact source scene and output persistence |

Provider-running tools require separate OAuth capabilities from ordinary graph editing because they can consume Cloud credits or self-hosted provider resources.

## Import, portable documents and media

| Manual capability | MCP operation | Status | Required evidence |
| --- | --- | --- | --- |
| Import TikTok post | `import_tiktok_to_canvas` | implemented | Rate limit, provider call, hook extraction, graph transaction |
| Refresh TikTok stats | `refresh_tiktok_source` | implemented | Source URL/project binding |
| Import `.scenelith.json` | `import_canvas_document` | implemented | Existing portable-document validation |
| Export `.scenelith.json` | `export_canvas_document` | implemented | Credential/media-free document fixture |
| Upload local media | `upload_library_asset` | implemented | Bounded base64 payload, MIME signature validation, quota transaction; never accepts server paths or remote URLs |
| Search and inspect private Library media | `list_library_assets`, `inspect_library_asset` | verified | Cursor pagination, grant-filtered counts/metadata, and MCP-native image/video-frame preview without public asset URLs |
| Inspect Character/Before/After references | `inspect_identity_reference` | verified | Workspace Identity ownership and MCP-native bounded image preview |
| Place existing Library media | `place_canvas_asset` | implemented | OAuth Library grant and selected-canvas enforcement |
| Export one Video Master scene or full sequence | `export_video_master_media` | implemented | Existing asset-export authorization, exact lane selection, durable Library MP4 |

## Automation from Canvas

Automation workflow authoring, versioning, publish, run, cancellation and run inspection are already separate MCP tools. The final Canvas audit must still verify that every automation tool rejects a workflow/run belonging to a canvas outside the OAuth resource grant.

## Final double-check procedure

1. Generate the live capability catalogue from the provider and Assistant registries.
2. Create a disposable workspace with two allowed canvases and one denied canvas.
3. Connect through the real OAuth + MCP Streamable HTTP flow.
4. Exercise every row above marked implemented or verified and inspect PostgreSQL, storage and the persisted graph after each mutation.
5. Run a second independent inventory of `CanvasApp`, `FrameNode`, Canvas API routes and provider registries.
6. Diff that fresh inventory against this ledger. Any manual action without an MCP row reopens implementation.
7. Repeat desktop/mobile consent and Connected agents QA, then run the full self-host audit, test suite and production build.

## Audit result — 2026-08-30

The second inventory found no remaining safe manual Canvas operation without an MCP counterpart. The final run exercised the real OAuth bearer against the Streamable HTTP route, verified explicit project isolation across both canvas discovery and Library results, and covered semantic graph/video mutations through the SDK client. Consent and Connected agents were checked in a browser at desktop and mobile sizes; the latter pass also caught and fixed a locale-dependent hydration mismatch in connection timestamps.

Final evidence: 91 registered tools, 524 passing tests, production build, lint, and the public self-host boundary audit. Rows marked `implemented` above have code and focused structural/domain tests; rows marked `verified` additionally have direct protocol/resource-grant evidence called out in the ledger.
