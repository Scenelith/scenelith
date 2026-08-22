import { requireApiAuth } from "@/lib/auth";
import { generationProvider } from "@/platform/providers/registry";

export async function GET() {
  const unauthorized = await requireApiAuth();
  if (unauthorized) return unauthorized;
  return Response.json({ models: generationProvider().models });
}
