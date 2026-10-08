import { handleGenerationRequest } from "@/lib/generation-http";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) { return handleGenerationRequest(request); }
