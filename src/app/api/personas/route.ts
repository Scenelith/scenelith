import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { db, userCanAccessAsset, userCanAccessWorkspace } from "@/lib/postgres-db";
import { createIdentityThumbnail } from "@/lib/image-thumbnails";
import { deleteStorageObject, readStorageObject, safeExtension, saveBytes } from "@/lib/storage";
import { assertWorkspaceStorageCapacity, enqueueStorageDeletion } from "@/lib/storage-lifecycle";
import { mediaContentMatchesMime } from "@/lib/media-content";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { appendAuditEvent } from "@/lib/audit-log";

export const runtime = "nodejs";

const MAX_PERSONA_REFERENCES = 100;
const MAX_PERSONA_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_PERSONA_BATCH_BYTES = 280 * 1024 * 1024;
const PERSONA_ROLES = new Set(["reference", "before", "after"]);

async function listPersonas(workspaceId: string) {
  const personas = await db.prepare("SELECT * FROM personas WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId) as Array<Record<string, unknown>>;
  return Promise.all(personas.map(async (persona) => {
    const assets = await db
      .prepare("SELECT id, filename, role, sort_order, metadata_json FROM assets WHERE persona_id = ? ORDER BY CASE role WHEN 'reference' THEN 0 WHEN 'before' THEN 1 WHEN 'after' THEN 2 ELSE 3 END, sort_order, created_at, id")
      .all(persona.id) as Array<{ id: string; filename: string; role: string | null; sort_order: number; metadata_json: string | null }>;
    const normalizedAssets = assets.map((asset) => {
      let sourceAssetId = "";
      try {
        const metadata = JSON.parse(asset.metadata_json || "{}") as { sourceAssetId?: unknown };
        sourceAssetId = typeof metadata.sourceAssetId === "string" ? metadata.sourceAssetId : "";
      } catch {}
      return {
        id: asset.id,
        filename: asset.filename,
        sortOrder: asset.sort_order,
        role: asset.role === "after" ? "after" as const : asset.role === "reference" ? "reference" as const : "before" as const,
        url: `/api/assets/${asset.id}`,
        thumbnailUrl: `/api/assets/${asset.id}?variant=thumbnail&delivery=direct&v=2`,
        ...(sourceAssetId ? { sourceAssetId } : {}),
      };
    });
    const avatar = normalizedAssets.find((asset) => asset.role === "after") || normalizedAssets.find((asset) => asset.role === "reference") || normalizedAssets[0];
    return {
      id: String(persona.id),
      name: String(persona.name),
      notes: String(persona.notes),
      workspaceId: String(persona.workspace_id),
      createdAt: String(persona.created_at),
      avatarUrl: avatar?.thumbnailUrl || avatar?.url,
      assets: normalizedAssets,
    };
  }));
}

async function storePersonaFiles(workspaceId: string, personaId: string, entries: Array<{ file: File; role: "reference" | "before" | "after"; sourceAssetId?: string }>, startIndex = 0) {
  const now = new Date().toISOString();
  const written: Array<{ id: string; storagePaths: string[] }> = [];
  const nextOrder = new Map<"reference" | "before" | "after", number>();
  const orderRows = await db.prepare("SELECT role, COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM assets WHERE persona_id = ? GROUP BY role").all(personaId) as Array<{ role: "reference" | "before" | "after"; next_order: number }>;
  for (const row of orderRows) nextOrder.set(row.role, Number(row.next_order));
  try {
    for (const [index, { file, role, sourceAssetId }] of entries.entries()) {
      const assetId = crypto.randomUUID();
      const filename = `ref-${String(startIndex + index + 1).padStart(3, "0")}-${assetId.slice(0, 8)}${safeExtension(file.name, file.type)}`;
      const sortOrder = nextOrder.get(role) || 0;
      const bytes = await file.arrayBuffer();
      const stored = await saveBytes(bytes, `workspaces/${workspaceId}/personas/${personaId}`, filename, file.type);
      const writtenAsset = { id: assetId, storagePaths: [stored.reference] };
      written.push(writtenAsset);
      const { stored: thumbnail } = await createIdentityThumbnail(bytes, {
        id: assetId,
        workspaceId,
        personaId,
        storagePath: stored.reference,
        objectKey: stored.key,
      });
      writtenAsset.storagePaths.push(thumbnail.reference);
      await db.transaction(async () => {
        await assertWorkspaceStorageCapacity(workspaceId, stored.size + thumbnail.size);
        await db.prepare(
          `INSERT INTO assets (id, workspace_id, persona_id, kind, role, sort_order, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash, thumbnail_storage_path, thumbnail_size_bytes, thumbnail_content_hash, thumbnail_mime_type, mime_type, metadata_json, created_at)
           VALUES (?, ?, ?, 'persona_ref', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'image/webp', ?, ?, ?)`,
        ).run(assetId, workspaceId, personaId, role, sortOrder, filename, stored.reference, stored.provider, stored.bucket, stored.key, stored.size, stored.contentHash, thumbnail.reference, thumbnail.size, thumbnail.contentHash, file.type, JSON.stringify(sourceAssetId ? { sourceAssetId } : {}), now);
      })();
      nextOrder.set(role, sortOrder + 1);
    }
  } catch (error) {
    for (const asset of written) {
      for (const storagePath of asset.storagePaths) await deleteStorageObject(storagePath).catch(() => undefined);
      await db.prepare("DELETE FROM assets WHERE id = ?").run(asset.id);
    }
    throw error;
  }
  return written.map((asset) => asset.id);
}

const supportedImageTypes = new Set(["image/jpeg", "image/jpg", "image/png"]);

async function invalidPersonaFile(files: File[]) {
  if (files.some((file) => file.size > MAX_PERSONA_IMAGE_BYTES)) return "Each reference must be smaller than 25 MB";
  if (files.reduce((total, file) => total + file.size, 0) > MAX_PERSONA_BATCH_BYTES) return "References are too large to upload together";
  for (const file of files) {
    const prefix = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    if (!mediaContentMatchesMime(prefix, file.type)) return `${file.name || "Reference"} does not match its format`;
  }
  return null;
}

async function readPersonaForm(request: Request) {
  try {
    return await request.formData();
  } catch (error) {
    console.error("Identity multipart upload could not be read", error);
    return null;
  }
}

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const workspaceId = new URL(request.url).searchParams.get("workspaceId") || "";
  if (!workspaceId) return Response.json({ error: "workspaceId is required" }, { status: 400 });
  if (!await userCanAccessWorkspace(auth.user.id, workspaceId)) return Response.json({ error: "App not found" }, { status: 404 });
  return Response.json({ personas: await listPersonas(workspaceId) });
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "identity-upload", identity: auth.user.id, limit: 20, windowSeconds: 600 });
  if (limited) return limited;
  if (request.headers.get("content-type")?.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { workspaceId?: string; name?: string; role?: string; sourceAssetId?: string };
    const workspaceId = String(body.workspaceId || "");
    const name = String(body.name || "").trim();
    const role = String(body.role || "");
    const sourceAssetId = String(body.sourceAssetId || "");
    if (!workspaceId || !name) return Response.json({ error: "Give this identity a name" }, { status: 400 });
    if (!PERSONA_ROLES.has(role)) return Response.json({ error: "Choose a valid reference group" }, { status: 400 });
    if (!await userCanAccessWorkspace(auth.user.id, workspaceId)) return Response.json({ error: "App not found" }, { status: 404 });
    if (!sourceAssetId || !await userCanAccessAsset(auth.user.id, sourceAssetId)) return Response.json({ error: "Generated image not found" }, { status: 404 });
    const source = await db.prepare("SELECT id, filename, storage_path, mime_type FROM assets WHERE id = ? AND workspace_id = ?").get(sourceAssetId, workspaceId) as { id: string; filename: string; storage_path: string; mime_type: string } | undefined;
    if (!source || !source.mime_type.startsWith("image/")) return Response.json({ error: "Only generated images can create an identity" }, { status: 400 });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO personas (id, workspace_id, name, notes, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)").run(id, workspaceId, name.slice(0, 80), now, now);
    try {
      const bytes = await readStorageObject(source.storage_path);
      const file = new File([bytes], source.filename || `generated-${source.id}.png`, { type: source.mime_type });
      const invalidFile = await invalidPersonaFile([file]);
      if (invalidFile) throw new Error(invalidFile);
      await storePersonaFiles(workspaceId, id, [{ file, role: role as "reference" | "before" | "after", sourceAssetId }]);
    } catch (error) {
      await db.prepare("DELETE FROM personas WHERE id = ?").run(id);
      console.error("Identity could not be created from generated image", error);
      return Response.json({ error: "Could not create an identity from this image. Please try again." }, { status: 502 });
    }
    await appendAuditEvent({ workspaceId, actorUserId: auth.user.id, action: "identity.created", targetType: "identity", targetId: id, metadata: { referenceCount: 1, sourceAssetId, role } });
    return Response.json({ personas: await listPersonas(workspaceId), personaId: id });
  }
  const form = await readPersonaForm(request);
  if (!form) return Response.json({ error: "The upload could not be read. Keep the total below 300 MB and try again." }, { status: 413 });
  const name = String(form.get("name") || "").trim();
  const notes = String(form.get("notes") || "").trim();
  const workspaceId = String(form.get("workspaceId") || "");
  const beforeFiles = form.getAll("beforeImages").filter((value): value is File => value instanceof File && value.size > 0);
  const afterFiles = form.getAll("afterImages").filter((value): value is File => value instanceof File && value.size > 0);
  const referenceFiles = form.getAll("referenceImages").filter((value): value is File => value instanceof File && value.size > 0);
  const files = [...referenceFiles, ...beforeFiles, ...afterFiles];
  if (!workspaceId || !name || !files.length) return Response.json({ error: "Project, name and at least one character reference are required" }, { status: 400 });
  if (!await userCanAccessWorkspace(auth.user.id, workspaceId)) return Response.json({ error: "App not found" }, { status: 404 });
  if (files.length > MAX_PERSONA_REFERENCES) return Response.json({ error: `Up to ${MAX_PERSONA_REFERENCES} reference images per identity` }, { status: 400 });
  if (files.some((file) => !supportedImageTypes.has(file.type))) {
    return Response.json({ error: "Use JPG or PNG references" }, { status: 400 });
  }
  const invalidFile = await invalidPersonaFile(files);
  if (invalidFile) return Response.json({ error: invalidFile }, { status: 400 });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO personas (id, workspace_id, name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    workspaceId,
    name.slice(0, 80),
    notes.slice(0, 2000),
    now,
    now,
  );
  const groupedFiles = [
    ...referenceFiles.map((file) => ({ file, role: "reference" as const })),
    ...beforeFiles.map((file) => ({ file, role: "before" as const })),
    ...afterFiles.map((file) => ({ file, role: "after" as const })),
  ];
  try {
    await storePersonaFiles(workspaceId, id, groupedFiles);
  } catch (error) {
    await db.prepare("DELETE FROM personas WHERE id = ?").run(id);
    console.error("Identity reference upload failed", error);
    return Response.json({ error: "Reference upload failed. Please try again." }, { status: 502 });
  }
  await appendAuditEvent({ workspaceId, actorUserId: auth.user.id, action: "identity.created", targetType: "identity", targetId: id, metadata: { referenceCount: files.length } });
  return Response.json({ personas: await listPersonas(workspaceId) });
}

export async function PATCH(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "identity-upload", identity: auth.user.id, limit: 20, windowSeconds: 600 });
  if (limited) return limited;
  if (request.headers.get("content-type")?.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { workspaceId?: string; personaId?: string; role?: string; sourceAssetId?: string };
    const workspaceId = String(body.workspaceId || "");
    const personaId = String(body.personaId || "");
    const role = String(body.role || "");
    const sourceAssetId = String(body.sourceAssetId || "");
    if (!PERSONA_ROLES.has(role)) return Response.json({ error: "Choose a valid reference group" }, { status: 400 });
    if (!await userCanAccessWorkspace(auth.user.id, workspaceId)) return Response.json({ error: "App not found" }, { status: 404 });
    if (!sourceAssetId || !await userCanAccessAsset(auth.user.id, sourceAssetId)) return Response.json({ error: "Generated image not found" }, { status: 404 });
    const persona = await db.prepare("SELECT id FROM personas WHERE id = ? AND workspace_id = ?").get(personaId, workspaceId);
    if (!persona) return Response.json({ error: "Identity not found" }, { status: 404 });
    const source = await db.prepare("SELECT id, filename, storage_path, mime_type FROM assets WHERE id = ? AND workspace_id = ?").get(sourceAssetId, workspaceId) as { id: string; filename: string; storage_path: string; mime_type: string } | undefined;
    if (!source || !source.mime_type.startsWith("image/")) return Response.json({ error: "Only generated images can be added to an identity" }, { status: 400 });
    const existing = await db.prepare("SELECT id FROM assets WHERE persona_id = ? AND role = ? AND metadata_json->>'sourceAssetId' = ?").get(personaId, role, sourceAssetId);
    if (existing) return Response.json({ personas: await listPersonas(workspaceId), alreadyAdded: true });
    const existingCount = Number((await db.prepare("SELECT COUNT(*) AS count FROM assets WHERE persona_id = ?").get(personaId) as { count: number }).count || 0);
    if (existingCount >= MAX_PERSONA_REFERENCES) return Response.json({ error: "This identity already has 100 references" }, { status: 400 });
    try {
      const bytes = await readStorageObject(source.storage_path);
      const file = new File([bytes], source.filename || `generated-${source.id}.png`, { type: source.mime_type });
      const invalidFile = await invalidPersonaFile([file]);
      if (invalidFile) return Response.json({ error: invalidFile }, { status: 400 });
      await storePersonaFiles(workspaceId, personaId, [{ file, role: role as "reference" | "before" | "after", sourceAssetId }], existingCount);
    } catch (error) {
      console.error("Generated image could not be added to identity", error);
      return Response.json({ error: "Could not add this image to the identity. Please try again." }, { status: 502 });
    }
    await db.prepare("UPDATE personas SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), personaId);
    await appendAuditEvent({ workspaceId, actorUserId: auth.user.id, action: "identity.generated_reference_added", targetType: "identity", targetId: personaId, metadata: { role, sourceAssetId } });
    return Response.json({ personas: await listPersonas(workspaceId), alreadyAdded: false });
  }
  const form = await readPersonaForm(request);
  if (!form) return Response.json({ error: "The upload could not be read. Keep the total below 300 MB and try again." }, { status: 413 });
  const workspaceId = String(form.get("workspaceId") || "");
  const personaId = String(form.get("personaId") || "");
  const requestedRole = String(form.get("role") || "reference");
  const role = requestedRole === "after" ? "after" as const : requestedRole === "before" ? "before" as const : "reference" as const;
  const files = form.getAll("images").filter((value): value is File => value instanceof File && value.size > 0);
  if (!await userCanAccessWorkspace(auth.user.id, workspaceId)) return Response.json({ error: "App not found" }, { status: 404 });
  const persona = await db.prepare("SELECT id FROM personas WHERE id = ? AND workspace_id = ?").get(personaId, workspaceId);
  if (!persona) return Response.json({ error: "Identity not found" }, { status: 404 });
  if (!files.length) return Response.json({ error: "Choose at least one image" }, { status: 400 });
  if (files.some((file) => !supportedImageTypes.has(file.type))) return Response.json({ error: "Use JPG or PNG references" }, { status: 400 });
  const invalidFile = await invalidPersonaFile(files);
  if (invalidFile) return Response.json({ error: invalidFile }, { status: 400 });
  const existingCount = Number((await db.prepare("SELECT COUNT(*) AS count FROM assets WHERE persona_id = ?").get(personaId) as { count: number }).count || 0);
  if (existingCount + files.length > MAX_PERSONA_REFERENCES) return Response.json({ error: `${MAX_PERSONA_REFERENCES - existingCount} reference slots remain` }, { status: 400 });
  try {
    await storePersonaFiles(workspaceId, personaId, files.map((file) => ({ file, role })), existingCount);
  } catch (error) {
    console.error("Identity reference append failed", error);
    return Response.json({ error: "Reference upload failed. Please try again." }, { status: 502 });
  }
  await db.prepare("UPDATE personas SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), personaId);
  await appendAuditEvent({ workspaceId, actorUserId: auth.user.id, action: "identity.references_added", targetType: "identity", targetId: personaId, metadata: { role, referenceCount: files.length } });
  return Response.json({ personas: await listPersonas(workspaceId) });
}

export async function PUT(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: string; personaId?: string; role?: string; assetIds?: string[] };
  const workspaceId = String(body.workspaceId || "");
  const personaId = String(body.personaId || "");
  const role = String(body.role || "");
  const assetIds = Array.isArray(body.assetIds) ? body.assetIds.map(String) : [];
  if (!await userCanAccessWorkspace(auth.user.id, workspaceId)) return Response.json({ error: "App not found" }, { status: 404 });
  if (!PERSONA_ROLES.has(role)) return Response.json({ error: "Invalid reference group" }, { status: 400 });
  const persona = await db.prepare("SELECT id FROM personas WHERE id = ? AND workspace_id = ?").get(personaId, workspaceId);
  if (!persona) return Response.json({ error: "Identity not found" }, { status: 404 });
  const storedIds = (await db.prepare("SELECT id FROM assets WHERE persona_id = ? AND role = ? ORDER BY sort_order, created_at, id").all(personaId, role) as Array<{ id: string }>).map((asset) => asset.id);
  const uniqueIds = new Set(assetIds);
  if (assetIds.length !== storedIds.length || uniqueIds.size !== storedIds.length || storedIds.some((id) => !uniqueIds.has(id))) {
    return Response.json({ error: "References changed while reordering. Try again." }, { status: 409 });
  }
  const updateOrder = db.prepare("UPDATE assets SET sort_order = ? WHERE id = ? AND persona_id = ? AND role = ?");
  await db.transaction(async () => {
    assetIds.forEach((assetId, index) => updateOrder.run(index, assetId, personaId, role));
    await db.prepare("UPDATE personas SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), personaId);
  })();
  return Response.json({ personas: await listPersonas(workspaceId) });
}

export async function DELETE(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: string; personaId?: string; assetId?: string };
  const workspaceId = String(body.workspaceId || "");
  const personaId = String(body.personaId || "");
  const assetId = String(body.assetId || "");
  if (!await userCanAccessWorkspace(auth.user.id, workspaceId)) return Response.json({ error: "App not found" }, { status: 404 });
  const asset = await db.prepare("SELECT id, storage_path, thumbnail_storage_path FROM assets WHERE id = ? AND persona_id = ? AND workspace_id = ?").get(assetId, personaId, workspaceId) as { id: string; storage_path: string; thumbnail_storage_path: string | null } | undefined;
  if (!asset) return Response.json({ error: "Reference not found" }, { status: 404 });
  const remaining = Number((await db.prepare("SELECT COUNT(*) AS count FROM assets WHERE persona_id = ?").get(personaId) as { count: number }).count || 0);
  if (remaining <= 1) return Response.json({ error: "An identity needs at least one reference" }, { status: 400 });
  await db.transaction(async () => {
    await enqueueStorageDeletion(asset.storage_path, workspaceId, "persona-reference-deleted");
    await enqueueStorageDeletion(asset.thumbnail_storage_path, workspaceId, "persona-thumbnail-deleted");
    await db.prepare("DELETE FROM assets WHERE id = ?").run(assetId);
    await db.prepare("UPDATE personas SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), personaId);
    await appendAuditEvent({ workspaceId, actorUserId: auth.user.id, action: "identity.reference_deleted", targetType: "identity_reference", targetId: assetId, metadata: { personaId } });
  })();
  return Response.json({ personas: await listPersonas(workspaceId) });
}
