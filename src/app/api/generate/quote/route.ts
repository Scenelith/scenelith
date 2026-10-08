import { handleGenerationRequest } from "@/lib/generation-http";
export const runtime = "nodejs";
export async function POST(request: Request) { return handleGenerationRequest(request, true); }
