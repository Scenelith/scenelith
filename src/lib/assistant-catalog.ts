import {assistantModels,type AssistantModelOption} from './assistant-models';
export type AssistantCatalog={models:AssistantModelOption[];updatedAt:string|null;source:'live'|'cached'|'fallback'};
export function pricedAssistantCatalog(payload:unknown):AssistantModelOption[]{
 const rows=(payload as {data?:unknown[]})?.data;if(!Array.isArray(rows)||!rows.length)throw new Error('Model catalogue is unavailable');
 return assistantModels.map(model=>{const row=rows.find(value=>(value as {id?:string})?.id===model.id) as {pricing?:{prompt?:unknown;completion?:unknown};architecture?:{input_modalities?:string[]}}|undefined;
  const prompt=Number(row?.pricing?.prompt),completion=Number(row?.pricing?.completion),valid=!!row&&row.pricing?.prompt!==undefined&&row.pricing?.completion!==undefined&&Number.isFinite(prompt)&&Number.isFinite(completion)&&prompt>=0&&completion>=0;
  return valid?{...model,promptUsdPerToken:prompt,completionUsdPerToken:completion,available:true,supportsVision:row.architecture?.input_modalities?.includes('image')??model.supportsVision}:{...model,available:false};
 });
}
