import { Pool } from "pg";
import { runCollaborationMigrations } from "./migration-runner.mjs";

if (!process.env.COLLABORATION_DATABASE_URL) throw new Error("Missing required environment variable: COLLABORATION_DATABASE_URL");

const pool = new Pool({
  connectionString: process.env.COLLABORATION_DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 10_000,
});

try {
  await runCollaborationMigrations(pool);
  console.log("Collaboration database migrations are current");
} finally {
  await pool.end();
}
