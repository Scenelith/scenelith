import { databaseSchemaStatus } from "@/lib/operations-observability";
import { relationalDatabaseReady } from "@/lib/relational-db";

export const runtime = "nodejs";

export async function GET() {
  try {
    const [database, schema] = await Promise.all([relationalDatabaseReady(), databaseSchemaStatus()]);
    const ok = database && schema.application && schema.collaboration;
    return Response.json(
      { ok, database, schema },
      { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, database: false, schema: { application: false, collaboration: false } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
