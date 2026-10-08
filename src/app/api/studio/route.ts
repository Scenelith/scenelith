import { requireApiUser, sameOriginRequest } from '@/lib/auth';
import { studioWorkspace } from '@/lib/studio-workspace';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({error:'Invalid origin'}, {status:403});
  const body = await request.json().catch(() => ({}));
  try { return Response.json(await studioWorkspace(auth.user.id, typeof body.workspaceId === 'string' ? body.workspaceId : null)); }
  catch { return Response.json({error:'Workspace not found'}, {status:404}); }
}
