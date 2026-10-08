import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { exportVideoMedia } from "@/lib/export-media-service";
export const runtime = "nodejs";
export async function POST(request: Request) {
 const auth=await requireApiUser();
 if(auth.response)return auth.response;
 if(!sameOriginRequest(request))return Response.json({error:"Invalid origin"},{status:403});
 return exportVideoMedia(auth.user.id,await request.json().catch(()=>null));
}
