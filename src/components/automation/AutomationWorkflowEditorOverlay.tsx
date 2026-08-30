"use client";

import {
  BaseEdge,
  Background,
  ConnectionLineType,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Activity,
  ArrowRight,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Braces,
  Check,
  CircleAlert,
  Clapperboard,
  Code2,
  Copy,
  Download,
  Flag,
  FileInput,
  Gauge,
  GitBranch,
  Globe2,
  Image as ImageIcon,
  Images,
  Inbox,
  ChevronLeft,
  Layers3,
  ListTree,
  ListFilter,
  Merge,
  Play,
  Plus,
  Search,
  Route,
  RotateCcw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  StickyNote,
  Trash2,
  UserRound,
  WandSparkles,
  Workflow,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { generatorRatiosFor, generatorResolutionsFor, type GeneratorModelOption } from "@/components/FrameNode";
import { InspectorSelect } from "@/components/InspectorSelect";
import { assistantModels } from "@/lib/assistant-models";
import { automationMergeInputs, automationNodeDefinition, automationNodeDefinitions, automationNodeInputPorts, type AutomationMergeInput } from "@/lib/automation-workflows/registry";
import { automationCreativeControls, type AutomationCreativeControl } from "@/lib/automation-workflows/creative-direction-contract";
import type { PersonaRecord } from "@/lib/types";
import type { TikTokSlideshowSource } from "@/lib/tiktok-slideshow-sources";
import type {
  AutomationNode,
  AutomationAnnotation,
  AutomationEdgeRole,
  AutomationNodeFieldDefinition,
  AutomationValidationResult,
  AutomationWorkflowDetail,
  AutomationWorkflowGraph,
  AutomationWorkflowRecord,
} from "@/lib/automation-workflows/types";
import { previewAutomationPaths } from "@/lib/automation-workflows/preview";
import { topologicalAutomationNodeIds, validateAutomationConnection, validateAutomationWorkflowGraph } from "@/lib/automation-workflows/validation";
import { AutomationWorkflowOperations } from "./AutomationWorkflowOperations";
import { AutomationReferencePicker, type AutomationReferenceCandidate } from "./AutomationReferencePicker";
import type { AutomationCapabilities } from "@/editions/contracts/access";

type FlowNodeData = {
  kind: "step";
  automationNode: AutomationNode;
  stepIndex: number;
  readOnly: boolean;
  relation: "selected" | "previous" | "next" | null;
  supportingInputCount: number;
  supportingOutputCount: number;
  supportingOutputName: string | null;
  executionStatus: AutomationWorkflowNodeExecutionStatus;
  previewInactive: boolean;
  referenceControl: {
    workspaceId: string;
    projectId: string;
    canvasReferences: AutomationReferenceCandidate[];
    personas: PersonaRecord[];
    selectedIds: string[];
    maxItems: number;
    disabled: boolean;
    onChange: (assetIds: string[]) => void;
  } | null;
  [key: string]: unknown;
};

type FlowNoteData = {
  kind: "annotation";
  annotation: AutomationAnnotation;
  readOnly: boolean;
  [key: string]: unknown;
};

type AutomationFlowData = FlowNodeData | FlowNoteData;

export type AutomationWorkflowNodeExecutionStatus = "idle" | "running" | "completed" | "failed" | "skipped";
export type AutomationWorkflowExecutionState = {
  workflowId: string;
  runId: string | null;
  status: "queued" | "running" | "completed" | "completed_with_warnings" | "failed" | "cancelled";
  nodeRuns: Array<{ id?: string; nodeId: string; status: string; attempt: number; error?: string | null; errorCode?: string | null; startedAt?: string | null; completedAt?: string | null }>;
};

type AutomationNodeExecutionAttempt = {
  id: string;
  nodeId: string;
  nodeType: string;
  attempt: number;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  errorCode: string | null;
  chargedCredits: number;
  outputPorts: string[];
  reusedFromNodeRunId: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

type AutomationExecutionEdgeData = {
  executionStatus: AutomationWorkflowNodeExecutionStatus;
  label?: string;
  previewInactive?: boolean;
};

type WorkflowBindingOption = { id: string; name: string; status: string; publishedVersionId: string | null };
type CredentialOption = { id: string; name: string; kind: string; fingerprint: string };
type WorkflowBinding = { slotKey: string; type: "credential" | "subworkflow"; credentialId: string | null; credentialName: string | null; targetWorkflowId: string | null; targetWorkflowName: string | null };
type AutomationWorkflowClientDetail = AutomationWorkflowDetail & {
  capabilities: AutomationCapabilities;
  systemModelDefaults?: Record<string, string>;
};
type AutomationNodeDefinitionRecord = ReturnType<typeof automationNodeDefinitions>[number];

function workflowSwitcherPresentation(workflow: AutomationWorkflowRecord) {
  if (workflow.status === "system") return { group: "Scenelith", badge: "System", description: "Read-only default workflow" };
  if (workflow.status === "archived") return { group: "My workflows", badge: "Archived", description: "Archived workflow" };
  if (workflow.status === "published") return { group: "My workflows", badge: "Live", description: "Live and ready to run" };
  if (workflow.publishedVersionId) return { group: "My workflows", badge: "Draft", description: "Auto-saved changes · the live version still runs" };
  return { group: "My workflows", badge: "Draft", description: "Auto-saved draft · take it live before running" };
}

const categoryLabels = {
  trigger: "Triggers",
  input: "Inputs",
  ai: "AI",
  logic: "Logic",
  integration: "Integrations",
  generation: "Generation",
  output: "Outputs",
} as const;

const categoryNodeLabels = {
  trigger: "Trigger",
  input: "Input",
  ai: "AI",
  logic: "Logic",
  integration: "Integration",
  generation: "Generation",
  output: "Output",
} as const;

const automationNodeIcons = {
  play: Play,
  source: Clapperboard,
  identity: UserRound,
  references: Images,
  choices: SlidersHorizontal,
  inbox: Inbox,
  ai: Sparkles,
  transform: Braces,
  "select-one": Route,
  "select-path": ListFilter,
  condition: GitBranch,
  "prepare-direction": ListTree,
  "interpret-direction": Sparkles,
  "resolve-direction": WandSparkles,
  limit: Gauge,
  merge: Merge,
  workflow: Workflow,
  repeat: ListTree,
  retry: RotateCcw,
  http: Globe2,
  validate: ShieldCheck,
  "image-requests": FileInput,
  generate: ImageIcon,
  canvas: Layers3,
  finish: Flag,
} as const;

function AutomationNodeIcon({ definition, size = 14 }: { definition: AutomationNodeDefinitionRecord; size?: number }) {
  const Icon = automationNodeIcons[definition.icon];
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />;
}

function AutomationNodeCard({ data, selected }: NodeProps<Node<FlowNodeData>>) {
  const node = data.automationNode;
  const definition = automationNodeDefinition(node.type, node.version);
  if (!definition) return <div className="automation-flow-node is-error"><strong>{node.name}</strong><small>Unknown node type</small></div>;
  const inputPorts = automationNodeInputPorts(node);
  const portSummary = (ports: ReadonlyArray<{ label: string }>, empty: string) => ports.length
    ? `${ports.slice(0, 2).map((port) => port.label).join(" + ")}${ports.length > 2 ? ` +${ports.length - 2}` : ""}`
    : empty;
  const connectableOutputs = definition.outputs.filter((port) => port.connectable !== false);
  return <div className={`automation-flow-node is-${definition.accent} ${selected ? "is-selected" : ""} ${node.disabled ? "is-disabled" : ""} ${data.previewInactive ? "is-preview-inactive" : ""} ${data.relation ? `is-${data.relation}` : ""} ${data.executionStatus !== "idle" ? `is-execution-${data.executionStatus}` : ""}`}>
    {data.executionStatus === "running" && <svg className="generator-running-outline automation-flow-node-running-outline" aria-hidden="true">
      <rect className="generator-running-runner" x="2" y="2" width="calc(100% - 4px)" height="calc(100% - 4px)" rx="15" pathLength="100" />
    </svg>}
    {inputPorts.map((port, index) => <Handle
      key={port.id}
      id={port.id}
      type="target"
      position={Position.Left}
      isConnectable={!data.readOnly}
      style={{ top: `${((index + 1) / (inputPorts.length + 1)) * 100}%` }}
      title={port.label}
    />)}
    <span className="automation-flow-node-kicker"><AutomationNodeIcon definition={definition} size={13} /><em>{String(data.stepIndex).padStart(2, "0")}</em><b>{definition.title}</b>{data.executionStatus === "running" ? <i className="automation-flow-node-run-state is-running" title="Running now">Running</i> : data.executionStatus === "completed" ? <i className="automation-flow-node-run-state is-completed" title="Completed"><Check size={12} />Done</i> : data.executionStatus === "failed" ? <i className="automation-flow-node-run-state is-failed" title="Stopped on this step"><CircleAlert size={12} />Stopped</i> : data.executionStatus === "skipped" ? <i className="automation-flow-node-run-state is-skipped" title="Skipped">Skipped</i> : null}</span>
    <strong>{node.name}</strong>
    <p>{node.description || definition.description}</p>
    {data.referenceControl && <div className="automation-flow-node-references nodrag nopan nowheel">
      <AutomationReferencePicker
        workspaceId={data.referenceControl.workspaceId}
        projectId={data.referenceControl.projectId}
        canvasReferences={data.referenceControl.canvasReferences}
        personas={data.referenceControl.personas}
        selectedIds={data.referenceControl.selectedIds}
        maxItems={data.referenceControl.maxItems}
        disabled={data.referenceControl.disabled}
        placement="node"
        onChange={data.referenceControl.onChange}
      />
    </div>}
    <span className="automation-flow-node-io" aria-hidden="true">
      <i title={inputPorts.map((port) => port.label).join(", ")}>{inputPorts.length ? `Gets: ${portSummary(inputPorts, "")}` : "Starts here"}</i>
      <i title={connectableOutputs.map((port) => port.label).join(", ")}>{connectableOutputs.length ? `Sends: ${portSummary(connectableOutputs, "")}` : "Ends here"}</i>
    </span>
    {(data.supportingInputCount > 0 || data.supportingOutputCount > 0) && <span className="automation-flow-node-context">
      {data.supportingInputCount > 0 && <i>Uses {data.supportingInputCount} extra source{data.supportingInputCount === 1 ? "" : "s"}</i>}
      {data.supportingOutputCount === 1 && data.supportingOutputName
        ? <i>Feeds: {data.supportingOutputName}</i>
        : data.supportingOutputCount > 0 && <i>Reused by {data.supportingOutputCount} later steps</i>}
    </span>}
    {definition.outputs.filter((port) => port.connectable !== false).map((port, index, ports) => <Handle
      key={port.id}
      id={port.id}
      type="source"
      position={Position.Right}
      isConnectable={!data.readOnly && !definition.terminal}
      style={{ top: `${((index + 1) / (ports.length + 1)) * 100}%` }}
      title={port.label}
    />)}
  </div>;
}

function markdownInline(text: string, keyPrefix: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${keyPrefix}:${index}`}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={`${keyPrefix}:${index}`}>{part.slice(1, -1)}</code>;
    return <span key={`${keyPrefix}:${index}`}>{part}</span>;
  });
}

function markdownBlocks(markdown: string, keyPrefix: string) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (!list.length) return;
    const items = list;
    list = [];
    blocks.push(<ul key={`${keyPrefix}:list:${blocks.length}`}>{items.map((item, index) => <li key={index}>{markdownInline(item, `${keyPrefix}:list:${blocks.length}:${index}`)}</li>)}</ul>);
  };
  markdown.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) { flushList(); return; }
    if (line.startsWith("- ")) { list.push(line.slice(2)); return; }
    flushList();
    if (line.startsWith("### ")) blocks.push(<h4 key={`${keyPrefix}:h4:${blocks.length}`}>{markdownInline(line.slice(4), `${keyPrefix}:h4:${blocks.length}`)}</h4>);
    else if (line.startsWith("## ")) blocks.push(<h3 key={`${keyPrefix}:h3:${blocks.length}`}>{markdownInline(line.slice(3), `${keyPrefix}:h3:${blocks.length}`)}</h3>);
    else if (line.startsWith("> ")) blocks.push(<blockquote key={`${keyPrefix}:quote:${blocks.length}`}>{markdownInline(line.slice(2), `${keyPrefix}:quote:${blocks.length}`)}</blockquote>);
    else if ((line.match(/→/g) || []).length >= 2) blocks.push(<div className="automation-markdown-pipeline" key={`${keyPrefix}:pipeline:${blocks.length}`}>{line.split("→").map((part, index, parts) => <span key={index}>{markdownInline(part.trim(), `${keyPrefix}:pipeline:${blocks.length}:${index}`)}{index < parts.length - 1 && <ArrowRight size={14} />}</span>)}</div>);
    else blocks.push(<p key={`${keyPrefix}:p:${blocks.length}`}>{markdownInline(line, `${keyPrefix}:p:${blocks.length}`)}</p>);
  });
  flushList();
  return blocks;
}

function AutomationMarkdown({ markdown }: { markdown: string }) {
  const [intro, ...sections] = markdown.split(/\n(?=### )/);
  return <div className="automation-markdown">
    <div className="automation-markdown-intro">{markdownBlocks(intro, "intro")}</div>
    {sections.length > 0 && <div className="automation-markdown-sections">{sections.map((section, index) => <section key={index}>{markdownBlocks(section, `section:${index}`)}</section>)}</div>}
  </div>;
}

function AutomationStickyNote({ data, selected }: NodeProps<Node<FlowNoteData>>) {
  const note = data.annotation;
  return <article className={`automation-flow-note sticky-note-${note.color} ${selected ? "is-selected" : ""}`} style={{ width: note.size.width, height: note.size.height }}>
    <header><span><StickyNote size={15} /> GUIDE NOTE</span><strong>{note.title}</strong></header>
    <AutomationMarkdown markdown={note.markdown} />
    <footer><span>Scenelith</span><small>Workflow guide · does not run</small></footer>
  </article>;
}

const nodeTypes = { automationNode: AutomationNodeCard, automationNote: AutomationStickyNote };

function AutomationExecutionEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps) {
  const edgeData = (data || {}) as AutomationExecutionEdgeData;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.32 });
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={24} />
    {edgeData.label && <EdgeLabelRenderer><div className="automation-execution-edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}>{edgeData.label}</div></EdgeLabelRenderer>}
  </>;
}

const edgeTypes = { automationExecution: AutomationExecutionEdge };

function portRequirement(port: AutomationNodeDefinitionRecord["inputs"][number]) {
  if (port.required) return "required";
  return "optional";
}

function AutomationNodeTechnicalDetails({ definition, inputPorts = definition.inputs }: { definition: AutomationNodeDefinitionRecord; inputPorts?: AutomationNodeDefinitionRecord["inputs"] }) {
  return <details className="automation-node-technical">
    <summary><span><Code2 size={14} /><b>Technical details</b><small>For developers and advanced integrations</small></span><Plus size={14} /></summary>
    <div>
      <dl className="automation-technical-identity">
        <div><dt>Node type</dt><dd><b>{definition.title}</b><code>{definition.type}</code></dd></div>
        <div><dt>Version</dt><dd><code>{definition.version}</code></dd></div>
        <div><dt>Behavior</dt><dd>{definition.terminal ? "Ends this workflow path" : "Passes work to another step"}</dd></div>
      </dl>
      <section>
        <h4>Input ports</h4>
        {inputPorts.length ? inputPorts.map((port) => <article key={port.id}>
          <span><b>{port.label}</b><em>{portRequirement(port)}{port.multiple ? " · multiple connections" : ""}</em></span>
          <code>{port.id}</code><small>{port.type}</small>
        </article>) : <p>This node has no input ports because it starts a path.</p>}
      </section>
      <section>
        <h4>Output ports</h4>
        {definition.outputs.length ? definition.outputs.map((port) => <article key={port.id}>
          <span><b>{port.label}</b><em>{port.connectable === false ? "internal run receipt · no connection handle" : port.multiple ? "multiple connections allowed" : "one typed output"}</em></span>
          <code>{port.id}</code><small>{port.type}</small>
        </article>) : <p>This node has no output ports because it ends a path.</p>}
      </section>
      {definition.help.technicalNotes?.length ? <section><h4>Runtime notes</h4><ul>{definition.help.technicalNotes.map((note) => <li key={note}>{note}</li>)}</ul></section> : null}
    </div>
  </details>;
}

function AutomationNodeGuide({ definition, node }: { definition: AutomationNodeDefinitionRecord; node?: AutomationNode }) {
  const inputPorts = node ? automationNodeInputPorts(node) : definition.inputs;
  return <div className="automation-node-help">
    <section className="automation-help-section is-intro">
      <small>WHAT THIS STEP DOES</small>
      <p>{definition.description}</p>
    </section>
    <section className="automation-help-section">
      <small>WHEN TO USE IT</small>
      <p>{definition.help.whenToUse}</p>
    </section>
    <section className="automation-help-section">
      <small>EXAMPLE FLOW</small>
      <div className="automation-help-flow">
        <span>{definition.help.exampleFlow.before}</span><ArrowRight size={13} />
        <strong>{definition.title}</strong><ArrowRight size={13} />
        <span>{definition.help.exampleFlow.after}</span>
      </div>
      <p>{definition.help.exampleFlow.explanation}</p>
    </section>
    <section className="automation-help-section">
      <small>HOW TO SET IT UP</small>
      <ol className="automation-help-steps">{definition.help.setup.map((step, index) => <li key={step}><i>{index + 1}</i><span>{step}</span></li>)}</ol>
    </section>
    <section className="automation-help-section">
      <small>WHAT IT RECEIVES AND CREATES</small>
      <div className="automation-help-contract">
        <span><b>Receives</b>{inputPorts.length ? inputPorts.map((port) => <i key={port.id}>{port.label}{port.required ? " · required" : " · optional"}</i>) : <em>Nothing — this starts the workflow</em>}</span>
        <ArrowRight size={13} />
        <span><b>{definition.outputs.some((port) => port.connectable !== false) ? "Creates" : "Records internally"}</b>{definition.outputs.length ? definition.outputs.map((port) => <i key={port.id}>{port.label}{port.connectable === false ? " · final receipt" : ""}</i>) : <em>Nothing — this finishes the path</em>}</span>
      </div>
    </section>
    {definition.help.tips?.length ? <section className="automation-help-section is-tips"><small>GOOD TO KNOW</small><ul>{definition.help.tips.map((tip) => <li key={tip}>{tip}</li>)}</ul></section> : null}
    <AutomationNodeTechnicalDetails definition={definition} inputPorts={inputPorts} />
  </div>;
}

function connectedStep(graph: AutomationWorkflowGraph, edge: AutomationWorkflowGraph["edges"][number]) {
  const sourceNode = graph.nodes.find((node) => node.id === edge.source);
  const targetNode = graph.nodes.find((node) => node.id === edge.target);
  const sourceDefinition = sourceNode ? automationNodeDefinition(sourceNode.type, sourceNode.version) : null;
  const sourcePort = sourceDefinition?.outputs.find((port) => port.id === edge.sourcePort);
  const targetPort = targetNode ? automationNodeInputPorts(targetNode).find((port) => port.id === edge.targetPort) : null;
  return {
    sourceNode,
    targetNode,
    sourceLabel: sourcePort?.label || edge.sourcePort,
    targetLabel: targetPort?.label || edge.targetPort,
    dataType: sourcePort?.type || targetPort?.type || "data",
  };
}

function AutomationNodeConnections({ graph, node, onSelect }: { graph: AutomationWorkflowGraph; node: AutomationNode; onSelect: (nodeId: string) => void }) {
  const incoming = graph.edges.filter((edge) => edge.target === node.id).map((edge) => ({ edge, contract: connectedStep(graph, edge) }));
  const outgoing = graph.edges.filter((edge) => edge.source === node.id).map((edge) => ({ edge, contract: connectedStep(graph, edge) }));
  const mainIncoming = incoming.filter(({ edge }) => edge.role !== "data");
  const dataIncoming = incoming.filter(({ edge }) => edge.role === "data");
  const mainOutgoing = outgoing.filter(({ edge }) => edge.role !== "data");
  const dataOutgoing = outgoing.filter(({ edge }) => edge.role === "data");
  const connectionList = (connections: typeof incoming, empty: string) => connections.length ? connections.map(({ edge, contract }) => <button type="button" key={edge.id} onClick={() => onSelect(edge.target === node.id ? edge.source : edge.target)}>
    <i>{edge.target === node.id ? contract.sourceNode?.name || "Previous step" : contract.targetNode?.name || "Next step"}</i>
    <em>{contract.sourceLabel} → {contract.targetLabel}</em>
    <ArrowRight size={12} />
  </button>) : <em className="automation-connection-empty">{empty}</em>;
  if (node.type === "logic.merge") return <section className="automation-node-connections">
    <small>THIS MERGE IN THE CURRENT WORKFLOW</small>
    <p>Merge waits for every named socket below. Each source stays separate until this card creates one combined result.</p>
    <div>
      <span>
        <b>Waits for</b>
        {connectionList(incoming, "No paths connected")}
      </span>
      <span>
        <b>Passes the combined result to</b>
        {connectionList(outgoing, "Nothing · this route finishes here")}
      </span>
    </div>
  </section>;
  return <section className="automation-node-connections">
    <small>THIS STEP IN THE CURRENT WORKFLOW</small>
    <p>Every curve is a real connection. Select any card to highlight only the steps and paths immediately before and after it.</p>
    <div>
      <span>
        <b>Runs after</b>
        {connectionList(mainIncoming, "Nothing · this step starts a route")}
      </span>
      <span>
        <b>Runs next</b>
        {connectionList(mainOutgoing, "Nothing · this route finishes here")}
      </span>
      {dataIncoming.length > 0 && <span className="is-supporting"><b>Also uses data from</b>{connectionList(dataIncoming, "")}</span>}
      {dataOutgoing.length > 0 && <span className="is-supporting"><b>Its data is reused by</b>{connectionList(dataOutgoing, "")}</span>}
    </div>
  </section>;
}

function displayGraph(
  graph: AutomationWorkflowGraph,
  readOnly: boolean,
  selectedNodeId: string | null,
  execution: AutomationWorkflowExecutionState | null = null,
  runtimeValues: Record<string, unknown> = {},
  referenceContext?: {
    workspaceId: string;
    projectId: string;
    canvasReferences: AutomationReferenceCandidate[];
    personas: PersonaRecord[];
    canRun: boolean;
    onRuntimeValueChange?: (key: string, value: unknown) => void;
    onFixedReferencesChange: (nodeId: string, assetIds: string[]) => void;
  },
) {
  const pathPreview = previewAutomationPaths(graph, runtimeValues);
  const orderedIds = topologicalAutomationNodeIds(graph);
  const completeOrder = [...orderedIds, ...graph.nodes.filter((node) => !orderedIds.includes(node.id)).map((node) => node.id)];
  const orderById = new Map(completeOrder.map((id, index) => [id, index + 1]));
  const previousIds = new Set(graph.edges.filter((edge) => edge.target === selectedNodeId).map((edge) => edge.source));
  const nextIds = new Set(graph.edges.filter((edge) => edge.source === selectedNodeId).map((edge) => edge.target));
  const latestNodeRuns = new Map<string, AutomationWorkflowExecutionState["nodeRuns"][number]>();
  for (const nodeRun of execution?.nodeRuns || []) {
    const current = latestNodeRuns.get(nodeRun.nodeId);
    if (!current || nodeRun.attempt >= current.attempt) latestNodeRuns.set(nodeRun.nodeId, nodeRun);
  }
  const executionStatus = (nodeId: string): AutomationWorkflowNodeExecutionStatus => {
    const status = latestNodeRuns.get(nodeId)?.status;
    if (status === "running" || status === "completed" || status === "failed" || status === "skipped") return status;
    return "idle";
  };
  const relation = (nodeId: string): FlowNodeData["relation"] => {
    if (!selectedNodeId) return null;
    if (nodeId === selectedNodeId) return "selected";
    if (previousIds.has(nodeId)) return "previous";
    if (nextIds.has(nodeId)) return "next";
    return null;
  }
  return {
    nodes: [
      ...graph.nodes.map((node) => ({
        id: node.id,
        type: "automationNode",
        position: node.position,
        data: {
          kind: "step" as const,
          automationNode: node,
          stepIndex: orderById.get(node.id) || 0,
          readOnly,
          relation: relation(node.id),
          supportingInputCount: graph.edges.filter((edge) => edge.target === node.id && edge.role === "data").length,
          supportingOutputCount: graph.edges.filter((edge) => edge.source === node.id && edge.role === "data").length,
          supportingOutputName: (() => {
            const outputs = graph.edges.filter((edge) => edge.source === node.id && edge.role === "data");
            return outputs.length === 1 ? graph.nodes.find((target) => target.id === outputs[0].target)?.name || null : null;
          })(),
          executionStatus: executionStatus(node.id),
          previewInactive: !pathPreview.activeNodeIds.has(node.id),
          referenceControl: (() => {
            if (node.type !== "input.visual-references" || !referenceContext) return null;
            const binding = node.bindings.references;
            const askOnRun = binding?.mode === "ask-on-run";
            const runtimeKey = `${node.id}.references`;
            const rawValue = askOnRun
              ? runtimeValues[runtimeKey] ?? binding?.value ?? node.config.references
              : binding?.mode === "fixed" && binding.value !== undefined ? binding.value : node.config.references;
            const selectedIds = Array.isArray(rawValue) ? rawValue.filter((item): item is string => typeof item === "string") : [];
            const maxItems = Math.min(32, Math.max(1, Number(node.config.maxItems || 8)));
            return {
              workspaceId: referenceContext.workspaceId,
              projectId: referenceContext.projectId,
              canvasReferences: referenceContext.canvasReferences,
              personas: referenceContext.personas,
              selectedIds,
              maxItems,
              disabled: askOnRun ? !referenceContext.canRun || !referenceContext.onRuntimeValueChange : readOnly,
              onChange: askOnRun
                ? (assetIds: string[]) => referenceContext.onRuntimeValueChange?.(runtimeKey, assetIds)
                : (assetIds: string[]) => referenceContext.onFixedReferencesChange(node.id, assetIds),
            };
          })(),
        },
      })),
      ...(graph.annotations || []).map((annotation) => ({ id: `annotation:${annotation.id}`, type: "automationNote", position: annotation.position, draggable: true, selectable: true, data: { kind: "annotation" as const, annotation, readOnly } })),
    ],
    edges: graph.edges.map((edge) => ({
      ...(() => {
        const incoming = Boolean(selectedNodeId && edge.target === selectedNodeId);
        const outgoing = Boolean(selectedNodeId && edge.source === selectedNodeId);
        const focused = incoming || outgoing;
        const directlyConnected = selectedNodeId === edge.target || selectedNodeId === edge.source;
        const contract = connectedStep(graph, edge);
        const role = edge.role;
        const sourceStatus = executionStatus(edge.source);
        const targetStatus = executionStatus(edge.target);
        const edgeExecutionStatus: AutomationWorkflowNodeExecutionStatus = targetStatus === "running" && sourceStatus === "completed"
          ? "running"
          : targetStatus === "failed" && sourceStatus === "completed"
            ? "failed"
            : sourceStatus === "completed" && (targetStatus === "completed" || targetStatus === "skipped")
              ? "completed"
              : "idle";
        const connectionLabel = directlyConnected ? `${contract.sourceLabel} → ${contract.targetLabel}` : undefined;
        return {
          hidden: false,
          className: [
            `is-${role}`,
            !pathPreview.activeEdgeIds.has(edge.id) ? "is-preview-inactive" : "",
            focused ? incoming ? "is-traced is-incoming" : "is-traced is-outgoing" : "",
            edgeExecutionStatus !== "idle" ? `is-execution-${edgeExecutionStatus}` : "",
          ].filter(Boolean).join(" "),
          data: { executionStatus: edgeExecutionStatus, label: connectionLabel, previewInactive: !pathPreview.activeEdgeIds.has(edge.id) } satisfies AutomationExecutionEdgeData,
        };
      })(),
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourcePort,
      targetHandle: edge.targetPort,
      type: "automationExecution",
      markerEnd: { type: MarkerType.ArrowClosed },
    })),
  };
}

const magneticSnapDistance = 12;

function magneticNodePosition(dragged: Node<AutomationFlowData>, nodes: Node<AutomationFlowData>[]) {
  const draggedWidth = dragged.measured?.width ?? dragged.width ?? 244;
  const draggedHeight = dragged.measured?.height ?? dragged.height ?? 122;
  let x = dragged.position.x;
  let y = dragged.position.y;
  let closestX = magneticSnapDistance + 1;
  let closestY = magneticSnapDistance + 1;

  for (const other of nodes) {
    if (other.id === dragged.id) continue;
    const otherWidth = other.measured?.width ?? other.width ?? 244;
    const otherHeight = other.measured?.height ?? other.height ?? 122;
    const xTargets = [
      other.position.x,
      other.position.x + otherWidth / 2 - draggedWidth / 2,
      other.position.x + otherWidth - draggedWidth,
    ];
    const yTargets = [
      other.position.y,
      other.position.y + otherHeight / 2 - draggedHeight / 2,
      other.position.y + otherHeight - draggedHeight,
    ];
    for (const target of xTargets) {
      const distance = Math.abs(dragged.position.x - target);
      if (distance <= magneticSnapDistance && distance < closestX) { x = target; closestX = distance; }
    }
    for (const target of yTargets) {
      const distance = Math.abs(dragged.position.y - target);
      if (distance <= magneticSnapDistance && distance < closestY) { y = target; closestY = distance; }
    }
  }
  return { x, y };
}

function layeredFlowPositions(nodes: Node<AutomationFlowData>[], edges: Edge[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  const outgoing = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) continue;
    incoming.get(edge.target)?.add(edge.source);
    outgoing.get(edge.source)?.add(edge.target);
  }
  const layer = new Map(nodes.map((node) => [node.id, 0]));
  const remaining = new Map([...incoming].map(([id, sources]) => [id, sources.size]));
  const queue = nodes.filter((node) => remaining.get(node.id) === 0).sort((a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id));
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    for (const target of outgoing.get(current.id) || []) {
      layer.set(target, Math.max(layer.get(target) || 0, (layer.get(current.id) || 0) + 1));
      const nextRemaining = Math.max(0, (remaining.get(target) || 0) - 1);
      remaining.set(target, nextRemaining);
      if (nextRemaining === 0) queue.push(nodes.find((node) => node.id === target)!);
    }
  }
  const lastLayer = Math.max(0, ...layer.values());
  nodes.filter((node) => !visited.has(node.id)).forEach((node, index) => layer.set(node.id, lastLayer + 1 + index));
  const buckets = new Map<number, Node<AutomationFlowData>[]>();
  for (const node of nodes) {
    const nodeLayer = layer.get(node.id) || 0;
    buckets.set(nodeLayer, [...(buckets.get(nodeLayer) || []), node]);
  }
  const maxRows = Math.max(1, ...[...buckets.values()].map((bucket) => bucket.length));
  const positions = new Map<string, { x: number; y: number }>();
  for (const [column, bucket] of [...buckets].sort(([a], [b]) => a - b)) {
    bucket.sort((a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id));
    const firstY = 120 + ((maxRows - bucket.length) * 176) / 2;
    bucket.forEach((node, row) => positions.set(node.id, { x: 96 + column * 330, y: firstY + row * 176 }));
  }
  return positions;
}

function arrangeWorkflowView(graph: AutomationWorkflowGraph) {
  const visible = displayGraph(graph, false, null);
  const positions = layeredFlowPositions(visible.nodes.filter((node) => node.type === "automationNode"), visible.edges);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node),
  };
}

function JsonEditor({ value, disabled, onChange }: { value: unknown; disabled: boolean; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [invalid, setInvalid] = useState(false);
  return <div className={`automation-json-editor ${invalid ? "is-invalid" : ""}`}>
    <textarea
      value={text}
      disabled={disabled}
      spellCheck={false}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        try { onChange(JSON.parse(text)); setInvalid(false); }
        catch { setInvalid(true); }
      }}
    />
    {invalid && <small>Use valid JSON before saving.</small>}
  </div>;
}

type ResponseFieldKind = "string" | "number" | "integer" | "boolean" | "array" | "object";

function responseSchemaRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function responseFieldKind(value: unknown): ResponseFieldKind {
  const type = String(responseSchemaRecord(value).type || "string");
  return ["string", "number", "integer", "boolean", "array", "object"].includes(type) ? type as ResponseFieldKind : "string";
}

function ResponseSchemaFieldRow({
  name,
  definition,
  disabled,
  siblingNames,
  onRename,
  onDefinitionChange,
  onRemove,
}: {
  name: string;
  definition: Record<string, unknown>;
  disabled: boolean;
  siblingNames: string[];
  onRename: (name: string) => void;
  onDefinitionChange: (definition: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const [draftName, setDraftName] = useState(name);
  const [nameError, setNameError] = useState("");
  const kind = responseFieldKind(definition);
  const commitName = () => {
    const nextName = draftName.trim().replace(/[^a-zA-Z0-9_-]/g, "");
    if (!nextName) {
      setDraftName(name);
      setNameError("Give this field a name.");
      return;
    }
    if (nextName !== name && siblingNames.includes(nextName)) {
      setDraftName(name);
      setNameError("Field names must be unique.");
      return;
    }
    setDraftName(nextName);
    setNameError("");
    if (nextName !== name) onRename(nextName);
  };
  return <div className={`automation-schema-row ${nameError ? "is-invalid" : ""}`}>
    <div className="automation-schema-row-main">
      <input
        aria-label="Answer field name"
        disabled={disabled}
        value={draftName}
        onChange={(event) => { setDraftName(event.target.value); setNameError(""); }}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setDraftName(name);
            setNameError("");
            event.currentTarget.blur();
          }
        }}
      />
      <InspectorSelect
        label={`${name} field type`}
        disabled={disabled}
        value={kind}
        options={[
          { value: "string", label: "Text" },
          { value: "number", label: "Number" },
          { value: "integer", label: "Whole number" },
          { value: "boolean", label: "Yes / no" },
          { value: "array", label: "List" },
          { value: "object", label: "Object" },
        ]}
        onChange={(value) => {
          const nextKind = value as ResponseFieldKind;
          const nextDefinition = nextKind === "array"
            ? { type: "array", items: { type: "string" }, ...(definition.description ? { description: definition.description } : {}) }
            : nextKind === "object"
              ? { type: "object", additionalProperties: false, properties: {}, required: [], ...(definition.description ? { description: definition.description } : {}) }
              : { type: nextKind, ...(definition.description ? { description: definition.description } : {}) };
          onDefinitionChange(nextDefinition);
        }}
      />
      <button type="button" aria-label={`Remove ${name}`} disabled={disabled} onClick={onRemove}><Trash2 size={13} /></button>
    </div>
    {nameError && <small className="automation-schema-name-error">{nameError}</small>}
    <input
      aria-label={`${name} field description`}
      disabled={disabled}
      value={String(definition.description || "")}
      placeholder="What should this field contain?"
      onChange={(event) => onDefinitionChange({ ...definition, description: event.target.value })}
    />
    <span className="automation-schema-required is-on"><i />Always included</span>
  </div>;
}

function ResponseSchemaEditor({ value, disabled, onChange }: { value: unknown; disabled: boolean; onChange: (value: unknown) => void }) {
  const schema = responseSchemaRecord(value);
  const properties = responseSchemaRecord(schema.properties);
  const entries = Object.entries(properties);
  const update = (nextProperties: Record<string, unknown>) => onChange({
    ...schema,
    type: "object",
    additionalProperties: false,
    properties: nextProperties,
    required: Object.keys(nextProperties),
  });
  return <div className="automation-schema-editor">
    <div className="automation-schema-fields">
      {entries.length ? entries.map(([name, rawDefinition]) => {
        const definition = responseSchemaRecord(rawDefinition);
        return <ResponseSchemaFieldRow
          key={name}
          name={name}
          definition={definition}
          disabled={disabled}
          siblingNames={Object.keys(properties)}
          onRename={(nextName) => update(Object.fromEntries(Object.entries(properties).map(([key, item]) => key === name ? [nextName, item] : [key, item])))}
          onDefinitionChange={(nextDefinition) => update({ ...properties, [name]: nextDefinition })}
          onRemove={() => {
            const nextProperties = { ...properties }; delete nextProperties[name];
            update(nextProperties);
          }}
        />;
      }) : <p>No fields yet. Add the first field that the next step needs.</p>}
    </div>
    <button type="button" className="automation-schema-add" disabled={disabled} onClick={() => {
      let index = entries.length + 1;
      let name = `field_${index}`;
      while (Object.prototype.hasOwnProperty.call(properties, name)) name = `field_${++index}`;
      update({ ...properties, [name]: { type: "string", description: "" } });
    }}><Plus size={13} /> Add answer field</button>
    <details className="automation-schema-technical">
      <summary><Code2 size={13} /><span><b>Technical JSON</b><small>For nested lists and objects</small></span><Plus size={12} /></summary>
      <JsonEditor key={JSON.stringify(value ?? {})} disabled={disabled} value={value} onChange={onChange} />
    </details>
  </div>;
}

function ResponseSchemaSummary({ value }: { value: unknown }) {
  const schema = responseSchemaRecord(value);
  const properties = responseSchemaRecord(schema.properties);
  const entries = Object.entries(properties);
  return <div className="automation-schema-summary">
    {entries.map(([name, rawDefinition]) => {
      const definition = responseSchemaRecord(rawDefinition);
      return <div key={name}><b>{name}</b><span>{responseFieldKind(definition).replace("integer", "whole number")} · always included</span>{Boolean(definition.description) && <small>{String(definition.description)}</small>}</div>;
    })}
    {!entries.length && <p>No answer fields are defined.</p>}
    <details className="automation-schema-technical">
      <summary><Code2 size={13} /><span><b>Technical JSON</b><small>Exact portable answer contract</small></span><Plus size={12} /></summary>
      <pre>{JSON.stringify(value ?? {}, null, 2)}</pre>
    </details>
  </div>;
}

function readableFieldValue(value: unknown, options: Array<{ value: string; label: string }>) {
  const option = options.find((candidate) => candidate.value === String(value));
  if (option) return option.label;
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  if (value === undefined || value === null || value === "") return "Not set";
  if (Array.isArray(value)) return value.length ? `${value.length} configured item${value.length === 1 ? "" : "s"}` : "No items";
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length ? "Configured data" : "Empty data";
  return String(value);
}

function fullFieldValue(value: unknown, options: Array<{ value: string; label: string }>) {
  const option = options.find((candidate) => candidate.value === String(value));
  if (option) return option.label;
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  if (value === undefined || value === null || value === "") return "Not set";
  if (typeof value === "object") {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value); }
  }
  return String(value);
}

function simpleFieldValue(value: unknown) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseSimpleFieldValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(trimmed);
  return value;
}

function SimpleValueEditor({ value, disabled, placeholder, onChange }: { value: unknown; disabled: boolean; placeholder?: string; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(() => simpleFieldValue(value));
  return <input
    disabled={disabled}
    type="text"
    value={text}
    placeholder={placeholder}
    onChange={(event) => setText(event.target.value)}
    onBlur={() => onChange(parseSimpleFieldValue(text))}
  />;
}

function CreativeControlsEditor({ value, disabled, onChange }: { value: unknown; disabled: boolean; onChange: (value: AutomationCreativeControl[]) => void }) {
  const controls = automationCreativeControls(value);
  const updateControl = (index: number, next: AutomationCreativeControl) => onChange(controls.map((control, current) => current === index ? next : control));
  return <section className="automation-creative-controls">
    <header><span><b>Choices the comment may affect</b><small>Each group maps model-visible option names to one real setting path and stored value.</small></span><em>{controls.length} choices</em></header>
    <div>{controls.map((control, controlIndex) => <article key={control.id}>
      <header><i>{controlIndex + 1}</i><label><span>Choice label</span><input disabled={disabled} value={control.label} onChange={(event) => updateControl(controlIndex, { ...control, label: event.target.value })} /></label>{!disabled && <button type="button" disabled={controls.length <= 1} aria-label={`Remove ${control.label}`} onClick={() => onChange(controls.filter((_, current) => current !== controlIndex))}><Trash2 size={12} /></button>}</header>
      <div className="automation-creative-control-address">
        <label><span>Stable id</span><input disabled={disabled} value={control.id} onChange={(event) => updateControl(controlIndex, { ...control, id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") })} /></label>
        <label><span>Setting path</span><input disabled={disabled} value={control.path} onChange={(event) => updateControl(controlIndex, { ...control, path: event.target.value.replace(/[^a-zA-Z0-9_.-]/g, "") })} /></label>
      </div>
      <div className="automation-creative-control-options">{control.options.map((option, optionIndex) => <div key={`${control.id}:${option.id}`}>
        <i>{optionIndex + 1}</i>
        <label><span>Option</span><input disabled={disabled} value={option.label} onChange={(event) => updateControl(controlIndex, { ...control, options: control.options.map((candidate, current) => current === optionIndex ? { ...candidate, label: event.target.value } : candidate) })} /></label>
        <label><span>Option id</span><input disabled={disabled} value={option.id} onChange={(event) => updateControl(controlIndex, { ...control, options: control.options.map((candidate, current) => current === optionIndex ? { ...candidate, id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") } : candidate) })} /></label>
        <label><span>Stored value</span><SimpleValueEditor disabled={disabled} value={option.value} onChange={(storedValue) => updateControl(controlIndex, { ...control, options: control.options.map((candidate, current) => current === optionIndex ? { ...candidate, value: storedValue as string | number | boolean | null } : candidate) })} /></label>
        {!disabled && <button type="button" disabled={control.options.length <= 2} aria-label={`Remove ${option.label}`} onClick={() => updateControl(controlIndex, { ...control, options: control.options.filter((_, current) => current !== optionIndex) })}><Trash2 size={11} /></button>}
        <label className="automation-creative-option-meaning"><span>Meaning for AI</span><textarea disabled={disabled} value={option.meaning} placeholder="Explain the complete intent that should select this option. The model understands context, language and negation." onChange={(event) => updateControl(controlIndex, { ...control, options: control.options.map((candidate, current) => current === optionIndex ? { ...candidate, meaning: event.target.value } : candidate) })} /></label>
      </div>)}</div>
      {!disabled && <button type="button" className="automation-creative-control-add" disabled={control.options.length >= 12} onClick={() => updateControl(controlIndex, { ...control, options: [...control.options, { id: `option-${control.options.length + 1}`, label: `Option ${control.options.length + 1}`, value: `option-${control.options.length + 1}`, meaning: "Describe when the AI should select this option." }] })}><Plus size={12} /> Add option</button>}
    </article>)}</div>
    {!disabled && <button type="button" className="automation-creative-control-add" disabled={controls.length >= 24} onClick={() => {
      const suffix = globalThis.crypto.randomUUID().slice(0, 8);
      onChange([...controls, { id: `choice-${suffix}`, label: "New choice", path: `custom.${suffix}`, options: [{ id: "first", label: "First option", value: "first", meaning: "Describe the intent that selects the first option." }, { id: "second", label: "Second option", value: "second", meaning: "Describe the intent that selects the second option." }] }]);
    }}><Plus size={13} /> Add controllable choice</button>}
    <small>The resolver accepts only these exact IDs and values. Unknown or contradictory requests stop instead of guessing.</small>
  </section>;
}

function FieldEditor({ field, node, disabled, options, referencePicker, onConfig, onBinding, onRequired }: {
  field: AutomationNodeFieldDefinition;
  node: AutomationNode;
  disabled: boolean;
  options: Array<{ value: string; label: string }>;
  referencePicker?: ReactNode;
  onConfig: (value: unknown) => void;
  onBinding: (askOnRun: boolean) => void;
  onRequired: (required: boolean) => void;
}) {
  const value = node.bindings[field.id]?.mode === "fixed" && node.bindings[field.id]?.value !== undefined
    ? node.bindings[field.id].value
    : node.config[field.id] ?? field.defaultValue ?? "";
  const askOnRun = node.bindings[field.id]?.mode === "ask-on-run";
  const required = Boolean(field.required || node.bindings[field.id]?.required);
  const readableValue = readableFieldValue(value, options);
  const fullValue = fullFieldValue(value, options);
  const showFullValue = fullValue !== "Not set" && (
    field.kind === "prompt"
    || field.kind === "textarea"
    || field.kind === "json"
    || field.kind === "schema"
    || fullValue.includes("\n")
    || fullValue.length > 72
  );
  if (disabled && field.kind === "schema") return <div className="automation-setting-summary">
    <span><b>{field.label}</b></span>
    <ResponseSchemaSummary value={value} />
    {field.description && <small>{field.description}</small>}
  </div>;
  if (disabled && field.kind === "references") {
    const references = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    return <div className="automation-setting-summary">
      <span><b>{field.label}</b>{askOnRun && <i>Before each run</i>}</span>
      <strong>{askOnRun ? "Chosen when the automation starts" : references.length ? `${references.length} selected` : "No references selected"}</strong>
      <small>{askOnRun ? (required ? "At least one image is required" : "The run can continue without reference images") : field.description}</small>
    </div>;
  }
  if (disabled) return <div className="automation-setting-summary">
    <span><b>{field.label}</b>{askOnRun && <i>Before each run</i>}</span>
    {showFullValue ? <div className={`automation-setting-value is-${field.kind}`}>
      <small>{field.kind === "prompt" ? "FULL PROMPT" : field.kind === "json" || field.kind === "schema" ? readableValue.toUpperCase() : "FULL VALUE"}</small>
      <pre>{fullValue}</pre>
    </div> : <strong>{readableValue}</strong>}
    {askOnRun && <small>{required ? "Required before the workflow starts" : "Optional when the workflow starts"}</small>}
    {!askOnRun && field.description && <small>{field.description}</small>}
  </div>;
  return <label className={`automation-inspector-field is-${field.kind}`}>
    <span><b>{field.label}</b>{field.runtimeBindable && <button type="button" disabled={disabled} className={askOnRun ? "is-on" : ""} aria-pressed={askOnRun} title={askOnRun ? "This value is chosen before every run" : "Move this setting to the Automation run panel"} onClick={() => onBinding(!askOnRun)}>{askOnRun ? "Asked on run" : "Ask on run"}</button>}</span>
    {askOnRun && <small className="automation-runtime-help">Shown in the Automation panel before every run.</small>}
    {askOnRun && <button type="button" className={`automation-runtime-required ${required ? "is-on" : ""}`} disabled={disabled || field.required} onClick={() => onRequired(!required)}><i /> {field.required ? "Required by this step" : "Required before run"}</button>}
    {field.description && <small>{field.description}</small>}
    {field.kind === "references" ? referencePicker
      : field.kind === "boolean" ? <button type="button" className={`automation-boolean ${value ? "is-on" : ""}`} disabled={disabled || askOnRun} onClick={() => onConfig(!value)}><i />{value ? "Enabled" : "Disabled"}</button>
      : field.kind === "model" && options.length ? <InspectorSelect label={field.label} disabled={disabled || askOnRun} value={String(value)} options={options} onChange={onConfig} />
      : field.kind === "select" && options.length ? <InspectorSelect label={field.label} disabled={disabled || askOnRun} value={String(value)} options={options} onChange={onConfig} />
        : field.kind === "json" ? <JsonEditor key={JSON.stringify(value ?? {})} disabled={disabled || askOnRun} value={value} onChange={onConfig} />
          : field.kind === "schema" ? <ResponseSchemaEditor disabled={disabled || askOnRun} value={value} onChange={onConfig} />
          : field.kind === "value" ? <SimpleValueEditor disabled={disabled || askOnRun} value={value} placeholder={field.placeholder} onChange={onConfig} />
          : field.kind === "textarea" || field.kind === "prompt" ? <textarea disabled={disabled || askOnRun} value={String(value)} placeholder={field.placeholder} spellCheck={field.kind !== "prompt"} onChange={(event) => onConfig(event.target.value)} />
            : <input disabled={disabled || askOnRun} type={field.kind === "number" ? "number" : "text"} min={field.min} max={field.max} value={String(value)} placeholder={field.placeholder} onChange={(event) => onConfig(field.kind === "number" ? Number(event.target.value) : event.target.value)} />}
  </label>;
}

function MergeInputsEditor({ node, graph, disabled, onChange }: {
  node: AutomationNode;
  graph: AutomationWorkflowGraph;
  disabled: boolean;
  onChange: (inputs: AutomationMergeInput[]) => void;
}) {
  const inputs = automationMergeInputs(node);
  const connectedByPort = new Map(graph.edges.filter((edge) => edge.target === node.id).map((edge) => [edge.targetPort, graph.nodes.find((candidate) => candidate.id === edge.source)?.name || "Connected step"]));
  const updateAt = (index: number, next: AutomationMergeInput) => onChange(inputs.map((input, current) => current === index ? next : input));
  const move = (index: number, offset: -1 | 1) => {
    const next = inputs.map((input) => ({ ...input }));
    const target = index + offset;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return <section className="automation-merge-inputs">
    <header><span><b>Inputs to wait for</b><small>Each row creates one socket on the left side of this card.</small></span><em>{inputs.length} inputs</em></header>
    <div>{inputs.map((input, index) => {
      const connectedSource = connectedByPort.get(input.id);
      return <article key={input.id}>
        <i>{index + 1}</i>
        <label><span>Input name</span><input
          disabled={disabled}
          aria-label={`Merge input ${index + 1} name`}
          value={input.name}
          onChange={(event) => updateAt(index, { ...input, name: event.target.value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^[^a-zA-Z_]+/, "") })}
        /></label>
        <span className={connectedSource ? "is-connected" : ""}>{connectedSource ? `Connected: ${connectedSource}` : "Not connected"}</span>
        {!disabled && <nav>
          <button type="button" disabled={index === 0} aria-label={`Move ${input.name} up`} onClick={() => move(index, -1)}><ArrowUp size={12} /></button>
          <button type="button" disabled={index === inputs.length - 1} aria-label={`Move ${input.name} down`} onClick={() => move(index, 1)}><ArrowDown size={12} /></button>
          <button type="button" disabled={inputs.length <= 2 || Boolean(connectedSource)} aria-label={`Remove ${input.name}`} title={connectedSource ? "Disconnect this input before removing it" : inputs.length <= 2 ? "A merge needs at least two inputs" : "Remove input"} onClick={() => onChange(inputs.filter((_, current) => current !== index))}><Trash2 size={12} /></button>
        </nav>}
      </article>;
    })}</div>
    {!disabled && <button type="button" className="automation-merge-add" disabled={inputs.length >= 24} onClick={() => {
      const used = new Set(inputs.map((input) => input.name));
      let index = inputs.length + 1;
      let name = `input_${index}`;
      while (used.has(name)) name = `input_${++index}`;
      onChange([...inputs, { id: `input-${globalThis.crypto.randomUUID().slice(0, 12)}`, name }]);
    }}><Plus size={13} /> Add input</button>}
    <small className="automation-merge-help">The merge waits for every named socket. In Named object mode, these names become the fields the next step receives.</small>
  </section>;
}

export function AutomationWorkflowEditorOverlay({ workspaceId, projectId, workflowId, sources, personas, models, canvasReferences, execution = null, runtimeValues = {}, onRuntimeValueChange, onClose, onWorkflowChanged }: {
  workspaceId: string;
  projectId: string;
  workflowId: string;
  sources: TikTokSlideshowSource[];
  personas: PersonaRecord[];
  models: GeneratorModelOption[];
  canvasReferences: AutomationReferenceCandidate[];
  execution?: AutomationWorkflowExecutionState | null;
  runtimeValues?: Record<string, unknown>;
  onRuntimeValueChange?: (workflowId: string, key: string, value: unknown) => void;
  onClose: () => void;
  onWorkflowChanged?: (workflowId: string) => void;
}) {
  const [detail, setDetail] = useState<AutomationWorkflowClientDetail | null>(null);
  const [graph, setGraph] = useState<AutomationWorkflowGraph | null>(null);
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [previewDefinitionKey, setPreviewDefinitionKey] = useState<string | null>(null);
  const [inspectorView, setInspectorView] = useState<"guide" | "settings" | "execution">("settings");
  const [executionResult, setExecutionResult] = useState<{ key: string; attempts: AutomationNodeExecutionAttempt[] }>({ key: "", attempts: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editRevision, setEditRevision] = useState(0);
  const [savedRevision, setSavedRevision] = useState(0);
  const [availableWorkflows, setAvailableWorkflows] = useState<AutomationWorkflowRecord[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);
  const [validation, setValidation] = useState<AutomationValidationResult | null>(null);
  const [bindingOptions, setBindingOptions] = useState<{ credentials: CredentialOption[]; workflows: WorkflowBindingOption[]; bindings: WorkflowBinding[] }>({ credentials: [], workflows: [], bindings: [] });
  const [newCredentialName, setNewCredentialName] = useState("");
  const [newCredentialValue, setNewCredentialValue] = useState("");
  const [newCredentialUsername, setNewCredentialUsername] = useState("");
  const [newCredentialHeaderName, setNewCredentialHeaderName] = useState("");
  const manageMenuRef = useRef<HTMLDivElement>(null);
  const flowStageRef = useRef<HTMLElement>(null);
  const dirty = editRevision !== savedRevision;

  const capabilities = detail?.capabilities || { run: false, edit: false, publish: false, manageTriggers: false, manageCredentials: false };
  const systemReadOnly = detail?.workflow.status === "system";
  const readOnly = systemReadOnly || !capabilities.edit;
  const workflowSwitchOptions = useMemo(() => availableWorkflows.map((workflow) => ({
    value: workflow.id,
    label: workflow.name,
    ...workflowSwitcherPresentation(workflow),
  })), [availableWorkflows]);
  useEffect(() => {
    const playingVideos = Array.from(document.querySelectorAll<HTMLVideoElement>(".canvas-stage video")).filter((video) => !video.paused);
    playingVideos.forEach((video) => video.pause());
    return () => {
      playingVideos.forEach((video) => { void video.play().catch(() => undefined); });
    };
  }, []);
  useEffect(() => {
    const setSpacePanning = (active: boolean) => flowStageRef.current?.classList.toggle("is-space-panning", active);
    const keyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, button, [contenteditable='true']")) return;
      setSpacePanning(true);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpacePanning(false);
    };
    const stopSpacePanning = () => setSpacePanning(false);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", stopSpacePanning);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", stopSpacePanning);
      stopSpacePanning();
    };
  }, []);
  useEffect(() => {
    if (!manageOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof globalThis.Node && !manageMenuRef.current?.contains(event.target)) setManageOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [manageOpen]);
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/automation-workflows?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { workflows?: AutomationWorkflowRecord[]; error?: string };
        if (!response.ok) throw new Error(body.error || "Could not load workflows");
        return body.workflows || [];
      })
      .then((workflows) => { if (!cancelled) setAvailableWorkflows(workflows); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, workflowId]);
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/automation-workflows/${encodeURIComponent(workflowId)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as AutomationWorkflowClientDetail & { error?: string };
        if (!response.ok) throw new Error(body.error || "Could not open the workflow");
        const version = body.draft || body.published;
        if (!version) throw new Error("This workflow has no editable version");
        return { body, version };
      })
      .then(({ body, version }) => {
        if (cancelled) return;
        const loadedGraph = structuredClone(version.graph);
        setDetail(body);
        setAvailableWorkflows((current) => current.some((workflow) => workflow.id === body.workflow.id)
          ? current.map((workflow) => workflow.id === body.workflow.id ? body.workflow : workflow)
          : [...current, body.workflow]);
        setGraph(loadedGraph);
        setName(body.workflow.name);
        setValidation(version.validation);
        setEditRevision(0);
        setSavedRevision(0);
        setLoading(false);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Could not open the workflow");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [workflowId]);

  const refreshBindings = useCallback(async () => {
    if (!detail || !detail.capabilities.edit) { setBindingOptions({ credentials: [], workflows: [], bindings: [] }); return; }
    const [credentialResponse, workflowResponse, bindingResponse] = await Promise.all([
      detail.capabilities.manageCredentials ? fetch(`/api/automation-credentials?workspaceId=${encodeURIComponent(detail.workflow.workspaceId)}`, { cache: "no-store" }) : null,
      fetch(`/api/automation-workflows?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" }),
      fetch(`/api/automation-workflows/${encodeURIComponent(detail.workflow.id)}/bindings`, { cache: "no-store" }),
    ]);
    const credentialsBody = credentialResponse ? await credentialResponse.json() as { credentials?: CredentialOption[] } : { credentials: [] };
    const workflowsBody = await workflowResponse.json() as { workflows?: WorkflowBindingOption[] };
    const bindingsBody = await bindingResponse.json() as { bindings?: WorkflowBinding[] };
    setBindingOptions({ credentials: credentialsBody.credentials || [], workflows: workflowsBody.workflows || [], bindings: bindingsBody.bindings || [] });
  }, [detail, projectId]);

  useEffect(() => { const timer = window.setTimeout(() => void refreshBindings(), 0); return () => window.clearTimeout(timer); }, [refreshBindings]);

  const markDirty = useCallback(() => {
    setEditRevision((current) => current + 1);
  }, []);
  const mutateGraph = useCallback((mutator: (current: AutomationWorkflowGraph) => AutomationWorkflowGraph) => {
    if (readOnly) return;
    setGraph((current) => current ? mutator(structuredClone(current)) : current);
    markDirty();
  }, [markDirty, readOnly]);

  const updateFixedNodeReferences = useCallback((nodeId: string, assetIds: string[]) => {
    mutateGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const binding = node.bindings.references;
        return {
          ...node,
          config: { ...node.config, references: assetIds },
          bindings: binding?.mode === "fixed"
            ? { ...node.bindings, references: { ...binding, value: assetIds } }
            : { ...node.bindings },
        };
      }),
    }));
  }, [mutateGraph]);

  const focusedNodeId = selectedId && graph?.nodes.some((node) => node.id === selectedId) ? selectedId : null;
  const visibleExecution = execution?.workflowId === workflowId ? execution : null;
  const display = useMemo(() => graph ? displayGraph(graph, Boolean(readOnly), focusedNodeId, visibleExecution, runtimeValues, {
    workspaceId,
    projectId,
    canvasReferences,
    personas,
    canRun: capabilities.run,
    onRuntimeValueChange: onRuntimeValueChange ? (key, value) => onRuntimeValueChange(workflowId, key, value) : undefined,
    onFixedReferencesChange: updateFixedNodeReferences,
  }) : { nodes: [], edges: [] }, [canvasReferences, capabilities.run, focusedNodeId, graph, onRuntimeValueChange, personas, projectId, readOnly, runtimeValues, updateFixedNodeReferences, visibleExecution, workflowId, workspaceId]);
  const automationLayoutKey = useMemo(() => graph ? JSON.stringify({
    nodes: graph.nodes.map((node) => [node.id, node.position.x, node.position.y]),
    annotations: (graph.annotations || []).map((annotation) => [annotation.id, annotation.position.x, annotation.position.y, annotation.size.width, annotation.size.height]),
  }) : "empty", [graph]);
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<Node<AutomationFlowData>>([]);
  const flowInstanceRef = useRef<Pick<ReactFlowInstance<Node<AutomationFlowData>>, "fitView"> | null>(null);
  const appliedLayoutKeyRef = useRef("");
  useEffect(() => {
    const layoutChanged = appliedLayoutKeyRef.current !== automationLayoutKey;
    appliedLayoutKeyRef.current = automationLayoutKey;
    setFlowNodes((current) => {
      if (layoutChanged || current.length === 0) return display.nodes;
      const currentById = new Map(current.map((node) => [node.id, node]));
      return display.nodes.map((node) => {
        const existing = currentById.get(node.id);
        return existing ? { ...node, position: existing.position, measured: existing.measured } : node;
      });
    });
  }, [automationLayoutKey, display.nodes, setFlowNodes]);
  const selectedNode = graph?.nodes.find((node) => node.id === selectedId) || null;
  const selectedEdge = graph?.edges.find((edge) => `edge:${edge.id}` === selectedId) || null;
  const selectedAnnotation = graph?.annotations?.find((annotation) => `annotation:${annotation.id}` === selectedId) || null;
  const selectedEdgeContract = graph && selectedEdge ? connectedStep(graph, selectedEdge) : null;
  const selectedEdgeRole = selectedEdge?.role || (selectedEdgeContract?.dataType === "error" ? "error" : "flow");
  const selectedEdgeRoleOptions = selectedEdge?.role === "retry"
    ? [{ value: "retry", label: "Bounded retry route" }]
    : selectedEdgeContract?.dataType === "error"
      ? [{ value: "error", label: "Error recovery route" }]
      : [{ value: "flow", label: "Main execution route" }, { value: "data", label: "Supporting data" }];
  const selectedDefinition = selectedNode ? automationNodeDefinition(selectedNode.type, selectedNode.version) : null;
  const selectedHasEditableSystemModel = Boolean(systemReadOnly && capabilities.edit && selectedDefinition?.fields.some((field) => (
    field.id === "modelId"
    && field.kind === "model"
    && (field.modelCapability === "assistant" || field.modelCapability === "image")
  )));
  const previewDefinition = previewDefinitionKey ? automationNodeDefinitions().find((definition) => `${definition.type}@${definition.version}` === previewDefinitionKey) || null : null;
  const executionDetailKey = selectedNode && execution?.runId && execution.workflowId === workflowId ? `${execution.runId}:${selectedNode.id}` : "";
  useEffect(() => {
    if (!selectedNode || !execution?.runId || !executionDetailKey) return;
    let cancelled = false;
    void fetch(`/api/automation-runs/${encodeURIComponent(execution.runId)}/nodes/${encodeURIComponent(selectedNode.id)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { attempts?: AutomationNodeExecutionAttempt[]; error?: string };
        if (!response.ok) throw new Error(body.error || "Could not load step execution");
        return body.attempts || [];
      })
      .then((attempts) => { if (!cancelled) setExecutionResult({ key: executionDetailKey, attempts }); })
      .catch(() => { if (!cancelled) setExecutionResult({ key: executionDetailKey, attempts: [] }); });
    return () => { cancelled = true; };
  }, [execution?.nodeRuns, execution?.runId, execution?.status, executionDetailKey, selectedNode]);
  function selectedFieldOptions(field: AutomationNodeFieldDefinition) {
    if (!selectedNode) return field.options || [];
    if (field.runtimeValueType === "tiktok-source") return sources.map((source) => ({ value: source.id, label: source.label }));
    if (field.runtimeValueType === "identity") return [{ value: "", label: "No identity" }, ...personas.map((persona) => ({ value: persona.id, label: persona.name }))];
    if (field.runtimeValueType === "assistant-model") return assistantModels.map((model) => ({ value: model.id, label: model.label }));
    if (field.modelCapability === "assistant") return [
      ...(!field.required ? [{ value: "", label: "No backup model" }] : []),
      ...assistantModels.map((model) => ({ value: model.id, label: model.label })),
    ];
    if (field.runtimeValueType === "image-model" || field.modelCapability === "image") return models.filter((model) => {
      if (model.mediaType !== "image") return false;
      if (!systemReadOnly) return true;
      if (model.maxReferences < 1) return false;
      const resolution = String(selectedNode.config.resolution || "");
      const ratio = String(selectedNode.config.ratio || "");
      return generatorResolutionsFor(model, false).includes(resolution)
        && generatorRatiosFor(model, resolution, true).includes(ratio);
    }).map((model) => ({ value: model.id, label: model.label }));
    const boundValue = (fieldId: string) => selectedNode.bindings[fieldId]?.mode === "fixed" && selectedNode.bindings[fieldId]?.value !== undefined
      ? selectedNode.bindings[fieldId].value
      : selectedNode.config[fieldId];
    const selectedModel = models.find((candidate) => candidate.id === String(boundValue("modelId") || ""));
    if (field.runtimeValueType === "resolution") return generatorResolutionsFor(selectedModel, false).map((value) => ({ value, label: value }));
    if (field.runtimeValueType === "aspect-ratio") return generatorRatiosFor(selectedModel, String(boundValue("resolution") || ""), true).map((value) => ({ value, label: value }));
    return field.options || [];
  }

  const arrangeCurrentView = useCallback(() => {
    setGraph((current) => current ? arrangeWorkflowView(current) : current);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      void flowInstanceRef.current?.fitView({
        nodes: flowNodes.filter((node) => node.data.kind === "step").slice(0, 8),
        padding: 0.2,
        minZoom: 0.42,
        maxZoom: 0.84,
        duration: 280,
      });
    }));
    if (!readOnly) markDirty();
  }, [flowNodes, markDirty, readOnly]);

  const moveFlowNode = useCallback((flowNode: Node<AutomationFlowData>) => {
    setGraph((current) => {
      if (!current) return current;
      if (flowNode.id.startsWith("annotation:")) {
        const annotationId = flowNode.id.slice("annotation:".length);
        return { ...current, annotations: (current.annotations || []).map((annotation) => annotation.id === annotationId ? { ...annotation, position: flowNode.position } : annotation) };
      }
      return { ...current, nodes: current.nodes.map((node) => node.id === flowNode.id ? { ...node, position: flowNode.position } : node) };
    });
    if (!readOnly) markDirty();
  }, [markDirty, readOnly]);

  const magnetizeFlowNode = useCallback((flowNode: Node<AutomationFlowData>) => {
    setFlowNodes((current) => {
      const position = magneticNodePosition(flowNode, current);
      return current.map((node) => node.id === flowNode.id ? { ...node, position } : node);
    });
  }, [setFlowNodes]);

  const finishFlowNodeDrag = useCallback((flowNode: Node<AutomationFlowData>) => {
    const snappedNode = { ...flowNode, position: magneticNodePosition(flowNode, flowNodes) };
    setFlowNodes((current) => current.map((node) => node.id === snappedNode.id ? snappedNode : node));
    moveFlowNode(snappedNode);
  }, [flowNodes, moveFlowNode, setFlowNodes]);

  const onConnect = useCallback((connection: Connection) => {
    if (!graph || readOnly || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const sourceNode = graph.nodes.find((node) => node.id === connection.source);
    const sourceDefinition = sourceNode ? automationNodeDefinition(sourceNode.type, sourceNode.version) : null;
    const sourcePort = sourceDefinition?.outputs.find((port) => port.id === connection.sourceHandle);
    const targetNode = graph.nodes.find((node) => node.id === connection.target);
    const retryTarget = targetNode?.type === "logic.retry-gate" && connection.targetHandle === "feedback";
    const alreadyHasMainRoute = graph.edges.some((edge) => edge.target === connection.target && edge.role === "flow");
    const role: AutomationEdgeRole = retryTarget ? "retry" : sourcePort?.type === "error" ? "error" : alreadyHasMainRoute ? "data" : "flow";
    const candidate = {
      id: crypto.randomUUID(),
      source: connection.source,
      sourcePort: connection.sourceHandle,
      target: connection.target,
      targetPort: connection.targetHandle,
      role,
    };
    const connectionValidation = validateAutomationConnection(graph, candidate);
    if (!connectionValidation.valid) {
      setError(connectionValidation.issues[0]?.message || "Those steps cannot be connected");
      return;
    }
    setError("");
    mutateGraph((current) => ({ ...current, edges: [...current.edges, candidate] }));
  }, [graph, mutateGraph, readOnly]);

  const addNode = useCallback((type: string, version: number) => {
    const definition = automationNodeDefinition(type, version);
    if (!definition || readOnly) return;
    const id = `${type.replace(/[^a-z0-9]+/gi, "-")}-${crypto.randomUUID().slice(0, 8)}`;
    const existing = graph?.nodes.length || 0;
    const newNode: AutomationNode = {
      id, type, version, name: definition.title, description: definition.description,
      position: { x: 180 + (existing % 5) * 300, y: 160 + (existing % 3) * 190 }, groupId: null,
      config: Object.fromEntries(definition.fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.id, field.defaultValue])),
      bindings: {}, disabled: false,
    };
    mutateGraph((current) => ({
      ...current,
      nodes: [...current.nodes, newNode],
    }));
    setSelectedId(id);
    setInspectorView("guide");
    setMobileInspectorOpen(true);
  }, [graph?.nodes.length, mutateGraph, readOnly]);

  function removeSelectedNode() {
    if (!selectedNode || readOnly) return;
    mutateGraph((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== selectedNode.id),
      edges: current.edges.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id),
      groups: current.groups.map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => id !== selectedNode.id) })).filter((group) => group.nodeIds.length),
    }));
    setSelectedId(null);
  }

  function removeSelectedEdge() {
    if (!selectedEdge || readOnly) return;
    mutateGraph((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== selectedEdge.id) }));
    setSelectedId(null);
  }

  function updateSelectedFieldConfig(field: AutomationNodeFieldDefinition, value: unknown) {
    if (!selectedNode) return;
    mutateGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) => {
        if (node.id !== selectedNode.id) return node;
        const binding = node.bindings[field.id];
        const nextNode = {
          ...node,
          config: { ...node.config, [field.id]: value },
          bindings: binding?.mode === "fixed" ? { ...node.bindings, [field.id]: { ...binding, value } } : { ...node.bindings },
        };
        const definition = automationNodeDefinition(node.type, node.version);
        const modelField = definition?.fields.find((candidate) => candidate.runtimeValueType === "image-model");
        const resolutionField = definition?.fields.find((candidate) => candidate.runtimeValueType === "resolution");
        const ratioField = definition?.fields.find((candidate) => candidate.runtimeValueType === "aspect-ratio");
        if (!modelField || (!resolutionField && !ratioField)) return nextNode;
        const effective = (fieldId: string) => nextNode.bindings[fieldId]?.mode === "fixed" && nextNode.bindings[fieldId]?.value !== undefined
          ? nextNode.bindings[fieldId].value
          : nextNode.config[fieldId];
        const model = models.find((candidate) => candidate.id === String(effective(modelField.id) || ""));
        const resolutions = generatorResolutionsFor(model, false);
        if (resolutionField && !resolutions.includes(String(effective(resolutionField.id) || ""))) {
          const nextResolution = model?.defaultResolution || resolutions[0] || "";
          nextNode.config[resolutionField.id] = nextResolution;
          if (nextNode.bindings[resolutionField.id]?.mode === "fixed") nextNode.bindings[resolutionField.id] = { ...nextNode.bindings[resolutionField.id], value: nextResolution };
        }
        const ratios = generatorRatiosFor(model, resolutionField ? String(nextNode.config[resolutionField.id] || effective(resolutionField.id) || "") : undefined, true);
        if (ratioField && !ratios.includes(String(effective(ratioField.id) || ""))) {
          const nextRatio = model?.defaultRatio && ratios.includes(model.defaultRatio) ? model.defaultRatio : ratios[0] || "";
          nextNode.config[ratioField.id] = nextRatio;
          if (nextNode.bindings[ratioField.id]?.mode === "fixed") nextNode.bindings[ratioField.id] = { ...nextNode.bindings[ratioField.id], value: nextRatio };
        }
        return nextNode;
      }),
    }));
  }

  function updateSelectedFieldBinding(field: AutomationNodeFieldDefinition, askOnRun: boolean) {
    if (!selectedNode) return;
    mutateGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) => {
        if (node.id !== selectedNode.id) return node;
        const currentBinding = node.bindings[field.id];
        const fixedValue = currentBinding?.value ?? node.config[field.id] ?? field.defaultValue;
        if (askOnRun) return {
          ...node,
          bindings: { ...node.bindings, [field.id]: { mode: "ask-on-run", value: fixedValue, label: field.label, required: Boolean(field.required || currentBinding?.required) } },
        };
        const bindings = { ...node.bindings };
        delete bindings[field.id];
        return { ...node, config: { ...node.config, [field.id]: fixedValue }, bindings };
      }),
    }));
  }

  function updateSelectedFieldRequired(field: AutomationNodeFieldDefinition, required: boolean) {
    if (!selectedNode) return;
    mutateGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === selectedNode.id ? {
      ...node,
      bindings: { ...node.bindings, [field.id]: { ...(node.bindings[field.id] || { mode: "ask-on-run", label: field.label }), required } },
    } : node) }));
  }

  async function saveDeploymentBinding(type: "credential" | "subworkflow", slotKey: string, targetId: string) {
    if (!detail || !slotKey) return;
    setSaving(true); setError("");
    try {
      const response = await fetch(targetId
        ? `/api/automation-workflows/${encodeURIComponent(detail.workflow.id)}/bindings`
        : `/api/automation-workflows/${encodeURIComponent(detail.workflow.id)}/bindings?slotKey=${encodeURIComponent(slotKey)}`, {
        method: targetId ? "POST" : "DELETE", headers: { "content-type": "application/json" },
        ...(targetId ? { body: JSON.stringify(type === "credential" ? { type, slotKey, credentialId: targetId } : { type, slotKey, targetWorkflowId: targetId }) } : {}),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not connect this deployment slot");
      await refreshBindings();
    } catch (bindingError) { setError(bindingError instanceof Error ? bindingError.message : "Could not connect this deployment slot"); }
    finally { setSaving(false); }
  }

  async function createAndBindCredential(slotKey: string, kind: string) {
    if (!detail || !newCredentialName.trim() || !newCredentialValue || (kind === "basic" && !newCredentialUsername) || (kind === "header" && !newCredentialHeaderName)) return;
    setSaving(true); setError("");
    try {
      const payload = kind === "bearer" ? { token: newCredentialValue }
        : kind === "api-key" ? { apiKey: newCredentialValue }
          : kind === "basic" ? { username: newCredentialUsername, password: newCredentialValue }
            : { headerName: newCredentialHeaderName, value: newCredentialValue };
      const response = await fetch("/api/automation-credentials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: detail.workflow.workspaceId, name: newCredentialName, kind, payload }) });
      const body = await response.json() as { credential?: CredentialOption; error?: string };
      if (!response.ok || !body.credential) throw new Error(body.error || "Could not save the credential");
      await saveDeploymentBinding("credential", slotKey, body.credential.id);
      setNewCredentialName(""); setNewCredentialValue(""); setNewCredentialUsername(""); setNewCredentialHeaderName("");
    } catch (credentialError) { setError(credentialError instanceof Error ? credentialError.message : "Could not save the credential"); }
    finally { setSaving(false); }
  }

  const saveDraft = useCallback(async () => {
    if (!graph || readOnly) return detail;
    const revisionToSave = editRevision;
    setSaving(true);
    setError("");
    try {
      const nextValidation = validateAutomationWorkflowGraph(graph);
      const response = await fetch(`/api/automation-workflows/${encodeURIComponent(detail!.workflow.id)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, graph, baseDraftVersionId: detail!.workflow.draftVersionId }),
      });
      const body = await response.json() as AutomationWorkflowDetail & { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not save the workflow");
      setDetail({ ...body, capabilities: detail!.capabilities });
      setValidation(nextValidation);
      setSavedRevision((current) => Math.max(current, revisionToSave));
      onWorkflowChanged?.(body.workflow.id);
      return body;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the workflow");
      return null;
    } finally {
      setSaving(false);
    }
  }, [detail, editRevision, graph, name, onWorkflowChanged, readOnly]);

  useEffect(() => {
    if (!dirty || saving || readOnly || !detail || !graph) return;
    const timer = window.setTimeout(() => void saveDraft(), 850);
    return () => window.clearTimeout(timer);
  }, [detail, dirty, graph, name, readOnly, saveDraft, saving]);

  async function saveSystemModel(nodeId: string, modelId: string | null) {
    if (!detail || !systemReadOnly || !capabilities.edit) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/automation-workflows/${encodeURIComponent(detail.workflow.id)}/system-model`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId, modelId }),
      });
      const body = await response.json() as AutomationWorkflowDetail & { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not save the model");
      const nextVersion = body.published;
      if (!nextVersion) throw new Error("The system workflow has no live version");
      setDetail({ ...body, capabilities: detail.capabilities, systemModelDefaults: detail.systemModelDefaults });
      setGraph(structuredClone(nextVersion.graph));
      setValidation(nextVersion.validation);
      onWorkflowChanged?.(body.workflow.id);
    } catch (modelError) {
      setError(modelError instanceof Error ? modelError.message : "Could not save the model");
    } finally {
      setSaving(false);
    }
  }

  async function takeLive() {
    const saved = dirty ? await saveDraft() : detail;
    if (!saved) return;
    const currentGraph = graph!;
    const nextValidation = validateAutomationWorkflowGraph(currentGraph);
    setValidation(nextValidation);
    if (!nextValidation.valid) {
      setError(nextValidation.issues.slice(0, 4).map((entry) => entry.message).join(" · "));
      const firstNodeId = nextValidation.issues.find((entry) => entry.nodeId)?.nodeId;
      if (firstNodeId) setSelectedId(firstNodeId);
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/automation-workflows/${encodeURIComponent(saved.workflow.id)}/publish`, { method: "POST" });
      const body = await response.json() as AutomationWorkflowDetail & { error?: string; validation?: AutomationValidationResult };
      if (!response.ok) throw new Error(body.error || "Could not take the workflow live");
      setDetail({ ...body, capabilities: detail!.capabilities });
      setGraph(structuredClone((body.draft || body.published)!.graph));
      setValidation((body.draft || body.published)!.validation);
      onWorkflowChanged?.(body.workflow.id);
    } catch (liveError) {
      setError(liveError instanceof Error ? liveError.message : "Could not take the workflow live");
    } finally {
      setSaving(false);
    }
  }

  async function duplicateSystem() {
    if (!detail) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/automation-workflows", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, sourceWorkflowId: detail.workflow.id, name: `${detail.workflow.name} · Custom` }),
      });
      const body = await response.json() as AutomationWorkflowDetail & { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not create a custom workflow");
      onWorkflowChanged?.(body.workflow.id);
    } catch (duplicateError) {
      setError(duplicateError instanceof Error ? duplicateError.message : "Could not create a custom workflow");
    } finally {
      setSaving(false);
    }
  }

  async function requestWorkflowSwitch(nextWorkflowId: string) {
    if (nextWorkflowId === workflowId || !onWorkflowChanged) return;
    if (saving) return;
    if (dirty && !await saveDraft()) return;
    onWorkflowChanged(nextWorkflowId);
  }

  const closeEditor = useCallback(async () => {
    if (saving) return;
    if (dirty && !await saveDraft()) return;
    onClose();
  }, [dirty, onClose, saveDraft, saving]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (runHistoryOpen) return;
      if (manageOpen) { setManageOpen(false); return; }
      if (mobileInspectorOpen) { setMobileInspectorOpen(false); return; }
      void closeEditor();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeEditor, manageOpen, mobileInspectorOpen, runHistoryOpen]);

  async function exportWorkflow() {
    const current = dirty ? await saveDraft() : detail;
    if (!current) return;
    const version = current.draft ? "draft" : "published";
    window.location.assign(`/api/automation-workflows/${encodeURIComponent(current.workflow.id)}/export?version=${version}`);
  }

  const filteredDefinitions = automationNodeDefinitions().filter((definition) => `${definition.title} ${definition.description} ${definition.example || ""} ${definition.category} ${definition.help.whenToUse} ${definition.help.setup.join(" ")} ${definition.help.exampleFlow.before} ${definition.help.exampleFlow.after} ${(definition.help.technicalNotes || []).join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selectedSlotType = selectedNode?.type === "integration.http-request" ? "credential" : selectedNode?.type === "logic.run-subworkflow" || selectedNode?.type === "logic.map-subworkflow" ? "subworkflow" : null;
  const selectedSlotKey = selectedSlotType === "credential" ? String(selectedNode?.config.credentialSlot || "") : selectedSlotType === "subworkflow" ? String(selectedNode?.config.subworkflowSlot || "") : "";
  const selectedDeploymentBinding = bindingOptions.bindings.find((binding) => binding.slotKey === selectedSlotKey && binding.type === selectedSlotType);
  const selectedCredentialKind = String(selectedNode?.config.credentialKind || "bearer");
  const credentialFormReady = Boolean(newCredentialName.trim() && newCredentialValue && (selectedCredentialKind !== "basic" || newCredentialUsername) && (selectedCredentialKind !== "header" || newCredentialHeaderName));
  const selectedVisibleFields = selectedNode && selectedDefinition ? selectedDefinition.fields.filter((field) => {
    if (!field.visibleWhen) return true;
    const controlling = selectedNode.bindings[field.visibleWhen.fieldId]?.mode === "fixed" && selectedNode.bindings[field.visibleWhen.fieldId]?.value !== undefined
      ? selectedNode.bindings[field.visibleWhen.fieldId].value
      : selectedNode.config[field.visibleWhen.fieldId] ?? selectedDefinition.fields.find((candidate) => candidate.id === field.visibleWhen!.fieldId)?.defaultValue;
    return field.visibleWhen.values.some((value) => Object.is(value, controlling));
  }) : [];
  const selectedMainFields = selectedVisibleFields.filter((field) => !field.advanced);
  const selectedAdvancedFields = selectedVisibleFields.filter((field) => field.advanced);
  const selectedAdvancedDescription = selectedDefinition?.category === "ai"
    ? "Permanent instructions, variation, retries and failures"
    : selectedDefinition?.category === "generation"
      ? "Parallel work, retries and complete failures"
      : selectedNode?.type === "integration.http-request"
        ? "Headers, waiting time, retries and failures"
        : "Extra inputs and failure behavior";
  const selectedValidatorHasContract = Boolean(selectedNode?.type === "logic.validate-slide-plans"
    && graph?.edges.some((edge) => edge.target === selectedNode.id && edge.targetPort === "contract"));
  const renderSelectedField = (field: AutomationNodeFieldDefinition) => {
    if (selectedNode?.type === "logic.merge" && field.id === "inputs") {
      return <MergeInputsEditor key={`${selectedNode.id}:${field.id}`} node={selectedNode} graph={graph!} disabled={Boolean(readOnly)} onChange={(value) => updateSelectedFieldConfig(field, value)} />;
    }
    if (field.kind === "creative-controls") {
      const fieldValue = selectedNode?.config[field.id] ?? field.defaultValue;
      return <CreativeControlsEditor key={`${selectedNode?.id}:${field.id}`} value={fieldValue} disabled={Boolean(readOnly)} onChange={(value) => updateSelectedFieldConfig(field, value)} />;
    }
    const fieldValue = selectedNode?.bindings[field.id]?.mode === "fixed" && selectedNode.bindings[field.id]?.value !== undefined
      ? selectedNode.bindings[field.id]?.value
      : selectedNode?.config[field.id] ?? field.defaultValue;
    const systemModelEditable = Boolean(
      systemReadOnly
      && capabilities.edit
      && field.id === "modelId"
      && field.kind === "model"
      && (field.modelCapability === "assistant" || field.modelCapability === "image"),
    );
    if (systemModelEditable) {
      const defaultModelId = detail?.systemModelDefaults?.[`${selectedNode!.id}.modelId`] || "";
      const currentModelId = String(fieldValue || "");
      return <div key={`${selectedNode!.id}:${field.id}`} className="automation-inspector-field is-model is-system-model">
        <span><b>{field.label}</b><button type="button" disabled={saving || !defaultModelId || currentModelId === defaultModelId} title="Restore the model selected by this system template" onClick={() => void saveSystemModel(selectedNode!.id, null)}><RotateCcw size={11} /> Reset to default</button></span>
        {field.description && <small>{field.description}</small>}
        <InspectorSelect label={field.label} disabled={saving} value={currentModelId} options={selectedFieldOptions(field)} onChange={(value) => void saveSystemModel(selectedNode!.id, value)} />
        <small className="automation-system-model-help">Saved for this workspace. Only models compatible with this step&apos;s locked image shape and quality are available.</small>
      </div>;
    }
    const selectedReferenceIds = Array.isArray(fieldValue) ? fieldValue.filter((item): item is string => typeof item === "string") : [];
    return <FieldEditor
      key={`${selectedNode?.id}:${field.id}`}
      field={field}
      node={selectedNode!}
      disabled={Boolean(readOnly || field.readOnly)}
      options={selectedFieldOptions(field)}
      referencePicker={field.kind === "references" ? <AutomationReferencePicker
        workspaceId={workspaceId}
        projectId={projectId}
        canvasReferences={canvasReferences}
        personas={personas}
        selectedIds={selectedReferenceIds}
        maxItems={Number(selectedNode?.config.maxItems || field.max || 8)}
        disabled={Boolean(readOnly || selectedNode?.bindings[field.id]?.mode === "ask-on-run")}
        placement="editor"
        onChange={(assetIds) => updateSelectedFieldConfig(field, assetIds)}
      /> : undefined}
      onConfig={(value) => updateSelectedFieldConfig(field, value)}
      onBinding={(askOnRun) => updateSelectedFieldBinding(field, askOnRun)}
      onRequired={(required) => updateSelectedFieldRequired(field, required)}
    />;
  };

  const currentVersionIsPublished = Boolean(detail && detail.workflow.status === "published" && !detail.workflow.draftVersionId && !dirty);
  const publishLabel = currentVersionIsPublished ? "Live" : detail?.workflow.publishedVersionId ? "Update live" : "Go live";

  return <div className="automation-editor-overlay" role="dialog" aria-modal="false" aria-label="Automation workflow editor" onPointerDown={(event) => event.stopPropagation()}>
    <div className="automation-editor-shell">
      <header className="automation-editor-topbar">
        <div className="automation-editor-title">
          <button type="button" className="automation-editor-collapse" disabled={saving} onClick={() => void closeEditor()} aria-label="Collapse workflow editor" title="Collapse workflow editor"><ChevronLeft size={19} /></button>
          <span><small>AUTOMATION CANVAS</small><input aria-label="Workflow name" value={name} disabled={Boolean(readOnly)} onChange={(event) => { setName(event.target.value); markDirty(); }} /></span>
          <i className={detail?.workflow.status === "published" || detail?.workflow.status === "system" ? "is-published" : ""}>{detail?.workflow.status === "system" ? "System template" : saving ? "Saving…" : dirty ? "Auto-save pending" : detail?.workflow.status === "published" ? "Live" : "Draft auto-saved"}</i>
        </div>
        <div className="automation-editor-actions">
          <div className="automation-workflow-switcher">
            <InspectorSelect
              label="Switch workflow"
              value={workflowId}
              options={workflowSwitchOptions}
              disabled={saving || !onWorkflowChanged || workflowSwitchOptions.length < 2}
              onChange={(nextWorkflowId) => void requestWorkflowSwitch(nextWorkflowId)}
            />
          </div>
          {validation && <button type="button" className={`automation-validation-pill ${validation.valid ? "is-valid" : ""}`} onClick={() => {
            const nextValidation = validateAutomationWorkflowGraph(graph);
            setValidation(nextValidation);
            if (!nextValidation.valid) {
              setError(nextValidation.issues.slice(0, 4).map((entry) => entry.message).join(" · "));
              const firstNodeId = nextValidation.issues.find((entry) => entry.nodeId)?.nodeId;
              if (firstNodeId) setSelectedId(firstNodeId);
            }
          }}>{validation.valid ? "Valid" : `${validation.issues.length} issues`}</button>}
          <div className="automation-manage-menu" ref={manageMenuRef}>
            <button type="button" className={manageOpen ? "is-open" : ""} aria-haspopup="menu" aria-expanded={manageOpen} onClick={() => setManageOpen((open) => !open)}>Manage</button>
            {manageOpen && <div role="menu">
              <button type="button" role="menuitem" onClick={() => { setManageOpen(false); setRunHistoryOpen(true); }}><Workflow size={14} /><span><b>Run history</b><small>See routes, failures and usage</small></span></button>
              <button type="button" role="menuitem" disabled={saving} onClick={() => { setManageOpen(false); void exportWorkflow(); }}><Download size={14} /><span><b>Export JSON</b><small>Portable, without credentials</small></span></button>
            </div>}
          </div>
          {systemReadOnly ? capabilities.edit && <button type="button" className="is-primary" disabled={saving} onClick={() => void duplicateSystem()}><Copy size={14} /> Duplicate to customize</button> : <>
            {capabilities.publish && <button type="button" className={`is-primary ${currentVersionIsPublished ? "is-published" : ""}`} disabled={saving || currentVersionIsPublished || (dirty && !capabilities.edit)} onClick={() => void takeLive()}>{publishLabel}</button>}
          </>}
        </div>
      </header>

      {error && <div className="automation-editor-error" role="alert"><CircleAlert size={14} /><span>{error}</span><button type="button" aria-label="Dismiss error" onClick={() => setError("")}><X size={13} /></button></div>}
      {detail?.systemModelIssues.map((issue) => <div className="automation-editor-model-warning" role="alert" key={`${issue.nodeId}:${issue.modelId}`}>
        <CircleAlert size={14} />
        <span><b>Saved model override needs attention</b><small>{issue.message}</small></span>
        {capabilities.edit && <button type="button" disabled={saving} onClick={() => void saveSystemModel(issue.nodeId, null)}><RotateCcw size={12} /> Clear override</button>}
      </div>)}

      {loading ? <div className="automation-editor-loading" aria-live="polite"><i /><i /><i /><span>Opening workflow…</span></div> : graph && <div className="automation-editor-body">
        <aside className="automation-node-library">
          <div className="automation-library-head"><span><Plus size={13} /> Node library</span><small>Every item below is a reusable node type. Add it, then give that step its own name.</small><label><Search size={13} /><input aria-label="Search node types" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search node types…" /></label></div>
          <div className="automation-library-list">
            {(Object.keys(categoryLabels) as Array<keyof typeof categoryLabels>).map((category) => {
              const categoryNodes = filteredDefinitions.filter((definition) => definition.category === category);
              if (!categoryNodes.length) return null;
              return <section key={category}><h3>{categoryLabels[category]}</h3>{categoryNodes.map((definition) => {
                const definitionKey = `${definition.type}@${definition.version}`;
                return <article key={definitionKey} className={previewDefinitionKey === definitionKey ? "is-selected" : ""}>
                  <button type="button" className="automation-library-info" onClick={() => { setPreviewDefinitionKey(definitionKey); setSelectedId(null); setInspectorView("guide"); setMobileInspectorOpen(true); }}>
                    <span className={`is-${definition.accent}`}><AutomationNodeIcon definition={definition} /></span>
                    <i><em>NODE TYPE</em><b>{definition.title}</b><small>{definition.description}</small></i>
                  </button>
                  {!readOnly && <button type="button" className="automation-library-add" aria-label={`Add ${definition.title}`} onClick={() => addNode(definition.type, definition.version)}><Plus size={13} /></button>}
                </article>;
              })}</section>;
            })}
          </div>
        </aside>

        <main ref={flowStageRef} className="automation-flow-stage">
          <div className="automation-flow-breadcrumb">
            <span className="automation-flow-map-title"><Workflow size={13} /><b>Workflow</b><small>{graph.nodes.length} steps · follow from left to right</small></span>
            <button type="button" onClick={arrangeCurrentView} title="Arrange the workflow into readable columns"><Sparkles size={12} /> Clean up layout</button>
          </div>
          {!(graph.annotations || []).length && <div className="automation-flow-hint">
            <b>{systemReadOnly ? "Click a card to follow the work" : "Click a card to follow or change it"}</b>
            <span>Every curve is a real connection from one visible socket to another. Select a card to see only its immediate inputs and outputs; named Merge inputs keep converging paths separate.</span>
          </div>}
          <ReactFlowProvider>
            <ReactFlow
              key="workflow"
              nodes={flowNodes}
              edges={display.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              defaultViewport={graph.viewport || { x: 60, y: 160, zoom: 0.72 }}
              minZoom={0.3}
              maxZoom={1.35}
              connectionRadius={32}
              connectionLineType={ConnectionLineType.Bezier}
              proOptions={{ hideAttribution: true }}
              onlyRenderVisibleElements
              zoomOnDoubleClick={false}
              panOnDrag={false}
              panActivationKeyCode="Space"
              panOnScroll
              panOnScrollSpeed={0.55}
              nodesDraggable
              nodesConnectable={!readOnly}
              elementsSelectable
              deleteKeyCode={null}
              onInit={(instance) => {
                flowInstanceRef.current = instance;
                window.requestAnimationFrame(() => void instance.fitView({
                  nodes: display.nodes.some((node) => node.data.kind === "annotation")
                    ? display.nodes.filter((node) => node.data.kind === "annotation").slice(0, 1)
                    : display.nodes.filter((node) => node.data.kind === "step").slice(0, 8),
                  padding: 0.2,
                  minZoom: 0.36,
                  maxZoom: 0.84,
                  duration: 0,
                }));
              }}
              onNodesChange={onFlowNodesChange}
              onNodeDrag={(_, flowNode) => magnetizeFlowNode(flowNode)}
              onNodeClick={(event, node) => {
                if (event.target instanceof Element && event.target.closest(".automation-reference-field")) return;
                setSelectedId(node.id); setPreviewDefinitionKey(null); setInspectorView("settings"); setMobileInspectorOpen(true);
              }}
              onEdgeClick={(_, edge) => { setSelectedId(`edge:${edge.id}`); setPreviewDefinitionKey(null); setInspectorView("guide"); setMobileInspectorOpen(true); }}
              onNodeDragStop={(_, flowNode) => finishFlowNodeDrag(flowNode)}
              onConnect={onConnect}
              onEdgesDelete={(edges) => mutateGraph((current) => ({ ...current, edges: current.edges.filter((edge) => !edges.some((removed) => removed.id === edge.id)) }))}
              onPaneClick={() => { setSelectedId(null); setPreviewDefinitionKey(null); setMobileInspectorOpen(false); }}
            >
              <Background color="var(--ff-grid-dot)" gap={28} size={1.15} />
              <Controls
                showInteractive={false}
                fitViewOptions={{
                  nodes: flowNodes.filter((node) => node.data.kind === "step"),
                  padding: 0.18,
                  minZoom: 0.3,
                  maxZoom: 0.84,
                }}
              />
            </ReactFlow>
          </ReactFlowProvider>
        </main>

        <aside className={`automation-node-inspector ${mobileInspectorOpen ? "is-open" : ""}`}>
          <button type="button" className="automation-inspector-close" aria-label="Close node details" onClick={() => { setSelectedId(null); setPreviewDefinitionKey(null); setMobileInspectorOpen(false); }}><X size={15} /></button>
          {previewDefinition ? <div className="automation-definition-preview"><span className={`is-${previewDefinition.accent}`}><AutomationNodeIcon definition={previewDefinition} size={16} /></span><small>{categoryNodeLabels[previewDefinition.category]} NODE TYPE</small><h2>{previewDefinition.title}</h2><AutomationNodeGuide definition={previewDefinition} />{!readOnly && <button type="button" onClick={() => addNode(previewDefinition.type, previewDefinition.version)}><Plus size={13} /> Add to workflow</button>}{systemReadOnly && capabilities.edit && <button type="button" className="is-secondary" disabled={saving} onClick={() => void duplicateSystem()}><Copy size={13} /> Duplicate template to add steps</button>}</div>
            : selectedAnnotation ? <div className="automation-annotation-inspector"><span><StickyNote size={18} /></span><small>GUIDE NOTE · DOES NOT RUN</small><h2>{selectedAnnotation.title}</h2><p>Notes explain the workflow but never enter its execution or data flow.</p><AutomationMarkdown markdown={selectedAnnotation.markdown} />{!readOnly && <><label><b>Note title</b><input value={selectedAnnotation.title} onChange={(event) => mutateGraph((current) => ({ ...current, annotations: (current.annotations || []).map((annotation) => annotation.id === selectedAnnotation.id ? { ...annotation, title: event.target.value } : annotation) }))} /></label><label><b>Markdown</b><textarea value={selectedAnnotation.markdown} onChange={(event) => mutateGraph((current) => ({ ...current, annotations: (current.annotations || []).map((annotation) => annotation.id === selectedAnnotation.id ? { ...annotation, markdown: event.target.value } : annotation) }))} /></label><button type="button" className="is-danger" onClick={() => { mutateGraph((current) => ({ ...current, annotations: (current.annotations || []).filter((annotation) => annotation.id !== selectedAnnotation.id) })); setSelectedId(null); setMobileInspectorOpen(false); }}><Trash2 size={13} /> Remove note</button></>}</div>
            : selectedEdge ? <div className="automation-inspector-empty is-group"><GitBranch size={20} /><small>HOW THESE STEPS CONNECT</small><h2>{selectedEdgeContract?.sourceNode?.name || "Step"} → {selectedEdgeContract?.targetNode?.name || "Step"}</h2><p>The first step passes <b>{selectedEdgeContract?.sourceLabel || selectedEdge.sourcePort}</b>. The next step receives it as <b>{selectedEdgeContract?.targetLabel || selectedEdge.targetPort}</b>.</p><label className="automation-edge-role"><span><b>Connection purpose</b><small>{selectedEdgeRole === "flow" ? "Main route: shows what runs next." : selectedEdgeRole === "data" ? "Supporting data: supplies an additional value without becoming the main route." : selectedEdgeRole === "retry" ? "Bounded retry: returns corrected data to its Retry gate." : "Recovery route: used only after a handled error."}</small></span><InspectorSelect label="Connection purpose" disabled={Boolean(readOnly || selectedEdgeContract?.dataType === "error" || selectedEdge.role === "retry")} value={selectedEdgeRole} options={selectedEdgeRoleOptions} onChange={(value) => mutateGraph((current) => ({ ...current, edges: current.edges.map((edge) => edge.id === selectedEdge.id ? { ...edge, role: value as AutomationEdgeRole } : edge) }))} /></label>{!readOnly && <button type="button" className="is-danger" onClick={removeSelectedEdge}><Trash2 size={13} /> Remove connection</button>}</div>
            : selectedNode && selectedDefinition ? <>
              <header><span className={`is-${selectedDefinition.accent}`}><AutomationNodeIcon definition={selectedDefinition} size={15} /></span><div><small><b>Node type · {selectedDefinition.title}</b><em>{categoryNodeLabels[selectedDefinition.category]} · {selectedHasEditableSystemModel ? "Model editable" : readOnly ? "View only" : "Editable step"}</em></small><h2>{selectedNode.name}</h2></div></header>
              <nav className="automation-inspector-tabs" aria-label="Step panel">
                <button type="button" className={inspectorView === "guide" ? "is-active" : ""} aria-pressed={inspectorView === "guide"} onClick={() => setInspectorView("guide")}><BookOpen size={14} /><span><b>Guide</b><small>Purpose and examples</small></span></button>
                <button type="button" className={inspectorView === "settings" ? "is-active" : ""} aria-pressed={inspectorView === "settings"} onClick={() => setInspectorView("settings")}><Settings2 size={14} /><span><b>Settings</b><small>{selectedHasEditableSystemModel ? "Choose model" : readOnly ? "Current values" : "Configure this step"}</small></span></button>
                <button type="button" className={inspectorView === "execution" ? "is-active" : ""} aria-pressed={inspectorView === "execution"} onClick={() => setInspectorView("execution")}><Activity size={14} /><span><b>Execution</b><small>{execution?.runId ? "Inputs · outputs · errors" : "No run selected"}</small></span></button>
              </nav>
              <div className="automation-inspector-scroll">
                {inspectorView === "guide" ? <>
                  <AutomationNodeGuide definition={selectedDefinition} node={selectedNode} />
                  {selectedNode.type === "logic.validate-slide-plans" && <section className={`automation-template-notice is-contract-${selectedValidatorHasContract ? "full" : "structural"}`}><CircleAlert size={14} /><span><b>{selectedValidatorHasContract ? "Full contract validation is connected" : "Structural validation only"}</b><small>{selectedValidatorHasContract ? "This step enforces the original run choices, copy decisions and exact prompt requirements." : "Connect Original generation contract to enforce run choices, copy decisions and exact prompt requirements too."}</small></span></section>}
                  <AutomationNodeConnections graph={graph} node={selectedNode} onSelect={(nodeId) => { setSelectedId(nodeId); setPreviewDefinitionKey(null); setInspectorView("settings"); setMobileInspectorOpen(true); }} />
                </> : inspectorView === "settings" ? <>
                  {systemReadOnly && <section className="automation-template-notice"><Copy size={14} /><span><b>Protected system template</b><small>AI and image models can be changed here. Duplicate the workflow to change prompts, connections or any other setting.</small></span></section>}
                  {selectedNode.type === "logic.validate-slide-plans" && <section className={`automation-template-notice is-contract-${selectedValidatorHasContract ? "full" : "structural"}`}><CircleAlert size={14} /><span><b>{selectedValidatorHasContract ? "Full contract validation" : "Structural validation only"}</b><small>{selectedValidatorHasContract ? "Original generation contract is connected, so exact run choices and prompt requirements are enforced." : "Original generation contract is not connected. This step checks structure, indexes, reference availability and limits, but cannot verify the original choices or prompt requirements."}</small></span></section>}
                  <div className="automation-inspector-section-label"><b>{selectedHasEditableSystemModel ? "Model setting" : readOnly ? "Current settings" : "Configure this step"}</b><span>{selectedHasEditableSystemModel ? "The model is saved immediately; all other values stay protected" : readOnly ? "Values this workflow will use" : "Saved to your draft"}</span></div>
                  {readOnly && <section className="automation-node-readonly-identity"><span><b>Step name</b><small>{selectedNode.name}</small></span><span><b>Description</b><small>{selectedNode.description || selectedDefinition.description}</small></span></section>}
                  {!readOnly && <label className="automation-inspector-field"><span><b>Step name</b><small>Give this particular step a clear name. Its node type stays {selectedDefinition.title} everywhere.</small></span><input value={selectedNode.name} onChange={(event) => mutateGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === selectedNode.id ? { ...node, name: event.target.value } : node) }))} /></label>}
                  {!readOnly && <label className="automation-inspector-field"><span><b>Step description</b></span><textarea value={selectedNode.description} onChange={(event) => mutateGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === selectedNode.id ? { ...node, description: event.target.value } : node) }))} /></label>}
                  {selectedMainFields.length ? selectedMainFields.map(renderSelectedField) : <p className="automation-no-settings">This step has no settings. Connect it to the next card and it is ready.</p>}
                  {selectedAdvancedFields.length > 0 && <details className="automation-node-advanced" open={readOnly ? true : undefined}><summary><span><b>Advanced settings</b><small>{selectedAdvancedDescription}</small></span><Plus size={14} /></summary><div>{selectedAdvancedFields.map(renderSelectedField)}</div></details>}
                  {selectedSlotType && <section className="automation-deployment-binding"><small>DEPLOYMENT BINDING</small><h3>{selectedSlotType === "credential" ? "Connect credential" : "Connect child workflow"}</h3><p>The portable workflow stores only <b>{selectedSlotKey || "a slot name"}</b>. This local connection is never exported.</p>{!selectedSlotKey ? <i>Set the slot name above first.</i> : selectedSlotType === "credential" ? capabilities.manageCredentials ? <>
                  <label><span>Saved credential</span><InspectorSelect label="Saved credential" disabled={Boolean(readOnly || saving)} value={selectedDeploymentBinding?.credentialId || ""} options={[{ value: "", label: "Choose saved credential…" }, ...bindingOptions.credentials.map((credential) => ({ value: credential.id, label: `${credential.name} · ${credential.kind} · ${credential.fingerprint}` }))]} onChange={(value) => void saveDeploymentBinding("credential", selectedSlotKey, value)} /></label>
                  {!readOnly && <details><summary>Create a new credential</summary><div><label><span>Name</span><input value={newCredentialName} onChange={(event) => setNewCredentialName(event.target.value)} placeholder="Production API key…" /></label>{selectedCredentialKind === "basic" && <label><span>Username</span><input value={newCredentialUsername} onChange={(event) => setNewCredentialUsername(event.target.value)} placeholder="Username…" autoComplete="username" /></label>}{selectedCredentialKind === "header" && <label><span>Header name</span><input value={newCredentialHeaderName} onChange={(event) => setNewCredentialHeaderName(event.target.value)} placeholder="X-API-Key…" /></label>}<label><span>{selectedCredentialKind === "basic" ? "Password" : "Secret value"}</span><input type="password" value={newCredentialValue} onChange={(event) => setNewCredentialValue(event.target.value)} placeholder={selectedCredentialKind === "basic" ? "Password…" : "Secret value…"} autoComplete="new-password" /></label><button type="button" disabled={saving || !credentialFormReady} onClick={() => void createAndBindCredential(selectedSlotKey, selectedCredentialKind)}>Save & connect</button></div></details>}
                  </> : <i>Your workspace role cannot manage credentials.</i> : <InspectorSelect label="Child workflow" disabled={Boolean(readOnly || saving)} value={selectedDeploymentBinding?.targetWorkflowId || ""} options={[{ value: "", label: "Choose live workflow" }, ...bindingOptions.workflows.filter((workflow) => workflow.id !== detail?.workflow.id && workflow.publishedVersionId).map((workflow) => ({ value: workflow.id, label: workflow.name }))]} onChange={(value) => void saveDeploymentBinding("subworkflow", selectedSlotKey, value)} />}</section>}
                  {!readOnly && <div className="automation-inspector-danger"><button type="button" onClick={removeSelectedNode}><Trash2 size={13} /> Remove step</button></div>}
                </> : <section className="automation-node-execution">
                  <div className="automation-inspector-section-label"><b>Step execution</b><span>{execution?.runId ? `Run ${execution.runId.slice(0, 8)}` : "Run the workflow to capture exact data"}</span></div>
                  {!execution?.runId ? <div className="automation-execution-empty"><Activity size={18} /><b>No execution selected</b><p>After a run starts, this panel shows every attempt, the exact captured input, output and any error returned by this step.</p></div>
                    : executionResult.key !== executionDetailKey ? <div className="automation-execution-empty"><Activity size={18} /><b>Loading execution…</b></div>
                      : executionResult.attempts.length ? executionResult.attempts.map((attempt) => <article key={attempt.id} className={`automation-execution-attempt is-${attempt.status}`}>
                        <header><span><b>Attempt {attempt.attempt}</b><small>{attempt.reusedFromNodeRunId ? `reused exact output from ${attempt.reusedFromNodeRunId.slice(0, 8)}` : attempt.status.replaceAll("_", " ")}</small></span>{attempt.chargedCredits > 0 && <em>{attempt.chargedCredits} credits</em>}</header>
                        {attempt.error && <div className="automation-execution-error"><small>{attempt.errorCode || "STEP_ERROR"}</small><b>{attempt.error}</b></div>}
                        <details open={Boolean(attempt.error)}><summary>Captured input <Plus size={12} /></summary><pre>{JSON.stringify(attempt.input ?? {}, null, 2)}</pre></details>
                        <details open={Boolean(attempt.error && attempt.output)}><summary>Produced output <Plus size={12} /></summary><pre>{JSON.stringify(attempt.output ?? null, null, 2)}</pre></details>
                      </article>)
                        : <div className="automation-execution-empty"><Activity size={18} /><b>This step did not run</b><p>Its required route may not have produced a value in the selected run.</p></div>}
                </section>}
              </div>
            </> : null}
        </aside>
      </div>}
    </div>

    {runHistoryOpen && detail && <AutomationWorkflowOperations
      projectId={projectId}
      workflowId={detail.workflow.id}
      capabilities={detail.capabilities}
      workflowNodes={(detail.draft || detail.published)?.graph.nodes.map((node) => ({ id: node.id, name: node.name })) || []}
      onClose={() => setRunHistoryOpen(false)}
    />}
  </div>;
}
