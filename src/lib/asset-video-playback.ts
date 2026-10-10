import { db } from './postgres-db';
import { readStorageObject, saveBytes, deleteStorageObject } from './storage';
import { assertWorkspaceStorageCapacity } from './storage-lifecycle';
import { normalizeVideoPlayback } from './video-playback-normalize';

type Source = {id:string;workspace_id:string|null;project_id:string|null;storage_path:string;size_bytes:number|null};
type Preview = {storagePath:string;size:number;contentHash:string|null};
const jobs = new Map<string,Promise<Preview>>();

/** Caller must authorize the source. Derived rows are private and never library items. */
export async function assetVideoPlayback(source: Source): Promise<Preview> {
  const running = jobs.get(source.id);
  if (running) return running;
  const job = db.transaction(async () => {
    await db.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))').get(`playback:${source.id}`);
    // Prevent deletion until the derivative and its cascading relationship exist.
    const current = await db.prepare('SELECT id FROM assets WHERE id=? FOR KEY SHARE').get(source.id);
    if (!current) throw new Error('Source video was removed');
    const cached = await db.prepare('SELECT storage_path,size_bytes,content_hash FROM assets WHERE playback_source_asset_id=?').get(source.id) as {storage_path:string;size_bytes:number;content_hash:string|null}|undefined;
    if (cached) return {storagePath:cached.storage_path,size:Number(cached.size_bytes),contentHash:cached.content_hash};
    if (!source.workspace_id || !source.size_bytes || Number(source.size_bytes)>200*1024*1024) throw new Error('Video exceeds playback preparation limit');
    const bytes = await normalizeVideoPlayback(await readStorageObject(source.storage_path));
    await assertWorkspaceStorageCapacity(source.workspace_id,bytes.length);
    const id=crypto.randomUUID();
    const stored=await saveBytes(bytes,`workspaces/${source.workspace_id}/video-previews`,`${id}.mp4`,'video/mp4');
    try {
      await db.prepare(`INSERT INTO assets (id,workspace_id,project_id,kind,role,filename,storage_path,storage_provider,storage_bucket,object_key,size_bytes,content_hash,mime_type,metadata_json,created_at,playback_source_asset_id)
        VALUES (?,?,?,'video_preview','internal',?,?,?,?,?,?,?,'video/mp4','{}',?,?)`).run(id,source.workspace_id,source.project_id,`${id}.mp4`,stored.reference,stored.provider,stored.bucket,stored.key,stored.size,stored.contentHash,new Date().toISOString(),source.id);
    } catch(error) { await deleteStorageObject(stored.reference).catch(()=>{}); throw error; }
    return {storagePath:stored.reference,size:stored.size,contentHash:stored.contentHash};
  })().finally(()=>jobs.delete(source.id));
  jobs.set(source.id,job);
  return job;
}
