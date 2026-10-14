'use client';
import {useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import {createPortal} from 'react-dom';

/** Fixed, viewport-aware menus escape clipped Canvas nodes and stay in a native dialog's top layer. */
export default function FloatingMenu({anchor,onClose,children,className='',width=288,label}:{anchor:RefObject<HTMLElement|null>;onClose:()=>void;children:ReactNode;className?:string;width?:number;label:string}){
 const menu=useRef<HTMLDivElement>(null),[placement,setPlacement]=useState<{host:HTMLElement;left:number;top:number;width:number;height:number;font:string}|null>(null);
 useLayoutEffect(()=>{
  const trigger=anchor.current;if(!trigger)return;
  const dialog=trigger.closest('dialog[open]') as HTMLElement|null,host=dialog||document.body;
  const position=()=>{const box=trigger.getBoundingClientRect(),viewport=window.visualViewport;
   const leftEdge=viewport?.offsetLeft||0,topEdge=viewport?.offsetTop||0,right=leftEdge+(viewport?.width||innerWidth),bottom=topEdge+(viewport?.height||innerHeight),gap=8;
   const bounds=dialog?.getBoundingClientRect(),minX=Math.max(leftEdge,bounds?.left||0)+12,maxX=Math.min(right,bounds?.right||right)-12,minY=Math.max(topEdge,bounds?.top||0)+12,maxY=Math.min(bottom,bounds?.bottom||bottom)-12;
   const roomBelow=Math.max(0,maxY-box.bottom-gap),roomAbove=Math.max(0,box.top-minY-gap),above=roomAbove>roomBelow;
   const height=Math.min(360,Math.max(roomAbove,roomBelow)),size=Math.min(Math.max(box.width,width),maxX-minX),measured=Math.min(menu.current?.scrollHeight||360,height);
   const computed=getComputedStyle(trigger.querySelector('strong')||trigger),scale=box.width/Math.max(1,trigger.offsetWidth);
   setPlacement({host,left:Math.max(minX,Math.min(box.left,maxX-size)),top:above?Math.max(minY,box.top-gap-measured):box.bottom+gap,width:size,height,font:`${Math.max(12,parseFloat(computed.fontSize)*scale)}px ${computed.fontFamily}`});
  };
  const outside=(event:PointerEvent)=>{if(!trigger.contains(event.target as Node)&&!menu.current?.contains(event.target as Node))onClose();};
  const keyboard=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();trigger.focus();}};
  position();const observer=new ResizeObserver(position);observer.observe(trigger);
  window.addEventListener('resize',position);window.addEventListener('scroll',position,true);window.visualViewport?.addEventListener('resize',position);window.visualViewport?.addEventListener('scroll',position);
  document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',keyboard,true);
  return()=>{observer.disconnect();window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);window.visualViewport?.removeEventListener('resize',position);window.visualViewport?.removeEventListener('scroll',position);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',keyboard,true);};
 },[anchor,onClose,width]);
 if(!placement)return null;
 return createPortal(<div ref={menu} data-floating-menu className={className} aria-label={label} style={{position:'fixed',zIndex:10000,left:placement.left,top:placement.top,width:placement.width,maxHeight:placement.height,overflowY:'auto',overscrollBehavior:'contain',font:placement.font,boxSizing:'border-box'}} onPointerDown={event=>event.stopPropagation()} onWheel={event=>event.stopPropagation()} onKeyDown={event=>{
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));if(!items.length)return;const current=items.indexOf(document.activeElement as HTMLButtonElement);const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowDown'?(current+1)%items.length:(current-1+items.length)%items.length;items[next].focus();
 }}>{children}</div>,placement.host);
}
