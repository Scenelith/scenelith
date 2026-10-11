import { MediaError, jobView, type MediaJob } from './contracts';
export function mediaResponse(job: MediaJob, admission = false) {
  const pending = !['completed','failed','cancelled'].includes(job.status);
  return Response.json(jobView(job),{status: admission && pending ? 202 : 200,
    headers:{'cache-control':'private, no-store',...(pending?{'retry-after':'2'}:{})}});
}
export function mediaErrorResponse(error: unknown) {
  if (error instanceof SyntaxError) return Response.json({error:'INVALID_MEDIA_REQUEST'},{status:400});
  if (error instanceof MediaError) return Response.json({error:error.code},{status:error.status});
  console.error('Media request failed',error);
  return Response.json({error:'MEDIA_REQUEST_FAILED'},{status:500});
}
