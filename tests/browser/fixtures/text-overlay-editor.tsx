import { createRoot } from "react-dom/client";
import { AutomationWorkflowEditorOverlay, type AutomationWorkflowEditorDemo } from "../../../src/components/automation/AutomationWorkflowEditorOverlay";
import { automationNodeSchema, automationWorkflowGraphSchema } from "../../../src/lib/automation-workflows/types";

const workflow = { id: "overlay-demo", workspaceId: "demo", projectId: "demo", name: "Local text overlay", description: "", status: "draft" as const, systemKey: null, draftVersionId: "v1", publishedVersionId: null, sourcePackageDigest: null, createdBy: null, createdAt: "2026-09-14", updatedAt: "2026-09-14" };
const demo: AutomationWorkflowEditorDemo = {
  workflows: [workflow], selectedNodeId: "overlay", inspectorView: "settings",
  detail: { workflow, published: null, systemModelIssues: [], capabilities: { run: true, edit: true, publish: true, manageTriggers: true, manageCredentials: true }, draft: {
    id: "v1", workflowId: workflow.id, version: 1, status: "draft", createdBy: null, createdAt: workflow.createdAt, publishedAt: null, validation: { valid: true, issues: [] },
    graph: automationWorkflowGraphSchema.parse({ schemaVersion: 1, groups: [], edges: [], nodes: [automationNodeSchema.parse({ id: "overlay", type: "media.text-overlay", version: 1, name: "Text overlay", position: { x: 0, y: 0 } })] }),
  } },
};
window.fetch = async (_input, init) => {
  const saved = JSON.parse(String(init?.body));
  document.documentElement.dataset.savedOverlayY = String(saved.graph.nodes[0].config.y);
  return Response.json({ ...demo.detail, draft: { ...demo.detail.draft, graph: saved.graph } });
};
createRoot(document.getElementById("root")!).render(<AutomationWorkflowEditorOverlay workspaceId="demo" projectId="demo" workflowId={workflow.id} sources={[]} personas={[]} models={[]} canvasReferences={[]} runtimeValues={{}} demo={demo} onClose={() => {}} />);
