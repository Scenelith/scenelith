# Automation MCP parity ledger

This document records the current public Automation surface that must remain available through Scenelith MCP in both Cloud and self-hosted editions. The executable source of truth is the canonical versioned registry, not this prose list.

## Architecture invariant

The Automation editor Node library, `get_automation_capabilities`, `scenelith://automation/node-catalog`, graph validation, and runtime resolve definitions from `src/lib/automation-workflows/registry.ts`. MCP does not maintain a second hand-written node schema. A newly registered latest node therefore appears to agents automatically, while older versions remain discoverable by exact type and version.

Every capability entry includes:

- exact node type and version, category, title, description, example, help, terminal and retry-safe flags;
- exact static or dynamic input ports, output ports, port types, required/connectable flags, and allowed edge roles;
- every field, field type, choices, defaults, dependencies, required rules, and runtime-binding support;
- default configuration, default bindings, and a complete node template;
- allowed template-variable roots or the explicit prohibition of variables;
- value-path syntax and live Canvas model/ratio/resolution data when `canvas_id` is supplied.

## Current latest node coverage: 25 of 25

| Category | Node | Agent-visible purpose |
| --- | --- | --- |
| Trigger | `core.manual-trigger@1` | Start a manual, scheduled, event, webhook, or nested run |
| Input | `input.tiktok-source@2` | Supply the selected TikTok slideshow and caption mode |
| Input | `input.identity@2` | Supply a selected Identity and its usable reference group |
| Input | `input.visual-references@1` | Supply Canvas, Library, or Identity images as visual references |
| Input | `input.creative-settings@1` | Collect the six Recreate TikTok choices |
| Input | `input.workflow-data@1` | Receive typed data from a trigger or parent workflow |
| AI | `ai.structured-task@2` | Run a named AI task with text or structured output |
| Logic | `logic.transform@1` | Select, rename, or combine incoming information |
| Logic | `logic.select-one@1` | Rejoin mutually exclusive branches |
| Logic | `logic.retry-gate@1` | Apply an explicit bounded retry route |
| Logic | `logic.select-path@1` | Extract a dot-path value without rebuilding it |
| Logic | `logic.condition@3` | Branch on an explicitly typed JSON comparison |
| Logic | `logic.prepare-creative-direction@3` | Build the path-explicit interpretation request |
| AI | `ai.interpret-creative-direction@3` | Classify creative-direction clauses with evidence |
| Logic | `logic.resolve-creative-direction@4` | Verify and apply only policy-approved choices |
| Logic | `logic.limit-batch@1` | Bound a list before expensive work |
| Logic | `logic.merge@1` | Wait for and combine 2-24 dynamic named inputs |
| Logic | `logic.run-subworkflow@1` | Run one published child workflow and await its result |
| Logic | `logic.map-subworkflow@1` | Run a child workflow for each bounded list item |
| Integration | `integration.http-request@1` | Call an external service through a safe deployment credential slot |
| Logic | `logic.validate-slide-plans@2` | Validate Recreate TikTok plans before generation |
| Generation | `generation.image@2` | Generate images from exact prepared requests |
| Logic | `logic.prepare-slideshow-image-requests@1` | Serialize approved plans and ordered references |
| Output | `output.add-to-canvas@3` | Add all generated slideshow images to the Canvas |
| Output | `output.finish@1` | End a route and return its result without Canvas mutation |

Historical registry versions remain discoverable and valid where supported; the parity test deliberately compares every latest definition field-for-field rather than freezing only the table above.

## RUN INPUTS parity

`set_automation_run_input` is the semantic MCP operation for the editor's left **RUN INPUTS** panel:

| Mode | Editor result | Runtime behavior |
| --- | --- | --- |
| `fixed` | Field is absent from the left panel | Value stays in node configuration |
| `optional` | Field appears in the left panel | Caller may omit it only when the canonical field permits omission |
| `required` | Field appears in the left panel | Run, publish, and trigger activation enforce a value |

The derived key is `node-id.field-id`. The tool rejects unknown fields, fields that are not runtime-bindable, and attempts to make a canonically required field optional. Draft and published run-input contracts are returned by `get_automation_workflow`.

## Lifecycle parity

| Area | MCP operations and guarantees |
| --- | --- |
| Discovery | Read workflow, current draft, published version, exact node catalog, current Canvas models, triggers, deployment bindings, versions, fixtures, runs, and safe credential metadata |
| Authoring | Create/import, add/configure/remove nodes, configure RUN INPUTS, validate/connect/remove edges, configure limits and policies, or replace the full graph as an escape hatch |
| Concurrency | Every semantic edit requires `base_draft_version_id`; stale edits return `AUTOMATION_DRAFT_CONFLICT` with the current draft ID |
| Validation | Validate malformed graphs, exact ports, types, roles, cycles, retry routes, terminal routes, fields, bindings, prompt variables, value paths, secrets, deployment slots, and run inputs |
| Versioning | Publish immutable versions, list them, restore one as a new draft, export/import an integrity-checked credential-free package, and archive only user workflows |
| Deployment | Bind published child workflows, bind already-saved credentials without exposing secrets, unbind slots, and set/reset the allowed system workflow model override |
| Testing | Store fixtures, preview one node with side-effect awareness, inspect captured node input/output/error, and delete fixtures |
| Triggers | Create paused interval/calendar, webhook, or Canvas-event triggers; validate and pin the current published version on activation; pause or delete without rewriting run history; inspect delivery attempts and replay only a dead-letter from its immutable snapshots |
| Execution | Start test or production runs, snapshot runtime inputs and workflow inputs immutably, poll details, cancel, retry safely from a failed node, and diagnose exact error codes |

## Verification contract

Three separate layers guard parity:

1. Catalog parity compares every latest canonical node with the MCP response: type, version, inputs, outputs, fields, help, defaults, templates, historical versions, dynamic ports, and RUN INPUTS metadata.
2. Core Automation validation/runtime suites cover node-specific invariants, graph topology, typed ports, prompt variables, value paths, immutable snapshots, retry behavior, triggers, deployment bindings, and handlers.
3. MCP protocol tests connect a real client and complete create → semantic edit → RUN INPUTS → connect → stale-write rejection → validate → publish → fixture preview → trigger lifecycle → production run → poll → captured node details → diagnose → export/import → archive.

Any new node or changed field causes layer 1 to fail until the capability remains exact. Runtime changes must pass layers 2 and 3 before release.
