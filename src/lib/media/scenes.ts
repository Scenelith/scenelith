import { mkdir,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_VIDEO_SCENE_SCORE,normalizeVideoSceneBoundaries,type VideoSceneCandidate } from '../video-scenes';
import { mediaProcess } from './process';
import { MediaError } from './contracts';
import type { LocalMedia } from './render';
import type { MediaFileOutcome } from './executor';

export async function extractSceneFiles(source:LocalMedia,dir:string,signal:AbortSignal):Promise<MediaFileOutcome[]> {
  const {duration}=source.metadata;
  if(!source.metadata.video)throw new MediaError('VIDEO_REQUIRED');
  const output=await mediaProcess('ffmpeg',['-i',source.path,'-vf',"select='gte(scene,0)',metadata=print:file=-",'-an','-f','null','-'],signal);
  const candidates:VideoSceneCandidate[]=[];
  for(const block of output.split(/(?=frame:\d+\s)/g)){
    const frame=Number(block.match(/frame:(\d+)/)?.[1]);
    const time=Number(block.match(/pts_time:([\d.]+)/)?.[1]);
    const score=Number(block.match(/lavfi\.scene_score=([\d.]+)/)?.[1]||0);
    if(Number.isFinite(frame) && Number.isFinite(time) && time>0)candidates.push({frame,time,score});
  }
  const segments=normalizeVideoSceneBoundaries(candidates,duration,{minimumScore:DEFAULT_VIDEO_SCENE_SCORE,maximumScenes:80});
  const sceneDir=join(dir,'scenes');await mkdir(sceneDir);
  const expression=segments.map(s=>`eq(n\\,${Math.max(0,Number(s.frame||0))})`).join('+')||'eq(n\\,0)';
  await mediaProcess('ffmpeg',['-i',source.path,'-vf',`select='${expression}',scale=720:-2`,
    '-fps_mode','vfr','-frames:v',String(Math.max(1,segments.length)),'-q:v','2',join(sceneDir,'scene-%03d.jpg')],signal);
  const files=(await readdir(sceneDir)).filter(f=>f.endsWith('.jpg')).sort();
  if(files.length!==segments.length)throw new MediaError('SCENE_FRAME_MISMATCH');
  const result:MediaFileOutcome[]=files.map((filename,index)=>({file:join(sceneDir,filename),mime:'image/jpeg',kind:'scene',
    role:index===0?'hook':index===files.length-1?'cta':'scene',filename,metadata:{...segments[index],duration}}));
  const count=Math.max(24,Math.min(600,Math.ceil(duration*15))),columns=Math.min(30,count),rows=Math.ceil(count/columns);
  const file=join(dir,'timeline-sprite.jpg');
  await mediaProcess('ffmpeg',['-i',source.path,'-vf',`fps=${count/duration},scale=-2:72,tile=${columns}x${rows}:padding=0:margin=0`,
    '-frames:v','1','-q:v','3',file],signal);
  result.push({file,mime:'image/jpeg',kind:'scene',role:'timeline',filename:'timeline-sprite.jpg',
    metadata:{timelineSprite:true,frameCount:count,columns,rows,duration}});
  return result;
}
