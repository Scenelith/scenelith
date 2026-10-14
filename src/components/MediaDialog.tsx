"use client";
import {useLayoutEffect,useState,type CSSProperties,type ComponentProps,type RefObject} from 'react';
import {X} from 'lucide-react';

/** One viewport footprint for preview, editing and character creation. */
export function MediaDialogBackdrop({className='',...props}:ComponentProps<'div'>){return <div className={`media-dialog-backdrop ${className}`} {...props}/>;}
export function MediaDialogSurface({className='',style,...props}:ComponentProps<'div'>){
 const [visibleHeight,setVisibleHeight]=useState(0);
 useLayoutEffect(()=>{const viewport=window.visualViewport;const fit=()=>setVisibleHeight(viewport?.height||innerHeight);fit();viewport?.addEventListener('resize',fit);window.addEventListener('resize',fit);return()=>{viewport?.removeEventListener('resize',fit);window.removeEventListener('resize',fit);};},[]);
 return <div role="dialog" aria-modal="true" data-short-viewport={visibleHeight>0&&visibleHeight<=600||undefined} className={`media-dialog-surface ${className}`} style={{...style,'--media-dialog-height':visibleHeight?visibleHeight+'px':undefined} as CSSProperties} {...props}/>;
}
export function MediaDialogClose({className='',...props}:ComponentProps<'button'>){return <button type="button" className={`media-dialog-close ${className}`} {...props}><X size={17}/></button>;}
export function useElementHeight(ref:RefObject<HTMLElement|null>,active=true){
 const [height,setHeight]=useState(0);
 useLayoutEffect(()=>{const element=ref.current;if(!active||!element)return;const update=()=>setHeight(element.getBoundingClientRect().height);update();const observer=new ResizeObserver(update);observer.observe(element);return()=>observer.disconnect();},[ref,active]);
 return height;
}
