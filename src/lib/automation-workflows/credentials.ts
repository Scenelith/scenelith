import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { db, userCanAccessWorkspace } from "@/lib/postgres-db";
import { requireAutomationPermission } from "./permissions";

export type AutomationCredentialKind = "api-key" | "bearer" | "basic" | "header";
export type AutomationCredentialPayload = Record<string, string>;

const managedHttpHeaders = new Set(["host", "connection", "transfer-encoding", "content-length", "proxy-authorization", "upgrade"]);

function exactCredentialPayload(kind: AutomationCredentialKind, payload: AutomationCredentialPayload) {
  const expected = kind === "basic" ? ["username", "password"]
    : kind === "header" ? ["headerName", "value"]
      : kind === "bearer" ? ["token"]
        : ["apiKey"];
  const keys = Object.keys(payload).sort();
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw Object.assign(new Error(`${kind} credentials require exactly: ${expected.join(", ")}`), { code: "CREDENTIAL_PAYLOAD_INVALID" });
  }
  for (const key of expected) {
    if (!String(payload[key] || "").trim()) throw Object.assign(new Error(`Credential field ${key} cannot be empty`), { code: "CREDENTIAL_PAYLOAD_INVALID" });
    if (/\r|\n/.test(payload[key])) throw Object.assign(new Error(`Credential field ${key} cannot contain a line break`), { code: "CREDENTIAL_PAYLOAD_INVALID" });
  }
  if (kind === "header") {
    const headerName = payload.headerName.trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName) || managedHttpHeaders.has(headerName.toLowerCase())) {
      throw Object.assign(new Error("Credential header name is invalid or managed by Scenelith"), { code: "CREDENTIAL_PAYLOAD_INVALID" });
    }
  }
  return Object.fromEntries(expected.map((key) => [key, payload[key]]));
}

function encryptionKeys() {
  const encodedKeys = (process.env.AUTOMATION_CREDENTIAL_ENCRYPTION_KEYS || process.env.AUTOMATION_CREDENTIAL_ENCRYPTION_KEY || "").split(",").map((value) => value.trim()).filter(Boolean);
  const keys = encodedKeys.map((encoded) => Buffer.from(encoded, "base64"));
  if (!keys.length || keys.some((key) => key.length !== 32)) throw new Error("Automation credential encryption keys must be base64 encoded 32-byte keys");
  return keys.map((key) => ({ key, id: createHash("sha256").update(key).digest("hex").slice(0, 12) }));
}

function encrypt(payload: AutomationCredentialPayload) {
  const iv = randomBytes(12);
  const current = encryptionKeys()[0];
  const cipher = createCipheriv("aes-256-gcm", current.key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${current.id}.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decrypt(value: string): AutomationCredentialPayload {
  const [version, keyId, ivValue, tagValue, ciphertextValue] = value.split(".");
  if (version !== "v1" || !keyId || !ivValue || !tagValue || !ciphertextValue) throw new Error("Unsupported encrypted credential format");
  const selected = encryptionKeys().find((candidate) => candidate.id === keyId);
  if (!selected) throw new Error("Credential was encrypted with a key that is not present in the configured key ring");
  const decipher = createDecipheriv("aes-256-gcm", selected.key, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]);
  const parsed = JSON.parse(plaintext.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Credential payload is invalid");
  return Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, String(entry)]));
}

function fingerprint(payload: AutomationCredentialPayload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
}

export async function listAutomationCredentials(userId: string, workspaceId: string) {
  if (!await userCanAccessWorkspace(userId, workspaceId)) return null;
  await requireAutomationPermission(userId, workspaceId, "automation.credentials.manage");
  return await db.prepare(`SELECT id, workspace_id AS "workspaceId", name, kind, fingerprint, created_at AS "createdAt",
    updated_at AS "updatedAt", last_used_at AS "lastUsedAt" FROM automation_credentials WHERE workspace_id = ? ORDER BY name`).all(workspaceId);
}

export async function createAutomationCredential(input: { userId: string; workspaceId: string; name: string; kind: AutomationCredentialKind; payload: AutomationCredentialPayload }) {
  if (!await userCanAccessWorkspace(input.userId, input.workspaceId)) return null;
  await requireAutomationPermission(input.userId, input.workspaceId, "automation.credentials.manage");
  const id = randomUUID();
  const now = new Date().toISOString();
  const payload = exactCredentialPayload(input.kind, input.payload);
  await db.prepare(`INSERT INTO automation_credentials
    (id, workspace_id, name, kind, encrypted_payload, encryption_version, fingerprint, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
    .run(id, input.workspaceId, input.name.trim().slice(0, 120), input.kind, encrypt(payload), fingerprint(payload), input.userId, now, now);
  return { id, workspaceId: input.workspaceId, name: input.name.trim().slice(0, 120), kind: input.kind, fingerprint: fingerprint(payload), createdAt: now, updatedAt: now, lastUsedAt: null };
}

export async function rotateAutomationCredential(input: { userId: string; credentialId: string; payload: AutomationCredentialPayload }) {
  const row = await db.prepare("SELECT workspace_id, kind FROM automation_credentials WHERE id = ?").get(input.credentialId) as { workspace_id: string; kind: AutomationCredentialKind } | undefined;
  if (!row || !await userCanAccessWorkspace(input.userId, row.workspace_id)) return null;
  await requireAutomationPermission(input.userId, row.workspace_id, "automation.credentials.manage");
  const now = new Date().toISOString();
  const payload = exactCredentialPayload(row.kind, input.payload);
  await db.prepare("UPDATE automation_credentials SET encrypted_payload = ?, encryption_version = encryption_version + 1, fingerprint = ?, updated_at = ? WHERE id = ?")
    .run(encrypt(payload), fingerprint(payload), now, input.credentialId);
  return { id: input.credentialId, workspaceId: row.workspace_id, fingerprint: fingerprint(payload), updatedAt: now };
}

export async function deleteAutomationCredential(input: { userId: string; credentialId: string }) {
  const row = await db.prepare("SELECT workspace_id FROM automation_credentials WHERE id = ?").get(input.credentialId) as { workspace_id: string } | undefined;
  if (!row || !await userCanAccessWorkspace(input.userId, row.workspace_id)) return null;
  await requireAutomationPermission(input.userId, row.workspace_id, "automation.credentials.manage");
  const inUse = await db.prepare("SELECT COUNT(*) AS count FROM automation_workflow_bindings WHERE credential_id = ?").get(input.credentialId) as { count: number };
  if (Number(inUse.count || 0) > 0) throw new Error("Disconnect this credential from every workflow before deleting it");
  await db.prepare("DELETE FROM automation_credentials WHERE id = ?").run(input.credentialId);
  return { id: input.credentialId, workspaceId: row.workspace_id };
}

export async function resolveAutomationCredential(input: { workflowId: string; workspaceId: string; slotKey: string; credentialId?: string }) {
  const row = input.credentialId
    ? await db.prepare(`SELECT id, kind, encrypted_payload FROM automation_credentials WHERE id = ? AND workspace_id = ?`)
      .get(input.credentialId, input.workspaceId) as { id: string; kind: AutomationCredentialKind; encrypted_payload: string } | undefined
    : await db.prepare(`SELECT credential.id, credential.kind, credential.encrypted_payload
    FROM automation_workflow_bindings binding JOIN automation_credentials credential ON credential.id = binding.credential_id
    WHERE binding.workflow_id = ? AND binding.workspace_id = ? AND binding.slot_key = ? AND binding.binding_type = 'credential'`)
      .get(input.workflowId, input.workspaceId, input.slotKey) as { id: string; kind: AutomationCredentialKind; encrypted_payload: string } | undefined;
  if (!row) throw Object.assign(new Error(`Credential slot “${input.slotKey}” is not connected`), { code: "CREDENTIAL_BINDING_MISSING" });
  const now = new Date().toISOString();
  await db.prepare("UPDATE automation_credentials SET last_used_at = ? WHERE id = ?").run(now, row.id);
  return { id: row.id, kind: row.kind, payload: exactCredentialPayload(row.kind, decrypt(row.encrypted_payload)) };
}

export async function bindAutomationCredential(input: { userId: string; workflowId: string; workspaceId: string; slotKey: string; credentialId: string }) {
  if (!await userCanAccessWorkspace(input.userId, input.workspaceId)) return null;
  await requireAutomationPermission(input.userId, input.workspaceId, "automation.credentials.manage");
  await db.transaction(async () => {
    const source = await db.prepare("SELECT id FROM automation_workflows WHERE id = ? AND workspace_id = ?").get(input.workflowId, input.workspaceId);
    if (!source) throw new Error("Workflow must belong to the selected workspace");
    const credential = await db.prepare("SELECT id FROM automation_credentials WHERE id = ? AND workspace_id = ?").get(input.credentialId, input.workspaceId);
    if (!credential) throw new Error("Credential must belong to the same workspace as the workflow");
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO automation_workflow_bindings
      (workflow_id, workspace_id, slot_key, binding_type, credential_id, target_workflow_id, config_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'credential', ?, NULL, '{}'::jsonb, ?, ?, ?)
      ON CONFLICT(workflow_id, slot_key) DO UPDATE SET binding_type = 'credential', credential_id = excluded.credential_id,
        target_workflow_id = NULL, created_by = excluded.created_by, updated_at = excluded.updated_at`)
      .run(input.workflowId, input.workspaceId, input.slotKey, input.credentialId, input.userId, now, now);
  })();
  return { workflowId: input.workflowId, slotKey: input.slotKey, credentialId: input.credentialId };
}

export async function bindAutomationSubworkflow(input: { userId: string; workflowId: string; workspaceId: string; slotKey: string; targetWorkflowId: string }) {
  if (!await userCanAccessWorkspace(input.userId, input.workspaceId)) return null;
  await requireAutomationPermission(input.userId, input.workspaceId, "automation.edit");
  if (input.workflowId === input.targetWorkflowId) throw new Error("A workflow cannot bind directly to itself");
  await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-bindings:${input.workspaceId}`);
    const source = await db.prepare("SELECT id FROM automation_workflows WHERE id = ? AND workspace_id = ?").get(input.workflowId, input.workspaceId);
    if (!source) throw new Error("Workflow must belong to the selected workspace");
    const target = await db.prepare("SELECT id FROM automation_workflows WHERE id = ? AND workspace_id = ? AND published_version_id IS NOT NULL").get(input.targetWorkflowId, input.workspaceId);
    if (!target) throw new Error("Target workflow must be live in the same workspace");
    const cycle = await db.prepare(`WITH RECURSIVE dependencies(workflow_id) AS (
      SELECT ?::text UNION
      SELECT binding.target_workflow_id FROM automation_workflow_bindings binding JOIN dependencies dependency ON binding.workflow_id = dependency.workflow_id
      WHERE binding.binding_type = 'subworkflow' AND binding.workspace_id = ?
    ) SELECT 1 AS found FROM dependencies WHERE workflow_id = ? LIMIT 1`).get(input.targetWorkflowId, input.workspaceId, input.workflowId);
    if (cycle) throw new Error("This binding would create a recursive workflow cycle");
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO automation_workflow_bindings
      (workflow_id, workspace_id, slot_key, binding_type, credential_id, target_workflow_id, config_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'subworkflow', NULL, ?, '{}'::jsonb, ?, ?, ?)
      ON CONFLICT(workflow_id, slot_key) DO UPDATE SET binding_type = 'subworkflow', credential_id = NULL,
        target_workflow_id = excluded.target_workflow_id, created_by = excluded.created_by, updated_at = excluded.updated_at`)
      .run(input.workflowId, input.workspaceId, input.slotKey, input.targetWorkflowId, input.userId, now, now);
  })();
  return { workflowId: input.workflowId, slotKey: input.slotKey, targetWorkflowId: input.targetWorkflowId };
}

export async function unbindAutomationWorkflowSlot(input: { userId: string; workflowId: string; workspaceId: string; slotKey: string }) {
  if (!await userCanAccessWorkspace(input.userId, input.workspaceId)) return null;
  const binding = await db.prepare("SELECT binding_type FROM automation_workflow_bindings WHERE workflow_id = ? AND workspace_id = ? AND slot_key = ?")
    .get(input.workflowId, input.workspaceId, input.slotKey) as { binding_type: "credential" | "subworkflow" } | undefined;
  await requireAutomationPermission(input.userId, input.workspaceId, binding?.binding_type === "credential" ? "automation.credentials.manage" : "automation.edit");
  const result = await db.prepare("DELETE FROM automation_workflow_bindings WHERE workflow_id = ? AND workspace_id = ? AND slot_key = ?")
    .run(input.workflowId, input.workspaceId, input.slotKey);
  return { workflowId: input.workflowId, slotKey: input.slotKey, deleted: result.changes === 1 };
}
