import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { automationPermissions } from "../src/editions/contracts/access";
import { executeAutomationNodePreview } from "../src/lib/automation-workflows/runtime";
import { parseAutomationProductEvent } from "../src/lib/automation-workflows/product-events";
import { nextAutomationScheduleAt, parseAutomationScheduleConfig } from "../src/lib/automation-workflows/schedules";
import type { AutomationWorkflowGraph } from "../src/lib/automation-workflows/types";

test("automation RBAC exposes independent team capabilities", () => {
  assert.deepEqual(automationPermissions, [
    "automation.run",
    "automation.edit",
    "automation.publish",
    "automation.triggers.manage",
    "automation.credentials.manage",
  ]);
});

test("calendar schedules are timezone aware and reject ambiguous timer syntax", () => {
  const config = parseAutomationScheduleConfig({ mode: "calendar", cron: "30 9 * * 1-5", timezone: "America/New_York", misfirePolicy: "catch-up-once" });
  assert.equal(config.mode, "calendar");
  assert.equal(nextAutomationScheduleAt(config, "2026-08-28T14:00:00.000Z"), "2026-08-31T13:30:00.000Z");
  assert.throws(() => parseAutomationScheduleConfig({ mode: "calendar", cron: "0 0 9 * * 1-5", timezone: "UTC", misfirePolicy: "skip" }), /five cron fields/i);
  assert.throws(() => parseAutomationScheduleConfig({ mode: "calendar", cron: "0 9 * * *", timezone: "Mars\/Olympus", misfirePolicy: "skip" }), /valid IANA timezone/i);
});

test("node preview executes only the selected node with captured port data", async () => {
  const graph: AutomationWorkflowGraph = {
    schemaVersion: 1,
    nodes: [
      { id: "start", type: "core.manual-trigger", version: 1, name: "Start", description: "", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
      { id: "finish", type: "output.finish", version: 1, name: "Finish", description: "", position: { x: 200, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false },
    ],
    edges: [{ id: "start-finish", source: "start", sourcePort: "run", target: "finish", targetPort: "data" }],
    groups: [],
  };
  let calls = 0;
  const result = await executeAutomationNodePreview({
    graph,
    nodeId: "finish",
    nodeInputs: { data: { exact: "fixture" } },
    context: { runId: "preview", userId: "user", workspaceId: "workspace", projectId: "project", runtimeInputs: {}, runKind: "node-preview" },
    handlers: {
      "output.finish@1": async ({ inputs }) => { calls += 1; return { result: inputs.data }; },
      "core.manual-trigger@1": async () => { throw new Error("ancestor must not run"); },
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.output, { result: { exact: "fixture" } });
});

test("migration persists delivery leases, DLQ history, alerts and fixtures", async () => {
  const migration = await readFile(new URL("../database/migrations/core/001_automation_workflows.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE public\.automation_trigger_deliveries/);
  assert.match(migration, /'dead_letter'/);
  assert.match(migration, /replay_of_delivery_id/);
  assert.match(migration, /CREATE TABLE public\.automation_trigger_alerts/);
  assert.match(migration, /CREATE TABLE public\.automation_workflow_fixtures/);
  assert.match(migration, /'node-preview'/);
  assert.match(migration, /overlap_policy text NOT NULL DEFAULT 'queue'/);
  assert.match(migration, /max_concurrent_runs integer NOT NULL DEFAULT 1/);
  assert.match(migration, /CREATE TABLE public\.automation_notification_outbox/);
  assert.match(migration, /CREATE TABLE public\.automation_product_event_outbox/);
  assert.match(migration, /automation_runs_workspace_active_idx/);
});

test("worker admission is fair across workspaces before selecting the oldest local job", async () => {
  const runs = await readFile(new URL("../src/lib/automation-workflows/runs.ts", import.meta.url), "utf8");
  assert.match(runs, /workspace_candidates AS/);
  assert.match(runs, /ORDER BY running_count, oldest_job, workspace_id LIMIT 1/);
  assert.match(runs, /JOIN eligible_queue eligible ON eligible\.workspace_id = chosen\.workspace_id/);
  assert.match(runs, /ORDER BY candidate\.created_at, candidate\.id/);
});

test("product events are strict, named and explicitly versioned", () => {
  assert.deepEqual(parseAutomationProductEvent({
    name: "generation.completed",
    version: 1,
    payload: { generationId: "generation", nodeId: "node", assetId: "asset", mediaType: "image", operation: "edit" },
  }), {
    name: "generation.completed",
    version: 1,
    payload: { generationId: "generation", nodeId: "node", assetId: "asset", mediaType: "image", operation: "edit" },
  });
  assert.throws(() => parseAutomationProductEvent({
    name: "generation.completed",
    version: 2,
    payload: { generationId: "generation", nodeId: "node", assetId: "asset", mediaType: "image", operation: "edit" },
  }), /version 2/i);
  assert.throws(() => parseAutomationProductEvent({
    name: "tiktok.imported",
    version: 1,
    payload: { sourceUrl: "https://example.com/post", assetIds: ["asset"], title: "Post", hiddenInternalValue: true },
  }), /unrecognized key/i);
});
