import { db } from '../postgres-db';
import { fingerprint,MediaError } from './contracts';
import {displayGeometry,type MediaMetadata} from './probe';
/** References have already been authorized by their caller; this never grants asset access. */
export async function verifiedMediaMetadata(storagePath:string) {
  const row=await db.prepare('SELECT id,workspace_id,project_id,content_hash,storage_path,size_bytes FROM assets WHERE storage_path=? LIMIT 1').get(storagePath) as
    {id:string;workspace_id:string;project_id:string|null;content_hash:string|null;storage_path:string;size_bytes:number}|undefined;
  if(!row)throw new MediaError('SOURCE_UNAVAILABLE',404);
  const identity=fingerprint([row.id,row.content_hash,row.storage_path,row.size_bytes]);
  const cached=await db.prepare('SELECT metadata_json FROM media_asset_analysis WHERE asset_id=? AND content_identity=? AND analyzer_version=1').get(row.id,identity) as {metadata_json:string}|undefined;
  return {asset:row,metadata:cached?JSON.parse(cached.metadata_json) as MediaMetadata:undefined};
}
export function legacyMetadata(metadata:MediaMetadata) {
  const {width,height}=displayGeometry(metadata);
  return {durationSeconds:metadata.duration,width,height,aspectRatio:width && height?width/height:undefined,fps:metadata.fps,hasAudio:Boolean(metadata.audio)};
}
