import { join } from 'node:path';
import sharp from 'sharp';
import { postDetails,resolveTikTok } from '../tiktok-resolver';
import { downloadExternalMedia } from './external-download';
import { mediaConfig } from './config';
import { MediaError } from './contracts';
import { probeFile } from './probe';
import { extractSceneFiles } from './scenes';
import type { MediaFileOutcome } from './executor';

export async function importMedia(url:string,dir:string,signal:AbortSignal,timings:Record<string,number>) {
  const data=await resolveTikTok(url),images=data.images||[],config=mediaConfig();
  if(images.length>100)throw new MediaError('IMPORT_FILE_LIMIT');
  const files:MediaFileOutcome[]=[];let totalBytes=0;
  const download=async(url:string,path:string,maxBytes=config.maxFileBytes)=>{
    const start=performance.now();
    const result=await downloadExternalMedia(url,path,Math.min(maxBytes,config.maxTempBytes-totalBytes),AbortSignal.any([signal,AbortSignal.timeout(config.transferTimeoutMs)]));
    totalBytes+=result.size;timings.downloadMs=(timings.downloadMs||0)+performance.now()-start;return result;
  };
  if(images.length){
    for(const [index,url] of images.entries()){
      const path=join(dir,`slide-source-${index}`),file=join(dir,`slide-${index+1}.jpg`);
      await download(url,path,25*1024*1024);
      const start=performance.now();await sharp(path).jpeg().toFile(file);
      timings.processMs=(timings.processMs||0)+performance.now()-start;
      files.push({file,mime:'image/jpeg',kind:'slide',role:index===0?'hook':index===images.length-1?'cta':'slide',filename:`slide-${index+1}.jpg`,metadata:{index:index+1}});
    }
  }else{
    const videoUrl=data.play||data.wmplay;if(!videoUrl)throw new MediaError('IMPORT_VIDEO_MISSING');
    const path=join(dir,'source.mp4');await download(videoUrl,path);
    const start=performance.now(),metadata=await probeFile(path,signal);
    files.push({file:path,mime:'video/mp4',kind:'video',role:'source',filename:'source.mp4',metadata});
    files.push(...await extractSceneFiles({path,metadata},dir,signal));
    timings.processMs=(timings.processMs||0)+performance.now()-start;
  }
  return {files,metadata:{post:{...postDetails(data,url),mediaType:images.length?'slideshow':'video',totalBytes}}};
}
