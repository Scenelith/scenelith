import { requireApiUser } from '@/lib/auth';
import { getMediaJob } from '@/lib/media/repository';
import { mediaResponse,mediaErrorResponse } from '@/lib/media/http';
export const runtime = 'nodejs';
export async function GET(_request: Request,context: {params: Promise<{id:string}>}) {
  const auth=await requireApiUser(); if(auth.response)return auth.response;
  try {return mediaResponse(await getMediaJob(auth.user.id,(await context.params).id));}
  catch(error){return mediaErrorResponse(error);}
}
