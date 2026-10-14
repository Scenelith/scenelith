import {requireApiUser} from '@/lib/auth';
import {liveAssistantCatalog} from '@/lib/assistant-catalog-server';
export const runtime='nodejs';
export async function GET(){const auth=await requireApiUser();if(auth.response)return auth.response;return Response.json(await liveAssistantCatalog(),{headers:{'Cache-Control':'private, max-age=60'}});}
