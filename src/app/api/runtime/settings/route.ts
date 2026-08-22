import { runtimeCapabilities } from "@/platform/runtime-capabilities";
import { readRuntimeConfig } from "@/platform/runtime-config";
import { hasInstanceSecret } from "@/platform/secrets";
import { emailDeliveryConfigured } from "@/lib/email";
import { runtimeProviderStatuses } from "@/platform/provider-catalog";

export const runtime = "nodejs";

export async function GET() {
  const config = readRuntimeConfig();
  return Response.json({
    deployment: {
      type: config.deploymentType,
      registrationMode: config.registrationMode,
    },
    capabilities: runtimeCapabilities(),
    providers: {
      connections: runtimeProviderStatuses(),
      generationConfigured: hasInstanceSecret("KIE_API_KEY"),
      assistantConfigured: hasInstanceSecret("OPENROUTER_API_KEY"),
      googleLoginConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      emailConfigured: emailDeliveryConfigured(),
    },
  }, { headers: { "cache-control": "private, no-store, max-age=0" } });
}
