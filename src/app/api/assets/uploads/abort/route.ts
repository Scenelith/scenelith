import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { abortDirectMultipartUpload } from "@/lib/storage";
import { verifyUploadSession } from "@/lib/upload-session";
import { releaseDurableUploadSession } from "@/lib/storage-lifecycle";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { token?: unknown };
  try {
    const upload = verifyUploadSession(String(body.token || ""));
    if (upload.userId !== auth.user.id) return Response.json({ error: "Not found" }, { status: 404 });
    await abortDirectMultipartUpload(upload);
    await releaseDurableUploadSession(upload.assetId, "aborted");
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: true });
  }
}
