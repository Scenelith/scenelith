import {DEFAULT_ASSISTANT_MODEL_ID} from './assistant-models';
import {editReferenceMentionToken} from './reference-mentions';
export type PromptAssistantPreferences={modelId:string;systemPrompt:string};
export type PromptAssistantReference={assetId?:string;url:string;title:string;token:string;role?:string;kind?:'image'|'video'|'audio';thumbnailUrl?:string;aspectRatio?:number};
export const defaultPromptAssistantPreferences=():PromptAssistantPreferences=>({modelId:DEFAULT_ASSISTANT_MODEL_ID,systemPrompt:''});
export function stableReferenceToken(reference:{assetId?:string;url:string;title:string;role?:string}){return editReferenceMentionToken(reference.title,`${reference.assetId||reference.url}:${reference.role||'reference-image'}`);}
export function assistantFailureMessage(reason:unknown){const text=reason instanceof Error?reason.message:String(reason);return /max.?price|no endpoints|no.*providers|model.*not available|model.*not found/i.test(text)?'This model is unavailable at the current price. Choose another assistant model and try again.':text;}
export function missingReferenceMention(text:string,references:PromptAssistantReference[]){const known=new Set(references.map(r=>r.token));return Array.from(text.matchAll(/(?:^|[^\p{L}\p{N}_@])(@[\p{L}\p{N}_]+)/gu),match=>match[1]).find(token=>!known.has(token));}
