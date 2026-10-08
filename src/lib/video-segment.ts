/** Output timestamps start at zero; MP4 edit lists remove encoder preroll.
 * make_zero shifts AAC/H.264 timestamps and can exceed the provider duration cap. */
export function videoSegmentArguments(input:string,output:string,start:number,end:number,modelId?:string){
 return ['-hide_banner','-loglevel','error','-i',input,'-ss',start.toFixed(6),'-t',(end-start).toFixed(6),'-map','0:v:0','-map','0:a?',
 ...(modelId==='seedance-2-5'?['-vf','scale=trunc(sqrt(921600*iw/ih)/2)*2:trunc(sqrt(921600*ih/iw)/2)*2,setsar=1','-r','30']:[]),
 '-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-avoid_negative_ts','disabled',output];
}
