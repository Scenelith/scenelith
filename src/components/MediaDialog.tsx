"use client";
import {useLayoutEffect,useState,type CSSProperties,type ComponentProps,type RefObject} from 'react';
import {X} from 'lucide-react';

/** One viewport footprint for preview, editing and character creation. */
export function MediaDialogBackdrop({className='',style,...props}:ComponentProps<'div'>){
 const [viewport,setViewport]=useState<{height:number;top:number}|null>(null);
 useLayoutEffect(()=>{const visible=window.visualViewport;const fit=()=>setViewport({height:visible?.height||innerHeight,top:visible?.offsetTop||0});fit();visible?.addEventListener('resize',fit);visible?.addEventListener('scroll',fit);window.addEventListener('resize',fit);return()=>{visible?.removeEventListener('resize',fit);visible?.removeEventListener('scroll',fit);window.removeEventListener('resize',fit);};},[]);
 return <div className={`media-dialog-backdrop ${className}`} style={{...style,...(viewport?{top:viewport.top,height:viewport.height,bottom:'auto'}:{})}} {...props}/>;
}
export function MediaDialogSurface({className='',style,...props}:ComponentProps<'div'>){
 const [visibleHeight,setVisibleHeight]=useState(0);
 useLayoutEffect(()=>{const viewport=window.visualViewport;const fit=()=>setVisibleHeight(viewport?.height||innerHeight);fit();viewport?.addEventListener('resize',fit);window.addEventListener('resize',fit);return()=>{viewport?.removeEventListener('resize',fit);window.removeEventListener('resize',fit);};},[]);
 return <div role="dialog" aria-modal="true" data-short-viewport={visibleHeight>0&&visibleHeight<=600||undefined} className={`media-dialog-surface ${className}`} style={{...style,'--media-dialog-height':visibleHeight?visibleHeight+'px':undefined} as CSSProperties} {...props}/>;
}
export function MediaDialogClose({className='',...props}:ComponentProps<'button'>){return <button type="button" className={`media-dialog-close ${className}`} {...props}><X size={17}/></button>;}
export function useElementHeight(ref:RefObject<HTMLElement|null>,active=true,layoutKey?:unknown){
 const [height,setHeight]=useState(0);
 useLayoutEffect(()=>{const element=ref.current;if(!active||!element)return;const update=()=>setHeight(element.offsetHeight);update();const observer=new ResizeObserver(update);observer.observe(element);return()=>observer.disconnect();},[ref,active]);
 useLayoutEffect(()=>{if(active&&ref.current)setHeight(ref.current.offsetHeight);},[ref,active,layoutKey]);
 return height;
}
