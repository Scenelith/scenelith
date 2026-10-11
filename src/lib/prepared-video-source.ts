'use client';
import {useEffect,useState} from 'react';
/** Prepare incompatible assets in the background without selecting a different player tab. */
export function usePreparedVideoSource(src:string) {
  const [prepared,setPrepared]=useState<{source:string;url:string}|null>(null);
  useEffect(()=>{
    if(!src.startsWith('/api/assets/'))return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const url=new URL(src,'http://scenelith.local');url.search='?variant=playback&status=1';
    let failures=0;
    const read=async()=>{
      try{
        const response=await fetch(`${url.pathname}${url.search}`,{signal:controller.signal,cache:'no-store',headers:{accept:'application/json'}});
        // Compatible older deployments still return media. Do not consume its body.
        if(!response.headers.get('content-type')?.includes('application/json')){await response.body?.cancel();return;}
        const body=await response.json();
        if(!response.ok){if(++failures<3)timer=setTimeout(read,3000);return;}
        failures=0;
        if(body.status==='completed' && body.result?.asset?.url)setPrepared({source:src,url:body.result.asset.url});
        else if(['queued','running','retry_wait'].includes(body.status))timer=setTimeout(read,2000);
      }catch{if(!controller.signal.aborted && ++failures<3)timer=setTimeout(read,3000);}
    };
    void read();return()=>{controller.abort();clearTimeout(timer);};
  },[src]);
  return prepared?.source===src?prepared.url:src;
}
