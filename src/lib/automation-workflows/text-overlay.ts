import { createHash } from "node:crypto";
import { z } from "zod";
import { db, userCanAccessAsset } from "@/lib/postgres-db";
import { putStorageObject, readStorageObject, statStorageObject } from "@/lib/storage";
import { assertWorkspaceStorageCapacity } from "@/lib/storage-lifecycle";
import { renderTextOverlay, textOverlaySettingsSchema } from "@/lib/text-overlay/render";
import { parseCurrentAutomationGeneratedAssets } from "./port-contracts";
import type { AutomationNodeExecution } from "./runtime";

const captionsSchema = z.object({ slides: z.array(z.object({
  index: z.number().int().positive(), overlayText: z.string().max(2_000),
}).passthrough()).min(1).max(5_000) }).passthrough();

export async function textOverlay(execution: AutomationNodeExecution) {
  const batch = parseCurrentAutomationGeneratedAssets(execution.inputs.assets);
  const { enabled = true, text: fixedText = "", ...renderConfig } = execution.config;
  if (typeof enabled !== "boolean" || typeof fixedText !== "string") throw new Error("Invalid Text overlay settings");
  if (!enabled) return { assets: batch, layers: { items: [] } };
  const settings = textOverlaySettingsSchema.parse(renderConfig);
  const sharedText = typeof execution.inputs.captions === "string" ? execution.inputs.captions : fixedText || null;
  const captions = (execution.inputs.captions === undefined || typeof execution.inputs.captions === "string") ? null : captionsSchema.parse(execution.inputs.captions);
  const byIndex = new Map(captions?.slides.map((slide) => [slide.index, slide.overlayText]));
  if (captions && byIndex.size !== captions.slides.length) throw new Error("Text input contains duplicate slide indexes");
  const jobs = batch.items.map((item) => {
    const index = item.presentation.index;
    if (captions && (index === null || !byIndex.has(index))) throw new Error(`No text supplied for slide ${index ?? item.requestKey}`);
    const text = captions ? byIndex.get(index!)! : sharedText ?? item.presentation.overlayText;
    if (text.length > 2_000) throw new Error(`Slide ${index ?? item.requestKey} text exceeds 2000 characters`);
    return { item, text };
  });
  if (captions && captions.slides.some((slide) => !batch.items.some((item) => item.presentation.index === slide.index))) throw new Error("Text input includes a slide that has no image");
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(execution.context.projectId) as { workspace_id: string } | undefined;
  if (!project) throw new Error("Canvas not found");
  // Authorize all source assets before producing any derivative. URLs in a batch
  // are display values, never network destinations or filesystem paths.
  for (const { item } of jobs) {
    if (!await userCanAccessAsset(execution.context.userId, item.assetId)) throw new Error("Overlay image is not accessible");
  }
  const count = jobs.filter((job) => job.text.trim()).length * (settings.transparent ? 2 : 1);
  if (count > (execution.context.policy?.maxGeneratedAssets ?? 200)) throw new Error("Overlay results exceed the workflow asset limit");
  if (count) await execution.context.usage?.reserveGeneratedAssets(count, `text-overlay:${execution.node.id}:${createHash("sha256").update(JSON.stringify(jobs.map(({ item, text }) => [item.requestKey, item.assetId, text, settings]))).digest("hex")}`);
  const items = [];
  for (const { item, text } of jobs) {
    execution.context.signal?.throwIfAborted();
    if (!text.trim()) { items.push(item); continue; }
    const key = createHash("sha256").update(JSON.stringify([execution.context.runId, execution.node.id, item.requestKey, item.assetId, text, settings])).digest("hex");
    const artifactId = `text-overlay-${key}`;
    const existing = await db.prepare("SELECT ar.value_json FROM automation_artifacts ar JOIN assets a ON a.id = ar.asset_id WHERE ar.id = ? AND ar.run_id = ?").get(artifactId, execution.context.runId) as { value_json: string } | undefined;
    if (existing) { items.push(JSON.parse(existing.value_json) as typeof item); continue; }
    const source = await db.prepare("SELECT storage_path, mime_type, size_bytes FROM assets WHERE id = ?").get(item.assetId) as { storage_path: string; mime_type: string; size_bytes: number } | undefined;
    if (!source?.mime_type.startsWith("image/")) throw new Error("Text overlay requires a still image");
    if (Number(source.size_bytes) > 32 * 1024 * 1024) throw new Error("Overlay input must be at most 32 MB");
    if ((await statStorageObject(source.storage_path)).size > 32 * 1024 * 1024) throw new Error("Overlay input must be at most 32 MB");
    const rendered = await renderTextOverlay(await readStorageObject(source.storage_path), text, settings, execution.context.signal);
    const assetId = `overlay-image-${key}`;
    const layerId = settings.transparent ? `overlay-layer-${key}` : null;
    const persist = async (id: string, bytes: Buffer, role: string) => db.transaction(async () => {
      await assertWorkspaceStorageCapacity(project.workspace_id, 0);
      if (await db.prepare("SELECT id FROM assets WHERE id = ?").get(id)) return;
      await assertWorkspaceStorageCapacity(project.workspace_id, bytes.length);
      const filename = `${id}.png`;
      const stored = await putStorageObject(bytes, `workspaces/${project.workspace_id}/projects/${execution.context.projectId}/overlays/${filename}`, { contentType: "image/png" });
      await db.prepare(`INSERT INTO assets
        (id,workspace_id,project_id,kind,role,filename,storage_path,storage_provider,storage_bucket,object_key,size_bytes,content_hash,mime_type,metadata_json,created_at)
        VALUES (?,?,?,'generated_image',?,?,?,?,?,?,?,?,'image/png',?,?) ON CONFLICT(id) DO NOTHING`).run(
          id, project.workspace_id, execution.context.projectId, role, filename, stored.reference, stored.provider, stored.bucket, stored.key, stored.size, stored.contentHash,
          JSON.stringify({ sourceAssetId: item.assetId, generationId: item.generationId, text, settings, layout: rendered.layout, automationRunId: execution.context.runId }), new Date().toISOString());
    })();
    await persist(assetId, rendered.image, "generated");
    if (layerId && rendered.overlay) await persist(layerId, rendered.overlay, "overlay");
    const value = { ...item, assetId, outputUrl: `/api/assets/${assetId}`, presentation: { ...item.presentation, overlayText: text },
      metadata: { ...item.metadata, textOverlay: { sourceAssetId: item.assetId, layerAssetId: layerId, settings, layout: rendered.layout } } };
    await db.prepare(`INSERT INTO automation_artifacts (id,run_id,node_id,item_key,workspace_id,project_id,kind,asset_id,value_json,created_at)
      VALUES (?,?,?,?,?,?,'text-overlay',?,?,?) ON CONFLICT(id) DO NOTHING`).run(artifactId, execution.context.runId, execution.node.id, `${item.requestKey}:${key}`, execution.context.workspaceId, execution.context.projectId, assetId, JSON.stringify(value), new Date().toISOString());
    items.push(value);
  }
  return { assets: parseCurrentAutomationGeneratedAssets({ ...batch, items }), layers: { items: items.flatMap((item) => {
    const layer = item.metadata.textOverlay as { layerAssetId?: string | null } | undefined;
    return layer?.layerAssetId ? [{ index: item.presentation.index, requestKey: item.requestKey, assetId: layer.layerAssetId, url: `/api/assets/${layer.layerAssetId}` }] : [];
  }) } };
}
