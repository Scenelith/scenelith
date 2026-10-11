import { mediaProcess } from './process';
import { MediaError } from './contracts';
export type MediaStream = {
  index:number; codec_type:string; codec_name:string; codec_tag_string?:string; profile?:string; level?:number;
  width?:number; height?:number; pix_fmt?:string; sample_aspect_ratio?:string; field_order?:string;
  color_range?:string; color_space?:string; color_transfer?:string; color_primaries?:string;
  time_base?:string; r_frame_rate?:string; avg_frame_rate?:string; start_time?:string; duration?:string;
  sample_rate?:string; channels?:number; channel_layout?:string; extradata_hash?:string;
  side_data_list?: Array<{rotation?:number}>; tags?: Record<string,string>;
};
export type MediaMetadata = {version:1;duration:number;video?:MediaStream;audio?:MediaStream;streams:MediaStream[];format:string;fps:number;rotation:number;directPlayback:boolean};
export function rational(value?:string) { const [n,d=1]=(value||'0').split('/').map(Number);return d>0?n/Number(d):0; }
export async function probeFile(path:string,signal:AbortSignal):Promise<MediaMetadata> {
  const raw=JSON.parse(await mediaProcess('ffprobe',['-show_streams','-show_format','-show_data_hash','sha256','-of','json',path],signal));
  const streams:MediaStream[]=raw.streams||[],video=streams.find(s=>s.codec_type==='video'),audio=streams.find(s=>s.codec_type==='audio');
  const duration=Number(video?.duration||raw.format?.duration||audio?.duration);
  if(!Number.isFinite(duration)||duration<=0)throw new MediaError('INVALID_MEDIA_DURATION');
  const rotation=Number(video?.side_data_list?.find(s=>s.rotation!==undefined)?.rotation||video?.tags?.rotate||0);
  const fps=rational(video?.avg_frame_rate)||rational(video?.r_frame_rate);
  const format=String(raw.format?.format_name||'');
  return {version:1,duration,video,audio,streams,format,fps,rotation,
    directPlayback:Boolean(video?.codec_name==='h264' && video?.pix_fmt==='yuv420p' && format.includes('mp4') && (!audio || (audio.codec_name==='aac' && audio.profile==='LC')))};
}
export type FrameBoundary={time:number;key:boolean};
export async function frameBoundaries(path:string,metadata:MediaMetadata,signal:AbortSignal):Promise<FrameBoundary[]> {
  const raw=JSON.parse(await mediaProcess('ffprobe',['-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time,key_frame','-of','json',path],signal));
  const origin=Number(metadata.video?.start_time||0);
  const frames=(raw.frames||[]).map((f:{best_effort_timestamp_time?:string;key_frame?:number})=>({time:Number(f.best_effort_timestamp_time)-origin,key:f.key_frame===1})).filter((f:FrameBoundary)=>Number.isFinite(f.time));
  if(!frames.length)throw new MediaError('NO_VIDEO_FRAMES');
  frames.push({time:metadata.duration,key:false});
  return frames;
}
export function quantizeRange(start:number,end:number,frames:FrameBoundary[]) {
  const nearest=(time:number)=>frames.reduce((best,frame)=>Math.abs(frame.time-time)<Math.abs(best.time-time)?frame:best,frames[0]).time;
  const from=nearest(start),to=nearest(end);
  if(to<=from)throw new MediaError('EMPTY_FRAME_RANGE');
  return {start:from,end:to};
}

/** Square-pixel display dimensions, accounting for the stored pixel shape and display matrix. */
export function displayGeometry(metadata:MediaMetadata) {
  const ratio=rational(metadata.video?.sample_aspect_ratio?.replace(':','/')) || 1;
  let width=Math.round(Number(metadata.video?.width||0)*ratio),height=Number(metadata.video?.height||0);
  if(Math.abs(metadata.rotation)%180===90)[width,height]=[height,width];
  return {width,height,aspectRatio:height?width/height:undefined};
}
