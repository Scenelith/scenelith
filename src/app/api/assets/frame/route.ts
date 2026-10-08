import {requireApiUser,sameOriginRequest} from '@/lib/auth';
import {captureVideoFrame} from '@/lib/frame-media-service';
export const runtime='nodejs';
export const maxDuration=120;
export async function POST(request:Request){const auth=await requireApiUser();if(auth.response)return auth.response;if(!sameOriginRequest(request))return Response.json({error:'Invalid origin'},{status:403});return captureVideoFrame(auth.user.id,await request.json().catch(()=>null));}
