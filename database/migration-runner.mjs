import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

const migrationLockId = 7_318_811_044;
const migrationsUrl = new URL("./migrations/", import.meta.url);

async function migrationFiles() {
  return (await readdir(migrationsUrl))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

function assertExpandOnly(version, sql) {
  const destructive = /\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|ALTER\s+COLUMN|RENAME\s+(?:COLUMN|TABLE))\b/i.exec(sql);
  if (destructive) throw new Error(`Application migration is not expand-only: ${version} (${destructive[0]})`);
}

export async function runApplicationMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [migrationLockId]);
    await client.query(`CREATE TABLE IF NOT EXISTS application_schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query("SELECT version, checksum FROM application_schema_migrations");
    const appliedByVersion = new Map(applied.rows.map((row) => [row.version, row.checksum]));
    for (const version of await migrationFiles()) {
      const sql = await readFile(new URL(version, migrationsUrl), "utf8");
      assertExpandOnly(version, sql);
      const digest = checksum(sql);
      const previous = appliedByVersion.get(version);
      if (previous && previous !== digest) throw new Error(`Applied application migration changed: ${version}`);
      if (previous) continue;
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO application_schema_migrations (version, checksum) VALUES ($1, $2)",
          [version, digest],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [migrationLockId]).catch(() => undefined);
    client.release();
  }
}

export async function assertApplicationMigrationsCurrent(pool) {
  const files = await migrationFiles();
  const table = await pool.query("SELECT to_regclass('public.application_schema_migrations') AS name");
  if (!table.rows[0]?.name) throw new Error("Application database migrations have not been run");
  const applied = await pool.query("SELECT version, checksum FROM application_schema_migrations");
  const appliedByVersion = new Map(applied.rows.map((row) => [row.version, row.checksum]));
  for (const version of files) {
    const sql = await readFile(new URL(version, migrationsUrl), "utf8");
    if (appliedByVersion.get(version) !== checksum(sql)) {
      throw new Error(`Application migration is missing or changed: ${version}`);
    }
  }
}
