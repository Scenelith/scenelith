# Automation node contract audit

This document records the current public-core node contract. It is an implementation checklist, not a product roadmap.

## Governing rule

A workflow may change a user's creative result only through connected values and visible, versioned node settings. Runtime policy may reject, cap, delay, retry, redact or route work for safety and reliability, but it must not rewrite creative instructions, infer an unconfigured choice or substitute a legacy result shape.

Node defaults are runtime behavior. Changing a default, port, field meaning, output shape or side effect requires a new node version. Historical handlers remain paired with their historical definitions; the current system template uses only current versions.

## Current node matrix

| Node | User-controlled behavior | Exact runtime effect | Non-creative guardrails |
| --- | --- | --- | --- |
| `core.manual-trigger@1` | Trigger configuration outside the graph | Emits run metadata and the captured trigger payload | One start node per workflow |
| `input.tiktok-source@2` | Source, caption mode, replacement caption | Loads the selected ordered slideshow; preserves, replaces or empties the caption exactly as selected | Access, media-type and source-shape checks |
| `input.identity@1` | Identity, reference group, optional flag | Resolves only assets in the selected saved identity group | Access and image checks |
| `input.visual-references@1` | Ordered asset IDs, maximum, optional flag | Preserves the selected asset order and emits only those images | Access, uniqueness, type and count checks |
| `input.creative-settings@1` | Six visible Recreate TikTok choices | Emits those six values without interpretation | Typed field validation |
| `input.workflow-data@1` | Manual value and optional payload path | Uses a trigger or parent payload when present; otherwise uses the visible manual value | Exact safe-path lookup |
| `ai.structured-task@2` | Model, prompts, response mode/schema, run condition, creativity, retries, fallback and failure mode | Sends visible instructions plus connected values; structured output must match the visible schema | Context limit, immutable execution-safety preamble and bounded attempts |
| `logic.transform@1` | JSON template | Produces exactly the rendered template | Safe variable/path grammar and output-size limit |
| `logic.select-one@1` | Connections | Passes the only produced alternative unchanged | Fails unless exactly one alternative produced a value |
| `logic.retry-gate@1` | Retry count and corrected-value path | Returns the original or exact corrected value through a visible retry route | Bounded retries and workflow step limit |
| `logic.select-path@1` | Field path | Passes the exact stored value unchanged | Fails on a missing or unsafe path |
| `logic.condition@2` | Path, typed operator and comparison value | Sends the original value down exactly one matching output | No string-to-boolean coercion or code evaluation |
| `logic.prepare-creative-direction@3` | Settings object, control map, comment/policy/result paths, taxonomy and limits | Creates contract v4 with the complete trimmed comment, configured semantics and explicit read/write paths | Rejects missing choices, unsafe/overlapping paths, occupied result destinations and invalid source indexes |
| `ai.interpret-creative-direction@3` | Visible prompts, model, creativity and retries | Classifies contract v4 into exact evidence ranges under the configured controls and taxonomy | Strict generated schema; no keyword or language fallback |
| `logic.resolve-creative-direction@4` | Prepared contract and selected change policy | Preserves the settings object, changes only configured control paths, and writes evidence only to the configured empty result path | Accepts only contract v4 and fails closed on mismatch, omission, ambiguity, invented evidence or invalid scope |
| `logic.limit-batch@1` | Maximum item count | Passes the list unchanged with a count summary | Stops oversized batches |
| `logic.merge@1` | Named inputs and list/object mode | Combines exact connected values in configured order | Requires stable unique inputs and complete required connections |
| `logic.run-subworkflow@1` | Deployment slot, fixed child inputs and failure mode | Sends the connected value to the pinned child workflow and returns its result envelope | Depth, recursion, access and deployment-binding checks |
| `logic.map-subworkflow@1` | Deployment slot, fixed child inputs, item limit, concurrency and failure behavior | Runs the pinned child once per item and preserves item order/index in results | Item, depth, recursion and policy concurrency caps |
| `integration.http-request@1` | URL, method, body, headers, credential slot, timeout, attempts and failure mode | Sends the rendered request and returns the declared JSON or text response | Public-network only, response-size limit, redaction and idempotency requirement for mutating retries |
| `logic.validate-slide-plans@2` | Visible `Recreate TikTok v1` profile, slide limit and failure mode | Validates without repairing or rewriting; with the contract input it enforces that profile's visible choices, copy, prompt and reference rules | Schema, index, reference availability and bounded-size checks |
| `logic.prepare-slideshow-image-requests@1` | Connected validated plans and references | Serializes every approved prompt unchanged and preserves ordered reference IDs/labels | Rejects unavailable, reordered or mismatched references |
| `generation.image@2` | Model, ratio, resolution, concurrency, attempts and failure behavior | Sends each exact prompt and ordered reference package and returns the provider result | Model capacity, access, cost, workflow policy and admission limits stop work but do not rewrite it |
| `output.add-to-canvas@2` | Layout and plan-note flag | Accepts only canonical generated assets, then creates editable generated-image nodes, optional plan note and source lineage links | Preview/test runs are side-effect free; repeated completion is idempotent |
| `output.finish@1` | Outcome and rendered message | Stores the exact final data on success or deliberately fails with the rendered message | Terminal output only |

## Domain boundary

`input.creative-settings@1`, `logic.validate-slide-plans@2` and `logic.prepare-slideshow-image-requests@1` are Recreate TikTok domain nodes. The generic AI, data, HTTP, child-workflow and image-generation nodes do not contain TikTok, wardrobe, location or text-policy semantics.

The current creative-direction chain deliberately accepts a generic settings object at `logic.prepare-creative-direction@3`. This makes custom control paths real graph behavior rather than a handler-only capability.

## Automated evidence

The automation test suite checks that every current definition has a handler, every handler has a registered historical or current definition, the system graph validates, current creative-direction versions reject other contract versions, custom nested paths remain exact, unconfigured root fields are not inserted, prompt/reference payloads remain byte-for-byte stable and test previews do not perform canvas side effects.
