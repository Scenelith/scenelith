import {db} from "./postgres-db";
import {materializeVideoSegmentAsset, type VideoDerivativeSource} from "./video-derivatives";
import {followsReferenceDuration, referenceDurationSettings, type ReferenceDurationMode} from "./reference-duration";
import type {GenerationAdmissionReference} from "./generation-admission";

/** Trim a single long source through the shared, cached media pipeline. The
 * canvas original and its scene selection are never modified. */
export async function prepareReferenceDuration<T extends GenerationAdmissionReference>(input:{userId:string;projectId:string;modelId:string;duration:string;durationMode?:ReferenceDurationMode;references:T[]}) {
  let references = input.references;
  const videos = references.filter(ref => ref.role === "reference-video" || ref.role === "motion-video");
  if (followsReferenceDuration(input.modelId,input.durationMode) && videos.length === 1 && Number(videos[0].durationSeconds) > 15) {
    const original = videos[0];
    const source = await db.prepare("SELECT id,storage_path,mime_type FROM assets WHERE storage_path=?").get(original.path) as VideoDerivativeSource|undefined;
    const project = await db.prepare("SELECT workspace_id FROM projects WHERE id=?").get(input.projectId) as {workspace_id:string}|undefined;
    if (!source || !project) throw new Error("The reference video is no longer available");
    const clip = await materializeVideoSegmentAsset({userId:input.userId,projectId:input.projectId,workspaceId:project.workspace_id,source,segmentId:"wan-reference-first-15s",start:0,end:15});
    const asset = await db.prepare("SELECT storage_path,mime_type,size_bytes FROM assets WHERE id=?").get(clip.id) as {storage_path:string;mime_type:string;size_bytes:number};
    references = references.map(ref => ref === original ? {...ref,path:asset.storage_path,mimeType:asset.mime_type,sizeBytes:asset.size_bytes,durationSeconds:clip.durationSeconds} : ref);
  }
  return {references,duration:referenceDurationSettings(input.modelId,references,input.duration,input.durationMode).duration};
}
