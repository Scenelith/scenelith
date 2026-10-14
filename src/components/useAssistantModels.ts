'use client';
import {useEffect,useState} from 'react';
import {assistantModels,type AssistantModelOption} from '@/lib/assistant-models';
import type {AssistantCatalog} from '@/lib/assistant-catalog';
let cache:AssistantCatalog|undefined,expires=0,pending:Promise<AssistantCatalog|undefined>|undefined;
export function useAssistantModels(){const [models,setModels]=useState<AssistantModelOption[]>(cache?.models||assistantModels);useEffect(()=>{let active=true;const update=async()=>{if(Date.now()>=expires){pending??=fetch('/api/prompts/models').then(async response=>{if(!response.ok)return;const value=await response.json() as AssistantCatalog;if(!Array.isArray(value.models))return;cache=value;expires=Date.now()+60000;return value;}).catch(()=>undefined).finally(()=>{pending=undefined;});const result=await pending;if(active&&result)setModels(result.models);}else if(active&&cache)setModels(cache.models);};void update();const timer=setInterval(()=>void update(),60000);return()=>{active=false;clearInterval(timer);};},[]);return models;}
