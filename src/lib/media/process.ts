import { spawn } from 'node:child_process';
import { mediaConfig } from './config';
import { MediaError } from './contracts';

/** Every child has a deadline, bounded logs/output, and dies when its job loses its lease. */
export async function mediaProcess(command: 'ffmpeg'|'ffprobe', args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const config = mediaConfig();
  return new Promise<string>((resolve,reject)=> {
    const safeArgs=args.flatMap((arg)=>arg==='-i'?['-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mpegts,mp3,wav,aac,ogg,flac,aiff,concat',arg]:[arg]);
    const child = spawn(command,command==='ffmpeg'
      ? ['-nostdin','-hide_banner','-v','error','-y','-threads',String(config.threads),'-filter_threads',String(config.threads),'-filter_complex_threads',String(config.threads),...safeArgs]
      : ['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mpegts,mp3,wav,aac,ogg,flac,aiff',...args],{stdio:['ignore','pipe','pipe']});
    const chunks:Buffer[]=[];let outputBytes=0,stderr='', failure: MediaError|undefined;
    const kill = (error: MediaError)=>{failure=error;child.kill('SIGKILL');};
    const abort = ()=>kill(new MediaError('JOB_INTERRUPTED',409));
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    const timer=setTimeout(()=>kill(new MediaError('MEDIA_TIMEOUT')),config.processTimeoutMs);
    child.stdout.on('data',(chunk:Buffer)=>{outputBytes+=chunk.length;if(outputBytes>config.maxProbeBytes)kill(new MediaError('MEDIA_ANALYSIS_LIMIT'));else chunks.push(chunk);});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8000);});
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
    child.once('error',()=>{cleanup();reject(new MediaError('MEDIA_EXECUTABLE_UNAVAILABLE'));});
    child.once('close',code=>{cleanup();
      if(failure)reject(failure);
      else if(code!==0)reject(new MediaError(/No space left/.test(stderr)?'MEDIA_DISK_FULL':'INVALID_MEDIA'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
