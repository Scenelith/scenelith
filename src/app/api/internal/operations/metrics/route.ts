import { operationsPrometheus, operationsSnapshot } from "@/lib/operations-observability";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = process.env.SCENELITH_INTERNAL_METRICS_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized\n", { status: 401, headers: { "cache-control": "no-store" } });
  }
  try {
    const body = operationsPrometheus(await operationsSnapshot());
    return new Response(body, {
      headers: {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("[operations:metrics-failed]", { error });
    return new Response("Metrics unavailable\n", { status: 503, headers: { "cache-control": "no-store" } });
  }
}
