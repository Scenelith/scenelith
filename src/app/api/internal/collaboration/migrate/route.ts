import { db } from "@/lib/postgres-db";
import { readCollaborativeGraph } from "@/lib/collaboration-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.COLLABORATION_INTERNAL_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const projects = await db.prepare("SELECT id FROM projects ORDER BY created_at ASC").all() as Array<{ id: string }>;
  let migrated = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (let offset = 0; offset < projects.length; offset += 5) {
    const batch = projects.slice(offset, offset + 5);
    const results = await Promise.allSettled(batch.map((project) => readCollaborativeGraph(project.id)));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") migrated += 1;
      else failures.push({ id: batch[index].id, error: result.reason instanceof Error ? result.reason.message : "Migration failed" });
    });
  }
  return Response.json({ ok: failures.length === 0, total: projects.length, migrated, failures }, { status: failures.length ? 500 : 200 });
}
