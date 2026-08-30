import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { automationNodeDefinitions } from "../src/lib/automation-workflows/registry";

const canvasSource = readFileSync(new URL("../src/components/CanvasApp.tsx", import.meta.url), "utf8");
const panelSource = readFileSync(new URL("../src/components/TikTokAutomationPanel.tsx", import.meta.url), "utf8");
const legacyRouteSource = readFileSync(new URL("../src/app/api/automations/tiktok/plan/route.ts", import.meta.url), "utf8");
const workflowDetailRouteSource = readFileSync(new URL("../src/app/api/automation-workflows/[workflowId]/route.ts", import.meta.url), "utf8");
const systemModelRouteSource = readFileSync(new URL("../src/app/api/automation-workflows/[workflowId]/system-model/route.ts", import.meta.url), "utf8");
const workflowRunsSource = readFileSync(new URL("../src/lib/automation-workflows/runs.ts", import.meta.url), "utf8");
const workflowEditorSource = readFileSync(new URL("../src/components/automation/AutomationWorkflowEditorOverlay.tsx", import.meta.url), "utf8");
const workflowOperationsSource = readFileSync(new URL("../src/components/automation/AutomationWorkflowOperations.tsx", import.meta.url), "utf8");
const referencePickerSource = readFileSync(new URL("../src/components/automation/AutomationReferencePicker.tsx", import.meta.url), "utf8");
const referenceMenuShellSource = readFileSync(new URL("../src/components/ReferenceMenuShell.tsx", import.meta.url), "utf8");
const frameNodeSource = readFileSync(new URL("../src/components/FrameNode.tsx", import.meta.url), "utf8");
const defaultWorkflowSource = readFileSync(new URL("../src/lib/automation-workflows/default-tiktok.ts", import.meta.url), "utf8");
const registrySource = readFileSync(new URL("../src/lib/automation-workflows/registry.ts", import.meta.url), "utf8");
const nodeHandlersSource = readFileSync(new URL("../src/lib/automation-workflows/node-handlers.ts", import.meta.url), "utf8");
const creativeDirectionSource = readFileSync(new URL("../src/lib/automation-workflows/creative-direction-contract.ts", import.meta.url), "utf8");
const workflowTypesSource = readFileSync(new URL("../src/lib/automation-workflows/types.ts", import.meta.url), "utf8");
const themeSource = readFileSync(new URL("../src/app/theme.css", import.meta.url), "utf8");
const globalsSource = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

test("canvas run submission does not inject legacy built-in node ids", () => {
  for (const legacyKey of [
    "tiktok-source.source",
    "identity.identity",
    "creative-settings.mode",
    "generate-images.modelId",
  ]) assert.doesNotMatch(canvasSource, new RegExp(`['\"]${legacyKey.replace(".", "\\.")}['\"]`));
  assert.match(canvasSource, /inputs: runtimeOverrides/);
});

test("automation panel renders the selected workflow input contract", () => {
  assert.doesNotMatch(panelSource, /builtInInputKeys/);
  assert.match(panelSource, /visibleRunInputs\.map/);
  assert.match(panelSource, /runtimeValuesByWorkflow/);
  assert.match(panelSource, /selectedWorkflow\?\.publishedVersionId/);
});

test("automation AI settings reuse the complete Canvas Assistant model catalogue", () => {
  assert.match(frameNodeSource, /assistantModels\.map/);
  assert.match(workflowEditorSource, /assistantModels\.map/);
  assert.match(panelSource, /assistantModels\.map/);
  assert.doesNotMatch(workflowEditorSource, /tiktokAutomationPlanningModels/);
  assert.doesNotMatch(panelSource, /tiktokAutomationPlanningModels/);
});

test("automation image generation matches the Canvas Image Generator identity and owns its model setting", () => {
  const definition = automationNodeDefinitions().find((candidate) => candidate.type === "generation.image");
  assert.equal(definition?.title, "Image Generator");
  assert.equal(definition?.icon, "generate");
  assert.equal(definition?.accent, "image");
  assert.match(workflowEditorSource, /generate: ImageIcon/);
  assert.match(themeSource, /automation-flow-node\.is-image/);
  assert.doesNotMatch(defaultWorkflowSource, /bindings: \{ modelId: \{ mode: "ask-on-run"/);
  assert.match(defaultWorkflowSource, /config: \{ modelId: "nano-banana-2"/);
  assert.deepEqual(definition?.inputs.map((port) => port.id), ["requests"]);
  assert.ok(definition?.fields.filter((field) => ["modelId", "ratio", "resolution"].includes(field.id)).every((field) => field.required));
  assert.match(defaultWorkflowSource, /id: "prepare-image-requests"/);
  assert.match(defaultWorkflowSource, /edge\("prepare-image-requests", "requests", "generate-images", "requests"/);
});

test("automation semantics come only from visible node configuration", () => {
  assert.doesNotMatch(nodeHandlersSource, /connectorWords|keywordRules|negationWords/);
  assert.match(creativeDirectionSource, /export function splitAutomationCreativeDirection[\s\S]*?return \[\{ id: "creative-direction", text: raw, start: 0, end: raw\.length \}\];\n\}/);
  assert.match(creativeDirectionSource, /complete primary creative-direction request/i);
  assert.match(registrySource, /The server does not add its own categories/);
  assert.match(registrySource, /The server accepts only these configured ids/);
  assert.match(nodeHandlersSource, /allowedRatios\(model, resolution, request\.referenceAssetIds\.length > 0\)/);
});

test("protected system templates expose only primary AI and image model controls with reset", () => {
  assert.match(workflowEditorSource, /field\.id === "modelId"/);
  assert.match(workflowEditorSource, /field\.modelCapability === "assistant" \|\| field\.modelCapability === "image"/);
  assert.match(workflowEditorSource, /saveSystemModel\(selectedNode!\.id, null\)/);
  assert.match(workflowEditorSource, /> Reset to default<\/button>/);
  assert.match(workflowEditorSource, /prompts, connections or any other setting/);
  assert.match(workflowEditorSource, /\/system-model/);
  assert.match(systemModelRouteSource, /sameOriginRequest/);
  assert.match(systemModelRouteSource, /setSystemAutomationModelOverride/);
  assert.match(workflowDetailRouteSource, /systemModelDefaults/);
});

test("visual references are configured on their node from canvas, Library or Identities", () => {
  assert.match(referencePickerSource, />Canvas</);
  assert.match(referencePickerSource, /Library/);
  assert.match(referencePickerSource, /Identities/);
  assert.match(referencePickerSource, /identityReferences/);
  assert.match(referencePickerSource, /fetch\(`\/api\/assets\?\$\{query\.toString\(\)\}`/);
  assert.match(referencePickerSource, /workspaceId/);
  assert.match(referencePickerSource, /assetId/);
  assert.match(referencePickerSource, /maxItems/);
  assert.doesNotMatch(referencePickerSource, /draftIds|Use \{.*reference/);
  assert.match(referencePickerSource, /selections apply immediately/);
  assert.match(referencePickerSource, /automation-reference-personas/);
  assert.match(referencePickerSource, /\["reference", "before", "after"\]/);
  assert.match(referencePickerSource, /Clear/);
  assert.doesNotMatch(referencePickerSource, /storagePath|storage_path|apiKey|secret/i);
  assert.doesNotMatch(panelSource, /<AutomationReferencePicker/);
  assert.match(panelSource, /field\.valueType !== "visual-references"/);
  assert.match(panelSource, /nodeManagedInputKeys/);
  assert.match(workflowEditorSource, /<AutomationReferencePicker/);
  assert.match(workflowEditorSource, /placement="node"/);
  assert.match(referencePickerSource, /<ReferenceMenuShell/);
  assert.match(referencePickerSource, /automation-reference-node-menu/);
  assert.match(frameNodeSource, /<ReferenceMenuShell/);
  assert.match(referenceMenuShellSource, /generator-reference-menu nodrag nopan nowheel/);
  assert.doesNotMatch(referencePickerSource, /automation-reference-drawer is-node/);
  assert.match(workflowEditorSource, /onRuntimeValueChange/);
  assert.match(canvasSource, /automationRuntimePreview\.values/);
});

test("creative choice confirmation shows an exact node-authored diff and reruns visible inputs", () => {
  assert.match(panelSource, /automation-choice-confirmation/);
  assert.match(panelSource, /selectedLabel/);
  assert.match(panelSource, /requestedLabel/);
  assert.match(panelSource, /Confirm and run again/);
  assert.match(canvasSource, /outputPorts\?\.includes\("conflict"\)/);
  assert.match(canvasSource, /runtimeInputKey/);
  assert.match(canvasSource, /requestedValue/);
});

test("automation workflow discovery is not restarted by an unstable parent callback", () => {
  assert.match(panelSource, /const setWorkflowIdRef = useRef\(setWorkflowId\)/);
  assert.match(panelSource, /setWorkflowIdRef\.current\(next\[0\]\.id\)/);
  assert.doesNotMatch(panelSource, /\[demo, projectId, setWorkflowId, workflowId, workflowRefreshKey\]/);
});

test("the live automation panel exposes a read-only demo contract for Cloud marketing", () => {
  assert.match(panelSource, /export type TikTokAutomationPanelDemo/);
  assert.match(panelSource, /demo\?: TikTokAutomationPanelDemo/);
  assert.match(panelSource, /workspaceId\?: string/);
  assert.match(panelSource, /canvasReferences\?: AutomationReferenceCandidate\[\]/);
  assert.doesNotMatch(panelSource, /export function TikTokAutomationPanel\(\{[^}]*canvasReferences/s);
  assert.match(panelSource, /if \(demo\) return;/);
});

test("legacy TikTok API adapts into the versioned workflow runtime instead of creating legacy jobs", () => {
  assert.match(legacyRouteSource, /enqueueAutomationWorkflowRun/);
  assert.doesNotMatch(legacyRouteSource, /enqueueTikTokAutomationJob/);
});

test("run-only roles cannot see or execute drafts and each version keeps its own input contract", () => {
  assert.match(panelSource, /capabilities\.edit/);
  assert.match(panelSource, /draftRunInputs/);
  assert.match(panelSource, /inputsFor\(productionRunInputs\)/);
  assert.match(workflowDetailRouteSource, /canViewDraft = capabilities\.edit \|\| capabilities\.publish/);
  assert.match(workflowDetailRouteSource, /draftRunInputs/);
  assert.match(workflowRunsSource, /runKind === "test".*automation\.edit/s);
});

test("automation canvas owns an isolated React Flow store and cannot replace the content canvas graph", () => {
  assert.match(workflowEditorSource, /<ReactFlowProvider>\s*<ReactFlow/s);
  assert.match(workflowEditorSource, /onlyRenderVisibleElements/);
  assert.doesNotMatch(workflowEditorSource, /automation-editor-active/);
  assert.doesNotMatch(themeSource, /automation-editor-active[^}]*canvas-stage[^}]*visibility\s*:\s*hidden/);
  assert.match(themeSource, /\.automation-editor-overlay[^}]*background:\s*transparent/);
});

test("automation canvas presents one readable numbered workflow without nested stage modes", () => {
  assert.match(workflowEditorSource, /nodesDraggable/);
  assert.match(workflowEditorSource, /useNodesState/);
  assert.match(workflowEditorSource, /onNodesChange=\{onFlowNodesChange\}/);
  assert.match(workflowEditorSource, /magneticNodePosition/);
  assert.match(workflowEditorSource, /onNodeDrag=\{\(_, flowNode\) => magnetizeFlowNode\(flowNode\)\}/);
  assert.doesNotMatch(workflowEditorSource, /snapToGrid/);
  assert.match(workflowEditorSource, /connectionRadius=\{32\}/);
  assert.match(workflowEditorSource, /connectionLineType=\{ConnectionLineType\.Bezier\}/);
  assert.match(workflowEditorSource, /type: "automationExecution"/);
  assert.match(workflowEditorSource, /getBezierPath\(\{[^}]*curvature: 0\.32/s);
  assert.doesNotMatch(workflowEditorSource, /type: "smoothstep"/);
  assert.match(workflowEditorSource, /proOptions=\{\{ hideAttribution: true \}\}/);
  assert.match(workflowEditorSource, /panOnDrag=\{false\}/);
  assert.match(workflowEditorSource, /panActivationKeyCode="Space"/);
  assert.match(workflowEditorSource, /flowStageRef\.current\?\.classList\.toggle\("is-space-panning", active\)/);
  assert.match(workflowEditorSource, /event\.code !== "Space"/);
  assert.match(workflowEditorSource, /<main ref=\{flowStageRef\} className="automation-flow-stage">/);
  assert.match(workflowEditorSource, /moveFlowNode/);
  assert.match(workflowEditorSource, /layeredFlowPositions/);
  assert.match(workflowEditorSource, /topologicalAutomationNodeIds/);
  assert.doesNotMatch(workflowEditorSource, /phaseName/);
  assert.match(workflowEditorSource, /stepIndex/);
  assert.match(workflowEditorSource, /name: definition\.title/);
  assert.match(workflowEditorSource, /<b>\{definition\.title\}<\/b>/);
  assert.match(workflowEditorSource, /Node type · \{selectedDefinition\.title\}/);
  assert.match(workflowEditorSource, /Its node type stays \{selectedDefinition\.title\} everywhere/);
  assert.match(workflowEditorSource, /NODE TYPE/);
  assert.match(registrySource, /type: "ai\.structured-task", version: 2, title: "AI"/);
  assert.doesNotMatch(registrySource, /title: "Ask AI"/);
  assert.match(registrySource, /title: "Validate slide plans"/);
  assert.doesNotMatch(registrySource, /type: "logic\.(?:condition|limit-batch|validate-slide-plans)"[^\n]*accent: "rose"/);
  assert.match(workflowEditorSource, /defaultViewport/);
  assert.doesNotMatch(workflowEditorSource, /type EditorView/);
  assert.doesNotMatch(workflowEditorSource, /syntheticGroup/);
  assert.doesNotMatch(workflowEditorSource, /View stage details/);
  assert.doesNotMatch(workflowEditorSource, /WORKFLOW STAGE/);
  assert.match(themeSource, /\.automation-flow-node \{[^}]*background: var\(--color-ink-3\)/s);
  assert.doesNotMatch(themeSource, /\.automation-flow-node\.is-disabled \{[^}]*opacity:\s*\.(?:\d+)/s);
  assert.doesNotMatch(themeSource, /\.automation-flow-node \{[^}]*transition:[^;}]*transform/s);
  assert.match(themeSource, /\.automation-flow-stage \.react-flow__pane\.draggable \{ cursor: default; \}/);
  assert.match(themeSource, /\.automation-flow-stage \.react-flow__node\.draggable \{ cursor: default; \}/);
  assert.match(themeSource, /\.automation-flow-stage \.react-flow__node\.dragging \{ cursor: grabbing; \}/);
  assert.match(themeSource, /\.automation-flow-stage\.is-space-panning \.react-flow__renderer[^\n]*cursor: grab/);
  assert.match(themeSource, /\.automation-flow-stage\.is-space-panning \.react-flow__pane\.dragging \{ cursor: grabbing; \}/);
});

test("automation steps separate a plain-language guide from configuration and developer details", () => {
  assert.match(workflowEditorSource, /WHAT THIS STEP DOES/);
  assert.match(workflowEditorSource, /WHEN TO USE IT/);
  assert.match(workflowEditorSource, /EXAMPLE FLOW/);
  assert.match(workflowEditorSource, /HOW TO SET IT UP/);
  assert.match(workflowEditorSource, /WHAT IT RECEIVES AND CREATES/);
  assert.match(workflowEditorSource, /GOOD TO KNOW/);
  assert.match(workflowEditorSource, /Technical details/);
  assert.match(workflowEditorSource, /For developers and advanced integrations/);
  assert.match(workflowEditorSource, /Node type/);
  assert.match(workflowEditorSource, /Input ports/);
  assert.match(workflowEditorSource, /Output ports/);
  assert.match(workflowEditorSource, /aria-label="Step panel"/);
  assert.match(workflowEditorSource, />Guide</);
  assert.match(workflowEditorSource, />Settings</);
  assert.match(workflowEditorSource, /inspectorView === "guide"/);
  assert.match(workflowEditorSource, /inspectorView === "settings"/);
  assert.match(workflowEditorSource, /Click a card to follow the work/);
  assert.match(workflowEditorSource, /Every curve is a real connection/);
  assert.match(workflowEditorSource, /only the steps and paths immediately before and after it/);
  assert.doesNotMatch(workflowEditorSource, /const reachable/);
  assert.match(workflowEditorSource, /edge\.target === selectedNodeId/);
  assert.match(workflowEditorSource, /edge\.source === selectedNodeId/);
  assert.match(themeSource, /\.automation-flow-node\.is-previous,\.automation-flow-node\.is-next/);
  assert.doesNotMatch(workflowEditorSource, /persistentDataEdgeIds/);
  assert.match(workflowEditorSource, /Feeds:/);
  assert.match(workflowEditorSource, /THIS STEP IN THE CURRENT WORKFLOW/);
  assert.match(workflowEditorSource, /Runs after/);
  assert.match(workflowEditorSource, /Runs next/);
  assert.match(workflowEditorSource, /Also uses data from/);
  assert.match(workflowEditorSource, /Its data is reused by/);
  assert.match(workflowEditorSource, /connectedStep/);
  assert.match(workflowEditorSource, /sourceLabel.*targetLabel/s);
  assert.doesNotMatch(workflowEditorSource, />Overview</);
  assert.doesNotMatch(workflowEditorSource, />All steps</);
  assert.match(workflowEditorSource, /Protected system template/);
  assert.match(workflowEditorSource, /automation-setting-summary/);
  assert.match(workflowEditorSource, /fullFieldValue/);
  assert.match(workflowEditorSource, /FULL PROMPT/);
  assert.match(workflowEditorSource, /<div className=\{`automation-setting-value/);
  assert.doesNotMatch(workflowEditorSource, /View full prompt/);
  assert.doesNotMatch(workflowEditorSource, /title=\{readableFieldValue/);
  assert.match(workflowEditorSource, /Values this workflow will use/);
  assert.match(themeSource, /automation-editor-body:has\(\.automation-node-inspector\.is-open\)/);
  assert.match(themeSource, /automation-editor-body:has\(\.automation-node-inspector\.is-open\) \.automation-node-library \{ grid-column:3/);
  assert.match(themeSource, /\.automation-node-inspector\.is-open[^}]*grid-column:2/);
  assert.match(themeSource, /\.automation-node-library \{ grid-column:2/);
  assert.match(themeSource, /\.automation-editor-overlay[^}]*inset: 76px 14px 14px 430px/);
  assert.match(themeSource, /\.tiktok-automation-panel \{[^}]*width: min\(338px/);
  assert.doesNotMatch(panelSource, /is-editor-open/);
  assert.match(workflowEditorSource, /AutomationWorkflowExecutionState/);
  assert.match(workflowEditorSource, /nodeRun\.attempt >= current\.attempt/);
  assert.match(canvasSource, /nodeRuns\?: Array<\{ id: string; nodeId: string; nodeType: string; status: string; attempt: number;/);
  assert.match(canvasSource, /execution=\{automationExecution\}/);
  assert.match(canvasSource, /setAutomationExecution\(\{[\s\S]*nodeRuns: \(run\.nodeRuns \|\| \[\]\)\.map/);
  assert.match(themeSource, /is-execution-running/);
  assert.match(themeSource, /\.automation-flow-node\.is-execution-running \{ border-color:var\(--color-border-strong\); box-shadow:none; \}/);
  assert.match(workflowEditorSource, /generator-running-outline automation-flow-node-running-outline/);
  assert.match(workflowEditorSource, /<rect className="generator-running-runner"[^>]*pathLength="100"/);
  assert.match(globalsSource, /\.generator-running-runner \{[^}]*animation:generator-border-runner 1\.85s linear infinite/s);
  assert.doesNotMatch(workflowEditorSource, /LoaderCircle className="spin"/);
  assert.match(workflowEditorSource, /function AutomationExecutionEdge/);
  assert.doesNotMatch(workflowEditorSource, /animateMotion|automation-execution-particle/);
  assert.doesNotMatch(themeSource, /automation-execution-particle/);
  assert.match(workflowEditorSource, /edgeTypes=\{edgeTypes\}/);
  assert.match(workflowEditorSource, /Collapse workflow editor/);
  assert.match(workflowEditorSource, /ChevronLeft/);
  assert.doesNotMatch(workflowEditorSource, /PanelRightClose/);
  assert.match(workflowEditorSource, /appliedLayoutKeyRef/);
  assert.match(workflowEditorSource, /position: existing\.position/);
  assert.match(themeSource, /\.automation-editor-title > button\.automation-editor-collapse[^}]*border:0/);
  assert.match(themeSource, /automation-editor-body:has\(\.automation-node-inspector\.is-open\) \.automation-flow-hint \{ display:none/);
  assert.match(themeSource, /\.automation-inspector-section-label \{ display:grid/);
  assert.match(themeSource, /\.automation-setting-summary/);
  assert.match(themeSource, /\.automation-setting-value > pre/);
  assert.match(themeSource, /white-space:pre-wrap/);
  assert.match(themeSource, /\.automation-flow-stage \.react-flow__edge\.is-traced/);
  assert.doesNotMatch(themeSource, /\.automation-flow-node\.is-dimmed/);
  assert.doesNotMatch(themeSource, /\.react-flow__edge\.is-data[^\n]*stroke-dasharray/);
  assert.match(workflowEditorSource, /function MergeInputsEditor/);
  assert.match(workflowEditorSource, /Each row creates one socket/);
  assert.match(workflowEditorSource, /Disconnect this input before removing it/);
  assert.match(themeSource, /\.automation-node-connections/);
  assert.match(themeSource, /\.automation-inspector-tabs/);
  assert.match(workflowEditorSource, /useState<"guide" \| "settings" \| "execution">\("settings"\)/);
  assert.match(workflowEditorSource, /<b>Execution<\/b>/);
  assert.match(workflowEditorSource, /Captured input/);
  assert.match(workflowEditorSource, /Produced output/);
  assert.match(workflowEditorSource, /open=\{readOnly \? true : undefined\}/);
  assert.match(themeSource, /\.automation-node-execution/);
  assert.match(themeSource, /\.automation-help-flow/);
  assert.match(themeSource, /\.automation-help-steps/);
  assert.match(themeSource, /\.automation-node-technical/);
  assert.match(themeSource, /\.automation-inspector-scroll \{[^}]*flex:1/s);
  assert.match(themeSource, /\.automation-editor-body \{[^}]*grid-row:3/s);
  assert.match(workflowEditorSource, /Advanced settings/);
  assert.match(workflowEditorSource, /Permanent instructions, variation, retries and failures/);
  assert.match(workflowEditorSource, /function ResponseSchemaEditor/);
  assert.match(workflowEditorSource, /Technical JSON/);
  assert.match(workflowEditorSource, /parseSimpleFieldValue/);
  assert.match(registrySource, /example: "Choose a viral slideshow/);
  assert.match(registrySource, /If you added a person or character in the Identities section/);
  assert.doesNotMatch(registrySource, /Emma Before|Olivia/);
  assert.match(registrySource, /What should the AI do\?/);
  assert.match(registrySource, /advanced: true/);
  assert.match(registrySource, /kind: "value"/);
  assert.match(workflowEditorSource, /Only models compatible with this step&apos;s locked image shape and quality are available/);
  assert.match(themeSource, /\.automation-node-advanced/);
});

test("every registered node type owns hand-written user help and technical notes", () => {
  assert.match(workflowTypesSource, /export type AutomationNodeHelp/);
  assert.match(workflowTypesSource, /whenToUse: string/);
  assert.match(workflowTypesSource, /setup: string\[\]/);
  assert.match(workflowTypesSource, /exampleFlow:/);
  assert.match(workflowTypesSource, /technicalNotes\?: string\[\]/);
  assert.match(workflowTypesSource, /help: AutomationNodeHelp/);
  assert.match(registrySource, /const helpByType: Record<string, AutomationNodeHelp>/);
  assert.match(registrySource, /Missing help content for automation node type/);
  const registeredTypes = [...registrySource.matchAll(/^\s+type: "([^"]+)"/gm)].map((match) => match[1]);
  const helpByTypeSource = registrySource.slice(
    registrySource.indexOf("const helpByType"),
    registrySource.indexOf("const helpOverridesByVersion"),
  );
  const helpedTypes = [...helpByTypeSource.matchAll(/^\s+"([^"]+)": \{/gm)].map((match) => match[1]);
  const registeredVersions = new Set(
    [...registrySource.matchAll(/type: "([^"]+)", version: (\d+)/g)].map((match) => `${match[1]}@${match[2]}`),
  );
  const overriddenVersions = [...registrySource.matchAll(/^\s+"([^"@]+@\d+)": \{/gm)].map((match) => match[1]);
  assert.equal(new Set(registeredTypes).size, 25);
  assert.deepEqual(new Set(helpedTypes), new Set(registeredTypes));
  for (const versionKey of overriddenVersions) {
    assert.ok(registeredVersions.has(versionKey), `${versionKey} help override must target a registered node version`);
  }
  for (const definition of automationNodeDefinitions()) {
    assert.ok(definition.description.trim(), `${definition.type} needs a plain-language description`);
    assert.ok(definition.example?.trim(), `${definition.type} needs a non-developer example`);
    assert.ok(definition.help.whenToUse.trim(), `${definition.type} needs usage guidance`);
    assert.ok(definition.help.setup.length, `${definition.type} needs setup steps`);
    assert.ok(definition.help.technicalNotes?.length, `${definition.type} needs developer details`);
    for (const field of definition.fields) {
      assert.ok(field.description?.trim(), `${definition.type}.${field.id} needs an explanation`);
    }
  }
});

test("every node type has one visual identity reused across the canvas and both side panels", () => {
  const definitions = automationNodeDefinitions();
  assert.equal(new Set(definitions.map((definition) => definition.icon)).size, definitions.length);
  assert.match(workflowTypesSource, /icon: "play" \| "source" \| "identity"/);
  assert.match(workflowEditorSource, /const automationNodeIcons =/);
  assert.match(workflowEditorSource, /function AutomationNodeIcon/);
  assert.equal((workflowEditorSource.match(/<AutomationNodeIcon definition=/g) || []).length, 4);
  assert.doesNotMatch(workflowEditorSource, /definition\.category === "ai"/);
  assert.doesNotMatch(workflowEditorSource, /selectedDefinition\.accent}`}><Settings2/);
});

test("the default workflow teaches first-time users with a non-executable Markdown note", () => {
  assert.match(defaultWorkflowSource, /kind: "sticky-note"/);
  assert.match(defaultWorkflowSource, /Start here — how this automation works/);
  assert.match(defaultWorkflowSource, /position: \{ x: 100, y: -720 \}/);
  assert.match(defaultWorkflowSource, /Select a card to highlight only the cards and lines immediately before and after it/);
  assert.match(defaultWorkflowSource, /Start and collect the inputs/);
  assert.match(defaultWorkflowSource, /Understand the source before changing it/);
  assert.match(defaultWorkflowSource, /Decide what the new version should become/);
  assert.match(defaultWorkflowSource, /Build one executable plan per image/);
  assert.match(defaultWorkflowSource, /Check the whole series before generation/);
  assert.match(defaultWorkflowSource, /Create the assets and return them to the canvas/);
  assert.match(defaultWorkflowSource, /has five separate named inputs/);
  assert.match(defaultWorkflowSource, /the guide note itself never runs and never enters the data flow/);
  assert.match(workflowEditorSource, /display\.nodes\.some\(\(node\) => node\.data\.kind === "annotation"\)/);
  assert.match(workflowEditorSource, /!\(graph\.annotations \|\| \[\]\)\.length/);
  assert.match(workflowEditorSource, /function AutomationMarkdown/);
  assert.match(workflowEditorSource, /automationNote: AutomationStickyNote/);
  assert.match(workflowEditorSource, /GUIDE NOTE · DOES NOT RUN/);
  assert.match(themeSource, /\.automation-flow-note/);
  assert.match(themeSource, /\.automation-markdown-pipeline/);
  assert.match(themeSource, /\.automation-markdown-sections/);
});

test("the editor keeps system, draft, and published workflows switchable", () => {
  assert.match(workflowEditorSource, /InspectorSelect/);
  assert.match(workflowEditorSource, /Switch workflow/);
  assert.match(workflowEditorSource, /group: "Scenelith"/);
  assert.match(workflowEditorSource, /group: "My workflows"/);
  assert.match(workflowEditorSource, /Auto-saved draft · take it live before running/);
  assert.match(workflowEditorSource, /if \(dirty && !await saveDraft\(\)\) return/);
  assert.doesNotMatch(workflowEditorSource, /UNSAVED CHANGES|Save & switch|Discard &amp; switch/);
  assert.match(themeSource, /\.automation-workflow-switcher/);
});

test("workflow editing auto-saves while the live version changes only through an explicit action", () => {
  assert.match(workflowEditorSource, /window\.setTimeout\(\(\) => void saveDraft\(\), 850\)/);
  assert.doesNotMatch(workflowEditorSource, />Save draft</);
  assert.match(workflowEditorSource, /"Go live"/);
  assert.match(workflowEditorSource, /"Update live"/);
  assert.match(workflowEditorSource, /"Live"/);
  assert.match(workflowEditorSource, /const dirty = editRevision !== savedRevision/);
  assert.match(workflowEditorSource, /setSavedRevision\(\(current\) => Math\.max\(current, revisionToSave\)\)/);
  assert.match(workflowEditorSource, /const closeEditor = useCallback/);
  assert.doesNotMatch(workflowEditorSource, /Close without saving|Save this draft before switching/);
  assert.match(canvasSource, /setAutomationEditorWorkflowId\(\(current\) => current === workflowId \? null : workflowId\)/);
});

test("automation toolbar keeps management focused on run history", () => {
  assert.match(workflowEditorSource, /className=\{`automation-validation-pill/);
  assert.doesNotMatch(workflowEditorSource, /automation-validation-pill[\s\S]{0,500}<Check/);
  assert.match(workflowEditorSource, /aria-expanded=\{manageOpen\}/);
  assert.match(workflowEditorSource, />Manage<\/button>/);
  assert.match(workflowEditorSource, /<b>Run history<\/b><small>See routes, failures and usage<\/small>/);
  assert.match(workflowEditorSource, /<b>Export JSON<\/b>/);
  assert.doesNotMatch(workflowEditorSource, /<b>Versions<\/b>|<b>Automatic starts<\/b>|<b>Test a step<\/b>|<b>Workflow settings<\/b>/);
  assert.doesNotMatch(workflowOperationsSource, /Automatic starts|Test a step|Save fixture|Restore as draft/);
  assert.match(workflowOperationsSource, /Opening the latest run/);
  assert.match(workflowOperationsSource, /inspectRun\(runList\[0\]\.id, true\)/);
  assert.match(workflowOperationsSource, /workflowNodeNames\.get\(nodeRun\.nodeId\)/);
});

test("automation dropdown fields reuse the unclipped InspectorSelect", () => {
  assert.match(canvasSource, /<InspectorSelect label="Output type and model"/);
  assert.match(workflowEditorSource, /field\.kind === "model"[^?]*\? <InspectorSelect/s);
  assert.match(workflowEditorSource, /field\.kind === "select"[^?]*\? <InspectorSelect/s);
  assert.match(workflowEditorSource, /is-system-model[\s\S]*<InspectorSelect label=\{field\.label\}/);
  assert.doesNotMatch(workflowEditorSource, /<select|<option/);
  assert.match(workflowEditorSource, /Saved model override needs attention/);
  assert.match(workflowEditorSource, /Clear override/);
});

test("the slide-plan validator exposes when its optional contract is not connected", () => {
  assert.match(workflowEditorSource, /Structural validation only/);
  assert.match(workflowEditorSource, /selectedValidatorHasContract/);
  assert.match(registrySource, /Without it, this step performs structural checks only/);
});

test("workflow dropdown closes outside even when the editor stops pointer bubbling", () => {
  const inspectorSelectSource = readFileSync(new URL("../src/components/InspectorSelect.tsx", import.meta.url), "utf8");
  assert.match(workflowEditorSource, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(inspectorSelectSource, /addEventListener\("pointerdown", closeOutside, true\)/);
  assert.match(inspectorSelectSource, /removeEventListener\("pointerdown", closeOutside, true\)/);
  assert.match(inspectorSelectSource, /createPortal\(/);
  assert.match(inspectorSelectSource, /menuRef\.current\?\.contains\(target\)/);
});
