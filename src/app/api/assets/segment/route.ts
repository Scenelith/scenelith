import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { prepareVideoSegment } from "@/lib/segment-media-service";
export const runtime = "nodejs";
export async function POST(request: Request) {
 const auth=await requireApiUser();
 if(auth.response)return auth.response;
 if(!sameOriginRequest(request))return Response.json({error:"Invalid origin"},{status:403});
 return prepareVideoSegment(auth.user.id,await request.json().catch(()=>null));
}
