'use client';
import { useEffect,useRef,useState,type ComponentPropsWithRef } from 'react';
import { waitForMediaResult,type MediaJobStatus } from '@/lib/media-client';

/** Existing thumbnails keep their markup. Pending video frames wait on the durable job. */
export function PreparedMediaImage(props:ComponentPropsWithRef<'img'>) {
  const [prepared,setPrepared]=useState<{source:string;url:string}|null>(null);
  const active=useRef<AbortController|null>(null);
  useEffect(()=>()=>{active.current?.abort();active.current=null;},[props.src]);
  const src=typeof props.src==='string' && prepared?.source===props.src?prepared.url:props.src;
  // Private media uses authenticated asset delivery, not the Next image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} alt={props.alt} src={src} onError={async event=>{
    if(typeof props.src!=='string'||!props.src.startsWith('/api/assets/')||!props.src.includes('variant=thumbnail')||src!==props.src){props.onError?.(event);return;}
    if(active.current)return;
    const controller=new AbortController();active.current=controller;
    try {
      const url=new URL(props.src,'http://scenelith.local');url.searchParams.set('status','1');
      const response=await fetch(`${url.pathname}${url.search}`,{signal:controller.signal,cache:'no-store'});
      if(!response.ok || !response.headers.get('content-type')?.includes('application/json')){await response.body?.cancel();props.onError?.(event);return;}
      const job=await response.json() as MediaJobStatus;
      if(!job.id){props.onError?.(event);return;}
      const result=await waitForMediaResult(job,undefined,controller.signal);
      if(!controller.signal.aborted)setPrepared({source:props.src,url:`${result.asset.url}?delivery=direct`});
    }catch{if(!controller.signal.aborted)props.onError?.(event);}
    finally{if(active.current===controller)active.current=null;}
  }}/>;
}
