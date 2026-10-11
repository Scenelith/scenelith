import { fingerprint, MediaError } from './contracts';
import { rational, type MediaMetadata } from './probe';
export type PlannedClip = {id:string;start:number;end:number;metadata:MediaMetadata;outputDuration?:number;audio?:{id:string;start:number;end:number}};
export type ProcessingPlan = {version:1;video:'reuse'|'copy'|'transcode';audio:'selected'|'original'|'none';fps:number;duration:number;clips:PlannedClip[];reason:string};
const videoFields=['codec_name','codec_tag_string','profile','level','width','height','pix_fmt','sample_aspect_ratio','field_order','color_range','color_space','color_transfer','color_primaries','time_base','r_frame_rate','avg_frame_rate','extradata_hash'] as const;
export function compatibleVideo(a:MediaMetadata,b:MediaMetadata) {
  if(!a.video || !b.video || !a.video.extradata_hash || !b.video.extradata_hash)return false;
  if(a.rotation!==b.rotation || a.streams.length!==b.streams.length)return false;
  if(a.streams.some((s,i)=>s.codec_type!==b.streams[i]?.codec_type))return false;
  return videoFields.every(key=>a.video![key]===b.video![key]) &&
    fingerprint(a.video.side_data_list||[])===fingerprint(b.video.side_data_list||[]);
}
export function fullRange(clip:PlannedClip) {
  return Math.abs(clip.start)<1e-6 && Math.abs(clip.end-clip.metadata.duration)<1e-6;
}
export function planProcessing(clips:PlannedClip[],audio:'selected'|'original'|'none',geometryChange=false):ProcessingPlan {
  if(!clips.length || clips.some(c=>!c.metadata.video))throw new MediaError('VIDEO_REQUIRED');
  const first=clips[0].metadata;
  if(!(first.fps>0) || first.fps>240)throw new MediaError('UNSUPPORTED_FRAME_RATE');
  const adjusted=clips.some(c=>c.outputDuration!==undefined && Math.abs(c.outputDuration-(c.end-c.start))>1e-6);
  if(clips.some(c=>c.outputDuration!==undefined && Math.abs(c.outputDuration-(c.end-c.start))>1/c.metadata.fps+.002))throw new MediaError('OUTPUT_TIMING_OUTSIDE_FRAME');
  const allFull=clips.every(fullRange) && !adjusted;
  const duration=clips.reduce((sum,c)=>sum+(c.outputDuration ?? c.end-c.start),0);
  if(!geometryChange && clips.length===1 && allFull && audio==='selected')return {version:1,video:'reuse',audio,fps:first.fps,duration,clips,reason:'unchanged'};
  // A partial GOP copy is deliberately not accepted as an exact trim.
  const safeConcat=clips.every(c=>compatibleVideo(first,c.metadata) &&
    Number(c.metadata.video?.start_time||0)===0 && rational(c.metadata.video?.r_frame_rate)===c.metadata.fps &&
    Math.abs(c.metadata.duration*first.fps-Math.round(c.metadata.duration*first.fps))<.001);
  const copy=!geometryChange && allFull && first.format.includes('mp4') && (clips.length===1 || safeConcat);
  return {version:1,video:copy?'copy':'transcode',audio,fps:first.fps,duration,clips,reason:copy?'compatible-full-streams':geometryChange?'geometry':'exact-cut-or-normalization'};
}
