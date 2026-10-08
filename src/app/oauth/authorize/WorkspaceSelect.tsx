"use client";

import {useId,useRef,useState} from 'react';
import {Check,ChevronDown} from 'lucide-react';
import styles from './oauth-authorize.module.css';

export default function WorkspaceSelect({value,workspaces,onChange}:{value:string;workspaces:{id:string;name:string}[];onChange:(value:string)=>void}) {
 const id=useId(),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
 const [open,setOpen]=useState(false),[position,setPosition]=useState({left:0,top:0,width:0,maxHeight:300});
 const options=[{id:'',name:'All workspaces I can access'},...workspaces];
 const close=()=>{menu.current?.hidePopover();trigger.current?.focus({preventScroll:true});};
 const show=()=>{
  const rect=trigger.current!.getBoundingClientRect(),below=innerHeight-rect.bottom-16,above=rect.top-16;
  const height=Math.min(options.length*44+12,300,Math.max(below,above));
  setPosition({left:Math.max(8,Math.min(rect.left,innerWidth-rect.width-8)),top:below>=height?rect.bottom+6:Math.max(8,rect.top-height-6),width:Math.min(rect.width,innerWidth-16),maxHeight:height});
  menu.current?.showPopover();
  requestAnimationFrame(()=>menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({preventScroll:true}));
 };
 return <div className={styles.workspaceSelect}>
  <button ref={trigger} type="button" role="combobox" aria-label="Workspace" aria-controls={id} aria-expanded={open} aria-haspopup="listbox" className={styles.workspaceTrigger} onClick={()=>open?close():show()} onKeyDown={e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();show();}}}>
   <span>{options.find(option=>option.id===value)?.name}</span><ChevronDown size={15} aria-hidden="true"/>
  </button>
  <div ref={menu} id={id} popover="auto" role="listbox" aria-label="Workspace" className={styles.workspaceMenu} style={position} onToggle={e=>setOpen(e.newState==='open')} onKeyDown={e=>{
   if(e.key==='Escape'){e.preventDefault();close();}
   if(e.key==='Tab'){close();return;}
   if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
    e.preventDefault();const buttons=Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('[role="option"]')),at=buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(at+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();
   }
  }}>
   {options.map(option=><button type="button" role="option" aria-selected={option.id===value} key={option.id} onClick={()=>{onChange(option.id);close();}}><span>{option.name}</span>{option.id===value&&<Check size={15} aria-hidden="true"/>}</button>)}
  </div>
 </div>;
}
