'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {assetThumbnailUrl} from '@/lib/asset-preview-url';
import {PreparedMediaImage} from './PreparedMediaImage';

/** No image fetch or global observers until the pointer rests on a reference. */
export default function ReferenceHoverPreview({src,title,children}:{src:string;title:string;children:ReactNode}){
 const anchor=useRef<HTMLSpanElement>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const [preview,setPreview]=useState<{host:HTMLElement;left:number;top:number}|null>(null);
 const close=()=>{if(timer.current)clearTimeout(timer.current);timer.current=null;setPreview(null);};
 const open=()=>{if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>{
  const trigger=anchor.current;if(!trigger)return;
  const box=trigger.getBoundingClientRect(),viewport=window.visualViewport,left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,right=left+(viewport?.width||innerWidth),bottom=top+(viewport?.height||innerHeight),width=Math.min(240,right-left-24),height=Math.min(300,bottom-top-24);
  const x=box.right+12+width<=right-12?box.right+12:box.left-12-width>=left+12?box.left-12-width:Math.max(left+12,Math.min(box.left,right-width-12));
  const y=box.top-12-height>=top+12?box.top-12-height:Math.max(top+12,Math.min(box.top,bottom-height-12));
  setPreview({host:trigger.closest<HTMLElement>('dialog[open]')||document.body,left:x,top:y});
 },350);};
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
 useEffect(()=>{if(!preview)return;const close=()=>setPreview(null);window.addEventListener('scroll',close,true);window.addEventListener('resize',close);return()=>{window.removeEventListener('scroll',close,true);window.removeEventListener('resize',close);};},[preview]);
 return <span ref={anchor} className="reference-hover-trigger" onPointerEnter={event=>{if(event.pointerType!=='touch')open();}} onPointerLeave={close} onFocus={open} onBlur={close} onPointerDown={close}>{children}{preview&&createPortal(<div className="reference-hover-preview" aria-label={`Preview ${title}`} style={{position:'fixed',left:preview.left,top:preview.top,zIndex:20000,pointerEvents:'none',maxWidth:'calc(100vw - 24px)',maxHeight:'calc(100dvh - 24px)'}}><PreparedMediaImage src={assetThumbnailUrl(src)} alt={title} decoding="async"/></div>,preview.host)}</span>;
}
