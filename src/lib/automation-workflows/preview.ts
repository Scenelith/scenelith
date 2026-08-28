import { evaluateAutomationCondition } from "./condition";
import { automationNodeDefinition, automationNodeInputPorts } from "./registry";
import type { AutomationNode, AutomationWorkflowGraph } from "./types";
import { topologicalAutomationNodeIds } from "./validation";
import { automationCreativeControls, splitAutomationCreativeDirection } from "./creative-direction-contract";

const unknownPreviewValue = Symbol("automation-preview-value");

function resolvedPreviewConfig(node: AutomationNode, runtimeInputs: Record<string, unknown>) {
  const config = { ...node.config };
  for (const [fieldId, binding] of Object.entries(node.bindings)) {
    if (binding.mode === "ask-on-run") {
      const runtimeKey = `${node.id}.${fieldId}`;
      config[fieldId] = runtimeKey in runtimeInputs ? runtimeInputs[runtimeKey] : binding.value ?? config[fieldId];
    } else if (binding.value !== undefined) config[fieldId] = binding.value;
  }
  return config;
}

export type AutomationPathPreview = Readonly<{
  activeNodeIds: ReadonlySet<string>;
  activeEdgeIds: ReadonlySet<string>;
}>;

export function previewAutomationPaths(graph: AutomationWorkflowGraph, runtimeInputs: Record<string, unknown>): AutomationPathPreview {
  const activeNodeIds = new Set<string>();
  const activeEdgeIds = new Set<string>();
  const outputs = new Map<string, unknown>();
  const edgeValue = (source: string, port: string) => outputs.get(`${source}:${port}`);
  const hasEdgeValue = (source: string, port: string) => outputs.has(`${source}:${port}`);

  for (const nodeId of topologicalAutomationNodeIds(graph)) {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.disabled) continue;
    const definition = automationNodeDefinition(node.type, node.version);
    if (!definition) continue;
    const inputPorts = automationNodeInputPorts(node);
    const incomingByPort = new Map(inputPorts.map((port) => [port.id, graph.edges.filter((edge) => edge.target === node.id && edge.targetPort === port.id && hasEdgeValue(edge.source, edge.sourcePort))]));
    const ready = inputPorts.every((port) => !port.required || (incomingByPort.get(port.id)?.length || 0) > 0);
    if (!ready) continue;

    const config = resolvedPreviewConfig(node, runtimeInputs);
    // Optional inputs are real graph branches. When the run supplies no
    // identity, the identity node and every edge depending on its output must
    // remain inactive instead of pretending that an empty value flows onward.
    if (node.type === "input.identity" && !String(config.identity || "").trim() && config.optional !== false) continue;

    activeNodeIds.add(node.id);
    for (const edges of incomingByPort.values()) for (const edge of edges) activeEdgeIds.add(edge.id);

    if (node.type === "input.creative-settings") {
      outputs.set(`${node.id}:settings`, {
        mode: String(config.mode || "concept"),
        newOutfit: config.newOutfit !== false,
        newLocation: config.newLocation !== false,
        textStrategy: String(config.textStrategy || "rewrite"),
        creativeBrief: String(config.creativeBrief || ""),
        creativeDirectionPolicy: String(config.creativeDirectionPolicy || "propose"),
      });
      continue;
    }
    if (node.type === "logic.prepare-creative-direction") {
      const settingsEdges = incomingByPort.get("settings") || [];
      const settings = settingsEdges[0] ? edgeValue(settingsEdges[0].source, settingsEdges[0].sourcePort) : undefined;
      if (settings && settings !== unknownPreviewValue && typeof settings === "object" && !Array.isArray(settings)) {
        const record = settings as Record<string, unknown>;
        const rawBrief = String(record[String(config.briefPath || "creativeBrief")] || "").trim();
        outputs.set(`${node.id}:request`, {
          contractVersion: 2,
          briefHash: rawBrief ? "preview-nonempty" : "preview-empty",
          rawBrief,
          clauses: splitAutomationCreativeDirection(rawBrief),
          settings: record,
          controls: automationCreativeControls(config.controls),
          policy: String(record[String(config.policyPath || "creativeDirectionPolicy")] || "propose"),
          sourceSlideIndexes: [],
        });
      } else outputs.set(`${node.id}:request`, unknownPreviewValue);
      continue;
    }
    if (node.type === "ai.interpret-creative-direction") {
      const requestEdges = incomingByPort.get("request") || [];
      const request = requestEdges[0] ? edgeValue(requestEdges[0].source, requestEdges[0].sourcePort) : undefined;
      const clauses = request && request !== unknownPreviewValue && typeof request === "object" && !Array.isArray(request)
        ? (request as Record<string, unknown>).clauses
        : null;
      if (request && request !== unknownPreviewValue && typeof request === "object" && !Array.isArray(request) && Array.isArray(clauses) && !clauses.length) {
        outputs.set(`${node.id}:analysis`, { briefHash: (request as Record<string, unknown>).briefHash, clauseResults: [] });
      } else outputs.set(`${node.id}:analysis`, unknownPreviewValue);
      continue;
    }
    if (node.type === "logic.resolve-creative-direction") {
      const requestEdges = incomingByPort.get("request") || [];
      const request = requestEdges[0] ? edgeValue(requestEdges[0].source, requestEdges[0].sourcePort) : undefined;
      const requestClauses = request && request !== unknownPreviewValue && typeof request === "object" && !Array.isArray(request)
        ? (request as Record<string, unknown>).clauses
        : null;
      if (request && request !== unknownPreviewValue && typeof request === "object" && !Array.isArray(request)
        && Array.isArray(requestClauses) && !requestClauses.length) {
        outputs.set(`${node.id}:resolved`, (request as Record<string, unknown>).settings);
      } else {
        outputs.set(`${node.id}:resolved`, unknownPreviewValue);
        outputs.set(`${node.id}:conflict`, unknownPreviewValue);
      }
      continue;
    }
    if (node.type === "logic.condition") {
      const dataPort = inputPorts.find((port) => port.id === "data");
      const dataEdges = dataPort ? incomingByPort.get(dataPort.id) || [] : [];
      const data = dataEdges.length > 1 ? dataEdges.map((edge) => edgeValue(edge.source, edge.sourcePort)) : dataEdges[0] ? edgeValue(dataEdges[0].source, dataEdges[0].sourcePort) : undefined;
      if (data === unknownPreviewValue || (Array.isArray(data) && data.includes(unknownPreviewValue))) {
        outputs.set(`${node.id}:yes`, unknownPreviewValue);
        outputs.set(`${node.id}:no`, unknownPreviewValue);
      } else {
        outputs.set(`${node.id}:${evaluateAutomationCondition(data, config) ? "yes" : "no"}`, data);
      }
      continue;
    }
    for (const output of definition.outputs) outputs.set(`${node.id}:${output.id}`, unknownPreviewValue);
  }

  return { activeNodeIds, activeEdgeIds };
}
