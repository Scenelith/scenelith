import {requireApiUser,sameOriginRequest} from '@/lib/auth';
import {readStudioCharacters,saveStudioCharacters} from '@/lib/studio-characters-service';
export const runtime='nodejs';
export async function GET(request:Request){
 const auth=await requireApiUser();if(auth.response)return auth.response;
 const params=new URL(request.url).searchParams;
 return readStudioCharacters(auth.user.id,params.get('workspaceId')||'');
}
export async function PUT(request:Request){
 const auth=await requireApiUser();if(auth.response)return auth.response;
 if(!sameOriginRequest(request))return Response.json({error:'Invalid origin'},{status:403});
 const raw=await request.text();if(raw.length>300_000)return Response.json({error:'Settings are too large'},{status:413});
 let body;try{body=JSON.parse(raw);}catch{return Response.json({error:'Invalid JSON'},{status:400});}
 return saveStudioCharacters(auth.user.id,body);
}
