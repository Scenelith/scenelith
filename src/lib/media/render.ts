import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mediaProcess } from './process';
import { MediaError } from './contracts';
import { displayGeometry, type MediaMetadata } from './probe';
import { type ProcessingPlan } from './planner';
import { mediaConfig } from './config';
export type LocalMedia={path:string;metadata:MediaMetadata};
const time=(n:number)=>n.toFixed(9);
const concatPath=(path:string)=>path.replaceAll("'","'\\''");
const colorArgs=(metadata:MediaMetadata)=> {
  const v=metadata.video!;
  return [['-color_range',v.color_range],['-colorspace',v.color_space],['-color_trc',v.color_transfer],['-color_primaries',v.color_primaries]]
    .flatMap(([flag,value])=>value && value!=='unknown'?[flag!,value]:[]);
};
/** Uses only worker-local, generated paths. No untrusted filename enters a concat list/filter. */
export async function renderPlan(plan:ProcessingPlan,media:Map<string,LocalMedia>,dir:string,signal:AbortSignal,modelId?:string) {
  const first=plan.clips[0], base=first.metadata;
  const video=join(dir,'video.mp4'), output=join(dir,'output.mp4');
  const clips=plan.clips, config=mediaConfig();
  const normalize=clips.length>1 || clips.some(c=>c.outputDuration!==undefined);
  if(plan.video==='copy' || plan.video==='reuse') {
    if(clips.length===1)await mediaProcess('ffmpeg',['-i',media.get(first.id)!.path,'-map','0:v:0','-an','-c:v','copy','-movflags','+faststart',video],signal);
    else {
      const list=join(dir,'concat.txt');
      // Container duration may include a longer audio tail. The separately
      // assembled soundtrack must not shift the next video's timestamps.
      await writeFile(list,clips.map(c=>`file '${concatPath(media.get(c.id)!.path)}'\nduration ${time(c.end-c.start)}`).join('\n'));
      await mediaProcess('ffmpeg',['-f','concat','-safe','0','-i',list,'-map','0:v:0','-an','-c:v','copy','-movflags','+faststart',video],signal);
    }
  } else {
    const inputArgs=clips.flatMap(c=>['-i',media.get(c.id)!.path]);
    let {width,height}=displayGeometry(base);
    if(modelId==='seedance-2-5' && width*height>921600){const scale=Math.sqrt(921600/(width*height));width=Math.floor(width*scale/2)*2;height=Math.floor(height*scale/2)*2;}
    width=Math.floor(width/2)*2;height=Math.floor(height/2)*2;
    const pixelFormat=base.video!.pix_fmt||'yuv420p';
    if(!['yuv420p','yuv420p10le','yuv422p','yuv444p'].includes(pixelFormat))throw new MediaError('UNSUPPORTED_PIXEL_FORMAT');
    // HDR metadata that cannot be preserved by this path must not be silently discarded.
    if(clips.some(c=>['smpte2084','arib-std-b67'].includes(c.metadata.video?.color_transfer||'')))throw new MediaError('HDR_TRANSCODE_UNSUPPORTED');
    let cumulative=0,previousFrames=0;
    const filters=clips.map((c,i)=>{
      const trim=`[${i}:v:0]trim=start=${time(c.start)}:end=${time(c.end)},setpts=PTS-STARTPTS`;
      const geometry=`,scale=w='trunc(iw*sar/2)*2':h=ih,setsar=1,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2${colorConversion(c.metadata,base)},format=${pixelFormat}`;
      if(!normalize)return `[0:v:0]${geometry.slice(1)}[vout]`;
      cumulative+=c.outputDuration ?? c.end-c.start;
      const boundary=Math.round(cumulative*plan.fps),frames=boundary-previousFrames;previousFrames=boundary;
      return `${trim}${geometry},fps=${plan.fps}:start_time=0,tpad=stop_mode=clone:stop_duration=${time(frames/plan.fps)},trim=end_frame=${frames},setpts=N/(${plan.fps}*TB)[v${i}]`;
    });
    if(normalize)filters.push(`${clips.map((_,i)=>`[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[vout]`);
    await mediaProcess('ffmpeg',[...inputArgs,...(!normalize?['-ss',time(first.start),'-t',time(first.end-first.start)]:[]),'-filter_complex',filters.join(';'),'-map','[vout]','-an','-c:v','libx264','-threads',String(config.threads),'-preset','veryfast','-crf','20','-fps_mode',normalize?'cfr':'vfr',...(!normalize?['-enc_time_base',base.video!.time_base||'1/90000']:['-r',String(plan.fps)]),...colorArgs(base),'-movflags','+faststart',video],signal);
  }
  if(plan.audio==='none')return video;
  const audioBaseline=clips.map(c=>media.get(plan.audio==='original'?c.audio!.id:c.id)?.metadata.audio).find(Boolean);
  const sampleRate=Number(audioBaseline?.sample_rate)||48000;
  const layout=audioBaseline?.channel_layout||'stereo';
  if(sampleRate<8000 || sampleRate>192000 || !['mono','stereo','2.1','3.0','4.0','quad','5.0','5.0(side)','5.1','5.1(side)','6.1','7.1','7.1(wide)'].includes(layout))throw new MediaError('UNSUPPORTED_AUDIO_LAYOUT');
  const groups:Array<{id:string;start:number;end:number;duration:number;hasAudio:boolean}>=[];
  let total=0,lastSamples=0;
  for(const clip of clips){
    const range=plan.audio==='original'?clip.audio:clip;
    if(!range)throw new MediaError('ORIGINAL_AUDIO_MISSING');
    total+=clip.outputDuration ?? clip.end-clip.start;
    const boundary=Math.round(total*sampleRate),duration=(boundary-lastSamples)/sampleRate;lastSamples=boundary;
    const hasAudio=Boolean(media.get(range.id)?.metadata.audio),previous=groups.at(-1);
    if(previous && previous.id===range.id && previous.hasAudio===hasAudio && Math.abs(previous.end-range.start)<1/sampleRate &&
      Math.abs(previous.duration-(previous.end-previous.start))<1/sampleRate && Math.abs(duration-(range.end-range.start))<1/sampleRate){
      previous.end=range.end;previous.duration+=duration;
    }else groups.push({...range,duration,hasAudio});
  }
  if(groups.every(g=>!g.hasAudio))return video;
  const single=groups[0],original=media.get(single.id)!;
  const canCopyAudio=groups.length===1 && single.hasAudio && single.start===0 && original.metadata.audio?.codec_name==='aac' &&
    Math.abs(single.end-original.metadata.duration)<1e-6 && Math.abs(plan.duration-original.metadata.duration)<1e-6;
  if(canCopyAudio){
    await mediaProcess('ffmpeg',['-i',video,'-i',original.path,'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart',output],signal);
  }else{
    const audioArgs=groups.flatMap(g=>['-i',media.get(g.id)!.path]);
    const filters=groups.map((g,i)=>{
      const samples=Math.round(g.duration*sampleRate);
      return g.hasAudio?`[${i+1}:a:0]aresample=${sampleRate}:async=1:first_pts=0,atrim=start_sample=${Math.round(g.start*sampleRate)}:end_sample=${Math.round(g.end*sampleRate)},asetpts=N/SR/TB,aformat=channel_layouts=${layout},apad=whole_len=${samples},atrim=end_sample=${samples}[a${i}]`
        :`anullsrc=r=${sampleRate}:cl=${layout},atrim=end_sample=${samples}[a${i}]`;
    });
    filters.push(groups.length===1?'[a0]anull[aout]':`${groups.map((_,i)=>`[a${i}]`).join('')}concat=n=${groups.length}:v=0:a=1[aout]`);
    await mediaProcess('ffmpeg',['-i',video,...audioArgs,'-filter_complex',filters.join(';'),'-map','0:v:0','-map','[aout]','-c:v','copy','-c:a','aac','-b:a','160k','-movflags','+faststart',output],signal);
  }
  return output;
}

function colorConversion(source:MediaMetadata,target:MediaMetadata) {
  const keys=['color_space','color_transfer','color_primaries','color_range'] as const;
  if(keys.every(k=>source.video?.[k]===target.video?.[k]))return '';
  // Unknown primaries cannot be guessed safely when combining different color systems.
  if(keys.some(k=>!source.video?.[k] || source.video[k]==='unknown' || !target.video?.[k] || target.video[k]==='unknown'))throw new MediaError('COLOR_METADATA_REQUIRED');
  return `,colorspace=space=${target.video!.color_space}:trc=${target.video!.color_transfer}:primaries=${target.video!.color_primaries}:range=${target.video!.color_range}`;
}
