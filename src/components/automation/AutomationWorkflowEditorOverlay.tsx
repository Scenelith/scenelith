"use client";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  addEdge,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  ArrowLeft,
  Braces,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  FlaskConical,
  GitBranch,
  History,
  Layers3,
  MoreHorizontal,
  Plus,
  Save,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generatorRatiosFor, generatorResolutionsFor, type GeneratorModelOption } from "@/components/FrameNode";
import { tiktokAutomationPlanningModels } from "@/lib/assistant-models";
import { automationNodeDefinition, automationNodeDefinitions } from "@/lib/automation-workflows/registry";
import type { PersonaRecord } from "@/lib/types";
import type { TikTokSlideshowSource } from "@/lib/tiktok-slideshow-sources";
import type {
  AutomationGroup,
  AutomationNode,
  AutomationNodeFieldDefinition,
  AutomationValidationResult,
  AutomationWorkflowDetail,
  AutomationWorkflowGraph,
} from "@/lib/automation-workflows/types";
import { DEFAULT_AUTOMATION_WORKFLOW_SETTINGS } from "@/lib/automation-workflows/types";
import { automationRunInputFields, validateAutomationConnection, validateAutomationWorkflowGraph } from "@/lib/automation-workflows/validation";
import { AutomationWorkflowOperations } from "./AutomationWorkflowOperations";
import type { AutomationCapabilities } from "@/editions/contracts/access";

type FlowNodeData = {
  automationNode?: AutomationNode;
  group?: AutomationGroup;
  syntheticGroup: boolean;
  readOnly: boolean;
  [key: string]: unknown;
};

type EditorView = "groups" | "all" | { groupId: string };
type WorkflowBindingOption = { id: string; name: string; status: string; publishedVersionId: string | null };
type CredentialOption = { id: string; name: string; kind: string; fingerprint: string };
type WorkflowBinding = { slotKey: string; type: "credential" | "subworkflow"; credentialId: string | null; credentialName: string | null; targetWorkflowId: string | null; targetWorkflowName: string | null };
type AutomationWorkflowClientDetail = AutomationWorkflowDetail & { capabilities: AutomationCapabilities };

const categoryLabels = {
  trigger: "Triggers",
  input: "Inputs",
  ai: "AI",
  logic: "Logic",
  generation: "Generation",
  output: "Outputs",
} as const;

function AutomationNodeCard({ data, selected }: NodeProps<Node<FlowNodeData>>) {
  if (data.syntheticGroup && data.group) {
    return <div className={`automation-flow-group ${selected ? "is-selected" : ""}`}>
      <Handle id="input" type="target" position={Position.Left} isConnectable={false} />
      <span className="automation-flow-node-kicker"><Layers3 size={12} /> {data.group.nodeIds.length} editable steps</span>
      <strong>{data.group.name}</strong>
      <p>{data.group.description}</p>
      <span className="automation-flow-group-open">Open steps <ChevronRight size={12} /></span>
      <Handle id="output" type="source" position={Position.Right} isConnectable={false} />
    </div>;
  }

  const node = data.automationNode;
  if (!node) return null;
  const definition = automationNodeDefinition(node.type, node.version);
  if (!definition) return <div className="automation-flow-node is-error"><strong>{node.name}</strong><small>Unknown node type</small></div>;
  return <div className={`automation-flow-node is-${definition.accent} ${selected ? "is-selected" : ""} ${node.disabled ? "is-disabled" : ""}`}>
    {definition.inputs.map((port, index) => <Handle
      key={port.id}
      id={port.id}
      type="target"
      position={Position.Left}
      isConnectable={!data.readOnly}
      style={{ top: `${((index + 1) / (definition.inputs.length + 1)) * 100}%` }}
      title={`${port.label} · ${port.type}`}
    />)}
    <span className="automation-flow-node-kicker">{categoryLabels[definition.category]}</span>
    <strong>{node.name}</strong>
    <p>{node.description || definition.description}</p>
    {definition.outputs.map((port, index) => <Handle
      key={port.id}
      id={port.id}
      type="source"
      position={Position.Right}
      isConnectable={!data.readOnly && !definition.terminal}
      style={{ top: `${((index + 1) / (definition.outputs.length + 1)) * 100}%` }}
      title={`${port.label} · ${port.type}`}
    />)}
  </div>;
}

const nodeTypes = { automationNode: AutomationNodeCard };

function displayGraph(graph: AutomationWorkflowGraph, view: EditorView, readOnly: boolean) {
  const groups = graph.groups ?? [];
  if (view === "groups") {
    const grouped = new Map(groups.flatMap((group) => group.nodeIds.map((nodeId) => [nodeId, group.id] as const)));
    const nodes: Node<FlowNodeData>[] = [
      ...graph.nodes.filter((node) => !grouped.has(node.id)).map((node) => ({ id: node.id, type: "automationNode", position: node.position, data: { automationNode: node, syntheticGroup: false, readOnly } })),
      ...groups.map((group) => ({ id: `group:${group.id}`, type: "automationNode", position: group.position, data: { group, syntheticGroup: true, readOnly }, draggable: !readOnly })),
    ];
    const seen = new Set<string>();
    const edges: Edge[] = [];
    for (const edge of graph.edges) {
      const source = grouped.has(edge.source) ? `group:${grouped.get(edge.source)}` : edge.source;
      const target = grouped.has(edge.target) ? `group:${grouped.get(edge.target)}` : edge.target;
      if (source === target) continue;
      const id = `collapsed:${source}->${target}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, source, target, sourceHandle: source.startsWith("group:") ? "output" : edge.sourcePort, targetHandle: target.startsWith("group:") ? "input" : edge.targetPort, animated: false, markerEnd: { type: MarkerType.ArrowClosed } });
    }
    return { nodes, edges };
  }

  const visibleNodeIds = view === "all"
    ? new Set(graph.nodes.map((node) => node.id))
    : new Set(groups.find((group) => group.id === view.groupId)?.nodeIds || []);
  return {
    nodes: graph.nodes.filter((node) => visibleNodeIds.has(node.id)).map((node) => ({ id: node.id, type: "automationNode", position: node.position, data: { automationNode: node, syntheticGroup: false, readOnly } })),
    edges: graph.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourcePort,
      targetHandle: edge.targetPort,
      markerEnd: { type: MarkerType.ArrowClosed },
    })),
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

function FieldEditor({ field, node, disabled, options, onConfig, onBinding, onRequired }: {
  field: AutomationNodeFieldDefinition;
  node: AutomationNode;
  disabled: boolean;
  options: Array<{ value: string; label: string }>;
  onConfig: (value: unknown) => void;
  onBinding: (askOnRun: boolean) => void;
  onRequired: (required: boolean) => void;
}) {
  const value = node.bindings[field.id]?.mode === "fixed" && node.bindings[field.id]?.value !== undefined
    ? node.bindings[field.id].value
    : node.config[field.id] ?? field.defaultValue ?? "";
  const askOnRun = node.bindings[field.id]?.mode === "ask-on-run";
  const required = Boolean(field.required || node.bindings[field.id]?.required);
  return <label className={`automation-inspector-field is-${field.kind}`}>
    <span><b>{field.label}</b>{field.runtimeBindable && <button type="button" disabled={disabled} className={askOnRun ? "is-on" : ""} onClick={() => onBinding(!askOnRun)}>Ask on run</button>}</span>
    {askOnRun && <button type="button" className={`automation-runtime-required ${required ? "is-on" : ""}`} disabled={disabled || field.required} onClick={() => onRequired(!required)}><i /> {field.required ? "Required by this step" : "Required before run"}</button>}
    {field.description && <small>{field.description}</small>}
    {field.kind === "boolean" ? <button type="button" className={`automation-boolean ${value ? "is-on" : ""}`} disabled={disabled || askOnRun} onClick={() => onConfig(!value)}><i />{value ? "Enabled" : "Disabled"}</button>
      : (field.kind === "select" || field.kind === "model") && options.length ? <select disabled={disabled || askOnRun} value={String(value)} onChange={(event) => onConfig(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        : field.kind === "json" ? <JsonEditor disabled={disabled || askOnRun} value={value} onChange={onConfig} />
          : field.kind === "textarea" || field.kind === "prompt" ? <textarea disabled={disabled || askOnRun} value={String(value)} spellCheck={field.kind !== "prompt"} onChange={(event) => onConfig(event.target.value)} />
            : <input disabled={disabled || askOnRun} type={field.kind === "number" ? "number" : "text"} min={field.min} max={field.max} value={String(value)} onChange={(event) => onConfig(field.kind === "number" ? Number(event.target.value) : event.target.value)} />}
  </label>;
}

export function AutomationWorkflowEditorOverlay({ projectId, workflowId, sources, personas, models, onClose, onWorkflowChanged }: {
  projectId: string;
  workflowId: string;
  sources: TikTokSlideshowSource[];
  personas: PersonaRecord[];
  models: GeneratorModelOption[];
  onClose: () => void;
  onWorkflowChanged?: (workflowId: string) => void;
}) {
  const [detail, setDetail] = useState<AutomationWorkflowClientDetail | null>(null);
  const [graph, setGraph] = useState<AutomationWorkflowGraph | null>(null);
  const [name, setName] = useState("");
  const [view, setView] = useState<EditorView>("groups");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [operationsView, setOperationsView] = useState<"runs" | "versions" | "triggers" | "fixtures" | null>(null);
  const [validation, setValidation] = useState<AutomationValidationResult | null>(null);
  const [bindingOptions, setBindingOptions] = useState<{ credentials: CredentialOption[]; workflows: WorkflowBindingOption[]; bindings: WorkflowBinding[] }>({ credentials: [], workflows: [], bindings: [] });
  const [newCredentialName, setNewCredentialName] = useState("");
  const [newCredentialValue, setNewCredentialValue] = useState("");
  const [newCredentialUsername, setNewCredentialUsername] = useState("");
  const [newCredentialHeaderName, setNewCredentialHeaderName] = useState("");
  const manageMenuRef = useRef<HTMLDivElement>(null);

  const capabilities = detail?.capabilities || { run: false, edit: false, publish: false, manageTriggers: false, manageCredentials: false };
  const systemReadOnly = detail?.workflow.status === "system";
  const readOnly = systemReadOnly || !capabilities.edit;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (operationsView) return;
      if (manageOpen) { setManageOpen(false); return; }
      if (mobileInspectorOpen) { setMobileInspectorOpen(false); return; }
      if (confirmClose) { setConfirmClose(false); return; }
      if (dirty) setConfirmClose(true);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmClose, dirty, manageOpen, mobileInspectorOpen, onClose, operationsView]);
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
        setDetail(body);
        setGraph(structuredClone(version.graph));
        setName(body.workflow.name);
        setValidation(version.validation);
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

  const display = useMemo(() => graph ? displayGraph(graph, view, Boolean(readOnly)) : { nodes: [], edges: [] }, [graph, readOnly, view]);
  const selectedNode = graph?.nodes.find((node) => node.id === selectedId) || null;
  const selectedGroup = graph?.groups.find((group) => `group:${group.id}` === selectedId) || null;
  const selectedEdge = graph?.edges.find((edge) => `edge:${edge.id}` === selectedId) || null;
  const selectedDefinition = selectedNode ? automationNodeDefinition(selectedNode.type, selectedNode.version) : null;
  function selectedFieldOptions(field: AutomationNodeFieldDefinition) {
    if (!selectedNode) return field.options || [];
    if (field.runtimeValueType === "tiktok-source") return sources.map((source) => ({ value: source.id, label: source.label }));
    if (field.runtimeValueType === "identity") return [{ value: "", label: "No identity" }, ...personas.map((persona) => ({ value: persona.id, label: persona.name }))];
    if (field.runtimeValueType === "assistant-model" || field.modelCapability === "assistant") return tiktokAutomationPlanningModels.map((model) => ({ value: model.id, label: model.label }));
    if (field.runtimeValueType === "image-model" || field.modelCapability === "image") return models.filter((model) => model.mediaType === "image" && model.maxReferences > 0).map((model) => ({ value: model.id, label: model.label }));
    const boundValue = (fieldId: string) => selectedNode.bindings[fieldId]?.mode === "fixed" && selectedNode.bindings[fieldId]?.value !== undefined
      ? selectedNode.bindings[fieldId].value
      : selectedNode.config[fieldId];
    const selectedModel = models.find((candidate) => candidate.id === String(boundValue("modelId") || ""));
    if (field.runtimeValueType === "resolution") return generatorResolutionsFor(selectedModel, false).map((value) => ({ value, label: value }));
    if (field.runtimeValueType === "aspect-ratio") return generatorRatiosFor(selectedModel, String(boundValue("resolution") || ""), true).map((value) => ({ value, label: value }));
    return field.options || [];
  }

  const mutateGraph = useCallback((mutator: (current: AutomationWorkflowGraph) => AutomationWorkflowGraph) => {
    if (readOnly) return;
    setGraph((current) => current ? mutator(structuredClone(current)) : current);
    setDirty(true);
  }, [readOnly]);

  const onConnect = useCallback((connection: Connection) => {
    if (!graph || readOnly || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const candidate = {
      id: crypto.randomUUID(),
      source: connection.source,
      sourcePort: connection.sourceHandle,
      target: connection.target,
      targetPort: connection.targetHandle,
    };
    const connectionValidation = validateAutomationConnection(graph, candidate);
    if (!connectionValidation.valid) {
      setError(connectionValidation.issues[0]?.message || "Those steps cannot be connected");
      return;
    }
    setError("");
    mutateGraph((current) => ({ ...current, edges: addEdge({ ...connection, id: candidate.id }, current.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourcePort, targetHandle: edge.targetPort }))).map((edge) => ({ id: edge.id, source: edge.source, sourcePort: edge.sourceHandle || "output", target: edge.target, targetPort: edge.targetHandle || "input" })) }));
  }, [graph, mutateGraph, readOnly]);

  const addNode = useCallback((type: string, version: number) => {
    const definition = automationNodeDefinition(type, version);
    if (!definition || readOnly) return;
    const groupId = typeof view === "object" ? view.groupId : null;
    const id = `${type.replace(/[^a-z0-9]+/gi, "-")}-${crypto.randomUUID().slice(0, 8)}`;
    const existing = graph?.nodes.length || 0;
    const newNode: AutomationNode = {
      id, type, version, name: definition.title, description: definition.description,
      position: { x: 180 + (existing % 5) * 300, y: 160 + (existing % 3) * 190 }, groupId,
      config: Object.fromEntries(definition.fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.id, field.defaultValue])),
      bindings: {}, disabled: false,
    };
    mutateGraph((current) => ({
      ...current,
      nodes: [...current.nodes, newNode],
      groups: groupId ? current.groups.map((group) => group.id === groupId ? { ...group, nodeIds: [...group.nodeIds, id] } : group) : current.groups,
    }));
    setSelectedId(id);
    setMobileInspectorOpen(true);
  }, [graph?.nodes.length, mutateGraph, readOnly, view]);

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

  async function saveDraft() {
    if (!graph || readOnly) return detail;
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
      setDirty(false);
      onWorkflowChanged?.(body.workflow.id);
      return body;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the workflow");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    const saved = dirty ? await saveDraft() : detail;
    if (!saved) return;
    const currentGraph = graph!;
    const nextValidation = validateAutomationWorkflowGraph(currentGraph);
    setValidation(nextValidation);
    if (!nextValidation.valid) {
      setError(nextValidation.issues.slice(0, 4).map((entry) => entry.message).join(" · "));
      const firstNodeId = nextValidation.issues.find((entry) => entry.nodeId)?.nodeId;
      if (firstNodeId) { setView("all"); setSelectedId(firstNodeId); }
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/automation-workflows/${encodeURIComponent(saved.workflow.id)}/publish`, { method: "POST" });
      const body = await response.json() as AutomationWorkflowDetail & { error?: string; validation?: AutomationValidationResult };
      if (!response.ok) throw new Error(body.error || "Could not publish the workflow");
      setDetail({ ...body, capabilities: detail!.capabilities });
      setGraph(structuredClone((body.draft || body.published)!.graph));
      setValidation((body.draft || body.published)!.validation);
      setDirty(false);
      onWorkflowChanged?.(body.workflow.id);
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Could not publish the workflow");
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

  async function exportWorkflow() {
    const current = dirty ? await saveDraft() : detail;
    if (!current) return;
    const version = current.draft ? "draft" : "published";
    window.location.assign(`/api/automation-workflows/${encodeURIComponent(current.workflow.id)}/export?version=${version}`);
  }

  const filteredDefinitions = automationNodeDefinitions().filter((definition) => `${definition.title} ${definition.description} ${definition.category}`.toLowerCase().includes(search.trim().toLowerCase()));
  const currentGroup = typeof view === "object" ? graph?.groups.find((group) => group.id === view.groupId) : null;
  const selectedSlotType = selectedNode?.type === "integration.http-request" ? "credential" : selectedNode?.type === "logic.run-subworkflow" || selectedNode?.type === "logic.map-subworkflow" ? "subworkflow" : null;
  const selectedSlotKey = selectedSlotType === "credential" ? String(selectedNode?.config.credentialSlot || "") : selectedSlotType === "subworkflow" ? String(selectedNode?.config.subworkflowSlot || "") : "";
  const selectedDeploymentBinding = bindingOptions.bindings.find((binding) => binding.slotKey === selectedSlotKey && binding.type === selectedSlotType);
  const selectedCredentialKind = String(selectedNode?.config.credentialKind || "bearer");
  const credentialFormReady = Boolean(newCredentialName.trim() && newCredentialValue && (selectedCredentialKind !== "basic" || newCredentialUsername) && (selectedCredentialKind !== "header" || newCredentialHeaderName));

  return <div className="automation-editor-overlay" role="dialog" aria-modal="true" aria-label="Automation workflow editor" onPointerDown={(event) => event.stopPropagation()}>
    <div className="automation-editor-shell">
      <header className="automation-editor-topbar">
        <div className="automation-editor-title">
          <button type="button" onClick={() => dirty ? setConfirmClose(true) : onClose()} aria-label="Close workflow editor"><ArrowLeft size={16} /></button>
          <span><small>AUTOMATION CANVAS</small><input aria-label="Workflow name" value={name} disabled={Boolean(readOnly)} onChange={(event) => { setName(event.target.value); setDirty(true); }} /></span>
          <i className={detail?.workflow.status === "published" || detail?.workflow.status === "system" ? "is-published" : ""}>{detail?.workflow.status === "system" ? "System template" : detail?.workflow.status === "published" ? "Published" : "Draft"}</i>
        </div>
        <div className="automation-editor-actions">
          {validation && <button type="button" className={`automation-validation-pill ${validation.valid ? "is-valid" : ""}`} onClick={() => {
            const nextValidation = validateAutomationWorkflowGraph(graph);
            setValidation(nextValidation);
            if (!nextValidation.valid) {
              setError(nextValidation.issues.slice(0, 4).map((entry) => entry.message).join(" · "));
              const firstNodeId = nextValidation.issues.find((entry) => entry.nodeId)?.nodeId;
              if (firstNodeId) { setView("all"); setSelectedId(firstNodeId); }
            }
          }}>{validation.valid ? <Check size={13} /> : <CircleAlert size={13} />}{validation.valid ? "Valid" : `${validation.issues.length} issues`}</button>}
          <div className="automation-manage-menu" ref={manageMenuRef}>
            <button type="button" className={manageOpen ? "is-open" : ""} aria-haspopup="menu" aria-expanded={manageOpen} onClick={() => setManageOpen((open) => !open)}><MoreHorizontal size={15} /> Manage</button>
            {manageOpen && <div role="menu">
              <button type="button" role="menuitem" onClick={() => { setManageOpen(false); setOperationsView("runs"); }}><Workflow size={14} /><span><b>Run history</b><small>Inspect runs and retries</small></span></button>
              {(capabilities.edit || capabilities.publish) && <button type="button" role="menuitem" onClick={() => { setManageOpen(false); setOperationsView("versions"); }}><History size={14} /><span><b>Versions</b><small>Restore an earlier draft</small></span></button>}
              {capabilities.manageTriggers && <button type="button" role="menuitem" onClick={() => { setManageOpen(false); setOperationsView("triggers"); }}><Settings2 size={14} /><span><b>Triggers</b><small>Schedules, events and delivery</small></span></button>}
              {(capabilities.run || capabilities.edit) && <button type="button" role="menuitem" onClick={() => { setManageOpen(false); setOperationsView("fixtures"); }}><FlaskConical size={14} /><span><b>Step preview</b><small>Test with saved examples</small></span></button>}
              <button type="button" role="menuitem" onClick={() => { setManageOpen(false); setSelectedId(null); setMobileInspectorOpen(true); }}><Settings2 size={14} /><span><b>Workflow settings</b><small>Run behavior and limits</small></span></button>
              <button type="button" role="menuitem" disabled={saving} onClick={() => { setManageOpen(false); void exportWorkflow(); }}><Download size={14} /><span><b>Export JSON</b><small>Portable, without credentials</small></span></button>
            </div>}
          </div>
          {systemReadOnly ? capabilities.edit && <button type="button" className="is-primary" disabled={saving} onClick={() => void duplicateSystem()}><Copy size={14} /> Duplicate to customize</button> : <>
            {capabilities.edit && <button type="button" disabled={saving || !dirty} onClick={() => void saveDraft()}><Save size={14} /> {saving ? "Saving" : "Save draft"}</button>}
            {capabilities.publish && <button type="button" className="is-primary" disabled={saving || (dirty && !capabilities.edit)} onClick={() => void publish()}><Check size={14} /> Publish</button>}
          </>}
        </div>
      </header>

      {error && <div className="automation-editor-error" role="alert"><CircleAlert size={14} /><span>{error}</span><button type="button" aria-label="Dismiss error" onClick={() => setError("")}><X size={13} /></button></div>}

      {loading ? <div className="automation-editor-loading" aria-live="polite"><i /><i /><i /><span>Opening workflow…</span></div> : graph && <div className="automation-editor-body">
        <aside className="automation-node-library">
          <div className="automation-library-head"><span><Plus size={13} /> Add step</span><label><Search size={13} /><input aria-label="Search steps" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search steps…" /></label></div>
          <div className="automation-library-list">
            {(Object.keys(categoryLabels) as Array<keyof typeof categoryLabels>).map((category) => {
              const categoryNodes = filteredDefinitions.filter((definition) => definition.category === category);
              if (!categoryNodes.length) return null;
              return <section key={category}><h3>{categoryLabels[category]}</h3>{categoryNodes.map((definition) => <button type="button" key={`${definition.type}@${definition.version}`} disabled={Boolean(readOnly)} onClick={() => addNode(definition.type, definition.version)}><span className={`is-${definition.accent}`}>{definition.category === "ai" ? <Sparkles size={14} /> : definition.category === "logic" ? <GitBranch size={14} /> : definition.category === "output" ? <Layers3 size={14} /> : <Workflow size={14} />}</span><i><b>{definition.title}</b><small>{definition.description}</small></i><Plus size={12} /></button>)}</section>;
            })}
          </div>
        </aside>

        <main className="automation-flow-stage">
          <div className="automation-flow-breadcrumb">
            <button type="button" className={view === "groups" ? "is-active" : ""} onClick={() => { setView("groups"); setSelectedId(null); setMobileInspectorOpen(false); }}>Workflow</button>
            {currentGroup && <><ChevronRight size={12} /><span>{currentGroup.name}</span></>}
            <div><button type="button" className={view === "all" ? "is-active" : ""} onClick={() => { setView("all"); setSelectedId(null); setMobileInspectorOpen(false); }}><Braces size={12} /> All steps</button></div>
          </div>
          <ReactFlow
            nodes={display.nodes}
            edges={display.edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.22, minZoom: 0.2, maxZoom: 1.1 }}
            minZoom={0.08}
            maxZoom={1.7}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly && view !== "groups"}
            elementsSelectable
            deleteKeyCode={null}
            onNodeClick={(_, node) => { setSelectedId(node.id); setMobileInspectorOpen(true); }}
            onEdgeClick={(_, edge) => { setSelectedId(`edge:${edge.id}`); setMobileInspectorOpen(true); }}
            onNodeDoubleClick={(_, node) => {
              if (node.data.syntheticGroup && node.data.group) { setView({ groupId: node.data.group.id }); setSelectedId(null); setMobileInspectorOpen(false); }
            }}
            onNodeDragStop={(_, flowNode) => mutateGraph((current) => {
              if (flowNode.id.startsWith("group:")) return { ...current, groups: current.groups.map((group) => `group:${group.id}` === flowNode.id ? { ...group, position: flowNode.position } : group) };
              return { ...current, nodes: current.nodes.map((node) => node.id === flowNode.id ? { ...node, position: flowNode.position } : node) };
            })}
            onConnect={onConnect}
            onEdgesDelete={(edges) => mutateGraph((current) => ({ ...current, edges: current.edges.filter((edge) => !edges.some((removed) => removed.id === edge.id)) }))}
            onPaneClick={() => { setSelectedId(null); setMobileInspectorOpen(false); }}
          >
            <Background color="var(--ff-grid-dot)" gap={28} size={1.15} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </main>

        <aside className={`automation-node-inspector ${mobileInspectorOpen ? "is-open" : ""}`}>
          <button type="button" className="automation-inspector-close" aria-label="Close settings" onClick={() => setMobileInspectorOpen(false)}><X size={15} /></button>
          {selectedGroup ? <div className="automation-inspector-empty is-group"><Layers3 size={20} /><small>COLLAPSED SUBFLOW</small><h2>{selectedGroup.name}</h2><p>{selectedGroup.description}</p><button type="button" onClick={() => { setView({ groupId: selectedGroup.id }); setSelectedId(null); setMobileInspectorOpen(false); }}>Open {selectedGroup.nodeIds.length} steps <ChevronRight size={13} /></button></div>
            : selectedEdge ? <div className="automation-inspector-empty is-group"><GitBranch size={20} /><small>CONNECTION</small><h2>{graph.nodes.find((node) => node.id === selectedEdge.source)?.name || "Step"} → {graph.nodes.find((node) => node.id === selectedEdge.target)?.name || "Step"}</h2><p>{selectedEdge.sourcePort} → {selectedEdge.targetPort}</p>{!readOnly && <button type="button" className="is-danger" onClick={removeSelectedEdge}><Trash2 size={13} /> Remove connection</button>}</div>
            : selectedNode && selectedDefinition ? <>
              <header><span className={`is-${selectedDefinition.accent}`}><Settings2 size={15} /></span><div><small>{categoryLabels[selectedDefinition.category]} · advanced type {selectedDefinition.type}@{selectedDefinition.version}</small><input aria-label="Step name" value={selectedNode.name} disabled={Boolean(readOnly)} onChange={(event) => mutateGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === selectedNode.id ? { ...node, name: event.target.value } : node) }))} /></div></header>
              <div className="automation-inspector-scroll">
                <label className="automation-inspector-field"><span><b>Description</b></span><textarea disabled={Boolean(readOnly)} value={selectedNode.description} onChange={(event) => mutateGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === selectedNode.id ? { ...node, description: event.target.value } : node) }))} /></label>
                {selectedDefinition.fields.filter((field) => !field.visibleWhen || field.visibleWhen.values.some((value) => {
                  const controlling = selectedNode.bindings[field.visibleWhen!.fieldId]?.mode === "fixed" && selectedNode.bindings[field.visibleWhen!.fieldId]?.value !== undefined
                    ? selectedNode.bindings[field.visibleWhen!.fieldId].value
                    : selectedNode.config[field.visibleWhen!.fieldId] ?? selectedDefinition.fields.find((candidate) => candidate.id === field.visibleWhen!.fieldId)?.defaultValue;
                  return Object.is(value, controlling);
                })).map((field) => <FieldEditor
                  key={`${selectedNode.id}:${field.id}`}
                  field={field}
                  node={selectedNode}
                  disabled={Boolean(readOnly)}
                  options={selectedFieldOptions(field)}
                  onConfig={(value) => updateSelectedFieldConfig(field, value)}
                  onBinding={(askOnRun) => updateSelectedFieldBinding(field, askOnRun)}
                  onRequired={(required) => updateSelectedFieldRequired(field, required)}
                />)}
                {selectedSlotType && <section className="automation-deployment-binding"><small>DEPLOYMENT BINDING</small><h3>{selectedSlotType === "credential" ? "Connect credential" : "Connect child workflow"}</h3><p>The portable workflow stores only <b>{selectedSlotKey || "a slot name"}</b>. This local connection is never exported.</p>{!selectedSlotKey ? <i>Set the slot name above first.</i> : selectedSlotType === "credential" ? capabilities.manageCredentials ? <>
                  <label><span>Saved credential</span><select disabled={Boolean(readOnly || saving)} value={selectedDeploymentBinding?.credentialId || ""} onChange={(event) => void saveDeploymentBinding("credential", selectedSlotKey, event.target.value)}><option value="">Choose saved credential…</option>{bindingOptions.credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.name} · {credential.kind} · {credential.fingerprint}</option>)}</select></label>
                  {!readOnly && <details><summary>Create a new credential</summary><div><label><span>Name</span><input value={newCredentialName} onChange={(event) => setNewCredentialName(event.target.value)} placeholder="Production API key…" /></label>{selectedCredentialKind === "basic" && <label><span>Username</span><input value={newCredentialUsername} onChange={(event) => setNewCredentialUsername(event.target.value)} placeholder="Username…" autoComplete="username" /></label>}{selectedCredentialKind === "header" && <label><span>Header name</span><input value={newCredentialHeaderName} onChange={(event) => setNewCredentialHeaderName(event.target.value)} placeholder="X-API-Key…" /></label>}<label><span>{selectedCredentialKind === "basic" ? "Password" : "Secret value"}</span><input type="password" value={newCredentialValue} onChange={(event) => setNewCredentialValue(event.target.value)} placeholder={selectedCredentialKind === "basic" ? "Password…" : "Secret value…"} autoComplete="new-password" /></label><button type="button" disabled={saving || !credentialFormReady} onClick={() => void createAndBindCredential(selectedSlotKey, selectedCredentialKind)}>Save & connect</button></div></details>}
                </> : <i>Your workspace role cannot manage credentials.</i> : <select disabled={Boolean(readOnly || saving)} value={selectedDeploymentBinding?.targetWorkflowId || ""} onChange={(event) => void saveDeploymentBinding("subworkflow", selectedSlotKey, event.target.value)}><option value="">Choose published workflow</option>{bindingOptions.workflows.filter((workflow) => workflow.id !== detail?.workflow.id && workflow.publishedVersionId).map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select>}</section>}
                {!readOnly && <div className="automation-inspector-danger"><button type="button" onClick={removeSelectedNode}><Trash2 size={13} /> Remove step</button></div>}
              </div>
            </> : <div className="automation-workflow-policy"><Workflow size={20} /><small>WORKFLOW SETTINGS</small><h2>Run behavior</h2><p>Choose what happens when runs overlap. Advanced safety limits stay out of the way until you need them.</p>
              <label><span>When another run is active</span><select disabled={Boolean(readOnly)} value={(graph.settings || DEFAULT_AUTOMATION_WORKFLOW_SETTINGS).overlapPolicy} onChange={(event) => mutateGraph((current) => ({ ...current, settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, ...(current.settings || {}), overlapPolicy: event.target.value as "queue" | "skip" | "cancel-previous" } }))}><option value="queue">Queue the new run</option><option value="skip">Skip the new run</option><option value="cancel-previous">Cancel the previous run</option></select></label>
              <label><span>Concurrent runs</span><input type="number" disabled={Boolean(readOnly)} min={1} max={32} value={(graph.settings || DEFAULT_AUTOMATION_WORKFLOW_SETTINGS).maxConcurrentRuns} onChange={(event) => mutateGraph((current) => ({ ...current, settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, ...(current.settings || {}), maxConcurrentRuns: Number(event.target.value) } }))} /></label>
              <details className="automation-advanced-settings"><summary>Advanced safety limits</summary><div>{([
              ["timeoutSeconds", "Timeout, seconds", 60, 86400],
              ["maxNodeExecutions", "Maximum step executions", 1, 100000],
              ["maxGeneratedAssets", "Maximum generated assets", 1, 5000],
              ["maxParallelism", "Maximum parallel work", 1, 32],
              ["maxSubworkflowDepth", "Subworkflow depth", 1, 16],
            ] as const).map(([key, label, min, max]) => <label key={key}><span>{label}</span><input type="number" disabled={Boolean(readOnly)} min={min} max={max} value={(graph.settings || DEFAULT_AUTOMATION_WORKFLOW_SETTINGS)[key]} onChange={(event) => mutateGraph((current) => ({ ...current, settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, ...(current.settings || {}), [key]: Number(event.target.value) } }))} /></label>)}
              <label><span>Maximum credits <i>optional</i></span><input type="number" disabled={Boolean(readOnly)} min={0} value={(graph.settings || DEFAULT_AUTOMATION_WORKFLOW_SETTINGS).maxCredits ?? ""} placeholder="No workflow cap" onChange={(event) => mutateGraph((current) => ({ ...current, settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, ...(current.settings || {}), maxCredits: event.target.value === "" ? null : Number(event.target.value) } }))} /></label>
              </div></details>
              {view === "groups" && <button type="button" onClick={() => setView("all")}><Braces size={13} /> Show every step</button>}
            </div>}
        </aside>
      </div>}
    </div>

    {confirmClose && <div className="automation-unsaved-dialog"><div><small>UNSAVED CHANGES</small><h3>Close without saving?</h3><p>Your current draft changes exist only in this window.</p><span><button type="button" onClick={() => setConfirmClose(false)}>Keep editing</button><button type="button" className="is-danger" onClick={onClose}>Discard changes</button></span></div></div>}
    {operationsView && detail && <AutomationWorkflowOperations
      projectId={projectId}
      workflowId={detail.workflow.id}
      readOnly={Boolean(readOnly)}
      capabilities={detail.capabilities}
      runInputFields={detail.published ? automationRunInputFields(detail.published.graph) : []}
      workflowNodes={(detail.draft || detail.published)?.graph.nodes.map((node) => { const definition = automationNodeDefinition(node.type, node.version); return { id: node.id, name: node.name, type: node.type, category: definition?.category || "logic", inputs: (definition?.inputs || []).map((port) => ({ id: port.id, label: port.label, required: Boolean(port.required) })) }; }) || []}
      initialView={operationsView}
      onClose={() => setOperationsView(null)}
      onRestored={(restored) => {
        const version = restored.draft || restored.published;
        setDetail({ ...restored, capabilities: detail.capabilities });
        if (version) { setGraph(structuredClone(version.graph)); setValidation(version.validation); }
        setName(restored.workflow.name);
        setDirty(false);
        onWorkflowChanged?.(restored.workflow.id);
      }}
    />}
  </div>;
}
