import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { persistedProjectIdSchema } from "@/lib/project-id";
import { textOverlaySettingsSchema } from "@/lib/text-overlay/settings";
import { OverlayError, resolveTextOverlay, updateTextOverlay } from "@/lib/text-overlay/assets";

export const runtime = "nodejs";
export const maxDuration = 60;
const sourceSchema = z.object({ projectId: persistedProjectIdSchema, assetId: z.string().min(1).max(200) });
const requestSchema = sourceSchema.extend({ text: z.string().max(2_000), settings: textOverlaySettingsSchema, mode: z.enum(["save", "preview"]) }).strict();
const headers = { "Cache-Control": "private, no-store" };
function failure(error: unknown) {
  const status = error instanceof OverlayError ? error.status : 400;
  return Response.json({ error: error instanceof Error && /text|overlay|image|canvas|storage|space/i.test(error.message) ? error.message : "Could not update text. Try again." }, { status, headers });
}
export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = sourceSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "Choose an image" }, { status: 400, headers });
  try {
    const { document } = await resolveTextOverlay(auth.user.id, parsed.data.projectId, parsed.data.assetId);
    return Response.json(document, { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (Number(request.headers.get("content-length")) > 32_768) return Response.json({ error: "Text request is too large" }, { status: 413, headers });
  const raw = await request.text();
  if (raw.length > 32_768) return Response.json({ error: "Text request is too large" }, { status: 413, headers });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { body = null; }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Check text and size settings" }, { status: 400, headers });
  try {
    const { projectId, assetId, text, settings, mode } = parsed.data;
    return Response.json(await updateTextOverlay(auth.user.id, projectId, assetId, text, settings, mode, request.signal), { headers });
  } catch (error) { return failure(error); }
}
