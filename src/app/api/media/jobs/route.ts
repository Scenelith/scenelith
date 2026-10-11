import { requireApiUser,sameOriginRequest } from '@/lib/auth';
import { createMediaJob } from '@/lib/media/repository';
import { mediaResponse,mediaErrorResponse } from '@/lib/media/http';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const auth=await requireApiUser(); if(auth.response)return auth.response;
  if(!sameOriginRequest(request))return Response.json({error:'Invalid origin'},{status:403});
  if(process.env.SCENELITH_MEDIA_QUEUE_ENABLED!=='true')return Response.json({error:'MEDIA_QUEUE_DISABLED'},{status:503});
  try { return mediaResponse(await createMediaJob(auth.user.id,await request.json()),true); }
  catch(error) { return mediaErrorResponse(error); }
}
