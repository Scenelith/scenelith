import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { databaseEdition } from "./edition.mjs";

const migrationLockId = 7_318_811_044;
const legacyLedger = "application_schema_migrations";
const streamLedger = "application_schema_stream_migrations";

async function migrationFiles(directory) {
  return (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

function assertExpandOnly(stream, version, sql) {
  const destructive = /\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|ALTER\s+COLUMN|RENAME\s+(?:COLUMN|TABLE))\b/i.exec(sql);
  if (destructive) throw new Error(`Application migration is not expand-only: ${stream}/${version} (${destructive[0]})`);
}

async function ledgerExists(client, table) {
  const result = await client.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(result.rows[0]?.name);
}

async function createLedgers(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS public.${legacyLedger} (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS public.${streamLedger} (
    stream text NOT NULL,
    version text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (stream, version)
  )`);
}

async function legacyRows(client) {
  if (!await ledgerExists(client, legacyLedger)) return [];
  return (await client.query(`SELECT version, checksum FROM public.${legacyLedger}`)).rows;
}

async function baselineRow(client) {
  if (!await ledgerExists(client, streamLedger)) return undefined;
  return (await client.query(`SELECT version, checksum FROM public.${streamLedger} WHERE stream = 'baseline'`)).rows[0];
}

async function assertFreshSchema(client) {
  const result = await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT IN ($1, $2)
    ORDER BY table_name`, [legacyLedger, streamLedger]);
  if (result.rows.length) {
    throw new Error(`Database has an unversioned application schema: ${result.rows.map((row) => row.table_name).join(", ")}`);
  }
}

async function installBaseline(client) {
  await assertFreshSchema(client);
  const sql = await readFile(databaseEdition.baseline.url, "utf8");
  const digest = checksum(sql);
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await createLedgers(client);
    await client.query(
      `INSERT INTO public.${streamLedger} (stream, version, checksum) VALUES ('baseline', $1, $2)`,
      [databaseEdition.baseline.version, digest],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function verifyLegacy(client, rows) {
  const appliedByVersion = new Map(rows.map((row) => [row.version, row.checksum]));
  for (const version of await migrationFiles(databaseEdition.legacyUrl)) {
    const sql = await readFile(new URL(version, databaseEdition.legacyUrl), "utf8");
    const previous = appliedByVersion.get(version);
    if (!previous) throw new Error(`Legacy application migration is missing from the database: ${version}`);
    if (previous !== checksum(sql)) throw new Error(`Applied legacy application migration changed: ${version}`);
  }
}

async function verifyBaseline(client, row) {
  const sql = await readFile(databaseEdition.baseline.url, "utf8");
  if (!row || row.version !== databaseEdition.baseline.version || row.checksum !== checksum(sql)) {
    throw new Error(`Installed ${databaseEdition.name} baseline is missing or changed`);
  }
}

async function applyStreams(client) {
  const applied = await client.query(`SELECT stream, version, checksum FROM public.${streamLedger} WHERE stream <> 'baseline'`);
  const appliedByKey = new Map(applied.rows.map((row) => [`${row.stream}/${row.version}`, row.checksum]));
  for (const stream of databaseEdition.streams) {
    for (const version of await migrationFiles(stream.url)) {
      const sql = await readFile(new URL(version, stream.url), "utf8");
      assertExpandOnly(stream.name, version, sql);
      const digest = checksum(sql);
      const key = `${stream.name}/${version}`;
      const previous = appliedByKey.get(key);
      if (previous && previous !== digest) throw new Error(`Applied application migration changed: ${key}`);
      if (previous) continue;
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO public.${streamLedger} (stream, version, checksum) VALUES ($1, $2, $3)`,
          [stream.name, version, digest],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  }
}

async function verifyStreams(client) {
  if (!await ledgerExists(client, streamLedger)) throw new Error("Application stream migrations have not been initialized");
  const applied = await client.query(`SELECT stream, version, checksum FROM public.${streamLedger}`);
  const appliedByKey = new Map(applied.rows.map((row) => [`${row.stream}/${row.version}`, row.checksum]));
  for (const stream of databaseEdition.streams) {
    for (const version of await migrationFiles(stream.url)) {
      const sql = await readFile(new URL(version, stream.url), "utf8");
      if (appliedByKey.get(`${stream.name}/${version}`) !== checksum(sql)) {
        throw new Error(`Application migration is missing or changed: ${stream.name}/${version}`);
      }
    }
  }
}

export async function runApplicationMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [migrationLockId]);
    const legacy = await legacyRows(client);
    const baseline = await baselineRow(client);
    if (!legacy.length && !baseline) await installBaseline(client);
    await createLedgers(client);
    if (legacy.length) await verifyLegacy(client, legacy);
    else await verifyBaseline(client, await baselineRow(client));
    await applyStreams(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [migrationLockId]).catch(() => undefined);
    client.release();
  }
}

export async function assertApplicationMigrationsCurrent(pool) {
  const client = await pool.connect();
  try {
    const legacy = await legacyRows(client);
    if (legacy.length) await verifyLegacy(client, legacy);
    else {
      const baseline = await baselineRow(client);
      if (!baseline) throw new Error("Application database migrations have not been run");
      await verifyBaseline(client, baseline);
    }
    await verifyStreams(client);
  } finally {
    client.release();
  }
}
