'use client';
import {useCallback,useMemo,useState,useSyncExternalStore} from 'react';

const draftEvent='scenelith:browser-draft';
/** Personal UI drafts stay outside the shared Canvas document and its input revisions. */
export function useBrowserDraft<T>(key:string|undefined,decode:(value:unknown)=>T|null){
 const [transient,setTransient]=useState<{key:string|undefined;raw:string;persisted:boolean}|null>(null);
 const subscribe=useCallback((notify:()=>void)=>{
  const changed=(event:Event)=>{if(event instanceof StorageEvent ? event.key===key||event.key===null : (event as CustomEvent).detail===key)notify();};
  window.addEventListener('storage',changed);window.addEventListener(draftEvent,changed);
  return()=>{window.removeEventListener('storage',changed);window.removeEventListener(draftEvent,changed);};
 },[key]);
 const snapshot=useCallback(()=>{try{return key?localStorage.getItem(key):null;}catch{return null;}},[key]);
 const stored=useSyncExternalStore(subscribe,snapshot,()=>null),raw=transient&&transient.key===key&&!transient.persisted?transient.raw:stored??(transient&&transient.key===key?transient.raw:null);
 const value=useMemo(()=>{try{return raw===null?null:decode(JSON.parse(raw));}catch{return null;}},[raw,decode]);
 const save=useCallback((value:T)=>{const raw=JSON.stringify(value);let persisted=false;if(key){try{localStorage.setItem(key,raw);persisted=true;}catch{/* Keep editing when storage is unavailable. */}}setTransient({key,raw,persisted});if(key)window.dispatchEvent(new CustomEvent(draftEvent,{detail:key}));},[key]);
 return [value,save] as const;
}
export const stringDraft=(value:unknown)=>typeof value==='string'?value:null;
export type AssistantDraft={brief:string;proposal:string|null};
export const assistantDraft=(value:unknown):AssistantDraft|null=>{
 if(!value||typeof value!=='object')return null;
 const draft=value as Partial<AssistantDraft>;
 return typeof draft.brief==='string'&&(draft.proposal===null||typeof draft.proposal==='string')?{brief:draft.brief,proposal:draft.proposal}:null;
};
