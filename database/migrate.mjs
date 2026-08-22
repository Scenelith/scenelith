import pg from "pg";
import { runApplicationMigrations } from "./migration-runner.mjs";

const connectionString = process.env.DATABASE_URL || process.env.COLLABORATION_DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  await runApplicationMigrations(pool);
  console.log("Application database migrations are current");
} finally {
  await pool.end();
}
