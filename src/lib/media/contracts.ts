import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MEDIA_VERSION = 1;
const range = z.object({
  id: z.string().uuid(), start: z.number().finite().min(0), end: z.number().finite().positive(),
}).strict().refine(r => r.end > r.start, 'Invalid range');
export const mediaOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('import'), url: z.string().url().refine(value=>{const url=new URL(value);return url.protocol==='https:' && !url.username && !url.password && (url.hostname==='tiktok.com'||url.hostname.endsWith('.tiktok.com'));}) }).strict(),
  z.object({ operation: z.literal('analyze'), assetId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('scenes'), assetId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('preview'), assetId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('frame'), assetId: z.string().uuid(), time: z.number().finite().min(0), maxWidth: z.number().int().min(64).max(1920).optional() }).strict(),
  z.object({ operation: z.literal('segment'), range, modelId: z.enum(['wan-3','seedance-2-5']).optional() }).strict(),
  z.object({ operation: z.literal('export'), assets: z.array(range.extend({ audio: range.optional(), outputDuration: z.number().finite().positive().optional() })).min(1).max(100),
    audioMode: z.enum(['selected','original','none']).default('selected') }).strict(),
  z.object({ operation: z.literal('audio'), assetId: z.string().uuid(), audio: range.optional(), outputFormat: z.enum(['mp4','mov']).default('mp4') }).strict(),
]);
export const mediaJobRequestSchema = z.object({
  projectId: z.string().trim().min(1).max(160).optional(), workspaceId: z.string().uuid().optional(), requestKey: z.string().min(1).max(200), spec: mediaOperationSchema, dependencies: z.array(z.string().uuid()).max(100).default([]),
}).strict().refine(r=>Boolean(r.projectId||r.workspaceId),'Project or workspace required');
export type MediaSpec = z.infer<typeof mediaOperationSchema>;
export type MediaInput = { id: string; workspace_id: string; project_id: string | null; storage_path: string; mime_type: string; content_hash: string | null; size_bytes: number; identity: string };
export type MediaJobState = 'queued'|'running'|'retry_wait'|'completed'|'failed'|'cancelled';
export type MediaJob = { id: string; user_id: string; workspace_id: string; project_id: string|null; operation: string; operation_version: number;
  fingerprint: string; spec_json: string; inputs_json: string; resource_class: 'light'|'transcode'; status: MediaJobState; stage: string;
  attempts: number; fence: number; worker_id: string|null; result_asset_id: string|null; result_json: string|null; error_code: string|null; created_at: string; updated_at: string };
export class MediaError extends Error {
  constructor(public code: string, public status = 400, public retryable = false) { super(code); }
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function fingerprint(value: unknown) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function inputIds(spec: MediaSpec) {
  if (spec.operation === 'import') return [];
  if (spec.operation === 'segment') return [spec.range.id];
  if (spec.operation === 'export') return [...new Set(spec.assets.flatMap(a => [a.id, ...(a.audio ? [a.audio.id] : [])]))];
  if (spec.operation === 'audio') return [...new Set([spec.assetId, ...(spec.audio ? [spec.audio.id] : [])])];
  return [spec.assetId];
}
export function jobView(job: MediaJob) {
  return { id: job.id, jobId: job.id, status: job.status, stage: job.stage, attempt: job.attempts,
    statusUrl: `/api/media/jobs/${job.id}`, result: job.result_json ? JSON.parse(job.result_json) : null,
    error: job.error_code, createdAt: job.created_at, updatedAt: job.updated_at };
}
