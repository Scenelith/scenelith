"use client";
import {useLayoutEffect,useState,type ComponentProps,type RefObject} from 'react';
import {X} from 'lucide-react';

/** One viewport footprint for preview, editing and character creation. */
export function MediaDialogBackdrop({className='',...props}:ComponentProps<'div'>){return <div className={`media-dialog-backdrop ${className}`} {...props}/>;}
export function MediaDialogSurface({className='',...props}:ComponentProps<'div'>){return <div role="dialog" aria-modal="true" className={`media-dialog-surface ${className}`} {...props}/>;}
export function MediaDialogClose({className='',...props}:ComponentProps<'button'>){return <button type="button" className={`media-dialog-close ${className}`} {...props}><X size={17}/></button>;}
export function useElementHeight(ref:RefObject<HTMLElement|null>,active=true){
 const [height,setHeight]=useState(0);
 useLayoutEffect(()=>{const element=ref.current;if(!active||!element)return;const update=()=>setHeight(element.getBoundingClientRect().height);update();const observer=new ResizeObserver(update);observer.observe(element);return()=>observer.disconnect();},[ref,active]);
 return height;
}
