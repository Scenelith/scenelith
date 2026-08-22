import { db } from "../src/lib/postgres-db";
import { closeRelationalPool } from "../src/lib/relational-db";

export { db };

export async function resetTestDatabase() {
  const rows = await db.prepare(`SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('application_schema_migrations', 'application_schema_stream_migrations')`)
    .all() as Array<{ tablename: string }>;
  if (!rows.length) return;
  const tables = rows.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`).join(", ");
  await db.prepare(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`).run();
}

export { closeRelationalPool };
