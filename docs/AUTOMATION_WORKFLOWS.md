# Automation workflows

The current per-node settings-to-runtime audit is maintained in [AUTOMATION_NODE_CONTRACT_AUDIT.md](./AUTOMATION_NODE_CONTRACT_AUDIT.md). Update it whenever a current node version, help contract or runtime effect changes.

Scenelith automations are saved, versioned graphs. The editor opens as a separate canvas over the content canvas, while the Automation panel remains the place where a user selects a published workflow, supplies run-time values, starts it, and watches progress.

## Product flow

1. Open **Automation** from the canvas rail.
2. Choose the system workflow or any published custom workflow. Each canvas can keep multiple independent workflows and the selected workflow is the only one started by **Run automation**.
3. Open workflow settings. The system workflow is read-only; duplicate it to preserve the working baseline, or use **Create workflow** to start from an empty trigger.
4. Edit nodes, prompts, models, schemas, bindings, retries, and connections. Invalid connections are rejected while drawing them; the full graph is validated again before publish and before every run.
5. Save a draft, resolve validation issues, and publish an immutable version.
6. Return to the Automation panel. Fields marked **Ask on run** appear there automatically.
7. Run the workflow. The panel submits only the inputs declared by that selected version; it does not depend on built-in node IDs. The worker executes the published version and adds its generated branch to the content canvas.

Draft changes never alter an already published version. A queued job always points to one exact workflow-version ID and stores a deployment snapshot with every nested child version and credential identity. Switching, editing, rebinding, or publishing another workflow cannot change the execution plan already in progress. A draft with an older published version continues to run that published version until the draft is explicitly published.

## Portable workflow JSON

**Export JSON** downloads a canonical `scenelith.automation` package with integrity digest, minimum Scenelith version, exact node versions, provider capabilities, fixed model requirements, and required credential/subworkflow slot declarations. Import verifies the digest, rejects unsupported or undeclared contracts, scans for embedded secrets, removes instance-bound canvas and identity IDs, and creates an isolated draft with new local workflow identity. Re-exporting an unchanged imported graph produces the same digest.

The package is immediately deployable when it has no external slots. When slots are declared, the editor shows the missing local binding and the operator connects a saved credential or published local child workflow before running. Slot names are type-safe: one name cannot represent both a credential and a workflow, or credentials of incompatible kinds. Every required binding, credential kind, child publication, child input mapping, and nested child binding is preflighted before a run enters the queue or a trigger becomes active. Credentials, webhook tokens, trigger activation state, canvas IDs, user IDs, asset IDs, and Cloud-only data are never portable.

## Persistence model

Workflow metadata, immutable graph versions, runs, per-node attempts, events, and artifacts are separate PostgreSQL records. Custom workflows belong to the canvas that created them; the read-only system template belongs to the workspace and is available on each of its canvases. Database constraints allow at most one current draft and one current published version per workflow, while superseded versions remain available for run history and recovery.

Creating a new workflow inserts a separate workflow ID and first draft version. Duplicating the system workflow copies its graph into a new custom workflow; it never edits the system template. Publishing changes pointers transactionally, and every queued run stores both the selected workflow ID and its exact published version ID.

### System template registry and upgrades

Built-in workflows are declared once in the public core registry at `src/lib/automation-workflows/system-templates.ts`. One registry entry owns the stable system key, revision, user-facing name and description, and graph factory. Repository code installs every registered template for a workspace; it does not repeat template names, keys, or graph builders.

The stable key identifies a system workflow across releases. Any graph or execution-contract change requires an explicit revision increment in the same registry entry. On the next authorized workflow discovery, the server takes a per-workspace advisory lock, validates the new graph, appends one immutable published version, supersedes the previous published version, and keeps the workflow ID and run history. Display metadata is reconciled from the same registry without creating a graph version. A server running an older release never downgrades a template whose stored revision is newer.

System upgrades only target records with the matching `system_key`. Duplicated and from-scratch workflows have their own IDs, names, descriptions, draft/published pointers, and version history, so registry upgrades cannot rename or rewrite a user's workflow. Adding another built-in workflow means adding one registry entry and graph factory; no repository branch, new table, or Cloud-specific copy is required.

The registry, repository, migrations, and tests belong to the shared public core. Scenelith Cloud receives that exact implementation through the public-core update process and may add only private edition adapters around it. Do not reimplement or manually edit this workflow lifecycle in the Cloud repository.

## Built-in node contract

Every node has a versioned type, typed input and output ports, editable configuration, and optional run-time bindings. Port compatibility is directional: a domain value can feed a generic `data` input, but generic data cannot impersonate a TikTok source, identity, validated slide plan, generated asset, or other stronger domain type.

Node terminology has two deliberately separate layers. The registry `title` is the stable node type shown in the library, on the card and in the inspector, for example **AI**, **Merge paths**, or **Validate slide plans**. A graph node's `name` is the editable name of that particular step, for example **Check that every plan is usable**. The step name is the primary heading everywhere an existing graph node is shown; the stable node type is always the secondary label. Icons and calm accent colors come only from the node-type registry, so renaming a step never changes its meaning. Red is reserved for an actual failed/error state or recovery route, not ordinary logic, validation, branching, or limits.

The initial registry includes:

- manual trigger;
- TikTok slideshow source;
- reusable identity, visual references, and creative settings;
- multimodal AI task with explicit **Readable text** and **Defined data fields** output modes;
- generic workflow input, safe data transform, explicit condition operators, bounded batch preparation, branch combination, and a slide-plan validation gate;
- durable single-child and per-item Map subworkflows;
- bounded public HTTP requests with deployment-local encrypted credential slots;
- image generation;
- idempotent canvas output and a side-effect-free **Finish workflow** terminal.

Collapsed groups are presentation only. Every AI request remains an ordinary atomic node in the saved graph and is visible in **All steps**.

### Reading and building a flow

The editor separates **what runs next** from **what information a step also needs** without hiding either one. Every saved connection is drawn as a calm solid Bézier curve between its exact source and target sockets. Curves naturally fan out from a reused output instead of stacking several right-angle paths into one ambiguous rail. Selecting a card highlights its complete upstream and downstream path while leaving the rest of the workflow readable. Main, supporting-data and error roles still remain explicit in the portable edge contract because they control execution and recovery semantics, not visual decoration.

When a step has several upstream dependencies, the worker waits for every connected input it requires. Ready branches are then executed in deterministic graph order rather than being presented as simultaneous work. A downstream step can therefore consume earlier results by connection without drawing every supporting dependency across the full overview.

Use **Merge paths** when several routes must become one named package before the workflow continues. The card owns a configurable list of named single-connection input sockets, so every incoming value has an explicit destination instead of sharing one ambiguous handle. In **Named object** mode, those input names become stable fields such as `brief`, `copy`, or `references`; the next step receives one object instead of an anonymous array. **Append list** keeps the same configured input order when the intended result is one collection.

Use **For each item** for an explicit bounded loop. The parent receives a list, invokes one pinned child workflow for every item, preserves the item index and durable child result, enforces item and concurrency limits, and emits the collected results only after the loop has finished. The child workflow is the visible loop body, not an invisible group of nested cards. Use an ordinary **Run workflow** node when the child should run exactly once.

Conditions do not evaluate JavaScript or free-form expressions. They use an explicit field path and a supported operator. Both outcomes must be connected. An error connection is valid only when the node's failure behavior is **Use error output**, and that failure behavior cannot be published without a connected error branch. Terminal nodes cannot continue downstream. Cycles, self-connections, duplicate edges, occupied single-input ports, unreachable nodes, disconnected outputs, and incompatible port types are rejected.

`Limit batch` only validates and caps a collection. **For each item** is the true loop primitive: it starts one pinned child-workflow run per item, caps item count and concurrency, stores every child run, and reports item failures explicitly. Child workflows are deployment bindings rather than embedded IDs, so the same portable JSON can bind to a local workflow after import. Direct and indirect recursive workflow cycles are rejected when a binding is saved and checked again at run time. The root workflow owns the depth ceiling for its complete child tree; a child cannot relax it with its own settings.

The AI node has one current contract. It keeps the user task, permanent instructions, connected data and platform safety rules in separate prompt layers. Workflow variables are allowed in the task but not in permanent instructions. Connected source content is explicitly treated as data so it cannot replace higher-priority instructions. **Readable text** returns plain model text. **Defined data fields** uses a visual top-level field builder, keeps nested JSON available under technical details, asks the provider for strict structured output, and validates the value again before downstream execution.

AI response schemas use a safe JSON-Schema subset and are validated when the graph is published. The image generation node accepts only a `slide-plan-set` produced by **Validate slide plans**, so arbitrary AI output cannot reach an image provider without stable indexes, prompts, and reference IDs.

**Visual references** is separate from **Identity**. Identity resolves a saved person or character and its reference groups; Visual references selects ordinary product, place, pose, composition, or style images from the current content canvas or the workspace Library. The picker stores only stable asset IDs. At run time the server verifies workspace access, resolves private storage paths, rejects non-images, enforces the node limit, and passes one typed `visual-references` package through its output socket. That socket can connect to AI context, validation, or image generation only where the registry declares the typed input. A workflow may keep the selection fixed in its draft or mark it **Ask on run** so the same picker opens in the Automation panel before each execution. Portable export clears these instance-local IDs and restores Ask on run.

## Execution and recovery

Runs are queued in PostgreSQL and claimed with fenced worker leases. Node attempts, outputs, events, generated assets, usage, and final canvas application are persisted separately. If a worker is interrupted, a replacement worker resumes from completed node outputs and generated artifacts instead of replaying successful provider calls. Child runs never enter the global queue on their own: the parent owns their lifecycle, reuses exact successful Map items, and recreates only interrupted items. Run history lists root executions rather than presenting internal child runs as unrelated automations.

Admission is explicit and durable. Each published graph and each trigger choose an overlap policy: **Queue**, **Skip while active**, or **Cancel previous**; they also set the maximum concurrent root runs for that workflow or trigger. A PostgreSQL advisory lock serializes each admission key, so two web replicas cannot both bypass the same policy. Workers additionally enforce the instance-wide `AUTOMATION_WORKFLOW_CONCURRENCY` and per-workspace `AUTOMATION_WORKSPACE_CONCURRENCY` ceiling and select eligible work in workspace-fair order. Cancelling or superseding a running execution changes durable state first, then an abort monitor propagates that decision into active HTTP, OpenRouter, generation-wait, retry-delay, and timeout paths instead of letting provider work continue unnoticed.

Outputs are checked against the versioned node contract, limited in size, and persisted before downstream execution. Failure-policy outputs are persisted too, so a recovered worker does not repeat a provider call that already exhausted its retry policy. **Continue empty** emits through the node's real output port, records a warning, and remains discoverable by Retry instead of appearing as a clean success. A run cannot be reported as successful unless at least one terminal node actually produced an output.

Run inputs are accepted only when declared by **Ask on run**, use the declared value type, and stay within a bounded payload. Required node settings remain required at run time. Workflow drafts also use optimistic concurrency: saving an older browser tab returns a conflict instead of silently overwriting a newer draft.

Image automation and interactive canvas generation share the same generation-admission service. Provider validation, instance concurrency, usage reservation, dispatch, output persistence, and failure handling therefore have one implementation.

Admission waiting is bounded. Unsupported image model capabilities, aspect ratios, resolutions, reference IDs, duplicate slide indexes, excessive references, malformed provider output, and partial slide failures are surfaced explicitly instead of being silently truncated or substituted.

Canvas output uses deterministic node and edge IDs. Retrying a run or replaying its final step does not create duplicate content.

The editor exposes a side-effect-safe **Test draft**, run inspector, immutable version history, and rollback that creates a new draft instead of rewriting history. Retry creates a linked replay run, copies only safe upstream outputs, and reuses successful generated artifacts and successful per-item child runs.

Workflow timeout, node-execution, generated-asset, parallelism, child-depth, and optional credit limits are versioned in the graph and snapshotted into each run. Node executions, generated assets, and credit reservations are serialized and counted across the complete root/child run tree, so parallel Map items cannot individually pass a limit and collectively exceed the root cap. Generated-asset reservations use stable run/node/item identities, preventing a recovered worker from counting the same provider job twice. The run inspector reports aggregate tree usage rather than only the parent row.

Schedules, webhooks, and canvas events are deployment records outside the portable graph. They always target the current published version, are created paused, validate the complete run-input and deployment-binding contract before activation, and keep their last/next fire state in PostgreSQL. Calendar schedules use a five-field cron expression, an explicit IANA timezone, and an explicit missed-occurrence policy. The next occurrence is calculated from the scheduled instant rather than worker wall-clock time, preventing gradual drift; a compare-and-swap claim and unique occurrence key prevent multiple schedulers from emitting the same occurrence.

Trigger events never create runs inside the request or scheduler claim. They first append an immutable `automation_trigger_deliveries` record with a unique delivery key and snapshotted run inputs. A separate worker claims deliveries with fenced leases, creates at most one run per delivery, retries transient failures with bounded exponential backoff, and moves permanent or exhausted failures to the dead-letter state. A dead letter creates an in-product operational alert. Manual replay appends a new linked delivery instead of rewriting history; a successful replay resolves the original alert. Webhook callers may send `Idempotency-Key` to receive the same delivery for a repeated event. Deleting a trigger removes its secret and future activation while preserving prior delivery and run history.

Failure and recovery notifications use a transactional outbox rather than being sent inside the delivery transaction. Self-host records them as durable in-app acknowledgements and can additionally deliver them to the operator-owned `AUTOMATION_ALERT_WEBHOOK_URL`. Cloud replaces only the notification adapter, so email, chat, or managed notification delivery does not fork scheduler or workflow code. Outbox attempts have fenced leases, bounded exponential retry, and their own dead-letter state.

Product events are allowlisted, schema validated, and explicitly versioned. Version 1 currently includes completed TikTok imports and completed direct canvas generations; unknown fields, malformed payloads, unknown event names, and unsupported versions fail closed. The domain update and product-event outbox append share one database transaction, and a separate leased worker fans the stable event id into idempotent trigger deliveries. A crash can therefore delay an event but cannot silently lose or duplicate it. Automation-owned generations are deliberately not re-emitted, preventing an accidental self-triggering generation loop. Trigger creation, status changes, deletion, delivery inspection, and replay are rate limited or permission checked and audited where they mutate operator state. Webhook tokens are returned once, stored only as a hash, payloads are bounded and rate limited, and changing a draft does not change an active trigger until it is published.

## Team permissions

Automation authorization is action based rather than inferred from one broad editor role. The shared edition contract defines independent permissions for running, editing, publishing, managing triggers, and managing credentials. Self-host maps all five actions to its single owner. Cloud supplies its private team/grant adapter through `src/editions/current/access.ts`; workflow services, trigger delivery workers, fixture previews, and credential services call the shared action contract, so Cloud does not fork automation code. Revoking run permission also stops queued trigger deliveries from creating work and records an operational dead letter instead of bypassing RBAC in the worker.

## Fixtures and step preview

Fixtures are deployment-local saved examples pinned to one immutable workflow version. They store bounded runtime values and explicit input-port values per node; they are intentionally excluded from portable workflow packages because examples may refer to local assets or business data. A fixture can be authored directly or captured from the persisted input of a prior node run.

Previewing a step enqueues a normal durable `node-preview` run. The worker executes only the selected node with the captured port values: it does not run ancestors or downstream nodes. Provider calls still pass through the same validation, credential resolution, limits, usage reservation, artifacts, timeout, and run history as production. Canvas-output nodes are forced into preview mode and cannot mutate the content canvas. The inspector returns the selected node's captured input and persisted output so data can be checked between ports without exposing every production run's intermediate payloads.

The HTTP node resolves DNS itself, rejects loopback, carrier-grade NAT, link-local, documentation, multicast, private, and reserved addresses, pins the validated address for the request, does not follow redirects, blocks transport-owned headers, and limits request size, time, and response size. Bound secret values and sensitive response fields/headers are redacted before persistence. Actual credentials are AES-256-GCM encrypted at rest and are never returned by list APIs, stored in graphs, included in exported packages, or written into run events. Creation, binding, rotation, and deletion are rate limited and audited; deletion is blocked while a credential is bound. `AUTOMATION_CREDENTIAL_ENCRYPTION_KEYS` may contain a comma-separated key ring for key rotation; the first key encrypts new values and older keys remain available for decryption. `./scenelith init` creates the initial key automatically.

The former TikTok-plan endpoint is a compatibility adapter: new requests are converted into runs of the current system workflow. The legacy queue remains worker-readable only so records queued before this migration can finish; no product endpoint creates new legacy jobs.

## Retention

The worker deletes history in bounded batches using edition-owned policy. Self-host defaults to 30 days for successful runs and delivered product-event/notification outbox entries, and 90 days for failed or cancelled runs and trigger deliveries. Open delivery alerts are retained, and fixtures are retained indefinitely unless `AUTOMATION_FIXTURE_RETENTION_DAYS` is explicitly configured. Cloud can replace the retention-policy selector without duplicating cleanup or persistence code. The self-host values are configurable through the corresponding `AUTOMATION_*_RETENTION_DAYS` environment variables.

## Adding a node type

A new node type requires all of the following in the same change:

1. a versioned definition in `src/lib/automation-workflows/registry.ts`;
2. a server handler registered under the exact `type@version` key by `coreAutomationNodeHandlers()`;
3. typed ports and editable field metadata;
4. validation and runtime tests;
5. no direct provider transport import outside `src/platform/providers/`.

Do not put secrets in graph JSON, run inputs, node outputs, or browser responses. Native provider credentials stay in the server environment; integration credentials use named vault slots and are resolved only by the worker. Do not add browser polling or canvas-side provider orchestration to a node handler; long-running work belongs to the durable worker.

## Failure boundary

Provider, network, model, and media failures cannot be made impossible. The enforceable contract is that invalid graph structure and recursive dependencies are blocked before execution, trigger and child inputs are exact, expensive inputs are validated before dispatch, external work is bounded and visible, completed work is recoverable, secrets do not enter portable or observable state, and a run never reports a false success.

## Compatibility

The workflow schema starts at version 1. Node versions and graph-schema versions are independent: increment a node version for a breaking node contract, register a matching versioned handler, and add an explicit graph migration before accepting a future graph schema. Applied database migrations are immutable.
