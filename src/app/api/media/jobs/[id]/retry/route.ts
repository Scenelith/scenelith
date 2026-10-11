import { requireApiUser,sameOriginRequest } from '@/lib/auth';
import { retryMediaJob } from '@/lib/media/repository';
import { mediaResponse,mediaErrorResponse } from '@/lib/media/http';
export const runtime = 'nodejs';
export async function POST(request: Request,context: {params: Promise<{id:string}>}) {
  const auth=await requireApiUser(); if(auth.response)return auth.response;
  if(!sameOriginRequest(request))return Response.json({error:'Invalid origin'},{status:403});
  try {return mediaResponse(await retryMediaJob(auth.user.id,(await context.params).id));}
  catch(error){return mediaErrorResponse(error);}
}
